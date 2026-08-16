# Prompt Settlement 架构设计

> 状态：架构方向已接受，尚未进入实现；本文从 advisor-architecture.md 拆出，作为 Advisor 与通用 `ask_user` 的公共结算地基，可先于两者独立交付
>
> 日期：2026-08-16
>
> 范围：`packages/coding-agent` 的 TUI、daemon、Print、JSON、RPC 与 ACP 入口
>
> 关联：[Advisor 架构设计](advisor-architecture.md)、[通用 `ask_user` 会话能力](ask-user.md)

## 1. 结论

`agent_end` 保持“一次底层 Agent run 结束”的现有含义，不被当作外部请求结算。真正的请求结算由新增的 session 级 `PromptSettlementTracker` 承担：稳定的 `promptId` 在 session 接受输入时创建，所有会影响该 prompt 最终结果的后继工作都继承该 lineage，直到产生结构化 `PromptOutcome` 终态。

当前 `agent-loop.ts` 在 provider `error`、用户/信号 `aborted`、`shouldStopAfterTurn` 返回 true，或 `shouldStopBeforeTurn` 建立停止边界时，都会直接发出 `agent_end`；threshold/requested compaction 及其 continuation 可能跨越多个 Agent run。因此“请求模式只有一个最终 `agent_end`”不成立：`agent_end` 是 run 终态，`PromptOutcome` 才是 prompt 终态。现有 `AgentMessageOutcome`、`promptAndWait(): Promise<void>` 和 `session.waitForIdle()` 都只能作为实现素材，不能原样充当该契约。

settlement 是 Advisor 与 `ask_user` fallback 的公共地基，但它独立成立：当前 RPC client 的 `promptAndWait` 在第一个 `agent_end` 就 resolve，retry 与 compaction continuation 的结果今天就已经被请求方丢失。引入 `PromptOutcome` 修复这一层，与是否启用 Advisor 无关，因此本切片可以先于 Advisor 与 `ask_user` 单独交付和验收。

结算状态机属于可确定、可用状态机测试的工程问题；纯内部队列与状态机可通过 feature flag 回退。daemon/RPC/JSON 的 wire 变化一旦发布，回退成本较高，必须独立做 capability 或版本治理。

## 2. 生命周期分层

Prime 需要区分四层生命周期：

| 层级 | 开始 | 结束 | 含义 |
| --- | --- | --- | --- |
| Turn | `turn_start` | `turn_end` | 一次 assistant 响应及其工具调用、工具结果 |
| Agent run | `agent_start` | `agent_end` | 从一次外部触发开始，到工具链、steer、follow-up 等内部续跑全部结束 |
| Prompt settlement | session 接受一个 prompt | 产生终态 `PromptOutcome` | 该 prompt 所有影响结果的后继工作已结束，最终 trace 已通过 Advisor，或 Advisor 已按有界规则退出 |
| 外部请求/任务结算 | 模式入口接收一个或多个 prompt | 模式向调用方宣告完成 | 该模式组合的全部 prompt outcome 与 headless gate 已完成 |

当前一次典型 Agent run 是：

```text
prompt / trigger
  -> agent_start
  -> turn_start
  -> assistant 流式生成
  -> 可能执行工具并追加 tool result
  -> turn_end
  -> 判断是否因工具、steer、follow-up 等继续
       -> 是：进入下一 turn
       -> 否：agent_end，得到候选结果
```

但 `agent_end` 不是 session 结算：provider retry、threshold/requested compaction 及其 continuation 都可能建立新的 Agent run。session 级结算流程是：

```text
prompt accepted -> PromptSettlement(admitted)
  -> 一个或多个 main Agent run / retry / compaction continuation
  -> Advisor review / correction / re-review（启用时）
  -> 没有该 prompt 所属的待执行后继工作
  -> Advisor 已覆盖最终 trace、有界 fail-open，或该终态不等待审查
  -> PromptOutcome(terminal)
```

修正 turn 会再次进入同一流程。TUI 可以在 `PromptOutcome` 前显示候选回答并继续交互；settlement 是请求方的结算契约，不是 TUI 的调度状态。

## 3. `PromptSettlementTracker`

