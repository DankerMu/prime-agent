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
export interface PendingUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}
export interface PendingUserQuestion {
  toolCallId: string;
  question: string;
  options: PendingUserQuestionOption[];
  multi?: boolean;
  recommended?: number;
}
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
  acquire(promptId: string, kind: PromptLeaseKind): PromptLease;        // 每次调用返回独立计数 lease；同 promptId/kind 可并存多个实例；终态/released 后 throw
  recordFinalMessage(promptId: string, entryId: string): void;
  bumpTraceGeneration(promptId: string): void;
  requestCancel(promptId: string): void;                                // abort fence；幂等
  recordFailure(promptId: string, reason: string): void;               // 失败意图；幂等；不覆盖 cancel
  release(promptId: string): void;                                      // 仅对已终态记录设置 released fence并追加一次 persist；settling/未知 id no-op；outcome/emit 不变；幂等
  settleAll(status: "cancelled" | "failed", reason: string, options?: { released?: boolean }): void; // dispose/recovery 用：对全部未终态且未 released 的记录原子结算；options.released 与终态在同一次 persist 中写入；reason 一律进 ledger settleReason；status 为 failed 时同时进 outcome.failure 与 failureReason
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
- **零 lease 窗口**：lease 计数到 0 即终态，不做微任务延迟。每个 accepted turn 在 enqueue 前立即取得并把独立 `"run"` lease实例存到 action；inherit action会为同一 owner再取一个同 kind实例。retry/compaction continuation仍须在释放旧 lease前先取新 lease。禁止按 kind去重 lease，也禁止在 preparing 再取一次。
- **turn admission、非 turn成功与取消分界**：候选 id可先生成，但只有 normalization 后通过 disposing/coalesce/重复 id检查的 turn才在 `_admitSessionInput` accepted分支执行 `admit` + `acquire("run")`，两者成功后才 enqueue；失败则两者都不留。session/extension/handled 非 turn沿用现有 completion，不 admit/lease/ledger/outcome。任何 action移除或结束都只释放其已存 lease，禁止为触发终态再临时 acquire：缺省取消先 `requestCancel` 再 release；inherit非-abort取消只 release；inherit owner若已终态则 action直接放弃、不入队、不抛穿 pump。restore turn分配新 id并同样在 accepted时取 lease；dispose只原子 `settleAll(...,{released:true})`，不先 release。

### D3 lineage 挂点（session 侧，全部在 `agent-session.ts`）

| owned work | acquire | release | 备注 |
| --- | --- | --- | --- |
| 主 run（含排队期、同步 tool/子 Agent） | `_admitSessionInput` accepted分支在 enqueue前，以 action每个 promptIds owner取独立 `"run"` lease并存到 action；preparing不再 acquire。`"all"` 合并时共享 run owners为 action promptIds并集 | action completion/terminal error/实际取消时各自释放已存 leases；错误先逐 owner `recordFailure("run_error")`。排队期lease保证 accepted action无0-lease limbo | 同 owner可因父 action+inherit action并存多个 run lease。session command无 promptIds/lease；`:5608`不参与；`:6036`只释放实际 removed accepted turn的已有 lease |
| provider retry 窗口 | 建立 `_retryPromise`（`:3396`、`:10241`）时，对 `_lastRunPromptIds` 中每个 owner 取 `"retry"` lease | `_retryResolve` 置空（`:3614`）时逐个释放 | retry 属于共享 run 的全部 prompt owner；先全部 acquire，再释放对应 run lease |
| post-compaction continuation | `_schedulePostCompactionContinue`（`:7377`）置 `Scheduled=true` 时，对 `_lastRunPromptIds` 中每个 owner 取 `"compaction_continuation"` lease | `_cancelPostCompactionContinue`（`:7277`）、继续路径 `agent.continue()` 返回/抛出后、以及各提前 return 分支逐个释放 | 重排（`:7400-7404` 的 reschedule）沿用同一组 lease，不重复 acquire。非 abort 的取消路径（`_clearQueuedAutonomousContinuations` `:2802`、auto-refine 分支失效）只 release、不 `requestCancel`：此时主 run 已正常结束、continuation 不再需要，推导为 `completed` 是**预期结果**，不是误判 |
| autonomous threshold continuation（session 内部入队） | `_queueAutonomousContinuationForThresholdCompaction` 创建 action 时标 `lineage: { inherit: promptIds }`，其中 promptIds 是触发它的共享 run owner 快照；后续按"主 run"行逐 owner 挂 lease | 同主 run | 一个 continuation action 可以继承多个 promptId，但只执行一次；不得为每个 owner 重复入队同一 continuation，也不得任意选择一个 owner |

