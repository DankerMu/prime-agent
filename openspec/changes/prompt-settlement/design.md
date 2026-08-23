# Design: Prompt Settlement（切片 1——Advisor/ask_user 无关的结算地基）

## Context

设计来源：`packages/coding-agent/docs/prompt-settlement.md`。本 change 只实现 Advisor 与 `ask_user` 无关的部分（压测分支 1/2），`PromptOutcome` 类型按 §4 完整定义但可达终态仅 `completed | failed | cancelled`，`advisor` 恒 `disabled`。

现状事实（实施前若变化须回到本设计核对）：

- `AgentMessageOutcome`（`agent-session.ts:881`）只有 `delivery`/`completion` 两条腿，completion 在 action 完成（`:5499`）、终止错误（`:5546`）、扩展命令完成（`:5608`）、执行异常（`:6036`）处 settle 后立即删除，返回 `Promise<void>`；post-compaction continuation 由 100ms timer 另行调度（`_schedulePostCompactionContinue` `:7377-7386`），不在 completion 等待范围内。
- provider retry 由 `_retryPromise/_retryResolve`（`:3396`、`:10241`）表示等待窗口。
- threshold compaction 的 autonomous continuation 由 session 自己 `_admitSessionInput(this._createPreparedTurnAction("followUp", …))` 入队（`:2748-2757`）。
- `waitForIdle()`（`:6515`）是全局 idle：任何 queued action、cron、heartbeat 都会拖住它。
- action 有 `id` 与可选 `agentMessageId`（`session-action-store.ts:67-75`）。
- session JSONL 支持 `CustomEntry`（`session-manager.ts:159`，`appendCustomEntry(customType, data)`），已被 goal state（`agent-session.ts:1660`）与 refinement（`:7934`）用于重建内部状态；每个 entry 有稳定 `id`（`session-manager.ts:96-101`），内存 `AgentMessage` 没有 id。
- daemon：`DaemonResponse.data?: unknown`（`daemon-protocol.ts:769`）可承载 ACK 扩展；命令/事件兼容映射以 `capability` 门控（`:635-648`、`:956`）；`DAEMON_SCHEMA_REVISION = 16`、`DAEMON_PROTOCOL_VERSION = 7`。
- `RpcClient` 从 `src/index.ts:329` 公开导出，`promptAndWait` 在首个 `agent_end` resolve（`rpc-client.ts:551/573/585`）。
- JSON 模式是 print-mode 的子模式，透传全部 `session_event`（`print-mode.ts:105`）；首行 header 只含 session 文件 version（`docs/json.md:63`）。
- headless gate continuation 是 host 侧 `session.prompt(…, { internalPrompt: true })`（`headless-completion.ts:93-101`），前后各一次 `waitForIdle`。
- ACP `session/prompt` = `promptAndWait` + `waitForHeadlessCompletion` + `turnFailure` 判定（`acp-mode.ts:351-370`）。

## Goals / Non-Goals

Goals：稳定 `promptId`；owned-work lineage 覆盖主 run、retry、post-compaction continuation、session 内部 autonomous continuation；settle-once 原子终态；Print/JSON/ACP 以 outcome 结算；daemon/RPC 可协商地暴露 outcome；最小 ledger 持久化与重启后确定性结算。

Non-Goals：见 proposal「Non-goals」——`needs_user_input`/`pendingQuestions`/退出码 2（主题 3）；`advisor` 非 `disabled` 值、`unresolved_advisor`、封口规则、coverage 条件（主题 4）；lineage 重建；TUI 改动；feature flag；事件流 schema 版本。

## Decisions

### D1 Tracker 是独立纯状态机，session 只做挂线

新文件 `src/core/prompt-settlement.ts`：

