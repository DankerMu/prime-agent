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
| provider retry 窗口 | 同步 `agent_end` pre-arm与`_handleRetryableError` defensive fallback共用一个idempotent helper：首次建立window时捕获当下 `_lastRunPromptIds` 去重快照，对每个owner all-or-nothing取一份 `"retry"` lease，全部成功后才发布Promise/resolve/lease state | 唯一 `_resolveRetry` 漏斗先detach Promise/resolve/captured leases，再逐实例release并resolve原waiters；成功、耗尽、禁用、sleep cancel、overflow/compaction结束与abort均复用 | retry属于该共享run的全部prompt owner；同一chain多个error `agent_end`不重复acquire；snapshot随后变化不串owner；background/no-owner window允许零lease；先全部acquire再允许旧run lease释放 |
| post-compaction continuation | successful threshold/requested compaction或requested/overflow恢复路径确认需要后续run时，以当次run owner快照建立/扩展一个runtime continuation window：对missing owner all-or-nothing取独立`"compaction_continuation"` lease；同一真实obligation复用tuple，internal rearm不得读新owner | 单一close先detach timer/window/owner/lease state，再逐实例release；真实取消、确认无work、terminal结束/throw走close；busy/pump/already-processing与manual park/resume只rearm/转移同一tuple不release | schedule时旧run/retry ownership仍在，禁止0-lease空窗。runner在`agent.continue()`前临时安装captured owners到`_lastRunPromptIds`供group3 retry继承，等待continue+retry+event queue后按最终stopReason fence。overlapping真实compaction obligation原子扩展missing owners；非abort取消只release不`requestCancel` |
| autonomous threshold continuation（session 内部入队） | `_queueAutonomousContinuationForThresholdCompaction` 创建 action 时标 `lineage: { inherit: promptIds }`，其中 promptIds 是触发它的共享 run owner 快照；后续按"主 run"行逐 owner 挂 lease | 同主 run | 一个 continuation action 可以继承多个 promptId，但只执行一次；不得为每个 owner 重复入队同一 continuation，也不得任意选择一个 owner |

- **promptId admission**：turn action新增非空 `promptIds` 与同长度/owner对应的 `runLeases`。公共 action单 owner，内部 inherit可多 owner。`_createPreparedTurnAction` 只准备候选/lineage；`_admitSessionInput` 通过所有 pre-admission检查后、enqueue前：default先 admit再 acquire一个 run lease，inherit校验每个 owner仍 settling并逐 owner acquire（同 kind实例允许并存）；任一 owner已终态则放弃整个 inherit action且不入队。host internalPrompt总是新的单 owner；session command无这些字段。
- **共享 run owners**：当前 pump 在 `steeringMode`/`followUpMode === "all"` 时会把多个 turn action 合并为一次 `agent.prompt(preparedMessages)`，因此 owner 不能用单数表示。session 在调用 `agent.prompt` 前把本次所有 turn action 的 promptIds 去重为 `_lastRunPromptIds: string[]`，同时设置 `_currentRunOwners`；retry 对 `_lastRunPromptIds`、compaction continuation 对调度时捕获的 owner 快照逐 id 调用现有 tracker API。tracker 仍按单个 promptId 记账，不新增集合类型、不合并 promptId，也不改变 `"all"` batching userspace。A 的 continuation 被 B 重排时继续使用 A 的captured owner/lease tuple；runner调用`agent.continue()`前临时把A owners安装到`_lastRunPromptIds`，使continuation内group3 retry继承A而不是B或zero-owner，结束后恢复此前snapshot。消息归属仍由组7使用 `_currentRunOwners`（D5）。
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
- `traceGeneration`：该 prompt 持有 lease 期间每次successful threshold/requested compaction完成后 +1，admission时为0；manual与overflow compaction不计入该prompt trace generation。组4在compaction成功边界使用为该compaction捕获的owner snapshot逐id `bumpTraceGeneration`（不能读取已被后续run覆盖的 `_currentRunOwners`/`_lastRunPromptIds`）；continuation run再次成功threshold/requested compaction则同一owners再+1。组7复用同一snapshot记录message ids；本change只计数不消费。
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