- **promptId admission**：turn action新增非空 `promptIds` 与同长度/owner对应的 `runLeases`。公共 action单 owner，内部 inherit可多 owner。`_createPreparedTurnAction` 只准备候选/lineage；`_admitSessionInput` 通过所有 pre-admission检查后、enqueue前：default先 admit再 acquire一个 run lease，inherit校验每个 owner仍 settling并逐 owner acquire（同 kind实例允许并存）；任一 owner已终态则放弃整个 inherit action且不入队。host internalPrompt总是新的单 owner；session command无这些字段。
- **共享 run owners**：当前 pump 在 `steeringMode`/`followUpMode === "all"` 时会把多个 turn action 合并为一次 `agent.prompt(preparedMessages)`，因此 owner 不能用单数表示。session 在调用 `agent.prompt` 前把本次所有 turn action 的 promptIds 去重为 `_lastRunPromptIds: string[]`，同时设置 `_currentRunOwners`；retry 对 `_lastRunPromptIds`、compaction continuation 对调度时捕获的 owner 快照逐 id 调用现有 tracker API。tracker 仍按单个 promptId 记账，不新增集合类型、不合并 promptId，也不改变 `"all"` batching userspace。消息归属使用 `_currentRunOwners`（D5）；A 的 continuation 被 B 重排时使用 A 在调度时捕获的 owner/lease 组，不读取已被 B 覆盖的 `_lastRunPromptIds`。
- **steer/followUp**：`steer()`（`:4850`）、`followUp()`（`:4883`）与 `/goal` 斜杠命令的 goal context 入队（`_runOrQueueGoalContext` `:2063`，由用户命令触发）都经 `_createPreparedTurnAction` 缺省 lineage → 新 promptId；它们不会并入正在结算的 prompt，即使随后因 `"all"` batching 与其他 action 共享一次 run——共享 run 只使各自 outcome 等待同一份 run-owned work，不合并 lineage identity。
- **abort 与清队边界**：挂点是 `requestAbort()`。普通 abort保留真正的可见用户队列，但必须先识别并移除当前 owners的内部 inherited autonomous actions（即使其 `queueVisible` 默认 true，它们也不是用户队列）：对其 owners置 cancel fence并释放action已存 leases；同时取消/释放 compaction continuation leases，再对当前 run owners requestCancel，当前 action completion最终释放自己的 run leases。`clearQueue`/mutate delete/abortAndClearQueue取消实际移除的用户 action：default先cancel再release，inherit非-abort只release。任何取消路径禁止临时 acquire或让终态 inherit action恢复后执行。
- **dispose**：`dispose()`（`:3976`）在拒绝 `_agentMessageOutcomes`（`:4009-4013`）的同一处调用 `tracker.settleAll("cancelled", "session_disposed", { released: true })`。终态、released fence、persist、emit 与 waiter resolve 在一次同步操作内完成，不再随后逐项 `release()`；每个 prompt 因而仍只有 admission 与终态/released 两条 ledger 记录。
- **排除项**：auto-refine（`_scheduledAutoRefineTimers`）、cron/heartbeat、detached subagent、`session_command` 不取 lease；它们产生的后续消息不调用 `recordFinalMessage`。

### D4 `promptAndSettle` 与 `prompt_outcome` 事件

- `AgentSession.promptAndSettle(text, options?: PromptOptions & { promptId?: string }): Promise<PromptOutcome | undefined>`：公共 `prompt` 会 normalize 为 turn、`sessionCommand`、`extensionCommand` 或 `handled`。该方法为本次调用安装私有的 turn-admitted 回调并复用 `promptAndWait`：若回调捕获到本次 accepted turn 的 promptId，则无论 `AgentMessageOutcome.completion` resolve 还是 reject，都以 tracker 终态为真值并返回 `completed | failed | cancelled` outcome；terminal run error/abort 不作为 Promise rejection 泄漏。若没有捕获 id，说明是成功非 turn或 pre-admission 失败：非 turn completion 成功返回 `undefined`，session/extension command completion 失败和 admission 拒绝沿用原错误 reject。候选 `promptId` 只在 turn accepted 时 admit，非 turn不占用；私有回调避免重复候选 id竞态误取另一调用的 record。headless internalPrompt 必为 turn，返回 `undefined` 时 fail closed。
- `waitForPromptOutcome(promptId)`、`getPromptOutcome(promptId)` 直通 tracker。`promptAndSettle` 在本次调用内部以私有回调捕获 turn admission 的实际 promptId；普通 `prompt()` 同样接受候选 `promptId` 与一次性 settlement-admission 回调，供 AgentConnection/RPC 在不改变 `prompt(): Promise<void>` 时序的前提下获得“本次是否 accepted turn”。不暴露第二套 tracker 探测 API。
- 新 session event `{ type: "prompt_outcome"; outcome: PromptOutcome }`，在 tracker `emit` 回调中经 `_emit`（`:1491`）发出；TUI 不消费。

### D5 `finalMessageIds` 与 `traceGeneration`

- `finalMessageIds`：组2先建立 `_currentRunOwners` owner snapshot但不记录消息（因此组2 outcome保持空数组）；组7再在主 agent `message_end` 事件写入 JSONL 的 **assistant** message entry `id`，归属于 **`_currentRunOwners`**——session 在每个主 agent run 开始时设置、结束时清空的 promptId 去重数组：普通 dispatch 取本次所有 turn action 的 `promptIds`；`_runScheduledPostCompactionContinue` 调用 `agent.continue()` 前取该 continuation 调度时捕获的 owner 快照、返回/抛出后清空；retry 的续跑发生在同一次 action dispatch 内（`:5784` `waitForRetry` 先于 completion settle），owners 不清空。每条 assistant entry 对 owners 逐 id 调 `recordFinalMessage`，所以共享 run 的各 prompt 都记录同一真实输出。这样即使 prompt B 在 A 的 continuation 待执行期间先行运行（`:7398-7404` 的重排路径），B 的消息归 B、A 的 continuation 消息归 A。不以"是否持有 lease"或当前 `_lastRunPromptIds` 推断迟到 continuation 归属；run 之外（`_currentRunOwners` 为空）追加的 assistant 消息不记录。`completed` 时为完整列表；`cancelled/failed` 时为已追加的部分。
- `traceGeneration`：该 prompt 持有 lease 期间每次 compaction（threshold 或 requested）完成后 +1，admission 时为 0；`bumpTraceGeneration` 在 compaction 完成回调处对当前 `_currentRunOwners` 调用，若回调位于 run 结束边界则使用为该 compaction 捕获的 owner 快照，逐 id 递增（主题 4 的 review coverage 将对比它）；本 change 只计数不消费。
- `sessionEpoch`：取 `_sessionInputArrivalEpoch`（`:1112`）在 admission 时刻的值。

