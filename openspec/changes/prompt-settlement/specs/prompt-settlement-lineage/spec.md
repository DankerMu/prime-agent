# Spec: prompt-settlement-lineage

## ADDED Requirements

### Requirement: 稳定 promptId 与 lineage 归属

session 经公共入口（`prompt`、`promptAndWait`、`promptAndSettle`、`promptUntilAccepted`、`acceptAgentMessagePrompt`、`queueAgentMessagePrompt`、`steer`、`followUp`，以及用户 `/goal` 命令触发的 goal context 入队）接受的每个 turn 类输入 MUST 在 admission accepted 时刻获得唯一且稳定的 `promptId`；公共 action 的 `promptIds` 为该单一 id，session 内部 autonomous threshold continuation 的 `promptIds` MUST 继承触发它的 run 的全部去重 owner。`steeringMode`/`followUpMode === "all"` 把多个 action 合并为一次 Agent run 时，各 promptId 保持独立，但该共享 run、retry、compaction continuation、assistant entry MUST 归属于全部 owners。`session_command` 类 action MUST NOT 参与结算（不分配 promptId、不取 lease、不产生 outcome）。

#### Scenario: 公共入口每次 admission 分配新 promptId

- WHEN 两个 prompt 先后经 `promptAndSettle` 提交（第二个在第一个仍在执行时排队）
- THEN 两者获得不同的 `promptId`，各自独立产生 `PromptOutcome`，第二个不并入第一个的 lineage

#### Scenario: host 侧 internalPrompt 也是新 promptId

- WHEN host 以 `session.prompt(text, { internalPrompt: true })` 提交 headless gate continuation
- THEN 该输入获得新的 `promptId`，不继承任何在途 prompt 的 lineage

#### Scenario: session 内部 autonomous continuation 继承 lineage

- WHEN prompt A 的 run 触发 threshold compaction 且 session 为其内部排队 autonomous continuation
- THEN 该 continuation action 的 `promptIds` 为 `[A.promptId]`，A 的 outcome 在该 continuation 完成前不产生

#### Scenario: run 中 steer/followUp 不合并 identity

- WHEN prompt A 的 run 进行中，用户经 `steer()` 或 `followUp()` 提交输入
- THEN 该输入获得新的 `promptId` B；即使 `"all"` batching 使 A/B 共享一次后续 Agent run，两者仍有独立 outcome，且共享 run 的 retry/compaction/assistant entry 同时归属于 A 与 B

#### Scenario: all batching 的共享 run 覆盖全部 owner

- WHEN prompt A 与 B 以相同 delivery/execution policy 排队且 `steeringMode` 或 `followUpMode` 为 `"all"`，session 用一次 `agent.prompt` 执行两者
- THEN A/B 各持有该共享 run 的 run lease；其 retry 与 post-compaction continuation 对 A/B 各持有对应 lease；共享 assistant entry 同时出现在两个 outcome 的 `finalMessageIds`，任一 outcome 都不得在共享 owned work 结束前产生

#### Scenario: 非 turn 输入不参与结算

- WHEN 经公共 prompt 入口提交 `sessionCommand`（如 `/goal status`）、`extensionCommand` 或被 extension input handler 标记为 `handled` 的输入，随后提交一条普通 turn prompt
- THEN 非 turn 输入沿用现有 `AgentMessageOutcome.completion`/错误语义，但不分配 promptId、不产生 `prompt_outcome`、不写 ledger；普通 turn prompt 正常结算

#### Scenario: 预分配 promptId

- WHEN 调用方以 `options.promptId` 预分配 id 提交 prompt
- THEN admission 使用该 id；若该 id 已存在于 tracker，admission 以错误拒绝且不创建记录

### Requirement: owned-work lease 覆盖范围

prompt 的结算 MUST 等待：accepted turn从 admission/enqueue起持有的 run lease（覆盖排队、主 Agent run及同步 tool/子 Agent）、provider retry、post-compaction continuation、继承 lineage的 autonomous continuation。每次 acquire是独立实例，同 promptId/kind可并存；inherit action admission会新增 run lease。后台 auto-refine、cron、heartbeat、detached subagent、其他 prompt action不得阻塞或重开该 prompt。

#### Scenario: accepted 排队 turn 从 admission 起持有 lease

- WHEN turn A 被 accepted但仍排队，尚未进入 preparing
- THEN A 已持有一个存于 action的 run lease且保持 settling；preparing不得重复 acquire，执行/取消只释放该已有 lease

#### Scenario: 同 kind lease 按实例计数