- `SessionAction` 的 serializable/recovery payload不存 settlement identity或live lease。turn action runtime字段保存候选/accepted `promptIds` 与等长 `runLeases`；session command无这些字段。`getSessionActionRecoverySnapshot()`继续只保存现有action/delivery payload，不复制promptIds、Promise、closure或lease；`restoreSessionActions()`对普通turn生成新的default id，并将历史snapshot的`completionIncludesRetryChain`归一为`true`，保证fresh identity的main-run lease覆盖retry；对primary为heartbeat/RLM notice的settlement-excluded turn仅重派生runtime marker并保留历史timing flag（prefix/next-turn不得改变primary owner语义）。old-ledger lineage recovery留组9，wire/parser/formatVersion不变。
- `_createPreparedTurnAction` 只准备 candidate id或私有 `{inherit: owners}`，不调用 tracker；它以实际 primary message 为唯一分类源：primary customType 为 heartbeat/RLM notice 或 caller显式 staging exclusion时不生成 candidate并标记 runtime-only background exclusion，prefix/next-turn不得改变该分类。所有 prompt/custom/replay callers共享此policy，`restoreSessionActions()`的primary-only重派生仅是wire backstop。该私有lineage option是组2的可测seam；普通public/internal prompt callers走default，组5才把autonomous continuation producer接到inherit。
- `_admitSessionInput` 顺序固定：disposing/pump fence → coalesce → `ActionStore.assertCanEnqueue(action)`纯检查action lifecycle/duplicate ticket且不写store → duplicate候选/全部inherit owner检查 → default同步persist-first `admit({sessionEpoch})`+fresh identity `acquire("run")`，或inherit逐一acquire → 写入action →已preflight的no-throw enqueue安装数组/ticket → accepted callback（try/catch observer isolation）→ arrival epoch递增/wake。
- Default admission的post-admit failure被设计为不可达：#27 deps固定`now:Date.now`、`persist:()=>{}`，fresh identity在admit成功后`acquire("run")`不能unknown/terminal/busy；enqueue的所有显式throw条件已由同一store的pure preflight证明，随后同步安装不调用外部callback。若实现无法保持该结构，必须改为单id `requestCancel`+释放本actionlease并reject；禁止用global `settleAll`或留下settling。测试以red-capable monkeypatch/preflight regression证明duplicate action在admit前reject，而非要求生产注入persist spy。
- Inherit admission为all-or-nothing：先校验owner非空/去重且全部`isSettling`，再逐一acquire；任何owner unknown/terminal/busy或任一acquire失败时，按逆序释放本action本次已取得的sibling leases，整个action不入队；不得`requestCancel` owner，也不得释放parent action已有同-kind lease。fixture测试通过私有create/admit seam构造parent+inherit，无需提前接组5 producer。
- Action completion/cancel helper按object identity且仅一次消费其`runLeases`，消费前把数组从action取走并清空，防止release触发reentry、pump finally、cancel capture与重复queue操作二次释放。所有identity-bearing `TurnExecutionPolicy` 都必须先等待该main run现有retry chain结束，再读取最终 assistant `stopReason`：`error`先对owners记录`run_error`、`aborted`先置cancel fence；pump failure同样先记录`run_error`。此处只延长组2 run lease，不提前创建组3 retry lease。default actual removal先`requestCancel`；inherit非-abort removal不cancel。每批开始清空terminal signal，禁止上一失败污染下一成功；deferred rollback保持非terminal lease；第二次clear/mutate/finally必须零额外event/outcome。
- `"all"` batch只汇总本次active turn actions的`promptIds`到组2新建的`_lastRunPromptIds`/`_currentRunOwners` snapshots，不合并identity，不再acquire。每个action仍独立持有自己的run lease，batch共享`agent.prompt`完成后逐action释放。组7不再“新增”owner fields，而是消费它们记录message ids；组2不调用`recordFinalMessage`，所有outcome的`finalMessageIds=[]`。

### Session API and callback truth table

- `PromptOptions.promptId` 是候选，只在本次 accepted turn admission时占用；non-turn成功不占用，可由后续调用复用。重复候选turn reject `DuplicatePromptAdmissionError`，且无新event/record/action。
- 一次性 `settlementAdmission` callback只由本次 `_prompt` 调用触发一次：accepted identity-bearing turn在enqueue后立即 `{supported:true,promptId}`；成功 session/extension/handled或成功完成的settlement-excluded background turn在其legacy completion后 `{supported:true}`。pre-admission、non-turn completion失败或background turn pump failure不虚报accepted id/no-id。callback本身若抛必须按observer隔离，不回滚/泄漏action或串到其他调用。
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
- representative heartbeat或pending auto-refine与A无owned-work关系 -> A main run lease释放即outcome，不等待global idle/background completion。heartbeat/RLM primary无论经promptHeartbeat、restore followUp/steer、sendCustomMessage或 `_prompt` customMessage进入都无candidate/lease/outcome；成功 `_prompt` background callback恰一次no-id，pump failure零callback；普通custom与user-primary+background-prefix仍拿default identity。
- identity-bearing customTrigger + retry enabled error→stop -> 两个agent_end之间仍持run lease、无early failed，最终一个completed；retry disabled terminal error仍一个failed/run_error。普通requestAbort保留visible queued B的identity/lease/no outcome，实际clear才cancelled；真实deferred preparation rollback保持同id/lease/no outcome，resume后一个completed。
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
  - recovery snapshot/restore -> snapshot不含live identity/lease；普通turn生成fresh id且历史false retry flag归一为true，background primary仍无identity并保留历史timing，background prefix不改变普通primary identity。
  - callback reentry/parallel submissions/completion-id collision -> each callback sees only its own admission，occupied id在新deferred前reject，observer failure不能污染lifecycle。
  - direct AgentSession subscribe vs identity-forward adapters -> direct看见一个outcome；in-process main/watcher与daemon broadcast丢弃，外部union/wire不变。
  - unchanged prompt/promptUntilAccepted/promptAndWait/recovery/event consumers -> prior timing and errors remain stable.

### Boundary-surface checklist

- Shared helper roots: action construct/admit/batch/terminal/cancel helpers and `PromptSettlementTracker`; no duplicated state machine.
- Public entrypoints: AgentSession prompt family/query/event；mode adapter只做兼容过滤，无 AgentConnection API或daemon public wire扩展。
- Read/write/overwrite: in-memory action+tracker only; no JSONL/file overwrite.
- Stale/idempotency: consumed lease arrays emptied once；每批terminal signal清零；terminal owner inherit rejected；partial inherit acquire只回滚新sibling leases；duplicate candidate/completion id不重开；recovery不复制identity/lease、只由primary稳定customType派生background marker，并为所有fresh identity归一历史retry-wait policy。
- Producer/consumer evidence: callback/event/query bind to same promptId/outcome object；action-store inspection仅证明accepted-before-enqueue ownership，不作为tracker persist oracle。
- Unchanged downstream consumers: promptAndWait、session-action recovery和外部AgentConnection/JSON/RPC/daemon/ACP/TUI事件流保持source/runtime兼容。

### Non-goals for #27

- 不实现retry/compaction/autonomous producer leases、主动in-flight abort ownership清理、dispose released fence、finalMessageIds、ledger/restart、AgentConnection API/daemon capability/RPC/Print/ACP/TUI接线；两个adapter过滤只阻止session-only event提前泄漏。
- lineage spec 的 `requestAbort` inherited-work清理、abortAndClearQueue当前run与dispose场景分别由组6处理；本组只处理实际从action store移除的accepted queued action，并把provider最终已返回的`aborted` run正确推导为cancelled。

## Issue #28 implementation fixture

