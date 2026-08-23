# Spec: prompt-settlement-lineage

## ADDED Requirements

### Requirement: 稳定 promptId 与 lineage 归属

session 经公共入口（`prompt`、`promptAndWait`、`promptAndSettle`、`promptUntilAccepted`、`acceptAgentMessagePrompt`、`queueAgentMessagePrompt`、`steer`、`followUp`，以及用户 `/goal` 命令触发的 goal context 入队）接受的每个 turn 类输入 MUST 在 admission 时刻获得唯一且稳定的 `promptId`；session 内部为某 prompt 排队的 autonomous threshold continuation MUST 继承该 prompt 的 `promptId`；`session_command` 类 action MUST NOT 参与结算（不分配 promptId、不取 lease、不产生 outcome）。

#### Scenario: 公共入口每次 admission 分配新 promptId

- WHEN 两个 prompt 先后经 `promptAndSettle` 提交（第二个在第一个仍在执行时排队）
- THEN 两者获得不同的 `promptId`，各自独立产生 `PromptOutcome`，第二个不并入第一个的 lineage

#### Scenario: host 侧 internalPrompt 也是新 promptId

- WHEN host 以 `session.prompt(text, { internalPrompt: true })` 提交 headless gate continuation
- THEN 该输入获得新的 `promptId`，不继承任何在途 prompt 的 lineage

#### Scenario: session 内部 autonomous continuation 继承 lineage

- WHEN prompt A 的 run 触发 threshold compaction 且 session 为其内部排队 autonomous continuation
- THEN 该 continuation action 的 `promptId` 等于 A 的 `promptId`，A 的 outcome 在该 continuation 完成前不产生

#### Scenario: run 中 steer/followUp 不并入 lineage

- WHEN prompt A 的 run 进行中，用户经 `steer()` 或 `followUp()` 提交输入
- THEN 该输入获得新的 `promptId` B；A 的 outcome 只覆盖 A 自己的 run/retry/continuation，B 独立结算

#### Scenario: session_command 不参与结算

- WHEN 经 `prompt()` 提交一条被识别为 session command 的输入（如 `/goal status`），随后提交一条普通 prompt
- THEN session command 不产生 `prompt_outcome` 事件、`getPromptOutcome` 对其无记录，普通 prompt 正常结算

#### Scenario: 预分配 promptId

- WHEN 调用方以 `options.promptId` 预分配 id 提交 prompt
- THEN admission 使用该 id；若该 id 已存在于 tracker，admission 以错误拒绝且不创建记录

### Requirement: owned-work lease 覆盖范围

prompt 的结算 MUST 等待以下 owned work 全部结束：主 Agent run（含其同步等待的 tool 与子 Agent）、provider retry 等待窗口、threshold/requested compaction 的 post-compaction continuation、继承其 lineage 的 autonomous continuation。后台 auto-refine、cron、heartbeat、detached subagent、其他 prompt 的排队 action MUST NOT 阻塞该 prompt 的结算，其后续产生的消息 MUST NOT 重开已终态的 outcome。

#### Scenario: 同步 tool 调用阻塞结算

- WHEN run 的 assistant turn 发起 tool 调用且 tool 尚未返回
- THEN outcome 不产生；tool 返回、后续 turn 结束且无 retry/continuation 后才产生 `completed`

#### Scenario: retry 不提前结算

- WHEN run 因 provider 错误进入 retry 等待窗口，随后 retry 成功完成
- THEN outcome 在 retry 完成后才产生，状态 `completed`，期间只有一个 `promptId`、可能出现多个 `agent_end`

#### Scenario: compaction continuation 不提前结算

- WHEN run 结束时调度了 post-compaction continuation（timer 持有）
- THEN 在 continuation 的 run 完成前不产生 outcome；continuation 完成后产生一个 `completed` outcome

#### Scenario: 非 abort 原因取消 continuation 推导为 completed

- WHEN run 正常结束后调度了 post-compaction continuation，随后因排队 continuation 被清空（非 abort、非 dispose）而取消该 continuation
- THEN lease 释放且无 cancel/failure fence，outcome 为 `completed`——主 run 已正常完成，continuation 不再需要；不产生第二个 outcome

#### Scenario: lease 交接无空窗

- WHEN 主 run 的 lease 释放与 retry/compaction continuation 的 lease 获取在同一同步段发生
- THEN tracker 不在交接间隙产生终态；获取新 lease 先于释放旧 lease 的顺序被 session 保证，单测以交错顺序覆盖

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

#### Scenario: abort 推导为 cancelled

- WHEN `session.abort()` 在 run 进行中被调用
- THEN outcome 为 `cancelled`；即使 abort 前已记录 retry 失败，cancel fence 优先

#### Scenario: 终止错误推导为 failed

- WHEN run 以 provider `error` 结束且 retry 已耗尽或不适用
- THEN outcome 为 `{ status: "failed", failure: { reason: "run_error" } }`

#### Scenario: 二次变更为 no-op

