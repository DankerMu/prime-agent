# Tasks: Prompt Settlement（切片 1）

## 1. PromptSettlementTracker 核心

- [ ] 1.1 新建 `src/core/prompt-settlement.ts`：导出 `PromptOutcome`/`PromptOutcomeStatus`/`PromptAdvisorState`/`PendingUserQuestion`/`PromptSettlementRecord`/`PromptLease` 类型与 `PromptSettlementTracker`（design D1 API：`admit`/`acquire`/`recordFinalMessage`/`bumpTraceGeneration`/`requestCancel`/`recordFailure`/`release`/`settleAll`/`outcome`/`waitForOutcome`/`isSettling`/`snapshot`/`restore`），D2 推导顺序（cancel → failed → completed，`advisor: "disabled"`），lease 计数 1→0 同步原子终态，终态后 `acquire` 抛错、其他变更 no-op；`waitForOutcome`/`outcome` 对已终态记录（含 released）分别 resolve/返回同一对象，未知 id 分别 reject/返回 `undefined`；`settleAll(status, reason)` 一律把 reason 写入记录 `settleReason`；status 为 `failed` 时额外填 `outcome.failure.reason` 与记录 `failureReason`，为 `cancelled` 时不填 `outcome.failure`
- [ ] 1.2 tracker 单测（Seam 1，假 `emit/persist`）：正常完成、cancel 优先于 failure、failed 带 reason、二次变更 no-op、终态后 acquire 抛错、多 lease 交错（run→retry→compaction 交接，先取后放无空窗 / 先放后取提前终态的反例断言）、`settleAll("cancelled")` 对未终态且未 released 记录各结算一次、`failure === undefined`、记录 `settleReason` 正确且幂等、`settleAll("failed")` 填 `failure.reason`、`restore` 后终态只读且 `waitForOutcome`/`outcome` 对 released 终态一致、`admit` 重复 id 抛错、`emit`/`persist` 各恰好一次

Suggested fixture level: compact - 纯状态机，确定性单测即可穷举，但它承载后续全部组的正确性基线
Minimal mergeable slice: atomic - 新文件无调用方，合并即绿不改变任何行为

## 2. action promptId 与主 run lease

- [ ] 2.1 `QueuedSessionAction` 增加 `promptId: string`；`_createPreparedTurnAction` options 增加 `lineage?: { inherit: string }`，缺省经 `tracker.admit({ promptId: options.promptId, sessionEpoch: this._sessionInputArrivalEpoch })` 分配；`session_command` action 不分配；`AgentSession` 持有 tracker 实例（`emit` → `_emit({ type: "prompt_outcome", outcome })`，`persist` 暂为 no-op，由组 8 接管）
- [ ] 2.2 主 run lease：action 进入 `preparing` 前 `acquire(promptId, "run")` 并记录 `_lastRunPromptId`；在 `completion` 腿 settle 的四处（正常完成 / 终止错误 / 扩展命令 / 执行异常）同步 release，终止错误路径先 `recordFailure("run_error")`；已 admission 但在取得 run lease 前被移除的 action（coalesce 拒绝、`_rejectQueuedAgentMessageDeliveries`、`_cancelSessionActions`）在同一处：若 action 是缺省 lineage（自己拥有 promptId）则 `requestCancel` + `acquire("run").release()` 产生 `cancelled`；若 action 是 `lineage.inherit`（组 5 引入）则只 `acquire("run").release()`、不 `requestCancel`，原 prompt 的终态由其余 lease 决定。保证无永久 `settling` 记录
- [ ] 2.3 `promptAndSettle(text, options?: PromptOptions & { promptId?: string })`（options 与 `promptAndWait` 同集，透传 `streamingBehavior`/`internalPrompt`/`suppressAutonomousContinuation` 等；支持 `promptId` 预分配；admission 失败 reject 与 `promptAndWait` 同错误）、`waitForPromptOutcome`、`getPromptOutcome`；`AgentSessionEvent` 联合增加 `prompt_outcome`；`steer()`/`followUp()`/goal context 入队沿用缺省 lineage（无需改动，测试覆盖）
- [ ] 2.4 行为测试（Seam 2，faux provider）：单 run `completed` 且事件恰好一次；provider error 无 retry → `failed/run_error`；两个排队 prompt 各自独立 promptId 与 outcome；run 内同步 tool 调用（faux provider 返回 tool call，tool 延迟 resolve）期间 outcome 不产生、tool 完成后的后续 turn 结束才产生；run 中 `steer()`/`followUp()` 拿新 promptId 不并入；session command（`/goal status`）不产生记录；排队 prompt 被清队 → `cancelled` 且无 `settling` 残留；`promptAndWait` 时序回归（仍在 completion settle 时 resolve）；admission 被拒 → reject 无事件；A 终态后 cron/heartbeat 运行与 auto-refine 已调度时 A 的 outcome 立即产生（不等待后台工作）