Fixture level: expanded（上游建议compact；本切片直接修改retry与共享state-transition生命周期，命中mandatory expanded trigger）
Repair intensity: high（retry lease与run lease的同步交接是settle-once临界区；漏owner、重复acquire或漏release分别导致提前终态或永久settling）
Project profile: Prime Agent TypeScript monorepo (Generic-derived)

### Change surface and preservation boundary

- Change surface: `packages/coding-agent/src/core/agent-session.ts` 的同步`agent_end` retry pre-arm、`_handleRetryableError` defensive fallback、`_resolveRetry`唯一结束漏斗，以及focused settlement/retry harness测试；tracker API不变。
- Must preserve: retry eligibility/auth stale判定、attempt/backoff、`auto_retry_start/end`顺序与字段、AgentMessageOutcome/prompt timing、accepted agent-message queue semantics、overflow-compaction retry continuation、background exclusion与group-2 outcome classification。
- Must add: 一个retry window捕获建立时的去重owner snapshot并为每owner持有一份独立`retry` lease；所有结束路径detach/release一次；同window多个error不重复acquire；snapshot变化不串owner。
- Staged boundary: compaction continuation lease/traceGeneration（#29）、autonomous inherit（#30）、active abort/dispose终态语义（#31）、message ids（#32）与persistence/wire/modes（#33+）不实现。`abortRetry()`在本组只关闭当前retry window并释放其retry leases；它是否对prompt置cancel fence由#31决定。
- Seam under test: in-process AgentSession + faux provider；测试可spy tracker `acquire`及captured `PromptLease.release`，并从action/runtime只读观察owner/outcome。只看最终outcome不足以证明本组实现，因为group-2 run lease已覆盖retry chain。

### Retry-window ownership contract

- 建立helper必须idempotent：已有`_retryPromise`时不读新owner、不acquire；首次建立时复制`_lastRunPromptIds`去重数组。零owner合法（background或defensive路径），仍建立原retry Promise以保持legacy timing。
- Owner acquire为all-or-nothing：按captured顺序取得`retry` leases；任一失败只逆序release本次已取得siblings，且不得发布新的Promise/resolve/lease字段或触碰action run leases。正常identity-bearing owner在group-2 run lease仍存在时可稳定acquire；异常失败不得留下半开window。
- Promise、resolve、captured owner/lease属于同一个runtime-only window，不进入recovery snapshot。`_lastRunPromptIds`之后可被清空/覆盖；resolve严禁回读它。
- `_resolveRetry`是唯一close helper：先把Promise/resolve/owners/leases从session字段detach并清空，再release每个captured lease，最后resolve已捕获waiter并schedule pump。detach-first保证lease最后释放触发同步outcome/event/reentry时，重复abort/resolve看见empty window且不二次release。若legacy waiter ordering要求先resolve Promise，必须用测试证明不会允许pump/settlement观察未释放retry lease；默认采用release-before-resolve。
- retry成功、耗尽、disabled/fallback、无last assistant、sleep cancel、overflow/compaction terminal、cancelled dispatch与`abortRetry`均继续调用该close helper；不得新增旁路release。一个chain的多个`agent_end`只持一组leases，最终一次close全部释放。

### Risk packs considered

- Public API / CLI / script entry: not selected - 无签名、CLI、AgentConnection或wire变化。
- Config / project setup: not selected - retry配置shape/default不变。
- File IO / path safety / overwrite: not selected - 无文件或JSONL操作。
- Schema / columns / units / field names: not selected - tracker/outcome/action recovery schema不变；仅新增private runtime fields/helper。
- Auth / permissions / secrets: not selected - 不新增权限/secret；既有provider auth retry判定必须回归。
- Concurrency / shared state / ordering: selected - 两处window建立、multi-owner all-or-nothing acquire、唯一detach-first close与run→retry无空窗是核心。
- Resource limits / large input / discovery: not selected - owner数受当前batch限制；不新增polling或外部发现。
- Legacy compatibility / examples: selected - retry attempt/event/backoff、prompt timing、auth/overflow/accepted-message与background路径必须不变。
- Error handling / rollback / partial outputs: selected - partial owner acquire、exhaustion、sleep cancel、abort、重复close都必须无leak/双release。
- Release / packaging / dependency compatibility: not selected - 无public export或dependency变化。
- Documentation / migration notes: not selected - shared runtime status文档由#42统一更新；本fixture记录staged状态。
- TUI focus/render lifecycle: not selected - 不触碰TUI。
- Session/extension teardown lifecycle: selected - `abortRetry`和cancelled dispatch会关闭window；prompt cancel/dispose终态留#31。

### Required evidence

- single owner error→success：spy证明首个`agent_end`同步建立一次`acquire(owner,"retry")`，第二个`agent_end`前lease未release且outcome absent；最终release一次、两个`agent_end`、一个completed同promptId。
- `"all"` A/B error→success：首次window为exact dedup owners各acquire一次；中途两owner均settling且无outcome；最终每owner各completed一次。将`_lastRunPromptIds`在window建立后改写/清空不得改变captured release targets。
- 连续error→error→success：同window内每owner`acquire("retry")`仍恰一次，三次`agent_end`后release一次与一个completed。
- max retries exhausted：window最终detach/release每owner一次，run最终failure fence后各failed/run_error；zero retry lease residue、重复`abortRetry`/resolve无额外release/event。
- defensive fallback：直接在无pre-arm Promise但有稳定owner snapshot的`_handleRetryableError` seam建立相同window/leases；partial second-owner acquire failure回滚第一lease且不发布window。
- cancellation/unchanged siblings：retry sleep时`abortRetry`只关闭window并release一次；existing auth-stale、overflow-compaction、accepted-agent-message、retry-disabled和event-order tests保持原结果。prompt cancel fence语义不在本组断言。
- focused commands: settlement group3 tests + `agent-session-retry-events.test.ts` + auth regression `4491-provider-stale-after-401.test.ts`，再跑受影响session siblings、root check/build、strict OpenSpec。

