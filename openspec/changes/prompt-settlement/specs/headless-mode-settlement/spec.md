# Spec: headless-mode-settlement

## ADDED Requirements

### Requirement: Print/JSON 以 outcome 结算

Print MUST顺序调用 optional `promptAndSettle`：turn等完整 outcome，非 turn等completion得undefined。turn `failed|cancelled` 后 MUST停止发送剩余 messages并跳过 headless gate，随后用现有 transcript/stopReason输出并返回1；`completed`或成功非 turn才继续。输出仍由 transcript选择；0/1与信号码不变，非 turn不伪造 outcome。

#### Scenario: 多个 agent_end 一个 outcome

- WHEN Print 的单条 prompt 经历 retry 与 compaction continuation
- THEN 进程在 continuation 完成后才输出最终文本并退出 `0`；JSON 子模式输出多个 `agent_end` 与恰好一个 `prompt_outcome`

#### Scenario: 失败仍为 1 且 fail fast

- WHEN `initialMessage` 或某条 message 的 turn outcome 为 `failed/run_error` 或 `cancelled`
- THEN Print不发送本次剩余 messages、不进入 autonomous gate；仍从 transcript输出错误并返回1，与现有失败即停止语义一致

#### Scenario: 顺序不变

- WHEN 提供 `initialMessage` 与两条普通 turn `messages`
- THEN 三者按该顺序各自结算后才提交下一条，JSONL 中三条 `settling` 记录按序出现

#### Scenario: Print session command userspace 不变

- WHEN Print 提交 `/goal status` 或其他 session command
- THEN `promptAndSettle` 等到 command completion 后返回 `undefined`，text 模式仍输出 `SessionSlashCommandResultMessage` 并按原 success/severity 返回 0/1；JSON/ledger 不产生伪造的 `prompt_outcome`/settlement record

### Requirement: headless gate 显式组合

`waitForHeadlessCompletion(session)` 的单参数签名 MUST 不变。调用方 MUST 先通过 optional `promptAndSettle` 等完输入；internal gate continuation MUST 是 turn并返回 outcome，否则 fail closed；自由函数 MUST NOT 再等待 global idle。public daemon command/AgentConnection wire MUST 不变，但 supervisor MUST 按原 public client capability在 private worker envelope传 `callerPromptSettlement`，直连 worker MUST 由本地 client能力生成；worker MUST 仅在 false时执行一次 legacy idle，MUST NOT 从固定 supervisor-worker subscription能力推断调用方。

#### Scenario: gate continuation 各自结算

- WHEN autonomous gate 失败两次后通过
- THEN 产生三个不同 `promptId` 的 outcome（初始 + 两次 continuation），gate 循环在第三个 outcome 后返回

#### Scenario: daemon 托管路径行为一致

- WHEN 经 daemon 连接的 Print 运行同一 gate 失败两次后通过的场景
- THEN `wait_for_headless_completion` 命令形状不变，daemon 侧产生同样三个 outcome，客户端得到相同的 `AgentAutonomousStatus`

#### Scenario: 无关后台工作不拖住 continuation 结算

- WHEN gate continuation 执行期间 cron/heartbeat 正在运行
- THEN continuation 的 outcome 一到即进入下一轮判定，不等待后台工作 idle

#### Scenario: 旧客户端路径行为不变

- WHEN 未声明 `prompt_settlement` 的客户端经 daemon 以 `prompt_and_wait` 后调用 `wait_for_headless_completion`
- THEN supervisor/直连 worker根据该原始调用方把 `callerPromptSettlement: false` 传给 handler，handler在进入自由函数前执行一次 `waitForIdle`，结果同现状

#### Scenario: capable client 不等待全局 idle

- WHEN 声明 `prompt_settlement` 的客户端已经等到初始 outcome，随后调用 `wait_for_headless_completion`，且无关 cron/heartbeat 仍在运行
- THEN supervisor/直连 worker按该原始调用方传 `callerPromptSettlement: true`，handler跳过 legacy idle；同一 worker上的 old client仍走自己的 false分支，二者不串

### Requirement: ACP session/prompt 以 outcome 结算

ACP `session/prompt` MUST 通过 optional `promptAndSettle` 等输入；仅 `completed` turn或成功非 turn MUST 进入 headless gate。`failed` turn MUST 按现有 turnFailure抛 JSON-RPC error（除非本地 cancel），`cancelled` MUST 返回 cancelled，二者 MUST NOT 进入 gate。只有定义 outcome 时 MUST 附 meta；标准 failure/stopReason 逻辑 MUST 不变。

#### Scenario: retry 期间不提前返回

- WHEN ACP prompt 的 run 进入 retry 并成功
- THEN `session/prompt` 在 retry 完成后返回 `end_turn`，`_meta.promptOutcome.status === "completed"`

#### Scenario: 取消仍为 cancelled且不进 gate

- WHEN ACP `session/cancel` 在 turn run 中触发
- THEN 响应 stopReason cancelled、meta outcome cancelled，且不启动 headless gate continuation

#### Scenario: failed turn保持 ACP error

- WHEN turn outcome为 failed/run_error且不是本地 cancel
- THEN ACP沿现有 turnFailure返回 JSON-RPC error，不进入 gate，不把结构化 outcome误当成功 end_turn

#### Scenario: ACP 非 turn userspace 不变

- WHEN ACP `session/prompt` 执行 `/compact`、`/refine` 或其他非 turn 输入
- THEN 它等待现有 completion 后返回原有合法 `stopReason`，不误用上一条 assistant 失败，且 `_meta` 省略 `promptOutcome`
