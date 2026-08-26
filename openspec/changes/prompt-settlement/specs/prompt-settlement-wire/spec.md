# Spec: prompt-settlement-wire

## ADDED Requirements

### Requirement: daemon capability 与 schema 治理

daemon MUST 新增 server/client capability `prompt_settlement`；schema 16→17、protocol 7 不变。promptId响应、outcome事件、查询与 headless legacy fallback MUST 以发起/接收它们的原始 public client capability为准。supervisor MUST 在 private worker envelope转发 `callerPromptSettlement`，并在 worker outbound fanout时逐 public client过滤；resident worker MUST NOT 从固定 supervisor `worker_subscribe` capabilities推断调用方。直连 worker按本地 socket client capability执行同一规则。

#### Scenario: 新客户端对新 daemon

- WHEN 声明 `prompt_settlement` 的客户端 attach 到新 daemon
- THEN hello/attach 响应的 server capabilities 含 `prompt_settlement`，`get_prompt_outcome` 在命令兼容映射中为可用

#### Scenario: 旧客户端对新 daemon

- WHEN 未声明 `prompt_settlement` 的客户端 attach
- THEN `prompt`/`prompt_and_wait` 响应形状时序与 revision 16一致，不收到 outcome事件，查询得到兼容错误，headless命令先走一次 legacy idle

#### Scenario: 同一 worker 上 old/new clients 隔离

- WHEN 声明与未声明 capability 的两个 public clients 同时 attach 同一 resident worker
- THEN supervisor 对各自 prompt响应、查询与 headless fallback按发起方能力处理；worker产生的 outcome只 fanout给 new client，old client看不到，能力不因共享 worker串线

#### Scenario: 新客户端对旧 daemon

- WHEN 声明 `prompt_settlement` 的客户端 attach 到 schema revision 16 的 daemon
- THEN `AgentConnection.promptAndSettle` 以明确错误拒绝（指出 daemon 缺少 `prompt_settlement`），`promptAndWait` 行为不变

### Requirement: 响应携带 promptId 且保持命令时序

对声明 capability 的客户端，`prompt` 与 `prompt_and_wait` 命令 MUST 接受可选候选 `promptId`；响应 `data.promptId?` 仅在本次提交是 accepted turn 时出现，非 turn 不占用候选 id且无该字段。`prompt` MUST 保持 admission accepted 后即时 ACK、不等待结算；`prompt_and_wait` MUST 保持现有长运行语义，在 `AgentMessageOutcome.completion` 后才返回最终响应，不得因 capability 而退化为 admission ACK。未声明 capability 的客户端响应形状与时序 MUST 与 revision 16 完全一致。

#### Scenario: 预分配 id 回显

- WHEN capable client 发送 `prompt { promptId: "p-1" }`
- THEN admission ACK `data.promptId === "p-1"`，随后 `prompt_outcome.outcome.promptId === "p-1"`

#### Scenario: prompt ACK 不等结算

- WHEN `prompt` 的 run 需要数秒
- THEN ACK 在 admission accepted 后立即到达，`prompt_outcome` 在 run 结束后到达

#### Scenario: prompt_and_wait 保持 completion 时序

- WHEN capable client 发送 `prompt_and_wait { promptId: "p-2" }` 且 turn run 需要数秒
- THEN 命令在现有 `AgentMessageOutcome.completion` 前不返回，最终响应 `data.promptId === "p-2"`；同一客户端的 `prompt` 仍为即时 admission ACK

#### Scenario: 非 turn 不回显或占用候选 id

- WHEN capable client 发送 `prompt_and_wait { message: "/goal status", promptId: "candidate" }`
- THEN 命令等待 session command completion 后返回，响应无 `data.promptId`、无 `prompt_outcome`、ledger 无 `candidate`；后续 accepted turn 仍可使用该候选 id

### Requirement: prompt_outcome 事件与 get_prompt_outcome 命令

daemon MUST 在 session 发出 outcome 时生成独立 outbound，并在真正写 socket时过滤：直连 worker经 `shouldSendDaemonOutboundToClient`（或等价 helper），supervisor经 worker-frame fanout对每个 attached public client检查 capability；只向声明者转发。兼容映射元数据本身不算过滤实现。`get_prompt_outcome` 在 supervisor/worker命令入口均按原调用方 capability门控，返回 `{ outcome }`。

#### Scenario: 事件转发一次

- WHEN 一个 prompt 经历两个 `agent_end` 后结算
- THEN 客户端收到两个 `agent_end` session_event 与恰好一个 `prompt_outcome`

#### Scenario: 断线后查询

- WHEN 客户端在 `prompt_outcome` 发出前断开、随后重新 attach
- THEN `get_prompt_outcome` 返回该终态

### Requirement: AgentConnection.promptAndSettle

`AgentConnection.promptAndSettle` daemon实现 MUST先订阅，再以内部随机候选id发 `prompt_and_wait`。成功 response有id则等event，无id返回undefined。若命令因旧 completion失败，客户端 MUST先查缓存再调用 `get_prompt_outcome(candidate)`：存在则返回结构化 failed/cancelled turn outcome，不存在才透传非turn/admission error。连接断开transport failure；`promptAndWait`不变。