### Invariant Matrix

- Governing invariant: 每个active retry window对建立时全部identity-bearing run owners各持有且仅持有一份counted retry lease，先于旧owned-work release获取，并在任一window结束路径exactly-once释放后才允许settlement继续。
- Source-of-truth identity/contract: private retry-window tuple `{ promise, resolve, capturedPromptIds, leases }`，其中`capturedPromptIds[i] ↔ leases[i]`；owner来源是建立时`_lastRunPromptIds`快照。
- Producers: synchronous `_createRetryPromiseForAgentEnd` pre-arm和`_handleRetryableError` defensive fallback共享create helper。
- Validators/preflight: existing-window idempotency、owner dedup/settling acquire、multi-owner all-or-nothing rollback；零owner合法。
- Storage/cache/query: runtime-only session fields；action recovery、tracker record/persist与wire均不变。
- Public routes/entrypoints: prompt family与sendCustomMessage只间接触发；无新public API。
- Frontend/downstream consumers: retry events、TUI/extension listeners、AgentMessageOutcome、queue pump、auth stale与overflow compaction保持兼容。
- Failure paths/rollback/stale state: partial acquire、multiple errors、exhaustion、disabled/no-message、sleep cancel、abortRetry、cancelled dispatch、compaction结束、duplicate close与stale `_lastRunPromptIds`。
- Evidence/audit/readiness: direct acquire/release spies + faux-provider outcomes/events + existing retry/auth/compaction suites + check/build/OpenSpec。
- Regression rows:
  - single/multi-owner retry success -> exact owner leases established once, no early outcome, exact release, one completed per identity。
  - repeated error then exhaustion/abort -> no duplicate acquire/release, final failed or existing abort semantics, no lease residue。
  - partial owner acquire failure -> rollback only newly acquired siblings, no half-open retry tuple or owner cancellation。
  - owner snapshot changes after create -> releases original captured leases only, no cross-run ownership。
  - no-owner background/defensive retry -> legacy retry Promise/events continue with zero settlement lease/outcome。
  - unchanged auth/overflow/accepted-message consumers -> prior event, attempt, queue and continuation behavior unchanged。

### Boundary-surface checklist

- Shared helper roots: retry-window create/close plus tracker acquire/release; one implementation, no per-caller lease logic。
- Public entrypoints: unchanged；prompt/sendCustomMessage behavior only gains internal lease accounting。
- Staging/rollback: all-or-nothing owner acquire before publishing tuple；detach-first close before callback/reentry。
- Producer/consumer evidence: tests directly observe acquire/release and outcomes；not outcome-only。
- Stale/idempotency: window snapshot immutable for lifetime；multiple agent_end/resolve/abort cannot duplicate ownership。
- Unchanged downstream consumers: auth stale、overflow compaction、retry events、accepted agent-message queue、AgentConnection/wire。

### Non-goals for #28

- 不实现compaction/autonomous leases、traceGeneration、active abort/dispose fence、finalMessageIds、ledger/recovery或任何mode/wire变化。
- 不改变哪些provider错误可retry、maxRetries算法、backoff、event payload/order或error-message清理；发现这些问题只报告不顺手修。

## Issue #29 implementation fixture

Fixture level: expanded（上游建议compact；本切片引入100ms timer-owned work、取消/rearm、multi-owner扩展与retry/compaction handoff，命中mandatory expanded triggers）
Repair intensity: high（continuation跨越action、timer与多个Agent run；owner或lease任何空窗/串线都会不可逆提前settle或永久settling）
Project profile: Prime Agent TypeScript monorepo (Generic-derived)

### Change surface and preservation boundary

- Change surface: `packages/coding-agent/src/core/agent-session.ts` 的successful compaction owner capture/generation、`_schedulePostCompactionContinue`、`_cancelPostCompactionContinue`、`_runScheduledPostCompactionContinue`、manual compact park/resume与现有retry/terminal fence组合；focused settlement/compaction/queue tests。tracker API不变。
- Must preserve: 100ms timer、auto-refine pending语义、agent/session-owned queue draining、`already processing`重试、manual compact成功/失败/skipAbort行为、overflow recovery、retry事件/attempt/backoff、public prompt/AgentMessageOutcome timing、action recovery/wire，以及`_postCompactionContinuationMessages` autonomous bookkeeping。
- Must add: generation对successful threshold/requested compaction的exact owner计数；只为真实prompt-owned post-compaction obligation持continuation leases；captured owner tuple跨rearm/reorder/manual park稳定；continuation内retry/compaction正确handoff；单一terminal close。
- Staged boundary: autonomous action inherit producer（#30）仍暂用background exclusion；#29只清理自己新增的continuation-window资源。显式`requestAbort`/update-restart、普通manual-abort失败与dispose过渡路径对window owners先置cancel fence；`abortRetry()`只停止retry，不是prompt abort，因此对overflow continuation owners记录`run_error`后close。这样本切片单独合并后不会错误`completed`或永久settling。#31再补current owners、internal inherited actions、可见队列边界，并把dispose的session-wide `settleAll(...,{released:true})`移到window close之前；`_currentRunOwners`/finalMessageIds（#32）、ledger/restart与mode/wire（#33+）不实现。
- Seam under test: in-process AgentSession + faux provider + fake timers；直接spy tracker `acquire("compaction_continuation")`、returned lease object release与`bumpTraceGeneration`。只观察scheduled boolean或最终outcome不足以证明owner/lease/generation。

### Continuation-window ownership contract