当前 `AgentSession` 已有按 `agentMessageId` 记录的 `AgentMessageOutcome`，但它只区分 prompt 的 `delivery` 和当前 turn/action 的 `completion`，完成后立即删除，返回值也是 `Promise<void>`。它不是真正的结算，不能直接改名复用。

首版应新增独立的 `PromptSettlementTracker`。稳定的 `promptId` 在 session 接受输入时创建，所有会影响该 prompt 最终结果的后继工作都继承该 lineage：

- 主 Agent run 及其普通 continuation；
- provider retry；
- threshold/requested compaction 与 post-compaction continuation；
- 属于该 prompt 的 goal/autonomous/headless gate continuation；
- Advisor review、修正、反驳复审和有界 fail-open（启用时）。

结算范围只包含会改变本次最终回答的 prompt-owned work：主 Agent 正在同步等待的 tool/子 Agent 仍属于当前 run，因而自然包含；后台 auto-refine、独立 cron/heartbeat 和 detached subagent 明确排除。被排除的后台工作即使后来产生消息，也只能建立新的 session work/prompt outcome，不能重新打开已经终态化的旧 outcome。

普通 session action 可以先完成并从 ActionStore 释放，settlement record 继续存在；不能为了等待 Advisor 长期占用 action scheduler。结算也不能依赖全局 `session.waitForIdle()`，因为它既可能被无关 prompt、cron 或 heartbeat 拖住，也未必覆盖 timer 持有的 post-compaction continuation。

同 session 后续 prompt 的成功 admission 封口前一 prompt 的修正循环：已在途的修正 run/continuation 自然完成并复审，但此后不再为前一 prompt 启动新的 Advisor 修正周期；前一 prompt 在 review coverage 追平后按结果原子结算——复审静默为 `completed`，仍有未清除的 `concern`/`blocker` 为 `unresolved_advisor`。封口后迟到的修正（如 blocker steer 进新 prompt 的 run）属于新 prompt 的时间线，旧终态不重开。该规则对所有模式统一：Print 按现有顺序逐条等待 outcome，正常路径不会触发封口；主动流水线提交的 RPC/JSON 客户端接受同样语义。用户提交新 prompt 本身即对旧候选结果的显式处理，系统不为其保留无限期的修正债务。

## 4. `PromptOutcome` 契约

一个 prompt 的 `completed` 终态只在以下条件同时成立时原子产生：

1. 没有该 `promptId` 所属的在途或已调度后继工作；
2. Advisor 已审查到该 prompt 最终 trace generation，或明确进入有界 `fail_open`；Advisor 未启用时该条件视为满足，`advisor` 字段记 `disabled`；
3. 没有待执行的 Advisor correction；
4. 最终消息范围和结构化状态已固定。

建议的逻辑结果：

```ts
interface PromptOutcome {
  promptId: string;
  status: "completed" | "needs_user_input" | "unresolved_advisor" | "failed" | "cancelled";
  advisor: "passed" | "fail_open" | "unresolved" | "disabled" | "pending";
  finalMessageIds: string[];
  pendingQuestions?: PendingUserQuestion[];
  sessionEpoch: number;
  traceGeneration: number;
}
```

具体字段仍需在实现计划阶段核对现有 message identity 和 wire 类型；`PendingUserQuestion` 必须保留所属 `toolCallId`、原始 `question`、`options` 及其顺序，但不得再增加模型生成的 question identity。`pendingQuestions` 只在 fallback 形成 `needs_user_input` 终态时出现，并按 assistant/问题原始顺序保存当前及尚未执行的 ask；live responder 全部回答时不产生中间 outcome（见 [ask-user.md](ask-user.md)）。核心要求是终态 outcome 必须携带状态和关联 ID，而不是仅通过 Promise resolve 或最后一条文本反推成功。

### 4.1 `status` 与 `advisor` 字段的组合矩阵

`advisor` 表示结算时刻的审查状态，不允许用 `passed` 冒充“未启用”或“未等待”：