```ts
export type PromptOutcomeStatus = "completed" | "needs_user_input" | "unresolved_advisor" | "failed" | "cancelled";
export type PromptAdvisorState = "passed" | "fail_open" | "unresolved" | "disabled" | "pending";
export interface PromptOutcome {
  promptId: string;
  status: PromptOutcomeStatus;
  advisor: PromptAdvisorState;
  finalMessageIds: string[];          // session entry id（见 D5）
  pendingQuestions?: PendingUserQuestion[]; // 本 change 永不填充；类型按设计 §4 占位定义（toolCallId/question/options）
  sessionEpoch: number;
  traceGeneration: number;
  failure?: { reason: string };       // 仅 status === "failed" 时出现且必填；本 change 取值 "run_error" | "runtime_restarted"。cancelled 终态不填 failure（取消原因只经 settleAll 的 reason 参数进入 ledger 的 settleReason 与 waiter 的 Error，不进 outcome）
}
export type PromptLeaseKind = "run" | "retry" | "compaction_continuation";
export interface PromptLease { readonly promptId: string; readonly kind: PromptLeaseKind; release(): void; }
export class PromptSettlementTracker {
  constructor(deps: { now(): number; emit(outcome: PromptOutcome): void; persist(record: PromptSettlementRecord): void });
  admit(input: { promptId?: string; sessionEpoch: number }): string;   // 返回 promptId；已存在则 throw
  acquire(promptId: string, kind: PromptLeaseKind): PromptLease;        // 终态/released 后 throw
  recordFinalMessage(promptId: string, entryId: string): void;
  bumpTraceGeneration(promptId: string): void;
  requestCancel(promptId: string): void;                                // abort fence；幂等
  recordFailure(promptId: string, reason: string): void;               // 失败意图；幂等；不覆盖 cancel
  release(promptId: string): void;                                      // released fence：不再产生 outcome；幂等
  settleAll(status: "cancelled" | "failed", reason: string): void;     // dispose/recovery 用：对全部未终态且未 released 的记录原子结算；reason 一律进 ledger settleReason；status 为 failed 时同时进 outcome.failure 与 failureReason
  outcome(promptId: string): PromptOutcome | undefined;
  waitForOutcome(promptId: string): Promise<PromptOutcome>;            // 已终态（含 released 的终态）立即 resolve；未知 promptId reject
  isSettling(promptId: string): boolean;
  snapshot(): PromptSettlementRecord[];                                 // 持久化/恢复用
  restore(records: PromptSettlementRecord[]): void;
}
```

理由：状态机可用假时钟与假 lease 单测穷举（设计 §1 "可确定、可用状态机测试"），session 只负责在正确位置 `acquire/release` 与提供 entry id。不复用 `AgentMessageOutcome`（设计 §3 明确"不能直接改名复用"），两者并存、互不依赖。

备选：在 `AgentMessageOutcome` 上加腿——否决，它按 completion 即删，且 `Promise<void>` 无法携带结构化状态。

### D2 终态推导与 settle-once

- **终态触发点**：最后一个 lease `release()` 的同步时刻（lease 计数从 1 → 0），在同一个同步段内计算并写入终态、`persist`、`emit`、resolve waiters；之后任何 `acquire` 抛错、`recordFailure/requestCancel/recordFinalMessage` 为 no-op。
- **推导顺序**：`cancel fence` 置位 → `cancelled`；否则 `failure` 已记录 → `failed`；否则 → `completed`（`advisor: "disabled"`）。`needs_user_input`/`unresolved_advisor` 在本 change 没有生产路径。
- **零 lease 窗口**：lease 计数到 0 即终态，不做微任务延迟——要求 session 在"释放旧 lease"之前"获取新 lease"（见 D3 的挂点顺序），以保证 retry/compaction continuation 的 lease 交接不出现空窗。这是设计 §8 第 4 条竞态的实现规则，单测用交错顺序覆盖。
- **admission 后从未获得 lease**（admission 被拒、coalesce 掉、或 dispose 前排队）：缺省 lineage 的 action 在对应拒绝/取消路径 `requestCancel` 后 `acquire("run").release()` 触发结算，得到 `cancelled`；`lineage.inherit` 的 action 只 `acquire("run").release()`，原 prompt 终态由其余 lease 决定；不留下永久未终态记录。