#### Scenario: 事件早于 completion 响应

- WHEN daemon 的 turn `prompt_outcome` 事件先于 `prompt_and_wait` 最终响应到达客户端
- THEN `promptAndSettle` 缓存该事件，并在响应确认相同 promptId 后 resolve outcome

#### Scenario: daemon 非 turn 返回 undefined

- WHEN daemon connection 以 `promptAndSettle` 提交 session command 或 extension command
- THEN 它等待 `prompt_and_wait` completion，响应无 promptId 时 resolve `undefined`，不悬空、不伪造 outcome

#### Scenario: failed turn 的旧 completion error 不泄漏

- WHEN accepted turn 以 run_error 或 abort 使 `prompt_and_wait` 返回 failure，且对应 tracker已终态
- THEN daemon connection按候选id查询并返回 failed/cancelled outcome；仅在查询无记录时才透传非turn/admission error

#### Scenario: 断线 reject

- WHEN `promptAndSettle` 等待期间连接关闭
- THEN Promise reject 为 transport failure；daemon 侧 outcome 照常产生并可经查询获取

### Requirement: RPC 模式与 RpcClient

RPC 模式的 `prompt` handler MUST 保持即时 admission ACK，并通过 `AgentConnectionPromptOptions.settlementAdmission` 获得底层支持状态与本次 accepted-turn id。底层支持时响应 MUST additive 地带 `data: { promptSettlement: "supported"; promptId?: string }`：turn 有 id，非 turn无 id；底层不支持时保持旧响应形状、无该标记。`RpcClient.promptAndWait` 语义不变；新 `promptAndSettle` 必须三路处理：supported+id 等匹配 outcome，supported+无 id按 admission-only RPC 边界返回 undefined，缺 supported 标记明确拒绝而非误判非 turn。`prompt_outcome` 仍作为 session event 原样转发。

#### Scenario: promptAndWait 仍在首个 agent_end resolve

- WHEN 经 `RpcClient.promptAndWait` 提交的 prompt 经历 retry（两个 `agent_end`）
- THEN 它在第一个 `agent_end` resolve（现有行为），而同一场景的 `promptAndSettle` 在 `prompt_outcome` 后 resolve 且 `events` 含两个 `agent_end`

#### Scenario: RPC 非 turn 不等待 agent_end

- WHEN 支持 settlement 的 RPC `prompt` 被处理为非 turn
- THEN ACK 为 `{ promptSettlement: "supported" }` 且无 promptId，`RpcClient.promptAndSettle` 返回 `{ outcome: undefined, events }`，不等待永远不会出现的 `agent_end` 或 outcome

#### Scenario: RPC 底层旧 daemon 明确拒绝

- WHEN 新 rpc-mode 包裹 schema 16 daemon，或新 RpcClient 连接未实现 settlement marker 的旧 rpc-mode
- THEN RPC `prompt` 响应缺 `promptSettlement: "supported"`，`RpcClient.promptAndSettle` 明确拒绝；不得把它当成合法非 turn，旧 `prompt`/`promptAndWait` 仍保持现状

#### Scenario: 超时

- WHEN accepted turn 的 `promptAndSettle` 在 timeout 内未收到匹配 `prompt_outcome`
- THEN reject 并附 stderr 摘要，与 `promptAndWait` 超时错误形态一致

### Requirement: JSON additive 事件与文档承诺

JSON 模式 MUST 将 `prompt_outcome` 作为新 session event 行原样输出，不引入事件流版本字段；`docs/json.md` MUST 记录该事件的形状，并写明消费者必须忽略未知事件类型。

#### Scenario: JSON 输出含 prompt_outcome

- WHEN `--mode json` 运行一条经历 retry 的 prompt
- THEN stdout 含两行 `agent_end` 与一行 `{"type":"prompt_outcome","outcome":{...}}`，其余事件形状不变

### Requirement: ACP _meta 摘要

ACP `session/prompt` 对 accepted turn MUST 在 `_meta` 的 prime-agent 命名空间下附带 `{ promptOutcome: { promptId, status, advisor } }`；非 turn 的 `promptAndSettle` 返回 `undefined` 时 MUST 省略该字段。标准字段（`stopReason`）MUST 保持有效；不识别 `_meta` 的客户端 MUST 不受影响，不新增握手。

#### Scenario: 标准客户端忽略元数据

- WHEN 不识别 prime-agent `_meta` 的 ACP 客户端调用普通 turn `session/prompt`
- THEN 响应仍为合法 ACP 响应，`stopReason` 与现有逻辑一致

#### Scenario: ACP 非 turn 省略 outcome 摘要

- WHEN ACP `session/prompt` 执行 `/compact`、`/refine` 或其他非 turn 输入
- THEN 它等待现有 completion、标准 `stopReason` 保持现状，prime-agent `_meta` 不含 `promptOutcome`