Suggested fixture level: compact - 首次把 tracker 挂进 session，是所有模式依赖的基线路径
Minimal mergeable slice: atomic - 只覆盖主 run 一种 lease；retry/compaction 未挂线时它们不存在于测试路径，合并保绿

## 3. retry lease

- [ ] 3.1 `_retryPromise` 建立的两处（`:3396`、`:10241`）以 `_lastRunPromptId` `acquire("retry")`，在 `_retryResolve` 置空处 release；顺序保证：retry lease 在 run lease release 之前获取（run 以 error 结束 → 进入 retry 判定 → 先 acquire retry 再 release run）
- [ ] 3.2 行为测试：faux provider 先 error 后成功，断言一个 promptId、两个 `agent_end`、一个 `completed` outcome 且在 retry 完成后才产生；retry 耗尽 → `failed/run_error`

Suggested fixture level: compact - 涉及 lease 交接顺序，是设计 §8 第 4 条竞态的真实路径
Minimal mergeable slice: atomic - 单一挂点 + 配套测试，独立合并保绿

## 4. post-compaction continuation lease 与 traceGeneration

- [ ] 4.1 `_schedulePostCompactionContinue` 置 `Scheduled=true` 时以 `_lastRunPromptId` `acquire("compaction_continuation")`；`_cancelPostCompactionContinue`（含 `_clearQueuedAutonomousContinuations`、auto-refine 分支失效等非 abort 调用方——只 release 不 `requestCancel`）、`_runScheduledPostCompactionContinue` 的各提前 return 分支与 `agent.continue()` 返回/抛出后 release；reschedule 沿用同一 lease；compaction 完成回调处对 `_lastRunPromptId` 调用 `bumpTraceGeneration`（组 7 引入 `_currentRunOwner` 后改为 `_currentRunOwner ?? _lastRunPromptId`）
- [ ] 4.2 行为测试：threshold compaction 触发 continuation，断言 outcome 在 continuation run 结束后产生、`traceGeneration === 1`（无 compaction 的 prompt 为 0；A 终态后 B 的 compaction 不改 A）、`agent_end` 两次；continuation 因排队清空被取消（非 abort）→ 恰好一个 `completed` outcome；abort 取消 → `cancelled`（依赖组 6 的 abort 挂点，该断言放组 6.2）

Suggested fixture level: compact - timer 持有的 continuation 是现状 `AgentMessageOutcome` 丢失的核心场景
Minimal mergeable slice: atomic - 单一挂点 + 配套测试，独立合并保绿

## 5. autonomous threshold continuation 继承 lineage

- [ ] 5.1 `_queueAutonomousContinuationForThresholdCompaction` 创建 action 时传 `lineage: { inherit: this._lastRunPromptId }`；`_clearQueuedAutonomousContinuations` 取消该 action 时走组 2.2 已建立的"admission 后未取得 run lease 即移除"路径的 inherit 分支（只 release、不 `requestCancel`）
- [ ] 5.2 行为测试：goal 模式下 threshold compaction 排队 autonomous continuation，断言其 action.promptId 等于原 prompt、outcome 单次且在 continuation 完成后