- WHEN A 的父 action尚持有 run lease，session又为其 accepted一个 inherited autonomous action
- THEN tracker对同 promptId同时计数两个独立 run lease；任一单独释放都不得使 A终态

#### Scenario: 同步 tool 调用阻塞结算

- WHEN run 的 assistant turn 发起 tool 调用且 tool 尚未返回
- THEN outcome 不产生；tool 返回、后续 turn 结束且无 retry/continuation 后才产生 `completed`

#### Scenario: retry 不提前结算

- WHEN run 因 provider 错误进入 retry 等待窗口，随后 retry 成功完成
- THEN session 在释放旧 owned work 前对该 run 的每个去重 owner取得一份独立 `retry` lease；outcome 在 retry 完成并释放这些 captured leases 后才产生，状态 `completed`，期间每个 owner只有原 `promptId`、可能出现多个 `agent_end`

#### Scenario: shared retry window 按 owner 计数且不重复 acquire

- WHEN `"all"` batching 的 A/B 共享 run 连续经历多个 retryable error `agent_end` 后成功
- THEN 同一个 retry window 只在首次建立时为 A/B各 acquire一份 `retry` lease，后续 error不得重复 acquire；A/B均在最终 retry结束后各自产生一次 outcome，不合并identity

#### Scenario: retry window 所有结束路径只释放一次

- WHEN retry成功、耗尽、sleep被取消、overflow/compaction恢复结束或调用 `abortRetry()` 中任一路径关闭 retry window，并可能发生重复resolve/abort
- THEN window建立时捕获的每个retry lease只release一次，Promise/resolve/lease引用先被detach，重复结束为no-op；不得留下永久settling或对后续run的owner错放lease

#### Scenario: compaction continuation 不提前结算

- WHEN run 成功完成 threshold/requested compaction并确认存在该prompt-owned post-compaction work，随后调度continuation（timer持有）
- THEN session在旧run/retry ownership释放前捕获该run全部去重owners并各取得一份独立`compaction_continuation` lease；在continuation run（含其retry或再次compaction）完成前不产生outcome，最终每owner各产生一次`completed`

#### Scenario: compaction generation 与 continuation obligation 解耦

- WHEN prompt-owned run成功完成threshold/requested compaction但没有willRetry、tool/custom continuation或其他属于该prompt的post-compaction work
- THEN 对captured owners的`traceGeneration`仍各+1，但不建立空的continuation lease/timer；owners可在现有owned work结束后正常settle

#### Scenario: unrelated queued work 不扩展 continuation owner

- WHEN A的compaction后只因session中存在独立prompt B的queued action而需要唤醒scheduler，且不存在A自己的post-compaction work
- THEN scheduler可以运行B，但不得把A放入continuation window、不得让A等待B，也不得把B并入A的captured owner tuple

#### Scenario: staged ownerless continuation 保持既有 timer 行为

- WHEN #30接入autonomous lineage之前，settlement-excluded autonomous/background continuation或既有private scheduler seam没有active prompt owner但确有continuation work
- THEN session保留100ms continuation/message处理与internal rearm行为，但不创建settlement lease；它与只唤醒queued prompt的generic wake仍为不同分类

#### Scenario: continuation owner acquire 失败时 fail closed

- WHEN为A/B真实obligation建立或扩展window时，B的`compaction_continuation` acquire失败
- THEN本次已取得的new sibling leases逆序release，existing window保持原样；本次obligation不得在无完整ownership下执行，受影响的当前run owners最终为`failed/run_error`，不得取消或提前关闭旧window owners

#### Scenario: continuation 重排与内部 reschedule 保持原 owner

- WHEN prompt A 的continuation因B run、session pump、queued-work pause或`agent.continue()`报告already-processing而reschedule
- THEN timer只rearm同一个captured owner/lease tuple，不回读B的`_lastRunPromptIds`、不重复acquire/release；A的continuation最终只释放A在调度时捕获的leases

#### Scenario: overlapping compaction obligation 扩展 owner 而不重开 window

- WHEN A continuation仍scheduled/parked/running时，prompt B的run成功完成另一次需要continuation的compaction
- THEN existing window原子扩展B中尚未captured的owners与对应独立leases，并合并本次obligation snapshot；A/B均等待后续continuation，任一identity不被合并或提前终态

#### Scenario: continuation 自身 retry 继承 captured owners

- WHEN post-compaction `agent.continue()` 先以retryable provider error结束、随后retry成功
- THEN group3 retry window对continuation captured owners逐id取得retry leases；continuation leases在retry chain结束前不释放，最终每owner只有一个completed outcome

#### Scenario: continuation terminal fence 不被后续 run 覆盖