- **Generation producer**：`_runAutoCompaction`进入任何`await`前固定该次去重run-owner snapshot，避免auth/extension/provider等待期间另一run覆盖；仅successful threshold/requested在成功边界逐active owner `bumpTraceGeneration`一次。pump在调用pre-turn compaction前已安装即将执行batch的owners，且其admission run leases覆盖准备阶段，所以owned pre-turn success计入该batch；真正无identity owner的background/private pre-turn不bump。failed/skipped/cancelled、manual与overflow不bump；无continuation work仍bump，不创建window。unknown/terminal mutation自然no-op，不改其他prompt或cached outcome。
- **Schedule caller classification**：scheduler flag/timer与settlement window是正交状态。实现必须给每个调用点选择且仅选择一类：(1) successful `willRetry`、`shouldContinueAfterCompaction`，或requested失败后`shouldContinueAfterCompaction`为prompt-owned window create/extend + scheduler arm；(2) #30前settlement-excluded autonomous/background continuation与既有no-owner private seam为legacy ownerless scheduler obligation（100ms timer、零settlement lease）；(3) 仅agent-level queued message或independent session action为ownerless generic scheduler wake，前者继续走`agent.continue()`，后者走session pump；(4) busy/pump/`already processing`为原scheduler obligation internal rearm；(5) manual compact为window/scheduler park/resume；(6) `requestAbort`、update-restart、dispose、branch/no-work invalidation与`abortRetry` failure-close为close policy。tracked `_postCompactionContinuationMessages`只是obligation/message证据，不能把独立queued B并入captured owners。
- **Create/extend事务**：新window捕获去重active owners、obligation messages，对全部owners all-or-nothing acquire；partial失败逆序release本次siblings且不发布tuple。已有window收到新的真实obligation时，先求missing owners/messages，all-or-nothing acquire missing owners后再原子扩展并递增revision；相同owner重复obligation不重复lease。若create失败，本次全部owners记录`run_error`；若extend失败，只对未被旧window覆盖的本次owners记录`run_error`，旧owners/window不变。本次prompt-owned obligation/message/action不得作为这些失败owners的owned work继续或混入旧window；overflow `willRetry`须返回non-retry/resolve旧retry window，其他legacy ownerless queued work仍可按自身既有调度运行。不得cancel失败owners或破坏旧window。
- **Internal rearm / generic wake**：busy（streaming/compacting/retrying/pause）、pump ownership、`already processing`与100ms timer重试只改变scheduler state，复用同一obligation snapshot且不读取`_lastRunPromptIds`、不扩owner、不release。#30前legacy ownerless continuation保留相同timer/message行为但无settlement window。generic wake可保持现有timer：agent-level queue最终`agent.continue()`，session action先pump；若pump消费tracked continuation message，window须等该action及event queue结束后close；若只消费unrelated B，则A window rearm不close。两者都不得伪造或扩展window。manual compact在调用会触发`abort()`前先park window和scheduler timer：clear timer但保留tuple/leases，并以operation-local one-shot preserve token只让这次紧邻internal `abort()`跳过window close；任何外部/concurrent abort仍cancel+close。成功rearm原状态；普通manual失败/取消cancel+close；`skipAbort:true`不调用abort且无论成功或failed/skipped都resume。
- **Runner isolation/handoff**：direct `agent.continue()`路径先取得queued-work pause，并在install captured owners→clear terminal signal→continue→wait group3 retry chain→wait `_agentEventQueue`→capture/fence final stopReason期间持有，防retry close唤醒pump启动B；临时`_lastRunPromptIds=capturedOwners`使group3继承正确owners。该run的terminal signal在fence后被消费，finally只恢复此前owner snapshot，不把stale prior terminal signal写回。terminal fence与detach-first close/rearm在pause内完成；随后必须release pause，并以该release现有的`_scheduleSessionInputPump()`作为权威post-fence wake（或release后显式再schedule），最后才触发可与B并行的post-close auto-refine observer。pause期间`_resolveRetry`/close发出的pump请求允许被门闩拒绝，但不得成为唯一唤醒。matching overflow-retry continuation可在`isRetrying`时执行并结束其retry window，其他unrelated retry/busy才rearm，避免`isRetrying`自锁。session-action pump路径不能持pause：先捕获window identity/revision/message snapshot，schedule并await当次`_sessionInputPump`及`_agentEventQueue`；tracked continuation message被该action消费时才可在action terminal后close，若pump仅运行unrelated B则rearm原window。两条路径结束都比较window identity/revision，不得让late completion close后来扩展/rearmed的obligation。组7再在direct范围设置`_currentRunOwners`；tracked action沿普通batch owners记录，本组不做。
- **Terminal/rearm**：若continuation run触发新的successful threshold/requested compaction并使same window revision变化，则旧runner保留/rearmwindow；否则最终`error`对captured owners `recordFailure("run_error")`、`aborted` requestCancel，然后single close。successful overflow compaction前的overflow assistant error为provisional：willRetry window建立成功后不得由主run terminal fence永久recordFailure；recovery成功completed，只有recovery terminal error failed。
- **Close**：单一helper先detach timer/window/owners/messages/leases，再逐lease exact-once release，最后触发auto-refine/pump等observer动作；reentry/重复cancel/late timer no-op。branch invalidation、tracked work清空、确认无post-work等nonabort close只release。`abortRetry()`对overflow continuation owners先`recordFailure("run_error")`再close；`requestAbort`、update-restart、普通manual-abort失败及#29过渡期dispose先对window owners `requestCancel`再close。这只覆盖#29新增资源；#31仍负责完整abort/dispose，并须在dispose中先`settleAll(...,{released:true})`再允许任何window/action lease release。

### Risk packs considered