Suggested fixture level: none - 一行 options 透传 + 组 2.2 取消路径复用
Minimal mergeable slice: atomic - 单调用点，依赖组 2/4，独立合并保绿

## 6. cancel 路径：abort、admission 后未执行、dispose

- [ ] 6.1 `abort()` 对 `_lastRunPromptId` 与所有排队 turn action 的 promptId `requestCancel`（abort 取消的 post-compaction continuation 因 fence 推导为 `cancelled`）；`dispose()` 在拒绝 `_agentMessageOutcomes` 处调用 `settleAll("cancelled", "session_disposed")`（`outcome.failure` 不填，reason 进记录 `settleReason`）后 `release` 全部
- [ ] 6.2 行为测试：run 中 abort → `cancelled`（即使先有 retry failure）；continuation 待执行时 abort → `cancelled`；dispose 时 1 执行中 + 2 排队各一次 `cancelled` 且 `failure === undefined`、记录 `settleReason === "session_disposed"`、重复 dispose no-op

Suggested fixture level: compact - abort 与 dispose 各有独立触发，需逐条场景
Minimal mergeable slice: atomic - 取消语义一组内闭环，依赖组 2/4，独立合并保绿

## 7. finalMessageIds 记录

- [ ] 7.1 新增 `_currentRunOwner`：action dispatch 开始时设为 `action.promptId`、该 action 的 completion settle 时清空（retry 续跑发生在同一次 dispatch 内，期间不清空）；`_runScheduledPostCompactionContinue` 调用 `agent.continue()` 前设为该 continuation lease 的 owner、返回/抛出后清空；组 4 的 `bumpTraceGeneration` 目标改为 `_currentRunOwner ?? _lastRunPromptId`；主 agent `message_end` 写入 assistant entry 处，若 `_currentRunOwner` 存在则 `recordFinalMessage(_currentRunOwner, entryId)`；run 之外追加的消息不记录
- [ ] 7.2 行为测试：run → retry → compaction continuation 三条 assistant entry 按序出现在 `finalMessageIds`；A 的 continuation 在 B 运行后才执行时，B 的消息归 B、continuation 消息归 A；后台 refine 消息不出现

Suggested fixture level: compact - 含 continuation 重排下的归属竞态场景
Minimal mergeable slice: atomic - 单挂点 + 断言，依赖组 4，独立合并保绿

## 8. ledger 写入

- [ ] 8.1 tracker `persist` 接 `sessionManager.appendCustomEntry("prime-agent.prompt-settlement", record)`：admission 写 `settling`，终态/released 写终态记录；record 形状按 persistence spec（`failureReason` 仅 failed、`settleReason` 来自 `settleAll`）
- [ ] 8.2 行为测试：正常 prompt 恰两条；retry/compaction 不增加记录；dispose 写 `released: true, settleReason: "session_disposed"` 终态且无 `failureReason`

Suggested fixture level: none - 机械写盘 + 计数断言
Minimal mergeable slice: atomic - 只写不读，合并保绿

## 9. 重启恢复

- [ ] 9.1 session 构造期（任何 listener 订阅前）扫描 custom entries 按 promptId 取最后一条 `restore`；`settling && !released` → `settleAll("failed", "runtime_restarted")` 并追加终态 entry，**不发出** `prompt_outcome` 事件；终态/released 只读；action recovery 恢复的 action 走 `lineage` 缺省（新 promptId）
- [ ] 9.2 行为测试：四种记录形态（settling / completed / released / settling→cancelled）重载结果，含 `waitForPromptOutcome` 对 released 终态 resolve；加载后订阅的 listener 收不到 `runtime_restarted` 的事件；恢复 action 拿新 promptId 且旧 id 为 failed

Suggested fixture level: compact - 恢复路径有四种输入形态，需逐一验证
Minimal mergeable slice: atomic - 读路径一组闭环，依赖组 8 的写格式

## 10. AgentConnection.promptAndSettle（in-process）