- WHEN continuation retry结束会唤醒session pump，且另一prompt B仍在可执行队列
- THEN session在continuation的captured owners、最终assistant stopReason与leases完成terminal fence/close前保持scheduler隔离；B不得先启动并覆盖continuation的owner或terminal signal。close后release scheduler pause必须重新唤醒pump，B随后按自己的identity实际启动并完成，不得因pause期间被拒绝的pump请求永久stall

#### Scenario: overflow recovery 不继承 provisional failure且不丢后续 prompt wake

- WHEN A run以context overflow error结束，successful overflow compaction调度willRetry continuation，独立prompt B已排队，且A continuation recovery分别成功或以terminal error结束
- THEN原overflow assistant error不把A永久fence为failed；成功支A outcome为completed，terminal-error支A为failed/run_error，overflow均不bump generation。两支中A terminal fence与continuation close前B provider call均为0；scheduler pause release后B provider call恰为1并按B自己的promptId完成，不得因pause期间`_resolveRetry`的pump request被拒绝而stall

#### Scenario: manual compaction 暂存并恢复既有 continuation ownership

- WHEN scheduled continuation存在时执行普通manual compaction，manual path在通用abort取消timer前先park window，并在成功后恢复continuation
- THEN原captured owners/lease instances在park/resume期间持续有效且不出现0-lease窗口或fresh owner回读；普通manual compaction失败/取消对window owners先置cancel fence再exact-once close（完整current/inherited abort清理由组6补齐）

#### Scenario: skipAbort manual failure 保留既有 continuation

- WHEN scheduled continuation存在时以`compact(...,{skipAbort:true})`执行manual compaction且compaction失败或skipped
- THEN原timer/window/owners/leases保持scheduled并可继续执行，不因一次未abort的compaction失败而close、release或重复acquire

#### Scenario: 非 abort 原因取消 continuation 推导为 completed

- WHEN run正常结束后调度了post-compaction continuation，随后因排队work清空、branch invalidation或确认无后续work（非prompt abort、非dispose）而取消该obligation
- THEN对应continuation leases只release、不置cancel/failure fence，outcome为`completed`——主run已正常完成且continuation不再需要；不产生第二个outcome

#### Scenario: explicit abort 关闭 continuation window 推导为 cancelled

- WHEN scheduled/running continuation存在时调用`requestAbort()`或`abortForUpdateRestart()`
- THEN captured window owners在lease release前先置cancel fence，window/timer detach-first且每个lease只release一次，不得错误`completed`或永久settling；完整current/inherited owner清理由组6共用同一cancel顺序

#### Scenario: abortRetry 停止 overflow continuation 推导为 failed

- WHEN successful overflow compaction已建立willRetry continuation window，调用方执行`abortRetry()`停止该retry continuation
- THEN session对captured owners记录`run_error`后exact-once关闭retry与continuation leases，outcome为`failed`而非`cancelled`或`completed`；重复abort/close为no-op

#### Scenario: dispose 先原子结算再关闭 continuation resources

- WHEN session dispose时仍有scheduled/running continuation window
- THEN session先按dispose requirement对全部active prompts执行atomic `cancelled + released` settlement，再detach window并对其lease做无副作用的exact-once close；不得先由最后一份continuation lease产生未released终态

#### Scenario: lease 交接无空窗

- WHEN 主 run 的 lease 释放与 retry/compaction continuation 的 lease 获取在同一同步段发生
- THEN tracker 不在交接间隙产生终态；retry window在同步 `agent_end` handling中先捕获全部owner并完成all-or-nothing acquire，之后旧 lease才可释放，单测直接观察retry lease而非依赖现有run lease推断

#### Scenario: 无关后台工作不阻塞

- WHEN prompt A 的 owned work 全部结束，但 cron/heartbeat 正在运行且 auto-refine 已调度
- THEN A 立即产生 outcome，不等待上述工作；它们随后产生的消息不出现在 A 的 `finalMessageIds`

#### Scenario: 迟到消息不重开终态

- WHEN A 已终态后，被排除的后台工作追加新的 assistant message
- THEN A 的 outcome 对象不变、不再次发出 `prompt_outcome` 事件、`getPromptOutcome(A)` 返回原终态

### Requirement: settle-once 终态推导

每个 `promptId` MUST 恰好产生一次 `PromptOutcome`，在最后一个 lease 释放的同步时刻原子推导：cancel fence 置位 → `cancelled`；否则已记录失败 → `failed`（`failure.reason` 必填）；否则 → `completed`。本 change 内 `advisor` MUST 恒为 `disabled`，`needs_user_input` 与 `unresolved_advisor` MUST NOT 被生产。终态后对该 `promptId` 的 `acquire` MUST 抛错，其余变更调用 MUST 为 no-op。