- WHEN 终态后调用 `requestCancel`、`recordFailure`、`recordFinalMessage`
- THEN 不抛错、outcome 不变、不再次 emit

#### Scenario: 终态后 acquire 抛错

- WHEN 终态后对同一 `promptId` 调用 `acquire`
- THEN 抛出错误，记录保持终态

#### Scenario: admission 后未执行即被取消

- WHEN prompt 已 admission（有 promptId）但在执行前被 coalesce/拒绝/清队
- THEN 产生 `cancelled` outcome，不留下永久 `settling` 记录

### Requirement: PromptOutcome 契约

`PromptOutcome` MUST 包含 `promptId`、`status`（`completed | needs_user_input | unresolved_advisor | failed | cancelled`）、`advisor`（`passed | fail_open | unresolved | disabled | pending`）、`finalMessageIds: string[]`（session entry id）、`sessionEpoch`、`traceGeneration`，`status === "failed"` 时 MUST 含 `failure.reason`；`pendingQuestions` 在本 change MUST 不出现。类型定义 MUST 一次完整导出，供 daemon/RPC/JSON/ACP 共用。

#### Scenario: 类型完整且单一来源

- WHEN daemon-protocol、rpc-client、acp-meta 引用 outcome 类型
- THEN 均从 `core/prompt-settlement.ts` 导入同一 `PromptOutcome`，不各自复制枚举

#### Scenario: finalMessageIds 只含 lineage 内 assistant 消息

- WHEN 一个 prompt 的 lineage 经历 run → retry → compaction continuation 共追加 3 条 assistant message entry
- THEN `finalMessageIds` 恰为这 3 个 entry id 且按追加顺序

### Requirement: traceGeneration 计数

`traceGeneration` MUST 在 admission 时为 0，每当该 prompt 所属的 run（当前执行 run 的 owner；run 结束边界上为刚结束 run 的 prompt）完成一次 compaction（threshold 或 requested）时 +1，并在终态 outcome 中固定；本 change 不消费该值。

#### Scenario: compaction 计数

- WHEN prompt 的 run 触发一次 threshold compaction 并经 continuation 完成
- THEN outcome 的 `traceGeneration === 1`；无 compaction 的 prompt 为 0

#### Scenario: 后台 compaction 不计入他人

- WHEN prompt A 已终态后，session 因另一 prompt B 发生 compaction
- THEN A 的 outcome `traceGeneration` 不变，B 的计数 +1

### Requirement: session 结算 API 与事件

`AgentSession` MUST 提供 `promptAndSettle(text, options?: PromptOptions & { promptId?: string }): Promise<PromptOutcome>`（options 与 `promptAndWait` 同集，含 `streamingBehavior`、`internalPrompt`、`suppressAutonomousContinuation`）、`waitForPromptOutcome(promptId): Promise<PromptOutcome>`、`getPromptOutcome(promptId): PromptOutcome | undefined`，并在终态产生时发出 session event `{ type: "prompt_outcome", outcome }`；现有 `promptAndWait`、`AgentMessageOutcome`、`agent_end` 的语义与时序 MUST NOT 改变。

#### Scenario: promptAndSettle 等到终态

- WHEN 经 `promptAndSettle` 提交的 prompt 经历 retry 后完成
- THEN 返回的 Promise 在 `prompt_outcome` 事件发出的同一时刻 resolve 为该 outcome

#### Scenario: admission 失败即 reject

- WHEN `promptAndSettle` 的 admission 被拒绝（session disposing 或等价 follow-up 已排队）
- THEN Promise reject，错误与 `promptAndWait` 在同条件下的错误一致，且不产生 `prompt_outcome` 事件

#### Scenario: 已终态立即可得

- WHEN 对已终态的 `promptId` 调用 `waitForPromptOutcome` 或 `getPromptOutcome`
- THEN 前者立即 resolve、后者同步返回同一 outcome 对象；对 released 且已终态的记录（dispose 后）两者行为相同；对未知 `promptId`，前者 reject、后者返回 `undefined`

#### Scenario: promptAndWait 不变

- WHEN 现有调用方使用 `promptAndWait`
- THEN 其 resolve 时机仍为 `AgentMessageOutcome.completion` settle 时刻，不等待 post-compaction continuation

### Requirement: dispose 结算

`dispose()` MUST 对全部未终态且未 released 的 prompt 原子结算 `cancelled`（`outcome.failure` 不填；原因 `session_disposed` 只写入 ledger 记录的 `settleReason`）并标记 released fence；`promptAndSettle` 的 waiter MUST 得到 `cancelled` outcome 而非悬空。

#### Scenario: dispose 时在途与排队 prompt 各结算一次

- WHEN session 存在一个执行中 prompt 与两个排队 prompt 时 `dispose()`
- THEN 三者各产生一次 `cancelled` outcome（`failure === undefined`）、各发出一次 `prompt_outcome`、ledger 各写一条 `released: true, settleReason: "session_disposed"` 的终态；重复 `dispose()` 为 no-op