- Public API / CLI / script entry: not selected - 无签名/CLI/AgentConnection/wire变化。
- Config / project setup: not selected - compaction/retry配置shape与默认值不变。
- File IO / path safety / overwrite: not selected - 不新增文件/JSONL操作；compaction persistence逻辑不改。
- Schema / columns / units / field names: not selected - outcome/action recovery/wire shape不变；仅private runtime tuple。
- Auth / permissions / secrets: not selected - 不改auth；既有compaction/retry auth失败回归需保留。
- Concurrency / shared state / ordering: selected - timer、pump、manual park、overlapping obligations、retry与terminal signal交接是核心。
- Resource limits / large input / discovery: selected - timer/rearm必须有单window、不积累timer/lease/owner数组；owner/message集合按当前obligation去重有界。
- Legacy compatibility / examples: selected - queue/auto-refine/manual/overflow/timer/public prompt行为必须不变。
- Error handling / rollback / partial outputs: selected - partial owner extension、continue throw、compaction failure/skipped、late timer、duplicate close与provisional overflow error必须稳定。
- Release / packaging / dependency compatibility: not selected - 无export/dependency/build shape变化。
- Documentation / migration notes: not selected - shared状态文档由#42更新；fixture记录staged边界。
- TUI focus/render lifecycle: not selected - 不触碰TUI。
- Session/extension teardown lifecycle: selected - branch invalidation/requestAbort/update-restart/dispose/manual compaction会取消或park timer；cancel fences本组与#31边界必须明确。

### Required evidence

- single threshold/requested：run owner在compaction成功时generation 0→1并在旧ownership释放前取得一份continuation lease；timer pending/continuation run/retry期间无outcome，最终第二个agent_end后release一次completed。成功但无post-work：generation=1、零continuation acquire/timer。
- generation negatives/prepare boundary：无compaction为0；failed/skipped/cancelled/manual/overflow与真正ownerless pre-turn均不bump；owned pre-turn success只bump已安装的next batch owners；A终态后B successful threshold/requested只bump B；same owners的continuation再compaction到2且每代只bump一次。
- `"all"` A/B：两owners各exact acquire/release、generation +1、一个outcome；create/extend第二owner acquire失败逆序回滚本次siblings、旧window不变，当前obligation不continue且该次run owners最终`failed/run_error`。
- reorder/overlap：A timer pending时B普通run先执行，A tuple不变且B不并入；B自己的真实compaction obligation原子扩展B。unrelated queued action/generic 100ms wake不扩A。mutable `_lastRunPromptIds` clobber不改变release/retry targets。
- internal rearm：busy/retrying/external pause/pump/`already processing`只rearm同一timer/window，acquire/release各不重复；late timer与重复cancel no-op。100ms时序与existing queue/auto-refine tests保持。
- manual transfer：普通manual compact成功park/resume exact same lease；普通失败/取消对window owners cancel后close once；`skipAbort:true`成功或failed/skipped均resume scheduled window与leases。
- direct continuation retry：first continuation agent_end retryable时group3对captured owners各取retry lease；queued B的provider call在direct fence/close前为0；window close/rearm decision完成并release pause后，B的provider call恰发生一次并按B identity完成，证明wake未丢。A最终completed once；continuation再次compaction时same window revision变化并保留，generation再+1。非`already processing` continue throw最终`failed/run_error`并close，仍须唤醒B。
- pump handoff：tracked continuation action被pump执行时window等到action + event queue terminal再close；只运行unrelated B时A window/revision保持并rearm；不得用queued-work pause等待pump造成死锁。
- overflow recovery + post-fence wake：initial overflow error→successful overflow compaction→willRetry continuation success = A completed/no failure；recovery terminal error=A failed/run_error；overflow不bump generation。两支都预先排队独立prompt B，并直接断言A terminal fence/continuation close前B provider calls=0，pause release后B provider calls恰为1且B按自身promptId完成，证明`_resolveRetry`在pause内被拒绝的schedule不是唯一wake。
- close policies：branch invalidation、tracked messages移除或确认无work为release-only completed；`abortRetry()`为window-owner failure+release；`requestAbort`、update-restart与#29 dispose过渡路径为window-owner cancel+release once。#31测试并实现完整current/inherited/queue取消，以及dispose先session-wide released settle、后window close。
- focused commands: settlement groups 2-4 + compaction/queue/retry-events/auth/action-race/autonomous/serialized-refine siblings；root check/build；strict OpenSpec；diff/stash/debug scan。

### Invariant Matrix

- Governing invariant: 每个真实post-compaction obligation从successful scheduling边界到其最终continue/retry/recompaction结束始终由create-time/extended owner tuple的独立continuation leases覆盖；internal rearm不改变ownership，close exact-once且generation只归successful threshold/requested compaction owners。
- Source-of-truth identity/contract: private settlement-window tuple `{owners[i] ↔ leases[i], obligationMessages, revision, scheduled|running|parked}`与正交scheduler `{scheduled,timer,messageSnapshot}`；generation snapshot在`_runAutoCompaction`异步边界前固定。
- Producers: `_runAutoCompaction` successful threshold/requested/overflow-willRetry与requested-failure owned-resume；manual只park/resume，queued-only caller只generic wake；每个schedule/close caller必须分类。
- Validators/preflight: active owner/message dedup、prompt-owned vs legacy-ownerless vs generic-wake classification、existing-window missing-owner extension、tracker acquire、all-or-nothing rollback与fail-closed。
- Storage/cache/query: runtime-only settlement window/revision + legacy-compatible scheduler timer/message snapshot；tracker Map与outcome query；recovery/wire/persist不变。
- Public routes/entrypoints: prompt/compact skill/manual compact/queue/abort/dispose只间接触发；无新public API。
- Frontend/downstream consumers: agent queue, session action pump, retry window, auto-refine, compaction events/outcomes, autonomous message bookkeeping, future group6/7。
- Failure paths/rollback/stale state: partial create/extend fail-closed、busy/pump/already-processing、manual success/fail/skipAbort、branch/no-work close、requestAbort/abortRetry/update-restart/dispose、continue throw/aborted、continuation retry/recompaction、overflow provisional failure、late runner/reentry/duplicate close、B run overwrite。
- Evidence/audit/readiness: direct acquire/release/bump spies + faux-provider/fake-timer public paths + unchanged queue/compaction/retry/auto-refine suites。
- Regression rows:
  - successful compaction with/without post-work -> correct generation; lease only when obligation exists。
  - single/all owners continuation/retry/recompaction -> no early outcome, correct owner leases/generation, exact terminal。
  - A delayed behind B / overlapping A+B obligations -> captured/extended owners exact, generic wake does not merge identities。
  - pump consumes tracked continuation vs unrelated B -> close A only after tracked action/event completion; unrelated B only rearm A。
  - ownerless agent queue/background/private seam -> preserve timer/continue/message behavior with zero settlement leases。
  - create/extend failure -> rollback only new siblings, no unowned continuation, affected current owners failed while old window remains valid。
  - manual transfer or internal rearm -> no half-open window, no 0-lease handoff, legacy behavior stable。
  - nonabort close vs explicit abort/dispose transition -> release-only completed vs cancel+release; no duplicate outcome。
  - overflow recovery success/failure -> provisional error suppressed, final recovery status authoritative。
  - unchanged queue/auto-refine/manual/auth/action recovery consumers -> existing timing/events/serialization remain stable。

