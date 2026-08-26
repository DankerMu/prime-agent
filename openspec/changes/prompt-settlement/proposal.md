# Prompt Settlement：session 级 prompt 结算

## Why

`agent_end` 只是"一次底层 Agent run 结束"，不能代表外部请求结算。现状有两类缺口：`RpcClient.promptAndWait` 在首个 `agent_end` resolve，连后续 retry run 都不覆盖（`rpc-client.ts:551/573`）；session 级 `promptAndWait` 已通过 `waitForRetry()` 覆盖配置允许的 retry chain，但不覆盖 100ms timer 持有的 post-compaction continuation，Print/JSON/ACP 只能在逐条 `promptAndWait` 后靠 `waitForHeadlessCompletion` 的全局 `waitForIdle` 猜测，既可能提前，也可能被无关 cron/heartbeat/其他队列拖住。`packages/coding-agent/docs/prompt-settlement.md` 因此把真正的请求结算定义为 session 级 `PromptSettlementTracker` 产生的结构化 `PromptOutcome`。它是 Advisor（主题 4）与通用 `ask_user`（主题 3）的公共地基，但独立成立，可先行交付。

## What Changes

- 新增 session 级 `PromptSettlementTracker`：session accept 外部 turn 输入后创建稳定 `promptId`；该 prompt 的主 run、provider retry 等待窗口、threshold/requested compaction 的 post-compaction continuation、session 内部为其排队的 autonomous continuation 都以 **owned-work lease** 继承 lineage；`"all"` batching 让多个 prompt 共享一次 run 时，对全部独立 owners 逐 id 持有同类 lease，不合并 identity。最后一个 lease 释放时原子产生终态 `PromptOutcome`，settle-once，终态不重开。
- 结算范围：主 run 同步等待的 tool/子 Agent 自然包含；后台 auto-refine、cron/heartbeat、detached subagent、以及任何经公共 `prompt()` 入口进入的 host 侧 prompt（含 headless gate continuation）都不并入——后者各自拿新 `promptId`，由模式入口显式组合。
- `PromptOutcome` 契约按设计 §4 **完整定义**（`status` 五值、`advisor` 五值、`finalMessageIds`、`sessionEpoch`、`traceGeneration`、`pendingQuestions?`），wire 形状一次定型；本 change **可达**终态仅 `completed | failed | cancelled`，`advisor` 恒为 `disabled`。
- `AgentSession` 新增 `promptAndSettle(): Promise<PromptOutcome | undefined>`：accepted turn 等完整 settlement 并返回 outcome，现有 `sessionCommand`/`extensionCommand`/`handled` 非 turn输入继续等各自 completion 后返回 `undefined`，不分配 promptId、不写 ledger、不发 outcome。另增 `waitForPromptOutcome`/`getPromptOutcome` 与 turn-only `prompt_outcome` event；现有 `promptAndWait`/`AgentMessageOutcome`/`agent_end` 语义时序不变。
- 最小 settlement ledger 持久化到 session JSONL（custom entry）：`promptId`、状态、`sessionEpoch`、`traceGeneration`、abort/released fence。runtime 重启后，未终态且未 released 的记录原子结算为 `failed`（`failure.reason = "runtime_restarted"`）；终态记录不重开；重启前在途结果按 epoch 作废。不做 lineage 重建（后续增强）。
- 模式入口用统一等待 API：普通 turn等 outcome，非 turn等现有 completion；failed/cancelled turn fail fast，不发送剩余 Print messages、不进入 gate，ACP保持 error/cancelled语义。completed/非 turn才组合 internal gate outcomes；不再依赖global idle。退出码/stopReason不变。
- daemon/RPC wire：schema17 capability。supervisor在private envelope携带原public caller能力，worker内部产生完整结果，supervisor/直连worker在实际socket send与命令入口逐caller过滤；同worker old/new不串。prompt即时、prompt_and_wait completion，turn才有optional id。RPC ACK另带 `promptSettlement: "supported"` marker区分合法非 turn与旧底层；缺marker明确拒绝。
- `RpcClient.promptAndWait` 语义不变；新增 `promptAndSettle()`，通过 additive `promptSettlement: "supported"` marker 区分 accepted turn、合法非 turn与不支持的底层 daemon：有 id等 outcome，supported无 id返回 undefined，缺 marker明确拒绝。
- JSON 模式：`prompt_outcome` 作为新 session event 直接透传，定性 additive；`docs/json.md` 补事件说明与"消费者必须忽略未知事件类型"的前向兼容承诺。
- ACP：普通 turn 的 `session/prompt` 响应在 namespaced `_meta` 中附 outcome 摘要；非 turn省略该字段；不新增握手、不阻塞不识别元数据的客户端。
- 不加 feature flag：tracker 纯新增；模式入口改等 outcome 本身就是要修的缺陷。