| status | 终态条件 | 合法 `advisor` 值 |
| --- | --- | --- |
| `completed` | 上述四条件全部成立 | `passed`、`fail_open`、`disabled` |
| `unresolved_advisor` | 修正循环被封口且问题未清除，条件 1、4 成立 | `unresolved` |
| `needs_user_input` | 条件 1、4 成立；不等待条件 2、3 | `passed`、`fail_open`、`unresolved`、`disabled`、`pending` |
| `cancelled` | abort fence 已取消 prompt-owned work，条件 4 成立 | 同上 |
| `failed` | run 以错误终止且无可继续路径，条件 1、4 成立 | 同上 |

- `disabled`：Advisor 未启用。
- `pending`：该终态不等待审查，且结算时 review coverage 尚未追平最终 trace；只对非 `completed` 终态合法。
- `unresolved`：修正循环被封口且问题未清除。封口事件包括达到 `maxCorrectionCycles`、同 session 后续 prompt 的成功 admission（见第 3 节）与 `/advisor off`；三者共用同一状态，不各自增设枚举值。
- `needs_user_input` 与 `cancelled` 明确不等待 Advisor：把问题交给用户、执行用户的停止意图，都优先于审查完成。审查一段“正在等用户回答”的半截 trace 没有意义，也不得因此推迟向用户展示问题。
- 结算后迟到的 Advisor finding 不重开 outcome，按 Advisor 文档的迟到 finding 规则处理（终态迟到 `concern` 只保留卡片，`blocker` 视 abort fence 与运行模式决定是否唤醒）。

## 5. 各运行模式的结算契约

各模式的 Advisor 状态反馈与 `ask_user` 交互细节分别见 [advisor-architecture.md](advisor-architecture.md) 与 [ask-user.md](ask-user.md)；本节只定义结算本身。

### 5.1 TUI（包括 daemon 托管）

- settlement 不是 TUI 的忙闲或输入闸门：候选 `agent_end` 后立即显示回答，输入、提交和后续 prompt 执行保持现有行为，不新增 settlement 专用输入队列或 prompt-start fence。
- `PromptOutcome` 用于 daemon/客户端的状态查询、恢复与诊断，不引入前台等待。

### 5.2 Print

- 每个输入通过 session 级 prompt outcome 等待其全部结果相关后继工作；多个 `messages` 按现有顺序组合等待。
- stdout 只输出最终 settled 的主 Agent 文本，不输出被 Advisor 推翻的中间候选文本。
- headless autonomous gate 必须加入当前外部请求的 settlement lineage，或作为子 prompt outcome 被上层显式组合；不能退回全局 idle 猜测。
- 当前 print-mode 返回值只有 `0` 正常与 `1` 失败语义（信号退出 129/130/143 是独立路径），并会依次发送全部 `messages`。引入 `PromptOutcome(needs_user_input)` 后必须在该点短路剩余输入，并增加专用退出码 `2`：它表示需要外部输入，不是模型或运行时失败。输出完整问题后停止发送本次调用中尚未处理的后续 `messages`，避免越过未决问题；后续调用回答并正常结算后恢复现有 `0` 成功、`1` 失败语义。
- 进程退出后，该请求被标记为 released；Advisor 恢复不得追审并唤醒旧工作。

### 5.3 JSON

- 可以流式输出主 Agent、多个 `agent_end` 与 Advisor 的非终态事件；`agent_end` 继续只表示底层 run 结束。
- 新增携带 `promptId` 的结构化 `prompt_outcome` 作为 prompt 结算，不抑制或改写现有 `agent_end`。
- `needs_user_input`、`advisor_unavailable`、`unresolved_advisor` 使用结构化事件或字段表达，不依赖 stderr 文本解析。
- JSON 在写出完整的结构化 `prompt_outcome(needs_user_input)` 后同样以退出码 `2` 结束，并停止本次剩余 `messages`。事件是机器可读真值，退出码只是进程级快速分类；`0` 仍只表示本次请求全部完成，`1` 表示失败。
- 新结构化状态实施前必须审计现有消费者是否允许未知事件；若是 closed union，仍需 schema/version 处理，不能假定为无害的 additive change。

### 5.4 RPC