### D3 lineage 挂点（session 侧，全部在 `agent-session.ts`）

| owned work | acquire | release | 备注 |
| --- | --- | --- | --- |
| 主 run（含同步 tool/子 Agent） | action 进入 `preparing`（`:5480` 附近）前，以 action 的 `promptId` 取 `"run"` lease | `completion` 腿 settle 的四处（`:5499` / `:5546` / `:5608` / `:6036`）同步释放 | 终止错误路径先 `recordFailure("run_error")` 再释放 |
| provider retry 窗口 | 建立 `_retryPromise`（`:3396`、`:10241`）时取 `"retry"` lease | `_retryResolve` 置空（`:3614`）时释放 | retry 属于当前 run 所属 prompt（`_lastRunPromptId`，见下） |
| post-compaction continuation | `_schedulePostCompactionContinue`（`:7377`）置 `Scheduled=true` 时取 `"compaction_continuation"` lease | `_cancelPostCompactionContinue`（`:7277`）、继续路径 `agent.continue()` 返回/抛出后、以及各提前 return 分支释放 | 重排（`:7400-7404` 的 reschedule）沿用同一 lease，不重复 acquire。非 abort 的取消路径（`_clearQueuedAutonomousContinuations` `:2802`、auto-refine 分支失效）只 release、不 `requestCancel`：此时主 run 已正常结束、continuation 不再需要，推导为 `completed` 是**预期结果**，不是误判 |
| autonomous threshold continuation（session 内部入队） | `_queueAutonomousContinuationForThresholdCompaction` 创建 action 时标 `lineage: { inherit: promptId }`，后续按"主 run"行挂 lease | 同主 run | 继承当前 `_lastRunPromptId` |

- **promptId 归属**：`QueuedSessionAction` 新增 `promptId: string` 字段。`_createPreparedTurnAction` 的 options 新增 `lineage?: { inherit: string }`；缺省（所有公共 `prompt()/promptAndWait()/promptUntilAccepted()/acceptAgentMessagePrompt()/queueAgentMessagePrompt()` 路径）→ `tracker.admit()` 生成新 promptId；仅 session 内部 continuation 传 `inherit`。host 侧 headless gate 的 `session.prompt(internalPrompt)` 因此**总是新 promptId**（压测分支 4）。`session_command` 类 action 不参与 settlement（不创建 promptId，不取 lease）。
- **`_lastRunPromptId`**：action 进入 running 时记录；retry 与 compaction continuation 以它为 owner（两者都在 run 内或 run 结束边界调度，此时它就是该 run 的 prompt）。它是"当前正在/刚刚执行的 prompt"，不是全局 idle 推断；消息归属另用 `_currentRunOwner`（D5），两者在 continuation 重排场景下可以不同。
- **steer/followUp**：`steer()`（`:4850`）、`followUp()`（`:4883`）与 `/goal` 斜杠命令的 goal context 入队（`_runOrQueueGoalContext` `:2063`，由用户命令触发）都经 `_createPreparedTurnAction` 缺省 lineage → 新 promptId；它们不会并入正在结算的 prompt，即使在其 run 中途到达。
- **abort**：`abort()`（`:6609`）对当前 `_lastRunPromptId` 及所有排队 action 的 promptId 调用 `requestCancel`；run 以 `aborted` 结束后沿"主 run"行释放，推导为 `cancelled`。
- **dispose**：`dispose()`（`:3976`）在拒绝 `_agentMessageOutcomes`（`:4009-4013`）的同一处调用 `tracker.settleAll("cancelled", "session_disposed")`，然后 `release()` 全部——进程内 waiter 得到 `cancelled`，ledger 写入 released fence（设计 §5.2 "进程退出后标记 released"）。
- **排除项**：auto-refine（`_scheduledAutoRefineTimers`）、cron/heartbeat、detached subagent、`session_command` 不取 lease；它们产生的后续消息不调用 `recordFinalMessage`。