### D6 持久化与恢复（压测分支 3）

- ledger 记录 `PromptSettlementRecord { promptId; status: "settling" | PromptOutcomeStatus; sessionEpoch; traceGeneration; finalMessageIds; cancelRequested; failureReason?; settleReason?; released; admittedAt; settledAt? }`——`failureReason` 仅 `failed` 记录携带并与 `outcome.failure.reason` 相同；`settleReason` 记录 `settleAll` 的 reason（如 `session_disposed`），不回流到 `PromptOutcome`，以 `appendCustomEntry("prime-agent.prompt-settlement", record)` 追加；同一 promptId 多条时以最后一条为准（admission 一条、终态/released 一条；中途不写）。
- 恢复（session 加载 / daemon worker 重启后 `AgentSession` 构造期，在任何 listener 订阅之前）：扫描 custom entries 重建 `restore(records)`；对 `status === "settling" && !released` 的记录立即 `settleAll("failed", "runtime_restarted")` 并追加终态 entry；此时没有订阅者，**不发出 `prompt_outcome` 事件**——重连客户端经 `get_prompt_outcome` 查询得到该终态；终态记录只读；released 记录保持 released。不重建 lease、timer、action。
- 旧 epoch 在途结果作废：重启后 action recovery 恢复的 action 若带旧 promptId，`_createPreparedTurnAction(..., { restore: true })` 路径不 inherit 旧 promptId，而是分配新 promptId——旧记录已 `failed`，不重开。
- 不持久化：Promise、lease、timer、transport request id。

### D7 wire 治理（压测分支 6/8）

- 新 `DaemonServerCapability`（同时加入 `DaemonClientCapability` 协商集）`"prompt_settlement"`；schema 16→17、protocol 7 不变。能力判断必须针对发起命令/接收事件的**原始 public client**，不能让 resident worker 从 supervisor 的固定 `worker_subscribe` client 猜测。
- supervisor 转发 `prompt`/`prompt_and_wait`/`wait_for_headless_completion` 时，在 private worker envelope 携带 `callerPromptSettlement: boolean`；直连 worker 从本地 socket client capability生成同一布尔值。public command wire不暴露该内部字段。worker据此决定响应 optional promptId 与 legacy idle；原 public client未声明 capability时响应形状/时序不变。
- worker始终在内部产生 `prompt_outcome`；直连 worker的 send path 与 supervisor 的 worker-frame fanout都必须在真正写给每个 public client前调用 capability-aware outbound filter。`DAEMON_OUTBOUND_COMPATIBILITY` 条目只是元数据，不能代替 send-path过滤；同一 worker上的 old/new clients分别看不到/看到事件。
- `get_prompt_outcome` 在 supervisor 和直连 worker的命令 admission处都按原 public client capability拒绝不支持者；兼容映射 `{ minProtocol: 7, minSchemaRevision: 17, capability: "prompt_settlement" }`。新命令返回 `{ outcome }`。
- `AgentConnection.promptAndSettle(...): Promise<PromptOutcome | undefined>`：in-process直通；daemon先订阅outcome，再以内部随机候选id发 `prompt_and_wait`。成功响应有id则等缓存/后续event，无id表示成功非turn。若旧 completion使命令返回failure，客户端先查缓存，再 `get_prompt_outcome(candidate)`：存在则这是accepted failed/cancelled turn，返回结构化outcome；不存在才按非turn/admission error reject。这样 `promptAndWait` failure语义不变且非turn失败不被吞。断线仍transport failure。
- RPC 模式继续用即时 `connection.prompt()`，通过 `AgentConnectionPromptOptions.settlementAdmission` 一次性回调获得 `{ supported: true; promptId?: string } | { supported: false }`；in-process 恒 supported，daemon 按 server capability 与 ACK 填充。RPC `prompt` 成功响应仅在 supported 时 additive 地带 `data: { promptSettlement: "supported"; promptId?: string }`，缺标记表示底层不支持而非合法非 turn。`RpcClient.promptAndWait` 不动；新 `promptAndSettle` 三路处理：supported+id 等 outcome，supported+无 id 返回 undefined，缺 supported 标记明确拒绝。旧 RPC client 忽略 additive data。
- 跨版本矩阵：new-client/old-daemon 缺 capability，AgentConnection 与 RPC `promptAndSettle` 均明确拒绝；`promptAndWait` 照旧。old-client/new-daemon 不声明 capability，看不到新 daemon 字段/事件/命令；旧 RPC client忽略新 rpc-mode 的 additive data。

