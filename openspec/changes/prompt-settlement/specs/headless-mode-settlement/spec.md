# Spec: headless-mode-settlement

## ADDED Requirements

### Requirement: Print/JSON 以 outcome 结算

Print（text 与 json 子模式）MUST 对 `initialMessage` 与每条 `messages` 使用 `promptAndSettle` 并等待其 `PromptOutcome`，按现有顺序逐条进行；retry 与 post-compaction continuation 的结果 MUST 包含在等待范围内；退出码 MUST 保持 `0` 成功、`1` 失败、信号 `129/130/143` 不变。

#### Scenario: 多个 agent_end 一个 outcome

- WHEN Print 的单条 prompt 经历 retry 与 compaction continuation
- THEN 进程在 continuation 完成后才输出最终文本并退出 `0`；JSON 子模式输出多个 `agent_end` 与恰好一个 `prompt_outcome`

#### Scenario: 失败仍为 1

- WHEN prompt 的 outcome 为 `failed/run_error`
- THEN stderr 输出错误、退出码 `1`，与现有 `stopReason: "error"` 判定一致

#### Scenario: 顺序不变

- WHEN 提供 `initialMessage` 与两条 `messages`
- THEN 三者按该顺序各自结算后才提交下一条，JSONL 中三条 `settling` 记录按序出现

### Requirement: headless gate 显式组合

`waitForHeadlessCompletion(session)` 签名 MUST 保持不变（daemon `wait_for_headless_completion` 命令与 `AgentConnection.waitForHeadlessCompletion()` 不变）；其契约为：调用方在调用前已对自己的每条 prompt 等到终态；函数内每个 gate continuation MUST 以 `promptAndSettle(text, { streamingBehavior: "followUp", internalPrompt: true, suppressAutonomousContinuation: true })` 提交并等待其独立 outcome，MUST NOT 以 `session.waitForIdle()` 作为 continuation 的结算依据；进入 gate 循环前 MUST 恰好执行一次 `session.waitForIdle()`（从现有循环体内提出），仅作为未迁移（old-client）调用方的兜底；循环内 MUST NOT 再调用 `waitForIdle`。

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
- THEN 循环前的一次 `waitForIdle` 兜住首轮判定前的在途 run，gate 判定与结果同现状

### Requirement: ACP session/prompt 以 outcome 结算

ACP `session/prompt` MUST 等待初始 prompt 的 `PromptOutcome`，再经 `waitForHeadlessCompletion` 组合 gate continuation 的 outcome，然后返回；`turnFailure` 与 `acpStopReason` 判定 MUST 保持现有逻辑。

#### Scenario: retry 期间不提前返回

- WHEN ACP prompt 的 run 进入 retry 并成功
- THEN `session/prompt` 在 retry 完成后返回 `end_turn`，`_meta.promptOutcome.status === "completed"`

#### Scenario: 取消仍为 cancelled

- WHEN ACP `session/cancel` 在 run 中触发
- THEN 响应 `stopReason` 为 cancelled，`_meta.promptOutcome.status === "cancelled"`
