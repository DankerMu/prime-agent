# Spec: prompt-settlement-wire

## ADDED Requirements

### Requirement: daemon capability 与 schema 治理

daemon MUST 新增 server capability `prompt_settlement`（同时是可协商的 client capability）；`DAEMON_SCHEMA_REVISION` MUST 由 16 升为 17；`DAEMON_PROTOCOL_VERSION` MUST 保持不变。ACK `promptId`、`prompt_outcome` 事件、`get_prompt_outcome` 命令 MUST 仅对声明该 capability 的客户端生效。

#### Scenario: 新客户端对新 daemon

- WHEN 声明 `prompt_settlement` 的客户端 attach 到新 daemon
- THEN hello/attach 响应的 server capabilities 含 `prompt_settlement`，`get_prompt_outcome` 在命令兼容映射中为可用

#### Scenario: 旧客户端对新 daemon

- WHEN 未声明 `prompt_settlement` 的客户端 attach
- THEN `prompt`/`prompt_and_wait` ACK 形状与 revision 16 完全一致，不收到 `prompt_outcome` 事件，发送 `get_prompt_outcome` 得到兼容性错误

#### Scenario: 新客户端对旧 daemon

- WHEN 声明 `prompt_settlement` 的客户端 attach 到 schema revision 16 的 daemon
- THEN `AgentConnection.promptAndSettle` 以明确错误拒绝（指出 daemon 缺少 `prompt_settlement`），`promptAndWait` 行为不变

### Requirement: ACK 携带 promptId

对声明 capability 的客户端，`prompt` 与 `prompt_and_wait` 命令 MUST 接受可选 `promptId` 预分配，ACK `data` MUST 为 `{ promptId }`；未预分配时由 session 生成。ACK MUST 仍在 admission 完成时即时返回，不等待结算。

#### Scenario: 预分配 id 回显

- WHEN 客户端发送 `prompt { promptId: "p-1" }`
- THEN ACK `data.promptId === "p-1"`，随后 `prompt_outcome.outcome.promptId === "p-1"`

#### Scenario: ACK 不等结算

- WHEN prompt 的 run 需要数秒
- THEN ACK 在 admission 后立即到达，`prompt_outcome` 在 run 结束后到达

### Requirement: prompt_outcome 事件与 get_prompt_outcome 命令

daemon MUST 在 session 发出 `prompt_outcome` 时向声明 capability 的已 attach 客户端转发 `{ type: "prompt_outcome", activeSessionId, outcome }`；MUST 提供 `get_prompt_outcome { activeSessionId, promptId }` 命令返回 `{ outcome: PromptOutcome | undefined }`，兼容映射为 `{ minProtocol: 7, minSchemaRevision: 17, capability: "prompt_settlement" }`。

#### Scenario: 事件转发一次

- WHEN 一个 prompt 经历两个 `agent_end` 后结算
- THEN 客户端收到两个 `agent_end` session_event 与恰好一个 `prompt_outcome`

#### Scenario: 断线后查询

- WHEN 客户端在 `prompt_outcome` 发出前断开、随后重新 attach
- THEN `get_prompt_outcome` 返回该终态

### Requirement: AgentConnection.promptAndSettle

`AgentConnection` MUST 新增 `promptAndSettle(message, options?): Promise<PromptOutcome>`：in-process 实现直通 `session.promptAndSettle`；daemon 实现 MUST 先订阅 `prompt_outcome` 再发送带预分配 `promptId` 的 `prompt`，按 id 匹配 resolve；连接断开 MUST reject 为 transport failure 而非悬空。现有 `promptAndWait` MUST 保持不变。

#### Scenario: 事件早于 ACK

- WHEN daemon 的 `prompt_outcome` 事件先于 `prompt` ACK 到达客户端
- THEN `promptAndSettle` 仍以该 outcome resolve

#### Scenario: 断线 reject

- WHEN `promptAndSettle` 等待期间连接关闭
- THEN Promise reject 为 transport failure；daemon 侧 outcome 照常产生并可经 `get_prompt_outcome` 获取

### Requirement: RPC 模式与 RpcClient

RPC 模式 `prompt` 响应 MUST 在 `data` 中附带 `{ promptId }`，并将 `prompt_outcome` 作为 session event 原样转发。`RpcClient.promptAndWait` 语义 MUST 不变并在 JSDoc 标注仅代表 run 终态；MUST 新增 `promptAndSettle(message, images?, timeout?)` 返回 `{ outcome, events }`，以响应中的 `promptId` 匹配 `prompt_outcome`。

#### Scenario: promptAndWait 仍在首个 agent_end resolve

- WHEN 经 `RpcClient.promptAndWait` 提交的 prompt 经历 retry（两个 `agent_end`）
- THEN 它在第一个 `agent_end` resolve（现有行为），而同一场景的 `promptAndSettle` 在 `prompt_outcome` 后 resolve 且 `events` 含两个 `agent_end`

#### Scenario: 超时

- WHEN `promptAndSettle` 在 timeout 内未收到匹配 `prompt_outcome`
- THEN reject 并附 stderr 摘要，与 `promptAndWait` 超时错误形态一致

### Requirement: JSON additive 事件与文档承诺

JSON 模式 MUST 将 `prompt_outcome` 作为新 session event 行原样输出，不引入事件流版本字段；`docs/json.md` MUST 记录该事件的形状，并写明消费者必须忽略未知事件类型。

#### Scenario: JSON 输出含 prompt_outcome

- WHEN `--mode json` 运行一条经历 retry 的 prompt
- THEN stdout 含两行 `agent_end` 与一行 `{"type":"prompt_outcome","outcome":{...}}`，其余事件形状不变

### Requirement: ACP _meta 摘要

ACP `session/prompt` 响应 MUST 在 `_meta` 的 prime-agent 命名空间下附带 `{ promptOutcome: { promptId, status, advisor } }`；标准字段（`stopReason`）MUST 保持有效；不识别 `_meta` 的客户端 MUST 不受影响，不新增握手。

#### Scenario: 标准客户端忽略元数据

- WHEN 不识别 prime-agent `_meta` 的 ACP 客户端调用 `session/prompt`
- THEN 响应仍为合法 ACP 响应，`stopReason` 与现有逻辑一致