### D8 模式入口（压测分支 4/7）

- `headless-completion.ts`：单参数签名不变；调用方先经 optional `promptAndSettle` 等完输入，函数内删除两次 global idle并让 internal gate continuation逐个等 outcome。legacy fallback 由命令发起方决定：supervisor 根据原 public client capability，在转发 `wait_for_headless_completion` 的 private envelope带 `callerPromptSettlement`；worker只在 false时先 `waitForIdle`。直连 worker按本地 client capability同样处理。public command与 AgentConnection签名不变；in-process新路径直接调用自由函数。**落地顺序**：组14/15迁移后再移动 legacy wait。
- `print-mode.ts`：逐条 optional promptAndSettle；completed/undefined才继续，failed/cancelled停止剩余messages并跳过gate。输出/退出仍读 transcript，command userspace不变；JSON仅turn有outcome。
- `acp-mode.ts`：optional outcome；completed/undefined才进gate，failed沿turnFailure抛错，cancelled返回cancelled，二者不进gate；仅定义outcome附meta，非turn省略。
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
- **owner 归属错误**：`"all"` batching 会让多个 prompt 共享一次 run；retry/compaction 若只挂一个 id 会使其余 prompt 提前结算，A 的 continuation 在 B 运行后才执行也可能串线。缓解：普通 dispatch 对所有去重后的 `_currentRunOwners` 逐 id 记账；retry 继承整组 `_lastRunPromptIds`；compaction continuation 在调度时捕获 owner/lease 组，执行时不回读可能已被后续 run 覆盖的 `_lastRunPromptIds`。seam 2 覆盖“两个 prompt 在 `"all"` 下共享 run”与“A 的 continuation 在 B 之后执行”。
- **JSONL 体积**：每 prompt 两条小 entry，可接受。
- **JSON 外部消费者 closed union**：定性 additive（压测分支 7），以文档承诺覆盖；无版本机制。
- **daemon 事件先于 ACK**：客户端先订阅后发送，已消除。

## Issue #26 implementation fixture

Fixture level: expanded（上游建议 compact；因本切片定义后续 session/wire 共用的公开状态机 API，且包含并发 lease、取消与终态顺序，按 mandatory expanded triggers 上调）
Repair intensity: high（共享状态机根；任一转移错误会污染后续 16 个切片）
Project profile: Prime Agent TypeScript monorepo (Generic-derived)

### Change surface and preservation boundary

- Change surface: 新增 `packages/coding-agent/src/core/prompt-settlement.ts` 与 `packages/coding-agent/test/prompt-settlement.test.ts`。
- Must preserve: 本切片无调用方，不改变现有 session、daemon、RPC、Print、ACP、TUI 行为或 `AgentMessageOutcome` 语义。
- Must add: D1 全部导出类型/API，以及 D2 的同步 settle-once、独立 lease 实例、terminal/released fence、snapshot/restore 行为；`PendingUserQuestion` 只定义未来 wire 占位，但必须保留 ask-user 原始问题形状：`toolCallId`、`question`、`options[{label,description?,preview?}]` 及可选 `multi`/`recommended`，不新增独立 option value/id。
- Seam under test: `PromptSettlementTracker` 公共 API，注入假时钟、`emit` 与 `persist`；这是最少且最高的确定性 seam，可直接观察每次原子转移。

### Risk packs considered

- Public API / CLI / script entry: selected - tracker 与 outcome 类型是后续模式的单一公共契约；本切片不接 CLI。
- Config / project setup: not selected - 无配置或工程设置变化。
- File IO / path safety / overwrite: not selected - `persist` 仅为注入回调，本切片不读写文件。
- Schema / columns / units / field names: selected - `PromptOutcome` 与 `PromptSettlementRecord` 字段及条件字段必须一次定型。
- Auth / permissions / secrets: not selected - 无授权或敏感数据边界。
- Concurrency / shared state / ordering: selected - 独立 lease 计数、先 acquire 后 release、同步 1→0 结算和 settle-once 是核心不变量。
- Resource limits / large input / discovery: not selected - 无发现、轮询、外部输入或无界资源操作。
- Legacy compatibility / examples: not selected - 新文件无调用方；现有 userspace 不变是边界条件。
- Error handling / rollback / partial outputs: selected - duplicate/unknown/terminal/released、cancel-over-failure 与原子 persist/emit 必须稳定。
- Release / packaging / dependency compatibility: not selected - 无依赖、构建或发布形状变化。
- Documentation / migration notes: not selected - 完整契约已在本 design/spec；运行时状态文档留给 #42。
- TUI focus/render lifecycle: not selected - 不触碰 TUI。
- Session/extension teardown lifecycle: selected - `settleAll(..., { released: true })` 必须一次性封口并保持 waiter 可读，实际 session dispose 挂线留给 #31。

### Required evidence