#### Scenario: 正常完成

- WHEN 主 run 以 `stop` 结束且无 retry/continuation
- THEN outcome 为 `{ status: "completed", advisor: "disabled" }`，`finalMessageIds` 含该 run 的 assistant message entry id，`sessionEpoch`/`traceGeneration` 为结算时刻值

#### Scenario: abort 推导当前 run 为 cancelled 且保留可见队列

- WHEN `requestAbort()`（含 `session.abort()` 与连接层普通 abort 路径）在 A 的 run 进行中被调用，且可见 prompt B 仍在队列
- THEN A及其所有内部 inherited autonomous actions/compaction continuations被摘除、置 cancel fence并释放各自已有 leases（即使此前有 failure，cancel优先）；真正的可见用户 prompt B不置 fence、保留 action run lease，恢复 pump后仍可执行且不因终态 A的 inherit action抛错

#### Scenario: abortAndClearQueue 取消可见队列

- WHEN 调用方执行 `clearQueue()`、mutate delete 或 `abortAndClearQueue()`，从 action store 实际移除已 accepted 的可见 prompt B
- THEN B 产生一个 `cancelled` outcome；普通 abort 未移除的可见 prompt 不满足该条件

#### Scenario: 终止错误推导为 failed

- WHEN run 以 provider `error` 结束且 retry 已耗尽或不适用
- THEN outcome 为 `{ status: "failed", failure: { reason: "run_error" } }`

#### Scenario: 二次变更为 no-op

- WHEN 终态后调用 `requestCancel`、`recordFailure`、`recordFinalMessage`
- THEN 不抛错、outcome 不变、不再次 emit

#### Scenario: 终态后 acquire 抛错

- WHEN 终态后对同一 `promptId` 调用 `acquire`
- THEN 抛出错误，记录保持终态

#### Scenario: pre-admission 拒绝不创建 outcome

- WHEN 候选 turn 因 session disposing、等价 follow-up coalesce 或重复预分配 promptId 而未被 accepted
- THEN tracker 不创建记录、不发 `prompt_outcome`，提交 API 沿用对应的现有拒绝语义；成功的非 turn 输入不属于该拒绝场景

#### Scenario: admission 后未执行即被取消

- WHEN default turn已 accepted并持有 action run lease，但执行前被 `clearQueue` 或 mutate delete移除
- THEN cancellation先 `requestCancel`再释放已有 lease，产生 `cancelled`；禁止临时 acquire，不留 settling

#### Scenario: 终态 owner 不接受 inherit action

- WHEN abort与内部 autonomous continuation admission竞争，inherit owner已终态
- THEN inherit action整项放弃、不入队、不 acquire、不抛穿 pump；终态 outcome不变

### Requirement: PromptOutcome 契约

`PromptOutcome` MUST 包含 `promptId`、`status`（`completed | needs_user_input | unresolved_advisor | failed | cancelled`）、`advisor`（`passed | fail_open | unresolved | disabled | pending`）、`finalMessageIds: string[]`（session entry id）、`sessionEpoch`、`traceGeneration`，`status === "failed"` 时 MUST 含 `failure.reason`；`pendingQuestions` 在本 change MUST 不出现。类型定义 MUST 一次完整导出，供 daemon/RPC/JSON/ACP 共用。

#### Scenario: 类型完整且单一来源

- WHEN daemon-protocol、rpc-client、acp-meta 引用 outcome 类型
- THEN 均从 `core/prompt-settlement.ts` 导入同一 `PromptOutcome`，不各自复制枚举

#### Scenario: finalMessageIds 只含 lineage 内 assistant 消息

- WHEN 一个 prompt 的 lineage 经历 run → retry → compaction continuation 共追加 3 条 assistant message entry
- THEN `finalMessageIds` 恰为这 3 个 entry id 且按追加顺序

### Requirement: traceGeneration 计数

`traceGeneration` MUST 在admission时为0；每当该prompt所属run成功完成一次threshold或requested compaction时，对该compaction开始时捕获的每个owner恰好+1，并在终态outcome中固定。失败/skipped/cancelled、manual与overflow compaction不得递增；是否需要post-compaction continuation不影响本次generation计数。本change不消费该值。

#### Scenario: compaction 计数

- WHEN prompt 的run成功完成一次threshold/requested compaction并经需要的continuation完成
- THEN outcome的`traceGeneration === 1`；无compaction为0