### Boundary-surface checklist

- Shared helper roots: one continuation create/extend/rearm/park/close state machine; no per-caller lease arrays。
- Public entrypoints: unchanged; compact/prompt APIs only gain internal ownership accounting。
- Staging/rollback: all-or-nothing owner extension before publish；failed extension禁止unowned continue；manual park retains tuple；detach-first close。
- Producer/consumer evidence: every schedule/close caller categorized; direct lease/generation spies, not scheduled-flag-only。
- Stale/idempotency: captured owners immutable except explicit atomic extension；revision protects newer obligation；late timer/rearm/duplicate cancel do not duplicate leases or terminal。
- Unchanged downstream consumers: retry/auth/queue/auto-refine/autonomous/manual compaction/recovery/wire。

### Non-goals for #29

- 不实现autonomous action `lineage:{inherit}` producer、完整current/inherited abort清理或dispose `settleAll(...,{released:true})`最终接线、finalMessageIds、ledger/restart或mode/wire变化；本组仅给自己新增的continuation window做cancel/close过渡闭环。
- 不改变compaction eligibility/summary/persistence、retry eligibility/backoff/events、queue visibility或auto-refine policy；发现范围外问题只报告。

## Issue #30 implementation fixture

Fixture level: expanded（上游建议none；本切片虽只接一个options producer，但会把session-internal autonomous action从zero-identity切换为counted multi-owner run leases，涉及共享状态、异步owner捕获与取消顺序，命中mandatory expanded trigger）
Repair intensity: high（漏owner、重复action/lease、可变snapshot串线或clear误cancel会造成提前终态、永久settling或错误cancelled）
Project profile: Prime Agent TypeScript monorepo (Generic-derived)

### Change surface and preservation boundary

- Change surface: `packages/coding-agent/src/core/agent-session.ts` 的 `_queueAutonomousContinuationForThresholdCompaction` action options；focused settlement/compaction/autonomous/goal harness tests。组2 admission/cancel helper、组4 continuation window与tracker API不改。
- Must preserve: autonomous decision/limits/gates、arrival-epoch rollback、同assistant message去重、100ms scheduler与compaction window、ownerless background/private continuation、`/goal` goal-context default lineage、public prompt/AgentMessageOutcome timing、action recovery/wire。
- Must add: threshold producer在进入`nextAutonomousContinuation`异步边界前复制触发run全部去重owners；非空snapshot通过`lineage:{inherit: owners}`让单一action逐owner取得独立run lease；零owner继续显式settlement-excluded。
- Staged boundary: #31才处理active abort摘除inherited actions与dispose released fence；#32记录message ids；#33+ ledger/wire/modes。不在本切片修改主动abort/dispose、recovery schema或public API。
- Seam under test: in-process AgentSession + faux provider的production threshold路径；必要的private只读action-store/clear seam仅用于在delivery前观察exact action owners/leases和已有group2 release-only分支。

### Autonomous inherit producer contract

- `_queueAutonomousContinuationForThresholdCompaction`先处理同message已有queued obligation的idempotent return；fresh producer随后立即复制`[...new Set(_lastRunPromptIds)]`，再进入gate/decision await。后续任何mutable owner snapshot变化不得改变本action lineage。
- decision返回message且arrival epoch仍匹配时，只创建一个queued message/action。owner snapshot非空则options只传`lineage:{inherit: snapshot}`；不得同时传`noSettlementIdentity`或生成fresh candidate。snapshot为空则保持`noSettlementIdentity:true`，不构造空inherit（空inherit会按组2拒绝）。
- 组2 `_admitSessionInput`是唯一lease producer：它对snapshot owners all-or-nothing acquire独立`run` leases并把exact dedup owners写入action；本方法不得自己逐owner入队或acquire。tracked continuation pump owner只在settlement admission与ActionStore enqueue均成功后发布。若owner在decision期间终态或partial acquire失败，producer恢复autonomous snapshot并只删除本轮weak-map/message/pending bookkeeping，返回无obligation；prior window/messages、parent leases/cancel state与pump owner不变，preflight throw清理后仍原样抛出。组4仍对同owners持独立`compaction_continuation` leases，两种kind/实例并存直到各自owned work终止。
- shared `"all"` run只调用本producer一次，因此只有一个autonomous message/action和一次后续provider run；action可有多个promptIds，但不得按owner复制action。
- `_clearQueuedAutonomousContinuations`继续通过`_cancelSessionActions`移除action。因为action带`lineage`，组2 non-abort inherit分支只消费本action run leases，不requestCancel owners；其余parent/window ownership决定自然终态。#31 active abort会另加cancel policy，不在此混入。
- `/goal`由`_runOrQueueGoalContext`创建的goal-context action不使用本producer，继续缺省lineage并取得fresh promptId；active goal run若自身触发threshold，则只对该run随后生成的autonomous threshold action继承该run owners。

### Risk packs considered