- `now=10; admit({promptId: P, sessionEpoch: 7})` -> persist 一条 `settling` record（`admittedAt=10`、`traceGeneration=0`、`finalMessageIds=[]`、`cancelRequested=false`、`released=false`），不 emit；随后 acquire、`recordFinalMessage(P, M)`、`bumpTraceGeneration(P)`、`now=20`、最后 lease release -> 再 persist 一条终态且 emit 一次同一 outcome：`{promptId:P,status:"completed",advisor:"disabled",sessionEpoch:7,traceGeneration:1,finalMessageIds:[M]}`，`settledAt=20`，无 `pendingQuestions`/`failure`/`failureReason`/`settleReason`；生命周期 persist=2、emit=1。
- 同 P 两个独立 `run` lease -> 释放第一个仍 `isSettling(P)===true` 且无 outcome；释放第二个才结算。run→retry→compaction 交接先取后放 -> 旧 lease 释放后仍 settling；先放旧 lease至 0 再 acquire -> 已同步 `completed` 且新 acquire 抛错，不存在隐式宽限。
- `recordFailure(P,"run_error")` 后 release -> failed，`outcome.failure.reason === record.failureReason === "run_error"` 且无 `settleReason`；先 failure 再 cancel -> cancelled，outcome 无 `failure` 且 record 无 `failureReason`；所有终态后 mutation/release lease 都不新增 persist/emit。
- `settleAll("failed","runtime_restarted")` -> 每个 eligible P 恰好追加一条 failed record并 emit一次，`failure.reason === failureReason === settleReason === "runtime_restarted"`；`settleAll("cancelled","session_disposed",{released:true})` -> 一条 `cancelled + released:true + settleReason` record与一次 emit，无 `failure`/`failureReason`，重复调用零副作用。
- `waitForOutcome(unknown)` -> reject；`outcome(unknown)` -> `undefined`；`isSettling` 对 unknown/terminal 为 false、active 为 true；duplicate admit -> throw且零新增 persist/emit。
- `snapshot()` -> 深复制 records/数组，修改 snapshot 不影响 tracker；`restore` 同 promptId 多条取最后一条，终态/released record只读且 `outcome` 与 `waitForOutcome` 返回同一缓存对象，不调用 persist/emit；恢复 active record 后可重新 acquire 并按 D2 结算。
- 三种 release API 不混淆：`PromptLease.release()` 只减少该 lease 实例并可能触发终态；`tracker.release(P)` 仅对已终态 record 设置 `released:true` 并追加一次 persist（active/unknown no-op，不 settle、不 emit，重复 no-op）；`settleAll(...,{released:true})` 对 active record在单次 persist/emit 中同时终态并置 released。
- `npx tsx ../../node_modules/vitest/dist/cli.js --run test/prompt-settlement.test.ts`（在 `packages/coding-agent`）与 `npm run check` 均退出 0。

### Invariant Matrix

- Governing invariant: 每个 admitted prompt 的全部独立 lease 在同步 1→0 边界只产生一个由 cancel、failure、completed 优先级确定的不可重开终态。
- Source-of-truth identity/contract: `promptId` 对应的单一内部 record、独立 lease 实例集合、terminal/released fences 与 D1 导出类型。
- Producers: `admit`、`restore`；未知或重复 identity 不得隐式创建/覆盖。
- Validators/preflight: `acquire`、所有 mutation/query 方法对 unknown、terminal、released 状态的分支。
- Storage/cache/query: tracker 内存 map、`snapshot` 深复制与 `restore` 最后一条记录恢复；本切片无 JSONL。
- Public routes/entrypoints: `PromptSettlementTracker` D1 公共方法与 `PromptLease.release()`。
- Frontend/downstream consumers: 本切片无运行时调用方；测试锁定后续 session/wire 将消费的单一类型与对象语义。
- Failure paths/rollback/stale state: duplicate admit、unknown wait/query、terminal acquire、重复 release/mutation、`settleAll` 与 released restore。
- Evidence/audit/readiness: tracker focused tests、TypeScript check、strict OpenSpec validation。
- Regression rows:
  - 同一 prompt 的多个同 kind/异 kind lease按任意非终态顺序释放 -> 最后一次 release 才按优先级恰好 settle 一次。
  - 旧 lease 先释放至 0 后再 acquire -> 已产生终态且 acquire 抛错，不允许重开或空窗宽限。
  - cancelled/failed settleAll 与 released restore -> 条件字段、settleReason、wait/query 对象及 persist/emit 次数保持契约。
  - 现有 session/daemon/RPC/TUI 消费者 -> 本切片无接线，行为与编译保持不变。

### Boundary-surface checklist

- Shared helper root: 新 tracker 由单一实现与单一测试套件拥有，不复制状态枚举。
- Public entrypoints: 仅 D1 导出 API；不接入现有模式。
- Read/write/stale-state boundaries: query/snapshot 与 mutation/restore/terminal fences 全部列入 regression rows。
- File publish/rollback and external evidence boundaries: 无，本切片只调用注入的同步 callbacks。
- Unchanged downstream consumers: `AgentSession`、daemon/RPC、Print/ACP/TUI 不修改。

### Non-goals for #26

- 不修改 `agent-session.ts`，不做 JSONL persist 实现，不接 daemon/RPC/mode，不生产 `needs_user_input` 或 `unresolved_advisor`。
- lineage spec 的 abort保留/清空队列、pre-admission拒绝、终态owner拒绝inherit 等 session 场景由 #27/#31 覆盖；#26 只覆盖能直接通过 tracker API 构造的终态推导、lease交接、record形状、released fence与恢复行为，不为满足“settle-once全部scenario”越界伪造 session 测试。