### D4 `promptAndSettle` 与 `prompt_outcome` 事件

- `AgentSession.promptAndSettle(text, options?: PromptOptions & { promptId?: string }): Promise<PromptOutcome>`：options 与 `promptAndWait` 完全同集（含 `streamingBehavior`、`internalPrompt`、`suppressAutonomousContinuation`、`images`、`source` 等），外加可选 `promptId` 预分配（RPC/daemon ACK 需要先知道 id）；内部走 `promptUntilAccepted` 同路径，admission 失败（被拒、coalesce）时 reject，与 `promptAndWait` 的拒绝语义一致。headless gate continuation 以 `promptAndSettle(text, { streamingBehavior: "followUp", internalPrompt: true, suppressAutonomousContinuation: true })` 提交，与现状 `session.prompt` 的选项一致。
- `waitForPromptOutcome(promptId)`、`getPromptOutcome(promptId)` 直通 tracker。
- 新 session event `{ type: "prompt_outcome"; outcome: PromptOutcome }`，在 tracker `emit` 回调中经 `_emit`（`:1491`）发出；TUI 不消费。

### D5 `finalMessageIds` 与 `traceGeneration`

- `finalMessageIds`：主 agent `message_end` 事件写入 JSONL 的 **assistant** message entry `id`，归属于 **`_currentRunOwner`**——session 在每个主 agent run 开始时设置、结束时清空的 promptId：action run 开始时为 `action.promptId`；`_runScheduledPostCompactionContinue` 调用 `agent.continue()` 前为该 `compaction_continuation` lease 的 owner、返回/抛出后清空；retry 的续跑发生在同一次 action dispatch 内（`:5784` `waitForRetry` 先于 completion settle），owner 不清空。这样即使 prompt B 在 A 的 continuation 待执行期间先行运行（`:7398-7404` 的重排路径），B 的消息归 B、A 的 continuation 消息归 A。不以"是否持有 lease"或 `_lastRunPromptId` 判定归属；run 之外（无 `_currentRunOwner`）追加的 assistant 消息（auto-refine、heartbeat/cron 若走独立路径）不记录。`completed` 时为完整列表；`cancelled/failed` 时为已追加的部分。
- `traceGeneration`：该 prompt 持有 lease 期间每次 compaction（threshold 或 requested）完成后 +1，admission 时为 0；`bumpTraceGeneration` 在 compaction 完成回调处对 `_currentRunOwner ?? _lastRunPromptId` 调用（run 进行中归当前 run，run 结束边界归刚结束的 run）（主题 4 的 review coverage 将对比它）；本 change 只计数不消费。
- `sessionEpoch`：取 `_sessionInputArrivalEpoch`（`:1112`）在 admission 时刻的值。

### D6 持久化与恢复（压测分支 3）

- ledger 记录 `PromptSettlementRecord { promptId; status: "settling" | PromptOutcomeStatus; sessionEpoch; traceGeneration; finalMessageIds; cancelRequested; failureReason?; settleReason?; released; admittedAt; settledAt? }`——`failureReason` 仅 `failed` 记录携带并与 `outcome.failure.reason` 相同；`settleReason` 记录 `settleAll` 的 reason（如 `session_disposed`），不回流到 `PromptOutcome`，以 `appendCustomEntry("prime-agent.prompt-settlement", record)` 追加；同一 promptId 多条时以最后一条为准（admission 一条、终态/released 一条；中途不写）。
- 恢复（session 加载 / daemon worker 重启后 `AgentSession` 构造期，在任何 listener 订阅之前）：扫描 custom entries 重建 `restore(records)`；对 `status === "settling" && !released` 的记录立即 `settleAll("failed", "runtime_restarted")` 并追加终态 entry；此时没有订阅者，**不发出 `prompt_outcome` 事件**——重连客户端经 `get_prompt_outcome` 查询得到该终态；终态记录只读；released 记录保持 released。不重建 lease、timer、action。
- 旧 epoch 在途结果作废：重启后 action recovery 恢复的 action 若带旧 promptId，`_createPreparedTurnAction(..., { restore: true })` 路径不 inherit 旧 promptId，而是分配新 promptId——旧记录已 `failed`，不重开。
- 不持久化：Promise、lease、timer、transport request id。