- Public API / CLI / script entry: not selected - 无签名或入口变化；`/goal`仅做不变回归。
- Config / project setup: not selected - autonomous/compaction/goal配置不变。
- File IO / path safety / overwrite: not selected - 无文件读写。
- Schema / columns / units / field names: not selected - 复用runtime-only action lineage字段，不改recovery/wire schema。
- Auth / permissions / secrets: not selected - 无权限或secret边界。
- Concurrency / shared state / ordering: selected - async前owner capture、multi-owner action lease与parent/window lease并存、terminal release顺序。
- Resource limits / large input / discovery: not selected - owner集合按当前run去重有界；同message idempotency禁止重复action/lease。
- Legacy compatibility / examples: selected - ownerless scheduler、autonomous gate/limit、goal context identity与public timing必须不变。
- Error handling / rollback / partial outputs: selected - arrival epoch/abort使decision失效时不入队；inherit admission失败沿组2 all-or-nothing drop；clear只release不cancel。
- Release / packaging / dependency compatibility: not selected - 无dependency/export/build变化。
- Documentation / migration notes: not selected - shared状态文档由#42统一更新。
- TUI focus/render lifecycle: not selected - 不触碰TUI。
- Session/extension teardown lifecycle: selected - queued inherited action的non-abort clear与#31 active abort必须严格分界。

### Required evidence

- production single owner threshold：decision await前captured owner为A；queued action `promptIds=[A]`且一份inherited run lease，与组4 continuation lease并存；first run terminal后无outcome，后续action/continuation terminal后A仅一个completed。
- production `"all"` A/B threshold：一个共享run只产生一个autonomous action，exact dedup `promptIds=[A,B]`、每owner一份run lease，后续provider continuation只调用一次；A/B各一个completed且都不早于continuation terminal。
- duplicate/async stability：同assistant message重复queue不新增action/acquire；decision await期间mutable `_lastRunPromptIds`被其他值覆盖也不改变captured lineage（可用deterministic gate seam，不能只检查最终outcome）。
- clear/skipped：delivery前清理inherited action时每份action lease释放一次、`requestCancel`对owners零调用，parent/window ownership保留并自然completed；重复clear零副作用。
- rejected admission：第二owner inherited `run` acquire失败与decision期间owner终态两支均不入队/不返回obligation；child siblings reverse-release once、autonomous usage恢复、只移除本轮maps/messages/pending，zero cancel/outcome/pump-owner；prior window/messages与parent leases保持exact。
- zero-owner：background/private调用仍创建legacy settlement-excluded work或按原decision no-op，零candidate/promptIds/run lease/outcome，100ms行为不变。
- goal boundary：`/goal`产生的goal-context action仍为default fresh identity；若该run触发threshold，其autonomous threshold child继承该fresh owner而非slash-command或先前prompt identity。
- focused settlement/compaction/autonomous/goal suites、root`npm run check`、workspace build、strict OpenSpec均exit 0。

### Invariant Matrix

- Governing invariant: 每个threshold autonomous obligation恰有一个action，且该action从admission到terminal始终以异步decision前捕获的全部run owners各一份独立run lease覆盖；非abort清理只释放该子action ownership。
- Source-of-truth identity/contract: fresh producer的immutable dedup `ownerSnapshot`，随后映射为`action.promptIds[i] ↔ action.runLeases[i]`；mutable `_lastRunPromptIds`与continuation-window owners不是admission后的重读来源。
- Producers: `_queueAutonomousContinuationForThresholdCompaction`唯一lineage producer；`_admitSessionInput`唯一run-lease acquire/publish helper。
- Validators/preflight: duplicate message map、arrival epoch、nonempty-vs-zero owner classification、组2全部owner settling检查与all-or-nothing acquire。
- Storage/cache/query: runtime maps/message arrays、ActionStore与tracker内存；recovery/persist/wire不变。
- Public routes/entrypoints: threshold compaction间接触发；`/goal`、public prompt与manual/requested/overflow不改producer语义。
- Frontend/downstream consumers: session pump、group4 continuation scheduler/window、autonomous limits/gates、goal context与future #31 abort cleanup。
- Failure paths/rollback/stale state: decision abort/arrival epoch变化、terminal owner/drop、partial acquire rollback、duplicate queue/clear、zero-owner background与mutable snapshot clobber。
- Evidence/audit/readiness: production faux-provider single/all tests、direct action/lease observations、clear/ownerless/goal compatibility tests、focused sibling suites与OpenSpec validation。
- Regression rows:
  - single/all active owners + successful threshold -> one action, exact captured owners/leases, no early or duplicate outcome。
  - decision await后owner snapshot clobber或duplicate call -> original owner tuple不变且无额外action/lease。
  - skipped/nonabort clear -> child leases exact release、zero cancel fence、parent/window自然terminal。
  - zero-owner producer -> legacy no-identity behavior；空inherit不得入队。
  - `/goal` goal context -> fresh default promptId；其threshold child只继承该run snapshot。
  - unchanged compaction/autonomous/action recovery consumers -> existing timer, gate, limits, queue与serialization behavior稳定。

### Boundary-surface checklist

- Shared helper roots: producer只选择lineage classification；所有acquire/release继续复用组2 helper，不复制状态机。
- Public entrypoints: 无变更；goal/public prompt仅回归。
- Staging/rollback: owner capture在await前；arrival epoch rollback和inherit all-or-nothing admission保持原子。
- Producer/consumer evidence: tests直接观察action promptIds/runLeases、provider call count与outcome timing，不以文本标签或timer flag代替ownership证明。
- Stale/idempotency: same-message map与immutable snapshot防duplicate/stale owner；clear与terminal helper exact-once。
- Unchanged downstream consumers: ownerless background、goal context、group4 scheduler/window、autonomous gates/limits、recovery/wire。

### Non-goals for #30

- 不实现#31主动abort/dispose ownership清理，不记录finalMessageIds，不接ledger/recovery/wire/modes，不改变compaction或autonomous决策策略。
- 不把`/goal` goal context改为inherit；它仍是独立default prompt identity。发现其他producer/abort问题只报告，不顺手修。