## Issue #27 implementation fixture

Fixture level: expanded（上游建议 compact；本切片首次修改共享 `AgentSession` 公共 API/event、action store schema和 admission/queue/cancellation 状态转换，命中 public API、schema 与 concurrency mandatory expanded triggers）
Repair intensity: high（一个 admission/release 顺序错误会制造永久 settling、错误终态或重复 outcome，并污染后续全部 runtime/mode/wire 切片）
Project profile: Prime Agent TypeScript monorepo (Generic-derived)

### Change surface and preservation boundary

- Change surface: `packages/coding-agent/src/core/agent-session.ts`、`session-action-store.ts`、必要的单一类型 re-export、新 `test/suite/agent-session-prompt-settlement.test.ts`，以及两个既有 identity-forward adapter 的临时过滤边界（`in-process-agent-connection.ts` 与 `daemon-extension-binding.ts`）；不修改 tracker 状态机。
- Must preserve: `prompt`、`promptUntilAccepted`、`promptAndWait`、`AgentMessageOutcome`、action delivery/completion、queue visibility、retry-chain completion、existing session event consumers 与 action recovery snapshot的现有语义。
- Must add: accepted turn在 enqueue前绑定稳定 id + run lease；action完成/错误/实际移除释放其自身 lease；session optional-outcome API/query/event；`"all"` batching owner并集。
- Staged boundary: 本切片只挂 main run lease。retry 与 compaction continuation leases（组3/4）、autonomous inherit producer（组5）、主动 `requestAbort` ownership 清理与 dispose 原子 released fence（组6）、message ids（组7）、ledger（组8）及 AgentConnection API/wire capability（组10+）不提前实现。组2必须把 provider 已返回的 `aborted` 终态判为 cancelled，避免临时生产错误的 completed outcome；只在两个无 capability 的 adapter 入口丢弃 session-only event，不扩 `AgentConnectionSessionEvent`、daemon schema或外部输出。
- Seam under test: in-process `AgentSession` + `test/suite/harness.ts` faux provider；另以既有 fake connection与 daemon binding callback seam证明 session直接订阅可见而 adapter不可见。tracker seam已由组1覆盖；真实process/RPC/JSON/ACP/TUI不消费本事件。

### Admission and ownership contract

- `SessionAction` 的 serializable/recovery payload不存 settlement identity或live lease。turn action runtime字段保存候选/accepted `promptIds` 与等长 `runLeases`；session command无这些字段。`getSessionActionRecoverySnapshot()`继续只保存现有action/delivery payload，不复制promptIds、Promise、closure或lease；`restoreSessionActions()`对普通turn生成新的default id，对 primary record 为 heartbeat/RLM notice 的稳定 customType重新派生 runtime-only background exclusion（prefix/next-turn context不得改变primary owner语义），old-ledger lineage recovery留组9。
- `_createPreparedTurnAction` 只准备 candidate id或私有 `{inherit: owners}`，不调用 tracker；明确排除的 background turn连 candidate也不生成。该私有lineage option是组2的可测seam；现有public/internal prompt callers都走default，组5才把autonomous continuation producer接到inherit。
- `_admitSessionInput` 顺序固定：disposing/pump fence → coalesce → `ActionStore.assertCanEnqueue(action)`纯检查action lifecycle/duplicate ticket且不写store → duplicate候选/全部inherit owner检查 → default同步persist-first `admit({sessionEpoch})`+fresh identity `acquire("run")`，或inherit逐一acquire → 写入action →已preflight的no-throw enqueue安装数组/ticket → accepted callback（try/catch observer isolation）→ arrival epoch递增/wake。
- Default admission的post-admit failure被设计为不可达：#27 deps固定`now:Date.now`、`persist:()=>{}`，fresh identity在admit成功后`acquire("run")`不能unknown/terminal/busy；enqueue的所有显式throw条件已由同一store的pure preflight证明，随后同步安装不调用外部callback。若实现无法保持该结构，必须改为单id `requestCancel`+释放本actionlease并reject；禁止用global `settleAll`或留下settling。测试以red-capable monkeypatch/preflight regression证明duplicate action在admit前reject，而非要求生产注入persist spy。
- Inherit admission为all-or-nothing：先校验owner非空/去重且全部`isSettling`，再逐一acquire；任何owner unknown/terminal/busy或任一acquire失败时，按逆序释放本action本次已取得的sibling leases，整个action不入队；不得`requestCancel` owner，也不得释放parent action已有同-kind lease。fixture测试通过私有create/admit seam构造parent+inherit，无需提前接组5 producer。
- Action completion/cancel helper按object identity且仅一次消费其`runLeases`，消费前把数组从action取走并清空，防止release触发reentry、pump finally、cancel capture与重复queue操作二次释放。本次run最终 assistant `stopReason` 为 `error` 时先对owners记录`run_error`、为`aborted`时先置cancel fence；pump failure同样先记录`run_error`。default actual removal先`requestCancel`；inherit非-abort removal不cancel。每批开始清空terminal signal，禁止上一失败污染下一成功；第二次clear/mutate/finally必须零额外event/outcome。
- `"all"` batch只汇总本次active turn actions的`promptIds`到组2新建的`_lastRunPromptIds`/`_currentRunOwners` snapshots，不合并identity，不再acquire。每个action仍独立持有自己的run lease，batch共享`agent.prompt`完成后逐action释放。组7不再“新增”owner fields，而是消费它们记录message ids；组2不调用`recordFinalMessage`，所有outcome的`finalMessageIds=[]`。