### D7 wire 治理（压测分支 6/8）

- 新 `DaemonServerCapability`（同时加入 `DaemonClientCapability` 协商集）`"prompt_settlement"`；`DAEMON_SCHEMA_REVISION` 16→17，`DAEMON_PROTOCOL_VERSION` 不变。
- `prompt` / `prompt_and_wait` 命令新增可选 `promptId?: string`（客户端预分配）；对声明 capability 的客户端，ACK `data` 为 `{ promptId }`（未预分配时由 session 生成）；未声明的客户端 ACK 不变。
- 新事件 `prompt_outcome { activeSessionId; outcome: PromptOutcome }`，在事件兼容映射中标 `capability: "prompt_settlement"`，未声明的客户端被过滤（沿用 `:956` 模式）。
- 新命令 `get_prompt_outcome { activeSessionId; promptId }` → `data: { outcome: PromptOutcome | undefined }`，兼容映射 `{ minProtocol: 7, minSchemaRevision: 17, capability: "prompt_settlement" }`。
- `AgentConnection.promptAndSettle(message, options): Promise<PromptOutcome>`：in-process 直通 session；daemon 连接先订阅 `prompt_outcome`，再发 `prompt`（带预分配 `promptId`），按 id 匹配事件 resolve；事件先于 ACK 到达时同样正确（订阅在发送前建立）；连接断开时 reject 为 transport failure，outcome 仍由 daemon 完成，可用 `get_prompt_outcome` 追查。
- RPC 模式（`rpc-mode.ts`）：`prompt` 响应 `data: { promptId }`（RPC 无 capability 协商，additive 字段）；`prompt_outcome` 作为 session_event 原样转发。`RpcClient.promptAndWait` 不动，JSDoc 注明"仅 run 终态"；新增 `promptAndSettle(message, images?, timeout?)`：发送 prompt、从响应取 `promptId`、等待匹配的 `prompt_outcome` 事件，返回 `{ outcome, events }`。
- 跨版本矩阵：new-client/old-daemon（ACK 无 `promptId`、无事件）→ `promptAndSettle` 以明确错误拒绝（"daemon lacks prompt_settlement"），`promptAndWait` 照旧；old-client/new-daemon → 不声明 capability，看不到任何新字段/事件/命令。

### D8 模式入口（压测分支 4/7）

