# Spec: prompt-settlement-persistence

## ADDED Requirements

### Requirement: 最小 ledger 持久化

session MUST 以 custom entry（`customType = "prime-agent.prompt-settlement"`）把每个 prompt 的 settlement 记录追加到 session JSONL：admission 时一条 `status: "settling"`，终态或 released 时一条终态记录；记录 MUST 含 `promptId`、`status`、`sessionEpoch`、`traceGeneration`、`finalMessageIds`、`cancelRequested`、`failureReason?`（仅 `failed` 记录，等于 `outcome.failure.reason`）、`settleReason?`（`settleAll` 的 reason，如 `session_disposed`/`runtime_restarted`；经 `settleAll("failed")` 产生的 failed 记录有 `failureReason === settleReason`；经 run 内 `recordFailure("run_error")` 产生的 failed 记录只有 `failureReason`、无 `settleReason`；`cancelled` 记录的 reason 不回流到 `PromptOutcome`）、`released`、`admittedAt`、`settledAt?`。Promise、lease、timer、transport request id MUST NOT 持久化。

#### Scenario: 正常 prompt 写两条记录

- WHEN 一个 prompt 从 admission 到 `completed`
- THEN JSONL 中该 `promptId` 恰有两条 custom entry：`settling` 与 `completed`，后者的 `finalMessageIds` 与 outcome 一致

#### Scenario: 中途状态不写盘

- WHEN prompt 经历 retry 与 compaction continuation
- THEN 该 `promptId` 仍只有 admission 与终态两条记录

### Requirement: 重启后确定性结算

session 从 JSONL 加载（含 daemon worker 重启）时 MUST 重建 ledger；对 `status === "settling"` 且 `released === false` 的记录 MUST 在构造期（任何 listener 订阅之前）立即原子结算为 `failed`（`failure.reason = "runtime_restarted"`）并追加终态记录；该路径 MUST NOT 发出 `prompt_outcome` 事件（无订阅者），重连客户端经 `get_prompt_outcome` 获取；终态记录 MUST 只读不重开；released 记录 MUST 保持 released、不重新结算（其已持久化的终态照常可查）。不重建 lease、timer 或 action。

#### Scenario: 未终态记录结算为 failed

- WHEN JSONL 含 promptId P 的 `settling` 记录（无终态），session 重新加载
- THEN `getPromptOutcome(P)` 返回 `{ status: "failed", failure: { reason: "runtime_restarted" } }`，JSONL 追加一条 `failed` 记录；加载后注册的 listener 收不到该 prompt 的 `prompt_outcome` 事件

#### Scenario: 终态记录不重开

- WHEN JSONL 含 promptId P 的 `completed` 记录，session 重新加载
- THEN `getPromptOutcome(P)` 返回 `completed`，不追加任何记录、不发出事件

#### Scenario: released 记录保持

- WHEN JSONL 含 promptId P 的 `released: true` 记录（dispose 写入），session 重新加载
- THEN `getPromptOutcome(P)` 与 `waitForPromptOutcome(P)` 均给出该记录对应的 `cancelled` 终态（`failure` 为空，记录 `settleReason === "session_disposed"`），不追加记录

#### Scenario: 同 promptId 多条以最后一条为准

- WHEN JSONL 中同一 `promptId` 先有 `settling` 后有 `cancelled`
- THEN 重建结果为 `cancelled`，不触发 `runtime_restarted` 结算

### Requirement: 旧 epoch 在途工作作废

重启后由 action recovery 恢复执行的 action MUST 分配新的 `promptId`，MUST NOT 继承重启前记录的 `promptId`；重启前的任何在途模型结果 MUST NOT 写入旧 `promptId` 的 outcome。

#### Scenario: 恢复的 action 拿新 promptId

- WHEN 重启前 promptId P 的 action 处于排队状态并被 action recovery 恢复
- THEN P 已为 `failed/runtime_restarted`，恢复执行的 action 获得新的 promptId Q 并独立结算

### Requirement: 重连可查询终态

对同一 session 的任何已知 `promptId`，`getPromptOutcome` 在进程内与经 daemon `get_prompt_outcome` 命令 MUST 返回同一终态；ledger MUST 保留 session 内全部 prompt 的终态记录，不做裁剪。

#### Scenario: 重启后按 promptId 查询

- WHEN 客户端在 daemon worker 重启后以 `get_prompt_outcome { promptId: P }` 查询
- THEN 返回 P 的 `failed/runtime_restarted` outcome；查询未知 id 返回 `outcome: undefined` 而非错误