#### Scenario: 无 continuation 的成功 compaction 仍计数

- WHEN prompt的run成功完成threshold/requested compaction但没有该prompt-owned post-compaction work
- THEN outcome可直接settle，且`traceGeneration === 1`，不因没有timer而漏计

#### Scenario: multiple owner 与多代 continuation

- WHEN `"all"`共享run的A/B成功完成一次compaction，随后continuation run再次成功完成一次threshold/requested compaction
- THEN A/B各自generation从0→1→2；每次compaction对每owner只bump一次

#### Scenario: 非计数 compaction 与失败不 bump

- WHEN prompt经历manual或overflow compaction，或threshold/requested compaction失败、跳过或取消
- THEN该事件不改变prompt的traceGeneration

#### Scenario: 后台 compaction 不计入他人

- WHEN prompt A 已终态后，session 因另一prompt B发生成功threshold/requested compaction
- THEN A的outcome `traceGeneration`不变，B的计数+1

### Requirement: session 结算 API 与事件

`AgentSession` MUST 提供 `promptAndSettle(text, options?: PromptOptions & { promptId?: string }): Promise<PromptOutcome | undefined>`（options 与 `promptAndWait` 同集）。它 MUST 精确捕获本次调用是否 admit 了 turn：accepted turn 无论现有 completion resolve 或 reject 都以 tracker 为真值，返回结构化 `completed | failed | cancelled` outcome；成功 `sessionCommand`/`extensionCommand`/`handled` 在现有 completion 后返回 `undefined`，这些非 turn completion 失败仍 reject；turn admission 拒绝也 reject。候选 id 仅在本次 turn accepted 时 admit，非 turn 不占用且并发调用不得串 id。session 另提供 outcome 查询 API 并发 turn-only event；现有 `promptAndWait`、`AgentMessageOutcome`、`agent_end` 语义时序不变。

#### Scenario: promptAndSettle 等到终态

- WHEN 经 `promptAndSettle` 提交的 turn 经历 retry 后完成
- THEN 返回的 Promise 在 `prompt_outcome` 事件发出的同一时刻 resolve 为该 outcome

#### Scenario: turn completion error 返回结构化 outcome

- WHEN accepted turn 的现有 `AgentMessageOutcome.completion` 因 terminal run error 或 abort reject
- THEN `promptAndSettle` 不透传该 completion error，而是等待并返回同 promptId 的 `failed/run_error` 或 `cancelled` outcome

#### Scenario: 非 turn 等现有 completion 后返回 undefined

- WHEN `promptAndSettle` 提交 `/goal status`、成功 extension command 或 `handled` 输入
- THEN Promise 在对应现有 completion 时 resolve `undefined`，不产生 settlement record/event；extension command 失败时仍以原错误 reject

#### Scenario: admission 失败即 reject

- WHEN `promptAndSettle` 的 turn admission 被拒绝（session disposing、等价 follow-up 已排队或重复预分配 id）
- THEN Promise reject，错误与 `promptAndWait` 在同条件下的错误一致，且不产生 `prompt_outcome` 事件

#### Scenario: 已终态立即可得

- WHEN 对已终态的 `promptId` 调用 `waitForPromptOutcome` 或 `getPromptOutcome`
- THEN 前者立即 resolve、后者同步返回同一 outcome 对象；对 released 且已终态的记录（dispose 后）两者行为相同；对未知 `promptId`，前者 reject、后者返回 `undefined`

#### Scenario: promptAndWait 不变

- WHEN 现有调用方使用 `promptAndWait`
- THEN 其 resolve 时机仍为 `AgentMessageOutcome.completion` settle 时刻，不等待 post-compaction continuation

### Requirement: dispose 结算

`dispose()` MUST 通过一次 `settleAll("cancelled", "session_disposed", { released: true })` 对全部未终态且未 released 的 prompt 原子结算 `cancelled` 并同时标记 released fence（`outcome.failure` 不填；原因只写入 ledger 的 `settleReason`）；终态/released 记录 MUST 只 persist 一次，dispose MUST NOT 随后逐项 `release()` 产生第三条记录。`promptAndSettle` 的 waiter MUST 得到 `cancelled` outcome 而非悬空。

#### Scenario: dispose 时在途与排队 prompt 各结算一次

- WHEN session 存在一个执行中 prompt 与两个排队 prompt 时 `dispose()`
- THEN 三者各产生一次 `cancelled` outcome（`failure === undefined`）、各发出一次 `prompt_outcome`、ledger 各写一条 `released: true, settleReason: "session_disposed"` 的终态；重复 `dispose()` 为 no-op