- `prompt` command 继续在完成提交后即时返回 ACK，不把现有双向协议改造成长时间同步调用。
- 协商支持 settlement 的 ACK 返回或确认一个稳定 `promptId`；后续 `prompt_outcome` 用该 ID 关联。
- 当前 RPC client 的 `promptAndWait` 在第一个 `agent_end` 就 resolve，不能作为真正结算；新 client 必须等待对应 `prompt_outcome`。
- `agent_end` 和其他流式事件保持现有 run 语义，不因 settlement 被隐藏。

### 5.5 ACP

- `session/prompt` 等待初始 prompt outcome，并将 headless autonomous gate 的子 outcomes 组合进同一次 ACP 请求，然后才返回。
- 保持 ACP 标准响应有效；Prime 专属状态放入可忽略的 namespaced `_meta` 或协议允许的扩展位置。
- 不要求不了解新契约的 ACP 客户端实现新的启动前握手，也不让可选元数据阻塞会话。

## 6. 持久化与恢复

daemon worker 重启时，未结算 prompt 必须恢复。session artifact 中持久化最小 settlement ledger：`promptId`、状态、session epoch、trace generation/review coverage、修正次数、fallback pending question queue、逐项已答 answer blocks，以及 abort/released fence。Promise、timer、owned-work lease、live `ask_user` responder request、transport request ID 和在途模型调用不持久化；重启后结合主 session JSONL、session action recovery 和 Advisor 私有 transcript 重建可重建部分。

恢复规则：

- 已终态 outcome 不可重开。
- 未终态且未 abort/released 的 outcome 重新核对 trace coverage，必要时重新发起 Advisor review。
- 重启前的在途模型结果全部按 epoch 作废，不能迟到写入新 runtime。
- 原等待连接断开可以报告 transport failure，但 outcome 继续由 daemon 完成；重连客户端可按 `promptId` 查询或订阅最终状态。
- 无法证明 lineage 完整时不得误报 `completed`，应进入结构化 `failed` 或明确 fail-open 路径。

pending question queue 的逐项持久化、重连展示与 admission 原子消费规则见 [ask-user.md](ask-user.md)；Advisor 私有 transcript 与 review 真值的持久化见 [advisor-architecture.md](advisor-architecture.md)。

## 7. 协议兼容性

| 变化 | 建议分类 |
| --- | --- |
| daemon/RPC `promptId` 与 `prompt_outcome` | capability-gated；若无协商机制则版本化 |
| JSON 新 `prompt_outcome` 与结构化状态 | 先审计消费者；可能需要 schema revision |
| ACP namespaced `_meta` 中的 settlement 状态 | 在 ACP 允许未知 metadata 的前提下 backward-compatible |
| Print 退出码 `2` | 行为变化只在 `needs_user_input` 出现时触发；文档化并覆盖脚本兼容测试 |

settlement 不改变现有 `agent_end` 的 run 终态含义，而是增加更高层的 prompt settlement。每个实际 daemon wire change 仍必须同步更新 `DAEMON_SCHEMA_REVISION`、命令/事件兼容映射，并覆盖 new-client/old-daemon 与 old-client/new-daemon；只有不兼容变化或启动开始依赖新行为时才按现有规则评估 `DAEMON_PROTOCOL_VERSION` bump。

## 8. 测试与验收

使用 `packages/coding-agent/test/suite/harness.ts` 和 faux provider，不调用真实 provider、API key 或付费 token。至少覆盖：