- [ ] 10.1 `agent-connection/types.ts` 增加 `promptAndSettle(message, options?): Promise<PromptOutcome>`；`in-process-agent-connection.ts` 直通 `session.promptAndSettle`；`daemon-agent-connection.ts` 的实现无条件以「daemon lacks prompt_settlement」错误 reject（这正是对不支持该 capability 的 daemon 的真实行为；组 12 把它改为按协商结果分支）
- [ ] 10.2 单测：in-process 连接 `promptAndSettle` 返回 outcome；daemon 连接以「daemon lacks prompt_settlement」拒绝

Suggested fixture level: none - 接口透传
Minimal mergeable slice: atomic - 接口 + in-process 实现，daemon 实现由组 12 依赖本组

## 11. daemon 协议：capability、ACK promptId、事件、命令

- [ ] 11.1 `daemon-protocol.ts`：从 `core/prompt-settlement.ts` 导入 `PromptOutcome`（不重声明枚举）；`"prompt_settlement"` 加入 client/server capability；`DAEMON_SCHEMA_REVISION` 17；`prompt`/`prompt_and_wait` 命令 `promptId?`；`prompt_outcome` 事件类型 + 事件兼容映射 `capability: "prompt_settlement"`；`get_prompt_outcome` 命令 + 兼容映射 `{ minProtocol: 7, minSchemaRevision: 17, capability }`
- [ ] 11.2 `daemon-mode.ts`：声明 capability 的客户端 `prompt`/`prompt_and_wait` ACK `data: { promptId }`（预分配透传给 session）；转发 `prompt_outcome`；实现 `get_prompt_outcome`；`cli/daemon-command.ts` 的 session_event 处理补 `prompt_outcome` 分支（不渲染）
- [ ] 11.3 协议测试：new-client/new-daemon（ACK 回显、事件一次、命令查询）、old-client/new-daemon（ACK 形状不变、无事件、命令兼容错误）、new-client/old-daemon（capability 缺失）；schema revision 兼容表快照更新

Suggested fixture level: compact - wire 变化必须覆盖双向跨版本矩阵
Minimal mergeable slice: atomic - 协议三件套共用同一 capability，拆开会发布半个 capability

## 12. daemon 连接 promptAndSettle

- [ ] 12.1 `daemon-agent-connection.ts`：`promptAndSettle` 先订阅 `prompt_outcome`、再发带预分配 `promptId` 的 `prompt`，按 id 匹配 resolve；daemon 未声明 capability → 明确错误；连接关闭 → transport failure reject
- [ ] 12.2 单测：事件早于 ACK 仍 resolve；断线 reject；capability 缺失拒绝

Suggested fixture level: compact - 客户端时序（事件先于 ACK）是真实竞态
Minimal mergeable slice: atomic - 单类单方法 + 测试，依赖组 10/11

## 13. RPC 模式与 RpcClient

- [ ] 13.1 `rpc-mode.ts`：`prompt` 响应 `data: { promptId }`（使用 `promptAndSettle` 风格的预分配或读取 session 返回）；`prompt_outcome` 随 session_event 原样转发
- [ ] 13.2 `rpc-client.ts`：`promptAndWait` JSDoc 标注仅 run 终态；新增 `promptAndSettle(message, images?, timeout?)` 返回 `{ outcome, events }`，超时错误形态与 `promptAndWait` 一致
- [ ] 13.3 RPC 测试：retry 场景下 `promptAndWait` 仍在首个 `agent_end` resolve、`promptAndSettle` 在 `prompt_outcome` 后 resolve 且 events 含两个 `agent_end`；超时路径

Suggested fixture level: compact - 公开导出的 RpcClient 是 userspace，需回归旧方法
Minimal mergeable slice: atomic - 两文件同一契约，依赖组 2

## 14. print-mode 与 docs/json.md

- [ ] 14.1 `print-mode.ts`：`initialMessage`/`messages` 改 `connection.promptAndSettle`（逐条等到终态），之后照旧 `connection.waitForHeadlessCompletion()`；退出码映射不变
- [ ] 14.2 `docs/json.md`：`prompt_outcome` 事件形状与"忽略未知事件类型"承诺
- [ ] 14.3 行为测试（假 connection）：多个 `agent_end` 一个 outcome 后才输出；`failed` → 1；三条输入顺序；json 子模式输出 `prompt_outcome` 行