### Session API and callback truth table

- `PromptOptions.promptId` 是候选，只在本次 accepted turn admission时占用；non-turn成功不占用，可由后续调用复用。重复候选turn reject `DuplicatePromptAdmissionError`，且无新event/record/action。
- 一次性 `settlementAdmission` callback只由本次 `_prompt` 调用触发一次：accepted turn `{supported:true,promptId}`；成功 session/extension/handled `{supported:true}`；pre-admission或non-turn completion失败不虚报accepted id。callback本身若抛必须按observer隔离，不回滚已accepted action或串到其他调用。
- `promptAndSettle` 必须用闭包捕获本次callback，而非查询“最新record”或共享可变field。若捕获id，无论 legacy completion resolve/reject，最终返回 tracker cached outcome；若无id，成功 non-turn返回 `undefined`，失败沿原错误reject。调用方提供的 `agentMessageId` 若已被任一unfinished action或completion waiter占用，必须在创建本次deferred前拒绝，不能同key coalesce到旧action后伪装成successful non-turn。
- `prompt_outcome` 在tracker terminal emit的同一同步段经 `_emit`广播；`getPromptOutcome`/`waitForPromptOutcome`返回同一cached object。事件只加入 `AgentSessionEvent`：AgentSession直接订阅可见；组10+接能力前，in-process main/watcher与daemon binding在identity-forward前丢弃，JSON/RPC/daemon/ACP/TUI不可见且`AgentConnectionSessionEvent`不扩union。公共d.ts必须从唯一 `prompt-settlement.ts` 类型源引用/导出 `PromptOutcome`，不得复制shape。

### Risk packs considered

- Public API / CLI / script entry: selected - 新增 `AgentSession.promptAndSettle`、query/wait与event；CLI/modes保持不变。
- Config / project setup: not selected - 无配置变化。
- File IO / path safety / overwrite: not selected - persist仍no-op，不读写JSONL。
- Schema / columns / units / field names: selected - action owner/lease字段、PromptOptions callback与session event shape必须单一来源。
- Auth / permissions / secrets: not selected - 无授权边界。
- Concurrency / shared state / ordering: selected - admission-before-enqueue、all-or-nothing inherit、`"all"` batching、completion/cancel双触发与并发callbacks。
- Resource limits / large input / discovery: not selected - 无外部发现/大输入；owner数组按当前batch有界。
- Legacy compatibility / examples: selected - public prompt/promptAndWait/action queue/recovery/event consumers不得改变。
- Error handling / rollback / partial outputs: selected - admit/acquire/enqueue/observer失败与实际queue removal必须无0-lease或重复release。
- Release / packaging / dependency compatibility: selected - exported session declarations必须能引用唯一 PromptOutcome类型；无依赖变化。
- Documentation / migration notes: not selected -运行时状态文档统一在组17更新。
- TUI focus/render lifecycle: not selected - TUI不消费settlement，本切片不触碰。
- Session/extension teardown lifecycle: selected - accepted queued cancellation、disposing拒绝与background exclusion；dispose本身明确留组6。

### Required evidence

- idle turn + faux `stop` -> callback捕获非空id，action在queued/selected观察点已有一条run lease且tracker query为settling；`promptAndSettle` resolve completed，query/wait/event使用同一outcome对象，`finalMessageIds=[]`，event恰一次；legacy `prompt`/`promptAndWait`时序不变。session级测试不窥探private persist计数。
- retry disabled + faux terminal error -> owner先记录`run_error`再一次消费lease，`promptAndSettle` resolve failed outcome而不透传completion错误；注入pump throw -> 同样failed/run_error且event一次；随后finally或二次cancel不产生第二outcome。
- 两个独立accepted prompts（第二个排队）-> 各在enqueue前有独立id/lease，各只产生一次outcome；A完成不terminal B。`"all"` 两个actions共享一次run -> mid-run只读inspection证明`_lastRunPromptIds`/`_currentRunOwners`恰为本batch action promptIds去重并集；运行结束前两者均settling，结束后各completed一次，finalMessageIds仍为空。
- gated同步tool -> tool pending时无outcome；tool完成且后续turn结束后completed。run中steer/followUp -> 新identity，不改当前owner；后续若batch为all仍各有独立outcome。
- 私有inherit seam：parent已有run lease时给同owner创建inherit action -> 同kind lease实例数增加，取消inherit只release其lease且parent仍settling；多owner中第二个acquire失败 -> 已取得sibling lease回滚，parents lease与cancel flag不变、action未入store；unknown/terminal/busy owner ->整action不入队且不抛穿pump。
- session command、成功extension、handled +候选P -> 每条成功输入的settlementAdmission恰调用一次`{supported:true}`且无promptId，返回undefined、零settlement event，P仍可被下一accepted turn使用；non-turn失败仍原错误reject且不虚报accepted id。
- accepted queued default action经clearQueue与mutate delete实际移除 -> cancellation先于stored lease release，得到cancelled且无active record；第二次clear/mutate/pump finally零额外event；普通requestAbort未移除的可见queued action不在本组错误cancel。
- disposing、coalesce、duplicate action/candidate id -> enqueue前reject，query(candidate)仍undefined且零event/action；duplicate action preflight在tracker admission前。并发promptAndSettle callbacks只收到本次id；callback throw不影响accepted action。
- recovery snapshot包含原action/delivery payload但无promptIds/runLeases；`restoreSessionActions()`不经public callback，测试以新session的只读action-store inspection取得restored action的fresh promptId，随后query/event只出现该新id，旧settlement id不被继承或查询到。
- representative heartbeat或pending auto-refine与A无owned-work关系 -> A main run lease释放即outcome，不等待global idle/background completion。
- targeted command: 新AgentSession settlement suite +现有 prompt queue/promptAndWait/recovery回归文件；`npm run check`、coding-agent build、strict OpenSpec validation均exit 0。