### Non-goals（留给后续主题，逐条列明以防遗漏）

主题 3（`ask_user`）：
- `needs_user_input` 终态的**生产**（tracker 本 change 不产出该 status）；
- `pendingQuestions` / `PendingUserQuestion` 的填充、持久化与重连展示；
- Print/JSON 在 `needs_user_input` 时短路剩余 `messages` 并返回退出码 `2`（设计 §5.2/§5.3）。

主题 4（Advisor）：
- `advisor` 字段取 `passed | fail_open | unresolved | pending` 的任何路径（本 change 恒 `disabled`）；
- `unresolved_advisor` 终态的生产；
- 设计 §3 的封口规则（后续 prompt admission / `maxCorrectionCycles` / `/advisor off` 封口前一 prompt 的修正循环）；
- 设计 §4 条件 2/3（review coverage 追平最终 trace、无待执行 correction）作为 `completed` 前置条件的执行；
- 结算后迟到 finding 的处理；Advisor review/correction/re-review 作为 lease kind 加入 lineage；Advisor 私有 transcript 持久化。

本 change 其他不做：
- 重启后从 session JSONL + action recovery **重建**未终态 lineage 并继续执行（当前一律 `failed/runtime_restarted`）；
- TUI 行为改动（settlement 不作为 TUI 忙闲/输入闸门，TUI 不消费 outcome）；
- 改变 `agent_end`、`promptAndWait`、`AgentMessageOutcome` 任何现有语义；
- 事件流 schema 版本机制。

无 BREAKING 变化：旧客户端不声明 capability 即收不到新 ACK 字段、事件与命令；Print/JSON/ACP 的成功/失败退出语义不变，只是在 retry/compaction continuation 存在时**等得更完整**。

## Capabilities

### New Capabilities

- `prompt-settlement-lineage`：`PromptSettlementTracker` 的 promptId 创建、owned-work lease 继承、结算范围包含/排除、settle-once 终态推导、`PromptOutcome` 契约与组合矩阵、`AgentSession` 结算 API 与 `prompt_outcome` 事件、dispose 行为。
- `prompt-settlement-persistence`：最小 ledger 的 custom entry 持久化、runtime 重启后的 `failed/runtime_restarted` 结算、epoch 作废、终态不重开、released fence。
- `prompt-settlement-wire`：daemon `prompt_settlement` capability、ACK `promptId`、`prompt_outcome` 事件、`get_prompt_outcome` 命令、schema revision 治理与双向跨版本兼容；`AgentConnection.promptAndSettle`、`RpcClient.promptAndSettle`；JSON additive 事件与文档承诺；ACP `_meta` outcome 摘要。
- `headless-mode-settlement`：Print/JSON/ACP 入口以 outcome 结算、headless gate continuation 的显式组合、退出码不变。

### Modified Capabilities

（无——`openspec/specs/` 仅有 `editor-surface-dialog-serialization`，与本 change 无交集。）

## Impact

- 新文件 `packages/coding-agent/src/core/prompt-settlement.ts`（tracker、`PromptOutcome` 类型、ledger 记录类型）。
- `packages/coding-agent/src/core/agent-session.ts`：admission（`_admitSessionInput`/`_createPreparedTurnAction`）打 promptId 与 lineage 标记；action 执行完成、retry 窗口（`_retryPromise` 生命周期）、post-compaction continuation（`_schedulePostCompactionContinue`/`_runScheduledPostCompactionContinue`/`_cancelPostCompactionContinue`）、autonomous threshold continuation 的 lease 挂点；abort/dispose fence；`promptAndSettle`/`waitForPromptOutcome`/`getPromptOutcome`；`prompt_outcome` 事件；ledger custom entry 读写与恢复。
- `packages/coding-agent/src/modes/headless-completion.ts`、`print-mode.ts`、`acp/acp-mode.ts`：以 outcome 结算。
- `packages/coding-agent/src/modes/agent-connection/{types,in-process-agent-connection,daemon-agent-connection}.ts`：`promptAndSettle`。
- `packages/coding-agent/src/modes/daemon/daemon-protocol.ts`、`daemon-mode.ts`、`packages/coding-agent/src/cli/daemon-command.ts`：capability、ACK 字段、事件、命令、schema revision、兼容映射。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`、`rpc-client.ts`：ACK `promptId`、`prompt_outcome` 转发、`promptAndSettle`。
- `packages/coding-agent/docs/json.md`、`docs/prompt-settlement.md`（状态行更新为"切片 1 实施中"）。
- 依赖方：主题 3/4 在本 tracker 上扩展（新增 lease kind 与终态生产者），不改本 change 的 wire 形状。
- 必读设计文档：`packages/coding-agent/docs/prompt-settlement.md`（全文，§3/§4 为 tracker 契约，§5 为模式契约，§6 为持久化，§7 为协议治理，§8 为验收）。