Suggested fixture level: compact - 入口行为变化 + 退出码回归
Minimal mergeable slice: atomic - 单入口 + 文档，依赖组 10（in-process）/组 12（daemon 路径）；`waitForHeadlessCompletion` 仍为旧实现，行为只更保守

## 15. acp-mode

- [ ] 15.1 `acp-mode.ts`：`promptAndWait` → `promptAndSettle`，其后 `waitForHeadlessCompletion()` 不变；`session/prompt` 响应 `_meta` 附 `primeAgentMeta({ promptOutcome: { promptId, status, advisor } })`；`acp-meta.ts` 增加该 payload 类型
- [ ] 15.2 行为测试：retry 期间不提前返回且 `_meta.promptOutcome.status === "completed"`；cancel → `cancelled`；标准响应字段不变

Suggested fixture level: compact - 外部协议响应形状变化
Minimal mergeable slice: atomic - 单入口，依赖组 10/12；`waitForHeadlessCompletion` 仍为旧实现

## 16. headless-completion 改为 outcome 组合

- [ ] 16.1 `waitForHeadlessCompletion(session)` **签名不变**：把现有 `while (true)` 内开头的 `await session.waitForIdle()`（`headless-completion.ts:76`）**提到循环之前只执行一次**（带注释：为经 daemon `prompt_and_wait` + `wait_for_headless_completion` 的旧客户端兜住首轮判定前的在途 run；对已迁移调用方只是多等一次 idle），删除 continuation 之后的那次 `waitForIdle`（`:104`），gate continuation 改为 `await session.promptAndSettle(text, { streamingBehavior: "followUp", internalPrompt: true, suppressAutonomousContinuation: true })`；JSDoc 写明契约"调用方应先对自己的 prompt 等到终态；进入循环前的一次 waitForIdle 只是旧客户端兜底，不构成结算依据"。`AgentConnection`/daemon `wait_for_headless_completion` 命令/`daemon-mode.ts:4364` 均不改。前置：组 14/15（print/acp 已改为逐条 `promptAndSettle`）先合并，因此 continuation 后的 `waitForIdle` 可删而无窗口期退化；旧客户端（old-client/new-daemon）路径靠循环前的一次 `waitForIdle` 兜住首轮判定前的在途 run（顺序提交的旧客户端与现状等价）
- [ ] 16.2 行为测试（直接调用自由函数，调用方先 `promptAndSettle`）：gate 失败两次后通过 → 三个 promptId、三个 outcome；continuation 结算不依赖 idle（cron/heartbeat 运行中 continuation 的 outcome 一到即推进）；daemon 路径经 `wait_for_headless_completion` 命令得到相同 status；顺序提交的 old-client 路径（`prompt_and_wait` + `wait_for_headless_completion`）行为与现状一致

Suggested fixture level: compact - 替换 waitForIdle 是行为变化，需 gate 循环真实路径
Minimal mergeable slice: atomic - 单函数改写，无签名/wire 改动，依赖组 2 与组 14/15（调用方已迁移），独立合并保绿

## 17. 收口验证

- [ ] 17.1 跨模式契约测试：同一 retry+compaction 场景下 Print/JSON/RPC/ACP 各只产生一个 `prompt_outcome`、允许多个 `agent_end`、RPC ACK 即时；in-process 与 daemon 连接对 `promptAndSettle` 行为一致
- [ ] 17.2 `docs/prompt-settlement.md` 状态行更新为"切片 1（Advisor/ask_user 无关部分）已实现"，并在文首列出 proposal Non-goals 指向主题 3/4 的遗留清单；`npm run check` 与 coding-agent 分片全绿

Suggested fixture level: compact - 跨全部模式的收口场景
Minimal mergeable slice: atomic - 纯测试与文档，依赖组 2-16（合并顺序：…→10→11→12→14/15→16）