### Invariant Matrix

- Governing invariant: 每个accepted turn在可见enqueue前恰有一个稳定prompt identity和至少一个action-owned run lease；只有该action的完成、失败或实际移除才能消费该lease，最后owner lease释放时恰产生一个不串call/batch的终态。
- Source-of-truth identity/contract: action runtime `promptIds[i] ↔ runLeases[i]`、tracker Map identity、per-call settlement callback closure与cached PromptOutcome。
- Producers: `_createPreparedTurnAction`候选、`_admitSessionInput` accepted分支、future inherit lineage；non-turn不得成为producer。
- Validators/preflight: disposing/pump fence、coalesce、duplicate action id、duplicate/terminal owner与all-or-nothing inherit验证，全部在enqueue前。
- Storage/cache/query: ActionStore runtime action + tracker in-memory Map；recovery snapshot不得序列化live lease；本组persist no-op。
- Public routes/entrypoints: prompt family、steer/followUp、`promptAndSettle`、query/wait、session subscribe event。
- Frontend/downstream consumers: existing promptAndWait/event/action-store callers unchanged；AgentConnection API/daemon capability/RPC/modes消费仍deferred，现有in-process/daemon adapter只增加session-only event过滤以保持外部行为不变。
- Failure paths/rollback/stale state: preflight-before-admit、inherit sibling acquire rollback、terminal provider error/aborted、pump throw、double completion/cancel、clear/mutate delete、callback throw、completion-id占用、terminal inherit owner、background primary restore与普通primary+background prefix恢复。
- Evidence/audit/readiness: faux-provider session suite、必要的只读action-store inspection、existing queue/recovery regressions、root check/build、strict OpenSpec。
- Regression rows:
  - accepted single/batched/tool-blocked turn -> lease spans queued+run+sync tool；mid-run owner snapshots等于batch去重owners；settles each owner once且group2 finalMessageIds为空。
  - pre-admission reject or successful non-turn -> no identity/lease/event; candidate remains reusable when no turn was accepted.
  - inherit multi-owner partial failure -> only本action新acquired siblings逆序释放，parent lease/cancel不变且action不入队。
  - actual queued removal/pump throw -> default cancelled或failed后consume once；repeated removal/finally no extra outcome。
  - recovery snapshot/restore -> snapshot不含live identity/lease；普通turn生成fresh id，background primary仍无identity，background prefix不改变普通primary identity。
  - callback reentry/parallel submissions/completion-id collision -> each callback sees only its own admission，occupied id在新deferred前reject，observer failure不能污染lifecycle。
  - direct AgentSession subscribe vs identity-forward adapters -> direct看见一个outcome；in-process main/watcher与daemon broadcast丢弃，外部union/wire不变。
  - unchanged prompt/promptUntilAccepted/promptAndWait/recovery/event consumers -> prior timing and errors remain stable.

### Boundary-surface checklist

- Shared helper roots: action construct/admit/batch/terminal/cancel helpers and `PromptSettlementTracker`; no duplicated state machine.
- Public entrypoints: AgentSession prompt family/query/event；mode adapter只做兼容过滤，无 AgentConnection API或daemon public wire扩展。
- Read/write/overwrite: in-memory action+tracker only; no JSONL/file overwrite.
- Stale/idempotency: consumed lease arrays emptied once；每批terminal signal清零；terminal owner inherit rejected；partial inherit acquire只回滚新sibling leases；duplicate candidate/completion id不重开；recovery不复制identity/lease且只由primary稳定customType派生background marker。
- Producer/consumer evidence: callback/event/query bind to same promptId/outcome object；action-store inspection仅证明accepted-before-enqueue ownership，不作为tracker persist oracle。
- Unchanged downstream consumers: promptAndWait、session-action recovery和外部AgentConnection/JSON/RPC/daemon/ACP/TUI事件流保持source/runtime兼容。

### Non-goals for #27

- 不实现retry/compaction/autonomous producer leases、主动in-flight abort ownership清理、dispose released fence、finalMessageIds、ledger/restart、AgentConnection API/daemon capability/RPC/Print/ACP/TUI接线；两个adapter过滤只阻止session-only event提前泄漏。
- lineage spec 的 `requestAbort` inherited-work清理、abortAndClearQueue当前run与dispose场景分别由组6处理；本组只处理实际从action store移除的accepted queued action，并把provider最终已返回的`aborted` run正确推导为cancelled。