- `headless-completion.ts`：`waitForHeadlessCompletion(session)` **签名不变**（daemon `wait_for_headless_completion` 命令与 `AgentConnection.waitForHeadlessCompletion()` 因而不变，无 wire 改动）。契约改为：调用方（print/acp）在调用前已对其每条 prompt `promptAndSettle` 并得到终态；现有循环内开头的 `waitForIdle`（`headless-completion.ts:76`）**提到 `while` 之前只执行一次**，作为旧客户端兜底（old-client/new-daemon 经 `prompt_and_wait` + `wait_for_headless_completion`，没有 `promptAndSettle` 可用——顺序提交的旧客户端在首轮判定前仍被兜住，行为与现状等价；对已迁移调用方只是多等一次 idle，不构成结算依据；循环第 2..N 轮不再等 idle，因为 continuation 已在函数内经 `promptAndSettle` 结算）；循环中每个 gate continuation 用 `session.promptAndSettle(…)` 并等待其 outcome 取代原先 `prompt + waitForIdle`。`selectHeadlessTerminalResult` 的消息选择逻辑不变。**落地顺序**：print/acp 先迁到 `promptAndSettle`（此时旧 `waitForHeadlessCompletion` 仍多等一次 idle，只更保守），再删 continuation 之后的那次 `waitForIdle`（`:104`）——不存在"调用方未迁移而安全网已拆"的窗口。
- `print-mode.ts`：`initialMessage` 与每条 `messages` 改用 `connection.promptAndSettle`（逐条等待终态后再提交下一条），随后照旧调用 `connection.waitForHeadlessCompletion()`；退出码映射不变（`completed` 或 `failed/cancelled` 仍走现有 `selectHeadlessTerminalResult` 对 stopReason 的判定 → `0/1`）；JSON 子模式多出 `prompt_outcome` 事件行。
- `acp-mode.ts`：`promptAndWait` → `promptAndSettle`（其后 `waitForHeadlessCompletion()` 调用不变）；`session/prompt` 响应 `_meta` 经 `primeAgentMeta({ promptOutcome: { promptId, status, advisor } })` 附带摘要；`turnFailure`/`acpStopReason` 逻辑不变。
- `docs/json.md`：新增 `prompt_outcome` 事件说明与"消费者必须忽略未知事件类型"承诺。

### D9 不加 feature flag（压测分支 5）

tracker 纯新增；模式入口改等 outcome 是缺陷修复；wire 由 capability 隔离。

## Sketch seams under test

1. **`PromptSettlementTracker` 公共 API**（新 seam，最高优先）——假 `emit/persist`、手工 `acquire/release` 交错即可穷举 D2 全部推导与竞态；理由：状态机是本 change 的全部复杂度所在，越少依赖 session 越能覆盖。
2. **`AgentSession` + faux provider（`test/suite/harness.ts`）**——验证 D3 挂点：retry、compaction continuation、autonomous continuation 继承同一 promptId；cron/heartbeat/auto-refine 不阻塞；abort → `cancelled`；dispose → `cancelled/session_disposed`；JSONL 重载 → `failed/runtime_restarted`。理由：已有 harness，是最高的进程内真实 seam。
3. **`AgentConnection`（in-process 与 daemon）**——`promptAndSettle` 行为与跨版本矩阵；理由：Print/ACP 只依赖这一抽象，daemon 连接在此验证 ACK/事件/命令三件套。
4. **print-mode / acp-mode 入口函数 + 假 connection**——多个 `agent_end` 只产生一个 outcome、逐条 messages 等待、退出码不变、ACP `_meta`；理由：现有 print/acp 测试已用假 connection。

## Risks / Trade-offs

- **lease 空窗误结算**：retry 或 compaction continuation 的 acquire 晚于 run lease release 会提前 `completed`。缓解：D2 "先取新后放旧"规则 + seam 1 交错单测 + seam 2 用 faux provider 触发 retry/compaction 的集成断言。
- **owner 归属错误**：并发排队时 retry/compaction 挂到错 prompt，或 A 的 continuation 在 B 运行后才执行导致消息归错。缓解：retry 只在 run 内发生（同一 action）；compaction continuation 在 `shouldStopAfterTurn` 边界调度，此时 `_lastRunPromptId` 即刚结束的 run；消息归属以 `_currentRunOwner`（每个 run 开始时设定）而非 `_lastRunPromptId`；seam 2 以"两个排队 prompt + A 的 continuation 在 B 之后执行"覆盖。
- **JSONL 体积**：每 prompt 两条小 entry，可接受。
- **JSON 外部消费者 closed union**：定性 additive（压测分支 7），以文档承诺覆盖；无版本机制。
- **daemon 事件先于 ACK**：客户端先订阅后发送，已消除。