1. Prompt settlement lineage：当前 action completion、retry、compaction continuation、Advisor review/correction 都正确继承同一 `promptId`；无关 prompt、cron、heartbeat 和后台维护不误入该结算。
2. 结算范围：同步 tool/子 Agent 会阻塞 outcome；auto-refine、cron/heartbeat、detached subagent 不阻塞，且迟到结果不能重开终态 outcome。
3. 组合矩阵：`completed` 严格执行四条件；`needs_user_input`/`cancelled`/`failed` 不等待 Advisor 条件即结算，`advisor` 字段如实记录 `disabled`/`pending`/当时 coverage，不得用 `passed` 冒充未审查。
4. 竞态：最后一个 owned-work lease 释放与新 correction/compaction continuation 建立并发时，outcome 只能在 generation 稳定且 review coverage 追平（或该终态不等待审查）后原子完成。
5. 重启恢复：未终态 settlement 从 ledger、session JSONL 和 action recovery 重建；旧在途结果失效，终态 outcome 不重开，重连可查询最终状态。
6. 模式结算：Print、JSON、RPC、ACP 在必须修正时不提前完成，允许多个 `agent_end`，只产生一个对应的 `prompt_outcome`；RPC ACK 仍即时返回，旧 `promptAndWait` 行为标记为不充分并由新等待逻辑替代。
7. 退出码：Print/JSON 的 `needs_user_input` 在完整输出问题或结构化 outcome 后返回 `2`，本次后续 `messages` 未发送且保持原顺序；正常完成仍为 `0`、模型/运行时失败仍为 `1`，后续独立调用回答 pending 后可正常返回 `0`。
8. 协议：daemon/RPC 能力协商和双向跨版本场景通过。
9. 封口规则：prompt B 成功 admission 后，A 的在途修正自然完成且不再启动新周期；A 按 coverage 追平后的结果结算 `completed`/`unresolved_advisor`；steer 进 B 的迟到修正属于 B 的时间线，A 终态不重开；Print 顺序路径不触发封口，RPC 流水线提交触发并得到相同语义。

## 9. 风险与反证信号

| 风险 | 早期信号 | 缓解 |
| --- | --- | --- |
| 各入口行为漂移 | TUI 可修正但 JSON/RPC 提前结束 | 共同 `PromptSettlementTracker` 与跨模式契约测试 |
| outcome 被全局 idle 污染 | 无关 cron/heartbeat 导致等待或过早释放 | 稳定 `promptId`、owned-work lineage、generation 与原子终态 |
| worker 重启丢失结算 | 主任务恢复但结算状态消失或重复执行 | 最小 settlement ledger、epoch 作废、JSONL/action recovery 重建、终态不可重开 |
| 协议演进破坏老客户端 | 老客户端无法 attach/start | capability gate、schema map、双向兼容测试、本地降级 |

## 10. Prime 源码事实依据

本设计依赖以下当前源码契约；实施前若这些契约变化，应先回到本设计重新核对：

- `packages/agent/src/agent-loop.ts`：正常 turn 在工具结果追加并发出 `turn_end` 后调用 `shouldStopAfterTurn`；provider `error`、用户/信号 `aborted`、`shouldStopAfterTurn` 返回 true 或 `shouldStopBeforeTurn` 建立停止边界时都会直接发出 `agent_end`。
- `packages/coding-agent/src/core/agent-session.ts`：当前 `AgentMessageOutcome.completion` 在 action 完成后立即释放；它等待配置允许的 retry chain 和 agent event queue，但 post-compaction continuation 由 timer 另行调度，不能直接视为最终 prompt outcome。
- `packages/coding-agent/src/core/agent-session.ts` 与 package-manager recovery：session action recovery 已携带 `agentMessageId`，可作为重建 prompt lineage 的现有锚点，但当前内存 `_agentMessageOutcomes` 本身不会跨 runtime 保存。
- `packages/coding-agent/src/modes/print-mode.ts` 与 `acp/`：先调用 `promptAndWait`，再单独调用 headless completion，证明外部请求本来就可能组合多个 session 阶段。
- `packages/coding-agent/src/modes/print-mode.ts`：当前返回值只有 `0` 正常与 `1` 失败语义，并会依次发送全部 `messages`；引入 `PromptOutcome(needs_user_input)` 后必须在该点短路剩余输入，并增加专用退出码 `2`，不能让脚本把未结算任务当作成功。
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts` 与 `rpc-client.ts`：`prompt` response 只是即时 ACK，当前 client 的 `promptAndWait` 在第一个 `agent_end` resolve，无法表达跨 run 的结算。
- `packages/coding-agent/src/core/agent-session-config.ts`：执行模式是 `interactive | print | json | rpc | acp`；daemon 是承载/传输边界，不是替代这些语义的第六种 Agent execution mode。
- `packages/coding-agent/src/modes/daemon/daemon-protocol.ts`：当前 protocol/version 常量和 schema revision 受兼容性规则约束，任何 wire 扩展都必须按 capability 与跨版本测试治理。
