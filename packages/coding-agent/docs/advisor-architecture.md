# Advisor 架构设计

> 状态：架构方向已接受，源码边界仍在逐项压测，尚未进入实现
>
> 日期：2026-08-16
>
> 范围：`packages/coding-agent` 的 TUI、daemon、Print、JSON、RPC 与 ACP 入口
>
> 关联：[Prompt Settlement 架构设计](prompt-settlement.md)（公共结算地基，从本文拆出）、[通用 `ask_user` 会话能力](ask-user.md)（独立会话能力，从本文拆出）

## 1. 结论

Advisor 应实现为 root `AgentSessionRuntime` 持有的一等子运行时，而不是 TUI 专属逻辑、daemon sidecar，或绕过 Prime 会话体系直接拼装的轻量 core `Agent`。Advisor 自身是完整但受限、不可寻址的 `AgentSessionRuntime → AgentSession → Agent`，复用 Prime 既有的模型、认证、配置、transcript、compaction、telemetry 和生命周期机制。

主 Agent 每次 `turn_end` 只提交增量审查快照，不同步等待 Advisor。Advisor 使用独立模型上下文串行消费合并后的快照。首版的 review 只在 delta 到达候选终态（请求—响应模式的 terminal checkpoint、TUI 的 terminal flush）时启动：WIP（`in_progress`）阶段只推进 backlog 与 cursor，不启动模型调用。这既避免把“每 turn 都观察”退化为“每 turn 都额外调用一次模型”，也避免最常见的 1–3 turn 短 prompt 为半成品 trace 支付双倍审查成本。审查无问题时保持静默；有问题时返回 `nit`、`concern` 或 `blocker`，由确定性的路由层根据严重度、主 Agent 状态、用户中断状态和运行模式决定何时反馈及是否唤醒主 Agent。

TUI（包括 daemon 托管的 TUI）保持完全异步：候选回答结束后显示 Advisor 当前状态，不阻塞输入、提交或下一 prompt 的执行。实际 finding 采用 oh-my-pi 已验证的“双通道、单消息”方式：同一条结构化 Advisor 消息既进入主 Agent 上下文，也在 TUI 聊天流渲染为独立卡片。主 Agent 已给出终态文本且没有排队工作时，迟到 `concern` 只保留为可见卡片，不唤醒 Agent；迟到 `blocker` 才启动修正。其他情况下按严重度进入旁注或 steering。所有迟到 finding 保留原 `promptId`、`reviewId` 和审查范围，不做过期重判或 rebase。Print、JSON 以及 RPC/ACP 在自然停止路径优先通过现有 `getContinuationMessages` checkpoint 完成同一 run 内修正；跨 run 的请求结算由 session 级 `PromptSettlementTracker` 与结构化 `PromptOutcome` 承担（见 [prompt-settlement.md](prompt-settlement.md)）。`agent_end` 保持“一次底层 Agent run 结束”的现有含义，不再被当作外部请求结算。

Advisor 故障分两类处理：显式启用前若 `advisor.model` 缺失、非法或不可解析，必须 fail-closed，不接受该次启动/session create；成功启用后的模型调用超时、provider 故障或 runtime 崩溃才有界等待并 fail-open。运行时 fail-open 时主结果仍可交付，但必须按模式报告 Advisor 不可用，且恢复后不得追溯唤醒已经释放的旧请求。

当主 Agent 判断必须由用户补充信息或选择时，调用 Prime 通用的 `ask_user` 会话能力（见 [ask-user.md](ask-user.md)）。它独立于 Advisor 存在与交付；Advisor finding 只是主 Agent 做出“修正、反驳或询问用户”判断的上游证据之一。

### 1.1 决策性质

这是一个跨入口的会话生命周期决策，同时包含 AI 输出分级的不确定性：

- 队列、epoch、结算和投递路由属于可确定、可用状态机测试的工程问题。
- “是否有问题、严重度为何”属于概率性判断，必须由结构化输出、去重、修正上限和 fail-open 包住。
- Advisor runtime 及其与主 `AgentSession` 的连接可通过 feature flag 回退，整体可逆性中等。
- daemon/RPC/JSON 的 wire 变化一旦发布，回退成本较高，必须独立做 capability 或版本治理。

## 2. 为什么 `turn_end` 不等于完整任务结束

Turn / Agent run / Prompt settlement / 外部请求结算四层生命周期的定义与结算流程见 [prompt-settlement.md](prompt-settlement.md)。对 Advisor 重要的是：`turn_end` 比 `agent_end` 提供更早、更完整的工具链观察能力，但两者都不是请求结算。

引入 Advisor 后，每个模式都在 `turn_end` 异步提交 trace delta，review 在自然停止边界启动并按交互契约分流：

```text
每次 turn_end
  -> 只提交 trace delta 并推进 backlog，主 Agent 不等待，WIP 阶段不启动 review
  -> 继续工具、steer、follow-up、goal 或 autonomous continuation
  -> Agent 原本即将停止
  -> 请求—响应模式：getContinuationMessages 中进入 Advisor terminal checkpoint
       -> flush 合并 backlog，启动并有界等待审查
       -> 无问题/nit：不创建修正 continuation，agent_end
       -> concern/blocker：返回 Advisor continuation，在同一 run 继续修正
       -> ask_user 且存在 responder：tool call 等待回答，返回正常结果并在同一 run 继续
       -> ask_user 无 responder/连接断开：持久化问题并产生 needs_user_input 结算
       -> 超时/不可用：有界 fail-open 后 agent_end
  -> TUI：只做非阻塞 terminal probe，并立即 flush 最终 backlog
       -> 迟到 finding 已就绪：可立即进入同一 run 修正
       -> review 未完成：agent_end，显示候选回答和 Advisor reviewing 状态
            -> 用户仍可立即提交并运行下一 prompt
            -> terminal flush 立即追平最终 backlog，不受 30 秒冷却限制
            -> pass/nit 或有界 fail-open：只更新 Advisor 状态
            -> concern：若仍是终态文本且无排队工作，只保留可见卡片；否则正常投递
            -> blocker：保留原 identity，唤醒或 steer 主 Agent 修正
```

修正 turn 会再次进入同一流程。TUI 可以在 `PromptOutcome` 前显示候选回答并继续交互；Advisor footer 状态是可观测提示，不是调度状态。finding 卡片则是持久化的会话消息，同时进入主 Agent 上下文。迟到 finding 仍属于原 `promptId`，主 Agent 根据收到时的完整上下文修正、反驳或询问用户。

因此 `turn_end` 适合作为观察点（delta 提交、cursor 推进），但既不是同步闸门，也不是首版 review 的启动点；候选终态才是审查启动边界。`getContinuationMessages` 是自然停止路径的低延迟修正入口，`PromptSettlementTracker` 负责跨 run 的请求模式结算。

## 3. 目标与非目标

### 3.1 目标

- 所有入口共享相同的审查、分级、去重、过期保护和修正循环语义。
- 无问题时不生成 “LGTM” 一类消息，不污染主上下文和用户界面。
- `nit`、`concern`、`blocker` 有稳定、可测试的定义和投递规则。
- TUI/daemon 不因 Advisor 增加前台等待；Advisor 状态只用于可观测性。
- 请求—响应模式不会过早释放未经审查的候选答案。
- 用户主动中断后，迟到的 Advisor 结果不能擅自恢复执行。
- Advisor 运行时故障、超时和 provider 不可用不会无限阻塞主任务；显式启用时的静态配置错误在任务开始前失败。
- Advisor 同时检查用户请求前提、主 Agent 推理、执行过程和结果正确性，不以“完全照做”替代正确性判断。
- 主 Agent 需要用户决策时，所有入口使用同一个通用 `ask_user` 会话契约（见 [ask-user.md](ask-user.md)），而不是从 assistant 文本猜测“这是问题”。
- 保留未来增加多 Advisor、策略审查和更强调查工具的演进空间，但首版不为这些能力引入额外复杂度。

### 3.2 非目标

- Advisor 不替代工具执行前的权限、安全或人工审批；高风险工具仍应在 `tool_call` 前由专门策略阻断。
- 首版强制 Advisor 只读，不提供配置逃生口，也不允许 Advisor 直接修改工作区。
- 首版不提供 prompt/pre-tool 双阶段审查，也不在 WIP（`in_progress`）阶段启动审查调用；Advisor 最早在候选终态的 terminal flush 后反馈，以避免增加首轮交互延迟和短 prompt 的双倍审查成本。WIP 提前审查是保留的演进选项（第 18 节）。
- 首版不提供受限 IPython。当前 IPython kernel 与 worker 共享 OS 权限，真正只读需要独立的进程级 sandbox。
- 首版不实现多个 Advisor 编排、投票或仲裁。
- 不把 Advisor 设计成必须由主模型主动调用的 tool。
- 不改变扩展系统的一般职责，也不要求公共 `turn_end` hook 承担 Advisor 的全部生命周期契约。

## 4. 已确定的产品语义

### 4.1 严重度

| 级别 | 定义 | 例子 | 主 Agent 行为 |
| --- | --- | --- | --- |
| `nit` | 不影响需求正确性、安全性或任务可交付性的改进建议 | 命名、表达、非必要的小幅简化 | 作为非打断旁注进入上下文并显示卡片；不唤醒空闲 Agent |
| `concern` | 很可能导致需求未满足、结果错误、验证不足或明显返工，应在交付前修正 | 漏掉已明确的边界用例、结论缺少必要证据、实现与约束不一致 | 活跃或中途 yield 时要求修正；终态文本后迟到则只保留可见卡片 |
| `blocker` | 当前结果不可安全或可信地继续，或违反不可妥协约束，需要在最早安全边界处理 | 破坏性误操作风险、凭据泄露、明确错误的关键结论、不可恢复的数据风险 | 进入最高优先级 steering，当前工具批次结束后先修正；终态文本后仍可唤醒 |

严重度由 Advisor 模型通过受约束输出选择，不在本地维护一套脆弱的关键词风险分类器。本地只校验 schema，并根据 severity、主 Agent 状态、用户中断状态和运行模式执行确定性路由。无法解析或没有实质信息的 finding 不得直接注入主上下文。

### 4.2 审查对象与权限边界

Advisor 的审查范围必须覆盖以下对象，但不要求模型输出结构化分类字段：

- 用户请求中的事实前提或目标约束。
- 主 Agent 的理解、推理或方案。
- 工具使用、代码修改和验证过程。
- 最终结论或交付结果的正确性、完整性和证据。

Advisor 可以挑战错误的用户前提，但不能把偏好和取舍包装成客观错误：

- 明确错误且修正不改变用户目标时，主 Agent 应自动纠正并解释。
- 正确做法会改变产品意图、需求范围或重要取舍时，主 Agent 应询问用户。
- 仅需告知且不影响交付时，主 Agent 可以说明后继续。
- 明显不可继续的严重问题由 `blocker` 路由到最早安全边界处理。

Advisor 不输出 `requiredAction`。系统只以 `severity` 决定旁注、steering、唤醒和 settlement 行为；主 Agent 根据 finding 的正文、证据和届时完整上下文自行决定修正、反驳还是询问用户。

主 Agent 的询问路径复用通用 `ask_user`（见 [ask-user.md](ask-user.md)）：存在可交互 responder 时在 tool call 内等待回答并在同一 run 继续；无 responder 时进入持久化 `needs_user_input`；用户明确取消以 `PromptOutcome(cancelled)` 结算且不保存未回答问题；transport 丢失不视为用户取消。

首版只做 post-turn 审查。Git 可以恢复一部分受版本控制的文件变化，但不能保护未跟踪文件、数据库、外部服务、网络操作或已泄露信息；这些是明确接受的首版残余风险，Advisor 不被描述为事前安全边界。

### 4.3 主 Agent 状态下的投递

| 主状态 | `nit` | `concern` | `blocker` |
| --- | --- | --- | --- |
| 当前 trace 标记为 `in_progress` | 不投递；候选终态重新判断 | 不投递；候选终态结合完整结果重新判断 | 进入最高优先级 steering；当前工具批次结束后阻止普通续跑并先修正 |
| 中途 yield、没有终态文本 | 记录，等待下一次自然交互 | 唤醒并启动修正 run | 唤醒并启动修正 run |
| 终态文本且无排队工作 | 记录为可见卡片 | 保留为可见卡片，不自动唤醒；下次自然交互重新进入上下文 | 保留可见卡片并启动修正 run |
| 用户主动中断 | 保留到下一次自然交互 | 保留到下一次自然交互，不自动唤醒 | 保留并醒目提示，但不自动唤醒 |
| 请求—响应模式尚未结算 | 记录，不单独触发修正 | 触发修正并复审 | 触发修正并复审 |

首版 review 只在候选终态启动，因此“当前 trace 标记为 `in_progress`”一行只会被上一 prompt 的迟到 finding 或修正循环中的复审结果命中；路由规则本身与 finding 来源无关。

“用户主动中断”优先于严重度。Advisor 是质量反馈，不是绕过用户停止意图的后台执行权限。

`blocker` 的“立即”是最早安全 turn boundary，不是硬 abort：不得调用用户级 `requestAbort()`，不得强杀正在执行的 provider stream、IPython cell 或工具批次。当前批次完成后，本地调度 fence 必须让 blocker correction 先于普通 steering、follow-up、goal/autonomous continuation 执行。需要在副作用发生前阻断的风险属于独立 pre-tool policy，不由 post-turn Advisor 补救。

### 4.4 反驳与复审

主 Agent 不能无声忽略 finding，但不需要调用专用工具或返回逐项机器状态。Advisor 消息按当前 `reviewId` 中的展示顺序将 findings 编为 `1..N`，只用于让反馈清晰可读；主 Agent 在正常 continuation 中自行修正问题、提供反驳证据，或生成澄清问题。

Advisor 随后重新审查新的完整 trace，而不是消费 `fixed`/`disputed`/`needs_user` 回执。有效修正或有证据的反驳会使问题在新 review 中消失；问题仍成立则重新报告。旧批次在复审输入建立后关闭，不跨 review 维护单条 finding 生命周期。新的 review 若仍有 `concern`/`blocker`，则进入下一次有界修正循环；空数组或仅有 `nit` 时不再阻塞 settlement。达到上限后标记 `unresolved_advisor`：TUI/daemon 展示最新一批未解决 finding 与双方证据；Print/JSON/RPC/ACP 返回当前结果和结构化 unresolved 状态。

### 4.5 无问题时静默

Advisor 的一次模型调用正常结束且没有接受到 `report_findings` 调用，即表示该批 trace 已审查且无问题。它不生成“通过”、`findings: []` 或其他回执消息；review coverage 由 host 在 Advisor turn 成功结束时推进。这样既节省 token，也避免 Advisor 自身输出被下一轮再次审查。

### 4.6 Finding 的双通道展示

每批被接受的 finding 只创建一条结构化 Advisor 会话消息，不分别制造“给 Agent 的隐藏消息”和“给用户的展示消息”：

- 对主 Agent，消息渲染为带 `reviewId`、批次内序号、严重度和行为提示的 advisory 内容，明确要求“权衡并验证，不要盲从”。
- 对 TUI，同一消息渲染为独立 Advisor 卡片，显示 finding 数量、严重度 badge 和正文；卡片与普通 assistant 文本视觉区分。
- 一张卡片最多展示本批已接受的 3 个 finding，与首版单次 review 上限一致，不需要额外折叠层。
- 卡片进入主 session transcript 并持久化，确保 resume、export 和后续主 Agent 上下文看到同一事实；Advisor 私有推理和调查 trace 不进入主 transcript。
- footer 只显示 Advisor runtime 状态，不重复 finding 正文。

用户主动中断、终态迟到 `concern` 或运行模式不允许自动 turn 时，卡片仍然可见并在下一次自然 resume 时进入上下文；这不是丢弃 finding。`blocker` 只有在用户没有建立 abort fence、且 host 允许 agent-initiated turn 时才可自动唤醒。

### 4.7 与通用 `ask_user` 的关系

`ask_user` 是 Prime 主 Agent 的通用内置工具/会话能力，完整契约见 [ask-user.md](ask-user.md)。对 Advisor 只有三条边界成立：

- `ask_user` 不属于 Advisor 输出 schema，也不由 Advisor 直接调用；Advisor finding 只是主 Agent 做出“修正、反驳或询问用户”判断的上游证据。
- Advisor 与其他受限 child runtime 通过现有 `baseToolsOverride/allowedToolNames` 排除该工具。
- 主 Agent 在修正循环中调用 `ask_user` 属于正常 continuation：存在 live responder 时在同一 run 内得到回答，无 responder 时进入结构化澄清终态；两种路径都不计作修正失败。

## 5. 方案比较

| 方案 | 全模式一致性 | 生命周期控制 | 初始改动 | 协议风险 | 长期演进 |
| --- | --- | --- | --- | --- | --- |
| A. 普通内置扩展，仅使用现有 hook | 较弱 | 较弱 | 小 | 中 | 较弱 |
| B. root `AgentSessionRuntime` 持有受限 Advisor 子运行时 | 强 | 强 | 中 | 可控 | 强 |
| C. daemon/supervisor sidecar | 弱 | 中 | 大 | 高 | 中 |
| D. 由主模型主动调用 Advisor tool | 弱 | 弱 | 小 | 低 | 弱 |

### 5.1 A：普通内置扩展

优点是接入快，也符合 hook 的表面形态。问题是现有公共 hook 不拥有模式结算、会话代际、模型认证、daemon 生命周期和结构化协议输出。若为 Advisor 持续扩大扩展 API，最终会把核心会话语义隐式地放进一个扩展，难以保证所有模式一致。

### 5.2 B：root runtime 持有 Advisor 子运行时

这是采用方案。root `AgentSessionRuntime` 负责 Advisor 子运行时的创建、资源装配和销毁；主 `AgentSession` 负责提交 trace delta，在现有 `getContinuationMessages` 边界执行自然停止路径的 terminal checkpoint，并通过独立的 prompt settlement 状态机跨 run 追踪结算。公共扩展事件可按需要补充只读字段，但不承担内部状态机。这样既遵循 Prime “完整 Agent 由完整 session/runtime 承载”的架构，也能让所有入口共享队列、过期保护和修正循环。

### 5.3 C：daemon/supervisor sidecar

该方案隔离性好，但 Print、JSON、RPC 和 ACP 不应为了 Advisor 被强制绑定到 daemon。跨进程传输完整增量 transcript 还会增加协议、恢复和隐私边界，收益不足以覆盖复杂度。

### 5.4 D：Advisor tool

由主模型决定是否调用，会重复弱模型“不知道何时求助”的盲点，也无法保证每个候选结果都经过检查。它可以作为未来的主动求助能力，但不能作为默认监督机制。

## 6. 推荐架构

```text
Root AgentSessionRuntime
  |-- Main AgentSession
  |    |-- turn_end：异步提交 trace delta
  |    |-- getContinuationMessages：自然停止路径的快速 terminal checkpoint
  |    `-- PromptSettlementTracker：跨 run 的 prompt 所有权与终态（见 prompt-settlement.md）
  |
  |-- SessionAdvisorManager
  |    |-- TranscriptCursor：生成增量审查输入
  |    |-- ReviewQueue：单飞执行、积压合并、去重（候选终态触发）
  |    |-- DeliveryRouter：按严重度和主状态投递
  |    `-- TerminalReviewCheckpoint：有界等待并返回 host continuation / settlement 状态
  |
  `-- Advisor AgentSessionRuntime (kind: advisor，不可寻址)
       `-- Advisor AgentSession
            |-- 独立 SessionManager / transcript / compaction
            |-- 强制只读 read / grep / glob / git_read
            `-- Advisor Agent

Mode adapters
  |-- TUI（含 daemon 托管）：footer 显示状态、聊天流显示 finding 卡片、交互不阻塞
  |-- Print：组合的 prompt outcomes 完成后只打印最终文本；故障写 stderr
  |-- JSON：继续流式输出 agent_end，另以 prompt_outcome 表达结算
  |-- RPC：提交 ACK 保持即时，以关联 ID 等待 prompt outcome
  `-- ACP：session/prompt result 等待 prompt outcome 与 headless gate
```

### 6.1 `SessionAdvisorManager`

由 root `AgentSessionRuntime` 创建、持有和销毁，并连接主、Advisor 两个 session，负责：

- 监听内部 turn-end checkpoint 和 session 生命周期变化。
- 维护当前 session epoch、transcript cursor、待审查范围和修正次数。
- 驱动 Advisor 队列与子 runtime，并处理其重建和销毁。
- 将结构化 advice 交给投递路由。
- 向主 `AgentSession` 暴露 terminal checkpoint，并与 prompt settlement 状态机交换 review coverage 和 correction ownership。
- 向模式适配器暴露稳定状态，但不让模式自行推断 Advisor 是否结算。

它不负责渲染 TUI，也不直接编码 JSON、RPC 或 ACP wire shape。

### 6.2 Advisor `AgentSessionRuntime`

Advisor 不是绕过 Prime 体系单独创建的轻量 core `Agent`，也不是普通 RLM 子 Agent。它使用完整且独立的 `AgentSessionRuntime → AgentSession → Agent`，避免监督提示、调查过程和 token 消耗污染主 Agent，同时复用 runtime factory、`ModelRegistry`、provider、认证、telemetry 和 compaction。

该子运行时应增加内部 `kind: "advisor"`，且不可被用户寻址、attach，不进入普通子 Agent roster、消息路由或用户 session 列表。它拥有独立 `SessionManager`、transcript、成本和生命周期；默认关闭 goal、autonomous、RLM、普通 extension 与跨 Agent messaging 等不属于审查职责的能力，但保留完整 session 自身的上下文压缩能力。

Advisor 不实现第二套 provider/model retry loop。其完整 `AgentSession` 直接复用 Prime 现有两层恢复：`streamSimple` 的 `retry.provider` 请求级 timeout/retry，以及 `AgentSession` 的 `retry.enabled/maxRetries/baseDelayMs`、认证失败标记和 retry-chain completion。重试始终对同一个已解析的 `advisor.model` 执行，不走启动/恢复时的模型 fallback 选择；Advisor manager 只用 `reviewTimeoutMs` 包住整条现有 retry chain，并在超时后中止 Advisor 子 session 的当前工作，不影响主 session。

首版通过 `baseToolsOverride` 加确定性 allowlist 强制替换为专用 `read`、`grep`、`glob` 与受控 `git_read`，不提供配置逃生口。四个工具的实现放在 `src/core/tools/`（`read.ts`、`grep.ts`、`glob.ts`、`git-read.ts`），沿用 `bash.ts`/`edit.ts` 的既有先例：作为通用工具实现存在，但不进入 `allToolNames`/`ToolName` union，不改变主 Agent 只有 `ipython` 的默认工具面；Advisor runtime 通过 `baseToolsOverride` 装配它们。

`read`/`grep`/`glob` 以本设计新增的薄 `FileSystemView` 接口为唯一 IO 边界。Prime 当前源码不存在可继承的 filesystem/exec-environment 适配器抽象，因此该接口由本设计引入：v1 只提供本机实现，直连 `node:fs`，读取根为主 session cwd 加 worker 进程本可读的路径（兄弟目录、多仓库、绝对路径、依赖源码），不做额外沙箱；只提供 read 语义，不提供 write、execute、network 或 kernel 能力。“继承主 Agent 的远程/容器文件视图”不是 v1 承诺，作为演进项保留在第 18 节——届时为 `FileSystemView` 增加远程实现，工具代码不变。

`git_read` 是受控只读 git 取证工具，覆盖“变更基线/聚合 diff”这一 trace 与工作区现状都提供不了的证据源：子命令 allowlist 仅限 `log`、`diff`、`show`、`blame`、`status`、`rev-parse`、`ls-files`，明确排除 `fetch`/`pull` 等网络子命令；每次调用强制附加 `--no-pager --no-ext-diff -c core.fsmonitor= -c diff.external=`，防止仓库配置（`.gitattributes` textconv、external diff driver、fsmonitor hook）把“只读 diff”变成任意代码执行。它以受控子进程运行，天然不经 `FileSystemView`，v1 仅本机实现，远程演进时随适配器一起演进。

当前 Prime 唯一内置注册工具 `ipython` 没有 OS 级 sandbox；代码过滤或 prompt 约束不能形成可靠只读边界，因此首版不向 Advisor 暴露 IPython。未来如提供受限 IPython，必须使用与主 Agent filesystem view 对齐的只读 mount、隔离可写临时目录、禁网、禁止访问主 kernel/socket/artifact，并设置进程资源上限。

Advisor 输出必须通过本地结构校验；模型文本不是可信控制指令，不能直接修改工作区或绕过主 Agent 的权限与审批。

#### 6.2.1 Advisor 内置规则

Advisor runtime 必须加载独立、不可由 settings、项目文件或主 Agent 内容覆盖的内置 system prompt，建议落在 `src/core/advisor/system.md`。该 prompt 至少规定：

- 审查用户事实前提、主 Agent 推理、执行过程、最终结果和验证证据是否正确、完整。
- 用户目标与偏好是约束，但用户提出的事实判断仍可核验和纠正；不能把偏好争议伪装成事实错误。
- 审查输入是到候选终态为止的完整合并 trace；结合完整结果判断，不对未完成的中间过程臆测问题。
- 无实质问题静默结束；有问题才调用一次 `report_findings`，单批最多 3 条，并按 severity 定义选择级别。
- 使用强制只读工具核验证据，避免复述主 Agent 已知信息、空泛不安、无依据猜测和重复建议。
- Advisor 反馈是供主 Agent 权衡的审查意见，不是权限授予、执行命令或自动修改能力。

主 Agent 的 effective system prompt、`AGENTS.md`、项目规则、权限和运行模式只能作为带明确边界标签的 review policy context 注入。它们描述“主 Agent 应遵守什么”，不能改变 Advisor 身份、输出协议、工具边界或上述内置规则。首版不发现或加载 `WATCHDOG.md`/`WATCHDOG.yml`，也不提供覆盖/追加 Advisor system prompt 的配置字段；确有独立 reviewer-only 项目规则需求时再单独设计第三层扩展。

### 6.3 增量 transcript

主 session 的每个 `turn_end` 只提交自 Advisor cursor 之后的新 trace。该 trace 是主 `AgentSession` 可观察到的完整执行记录，包括用户消息、assistant 文本、provider 可见的 thinking、tool-call 参数、IPython 代码、工具输出、错误、traceback 和必要的 lifecycle 事件。

Advisor 初始化时还必须获得主 Agent 的 effective policy context：有效 system prompt、适用的 `AGENTS.md`/项目规则、工具能力与权限、运行模式及其他会影响正确性判断的 host policy。它们作为“被审查规则”引用，不能覆盖 Advisor 自己的 system prompt。policy snapshot 使用稳定 version/hash 标识；未变化时不在每次 review 重发，变化时发送增量并更新版本。认证信息、凭据和敏感运行值不进入该 snapshot。

Advisor 在 session 创建时已经启用，则 review cursor 从该 session 的首个新 turn 开始，正常覆盖全部后续 trace。若通过 `/advisor on` 在已有 session 中途启用，则采用基线 cursor：

- 将主 Agent 当前有效、已规范化的 bounded transcript 作为只读背景装入 Advisor 上下文，使其理解当前任务、工具结果和已有约束。
- 记录 `enabledAtCursor`，只允许针对该 cursor 之后的新 trace 生成 finding。
- cursor 之前的内容标记为 `baseline_only`，不计入 review coverage，不触发历史 finding，也不会在后续 catch-up 中回补审查。
- `/advisor off` 期间新增的 trace 在再次 `on` 时同样只进入新 baseline，不追溯审查。
- baseline 使用主 session 当前有效 transcript 表示；已经 compaction 的历史沿用主 session 的有效 summary，不从完整 JSONL 重新展开，以免中途启用造成无界上下文和费用。

Advisor 消费内存中的 session event/trace 流，不在每个 turn 重新读取整个 JSONL；持久化 session JSONL 是恢复时的回放真相源。Advisor cursor 与主上下文独立，主 Agent compaction 后仍保留已审查进度，恢复时则从 JSONL 重建其私有 transcript 和 cursor。输入中排除：

- Advisor 自己产生的 advice、诊断和状态事件。
- provider 原始载荷、认证信息和不应进入第二模型的敏感元数据。
- 已确认与当前审查范围无关的 UI 事件。

Advisor 永不共享或连接主 Agent 的 live IPython kernel，也不读取其 namespace、dill snapshot 或 socket。它只能看到已进入 session trace 的 IPython 输入和输出。

消息采用分层压缩：

- 传输层只发送 cursor 之后的增量，不重复发送完整历史。
- 尚未审查的 trace delta 不做模型摘要，保留主 session 已规范化、持久化的消息内容。
- 尚未完成修正/复审的 review 批次、当前 prompt 的未审查 trace、最近修正/反驳证据、当前 policy version/hash、session epoch、cursor、review coverage 和 settlement 状态固定保留。
- 已审查且已解决的旧 trace 与旧 review 对话，由 Advisor 自己的 `AgentSession` compaction 压缩。

主 Agent compaction 不改变 Advisor cursor；Advisor compaction 也不能改变 review coverage 或 settlement ledger。compaction summary 只是模型上下文表示，不是真值来源。

分叉、恢复、切换 session 或替换 runtime 时必须按新的 session lineage 重建 cursor 或递增 epoch，不能继续使用旧快照的偏移量。主 Agent 的普通 compaction 本身不应丢失 Advisor 已持有的审查历史。

### 6.4 Review queue 与背压

- 每个 Advisor runtime 最多一个在途模型请求。
- 每次 `turn_end` 都记录新的待审查范围，积压范围合并为一个连续批次；每个 delta 仍由 host 标记为 `in_progress` 或 `candidate_terminal`（标记成本趋近于零，保留它为第 18 节的 WIP 演进保留触发语义）。
- 首版 review 只在 backlog 含候选终态 delta 时启动：请求—响应模式由 terminal checkpoint 触发，TUI 由候选 `agent_end` 后的 terminal flush 触发；修正 turn 完成后的复审同样在新的候选终态出现时启动。
- `in_progress` delta 只推进 backlog 与 cursor 记录，不单独启动模型调用。因此主 Agent 活跃期间到达的 finding 只能来自上一 prompt 的迟到结果或修正循环中的复审（§4.3 路由不变）。
- 30 秒是存在 backlog 时两个 review 启动时间之间的最小间隔（约束修正循环复审与多 prompt 连续结算），不是轮询周期；没有新的候选终态时不触发空 review。
- prompt 准备 settlement 时忽略冷却，立即 flush 最终 backlog。
- 审查完成时若已有新的候选终态 backlog，则在冷却到期或 terminal flush 时消费合并后的 delta。
- 所有模式的主 Agent 在正常 turn 进行中都不等待 Advisor 队列。
- TUI 在候选 `agent_end` 后立即 terminal flush，只更新 Advisor 状态，不等待队列，也不阻止下一 prompt 启动。
- 请求—响应模式只在 Agent 原本停止前的 terminal checkpoint 等待队列，而不是在每个 `turn_end` 等待。

因此审查频率的语义是“每个候选终态都不会漏掉、全部 trace 都被覆盖”，而不是“每个 turn 都增加一次模型调用”。1–3 turn 的短 prompt 每 prompt 至多一次 review 调用（外加修正后的复审）。

### 6.5 结构化 findings

首版逻辑契约：

```ts
interface AdvisorFinding {
  severity: "nit" | "concern" | "blocker";
  message: string;
  evidence?: string[];
}

interface AdvisorReviewResult {
  reviewId: string;
  sessionEpoch: number;
  throughTurn: number;
  findings: AdvisorFinding[];
}
```

有问题时，模型通过 Advisor runtime 内部专用的 `report_findings({ findings })` tool 原子提交一个非空批次。`read`、`grep`、`glob`、`git_read` 可在提交前用于调查；普通 assistant 文本、thinking 或其他 tool 输出均不作为 finding 投递。`reviewId`、`sessionEpoch` 和 `throughTurn` 由 host 根据当前 review lease 附加，findings 按校验和优先级排序后的展示顺序获得仅在该批次有效的 `1..N` 序号；模型不能自行声明 ID、序号或扩大审查范围。

`report_findings` 只在有实质问题时调用，单次调用包含完整批次；正常结束且没有被接受的调用就是静默通过，不属于缺失输出或故障。host 每个 Advisor update 最多接受一次有效调用，多余调用由本地 emission guard 抑制，不触发额外投递或模型重试。

一次 review update 最多接受 3 个独立 finding，按 `blocker → concern → nit` 排序。运行时应执行：

- 空白、套话和无信息内容过滤。
- `severity` 是唯一系统路由字段；正文和证据只作为主 Agent 判断依据。
- `reviewId` 与批次内序号只关联同一条 Advisor 消息、卡片和 correction continuation，不构成主 Agent response 协议；复审开始后旧序号失效。
- 首次投递的 `concern`/`blocker` 以规范化问题、目标范围和严重度生成当前 prompt 内的临时内容指纹，并进入 `awaiting_main` latch。该指纹不是协议 identity，不进入 transcript，prompt 结算后删除。
- 同一 latch 仍在等待主 Agent 处理时，后续 review 中的等价 finding 继续作为逻辑未解决问题参与 settlement，但 emission guard 不再生成卡片、聊天消息或重复 steering；severity 升级或新的独立问题可以重新投递。
- 普通 WIP 更新不清除 latch。只有包含该 Advisor 消息后的主 Agent 修正 turn 已完成，或到达最终 settlement checkpoint，才形成有效复审边界：复审仍报告等价问题时保持 latch 并进入下一修正轮，静默通过时才清除。
- 长度限制和安全转义。
- `sessionEpoch` 与已审查 turn 范围校验。
- 超过上限时只保留最高优先级的 3 个，不得把多个独立问题强行拼成一个 finding。

对主 Agent/UI 每个 review 只聚合投递一条 Advisor 消息；同一条消息既作为主 Agent 的 advisory 上下文，也渲染为 TUI 卡片。需要修正时最多启动一个修正 turn，避免一个 review 连续打扰多次。所有请求—响应模式都以最新复审结果是否仍含 `concern`/`blocker` 判断能否结算；`nit` 可以记录和展示，但不阻塞 settlement。TUI 的终态迟到 `concern` 按已接受的卡片保留规则处理，不因其未自动修正而阻塞交互。

emission guard 只控制重复投递，不改变 review 真值。Advisor prompt 必须允许在有效复审边界重新报告仍存在的问题；host 可据内容指纹保持 latch，而不会把重复 finding 误当成新的用户可见提醒或把被抑制的投递误判为通过。

具体 wire schema 可以不同，但必须保留 review 批次 identity、批次内稳定顺序和 review coverage；不增加持久 finding identity。

### 6.6 Session 级 prompt settlement

`PromptSettlementTracker` 与 `PromptOutcome` 的完整契约——lineage、结算范围、终态条件、`status × advisor` 组合矩阵与持久化 ledger——见 [prompt-settlement.md](prompt-settlement.md)。对 Advisor 成立的约束是：

- `completed` 终态要求 Advisor 已审查到该 prompt 最终 trace generation，或明确进入有界 `fail_open`；Advisor 未启用时该条件视为满足，`advisor` 字段记 `disabled`。
- `needs_user_input`、`cancelled`、`failed` 终态不等待 Advisor；结算后迟到的 finding 不重开 outcome，按 §7.2 的迟到规则处理。
- 修正循环被封口（达到修正上限、被后续 prompt admission 取代或 `/advisor off`）且问题未清除时以 `unresolved_advisor` 结算，`advisor` 字段为 `unresolved`。

## 7. 状态机与并发约束

### 7.1 Advisor 状态

```text
disabled
   |
   v
idle <---------> reviewing
  ^                 |
  |                 v
  +----------- catching_up
  |
  +-------- unavailable  --(恢复只处理新工作)--> idle

任意状态 -- session disposed --> disposed
```

- `idle`：没有在途 review 和 backlog。
- `reviewing`：一个批次正在执行。
- `catching_up`：批次完成时发现新的候选终态积压，继续合并消费。
- `unavailable`：超时、认证、provider 或 runtime 错误；按模式报告并 fail-open。
- `disposed`：会话退出，所有迟到结果永久失效。

### 7.2 过期结果保护

每个 review 必须绑定：

- session identity；
- session epoch；
- transcript 起止 cursor；
- 目标 Agent run generation 与 `throughTurn`。

以下事件至少递增 epoch 或使旧 review 失效：新建/切换 session、fork、恢复时重建 runtime、会话 dispose。主 Agent compaction 作为 trace 事件处理，不应仅因上下文被压缩就丢弃 Advisor 的独立 cursor。迟到结果先校验身份和范围，再决定投递；不得仅凭“当前 session 仍存在”就注入。

用户在 review 期间发起新 prompt，不会使同一 session/epoch 内的旧结果失效，也不要求先做 rebase review。迟到 finding 保留原 `reviewId`、`promptId` 和 `throughTurn`。若 B 已使主 Agent 活跃，A 的 `concern`/`blocker` 按活跃状态路由；若仍停在 A 的终态文本且无排队工作，`concern` 只保留卡片，`blocker` 可唤醒修正。主 Agent 基于届时完整上下文修正、提供反驳证据或询问用户，后续再由 Advisor 审查新的完整 trace。只有 session epoch/lineage 改变、会话 dispose 或用户主动 abort fence 才阻止自动投递。

投递归投递，结算归结算：B 的成功 admission 按第 8 节的封口规则处理 A 的 settlement——B admission 后不再为 A 启动新修正周期，A 在 review coverage 追平后结算；steer 进 B 的迟到修正属于 B 的时间线，A 的终态不重开。

## 8. 修正与复审循环

在 Print、JSON、RPC、ACP 中，一个 review 的全部 `concern`/`blocker` 被聚合为一条 Advisor continuation，优先通过 `getContinuationMessages` 触发同一 Agent run 内的修正；若 compaction 等边界已经结束该 run，修正可以启动继承同一 `promptId` 的新 run。TUI 中，终态迟到 `concern` 只保留可见卡片，终态迟到 `blocker` 可启动新的修正 run；若主 Agent 已因后续输入处于活跃状态，则按严重度进入其正常 steering/continuation 路由。所有实际修正都必须再次进入 Advisor。主 Agent 正常生成修正、证据或澄清问题，不承担 Advisor 专用输出协议；复审直接对当前完整结果重新出具批次。

为防止两个模型互相打断形成死循环：

- 每个 prompt settlement 维护 Advisor 修正计数。
- Advisor 重新审查修正后的完整 trace；问题消失后结束，仍存在才进入下一循环。
- 达到 `maxCorrectionCycles` 后停止自动唤醒，保留 finding 与双方证据，并标记 `unresolved_advisor`。
- 同 session 后续 prompt 的成功 admission 同样封口前一 prompt 的修正循环：已在途的修正 run/continuation 自然完成并复审，此后不再为旧 prompt 启动新的修正周期；旧 prompt 在 review coverage 追平后按结果结算 `completed` 或 `unresolved_advisor`（语义见 [prompt-settlement.md](prompt-settlement.md)）。迟到 `blocker` 仍按 §4.3 进入新 prompt 的 steering，但该修正属于新 prompt 的时间线，旧终态不重开。封口规则对所有模式统一，主动流水线提交的 RPC/JSON 客户端同样适用。
- Advisor 发出打断性反馈后进入可配置的 immune window。期间仍继续审查，但等价问题不重复打断；新的 blocker 或明确升级可以突破。
- 去重使用当前 prompt 内的 `awaiting_main` 内容指纹 latch：主 Agent 尚未获得有效处理机会时只维持未解决状态，不重复显示或 steering；有效复审后才清除或进入下一修正轮，不创建持久 finding identity。
- 主 Agent 收到的消息应明确标识为 Advisor 反馈，并要求验证、修正或说明为何不成立。

修正上限不是“静默忽略”。TUI/daemon 应显示未解决状态并等待用户；Print 输出当前结果并通过 stderr 报告；结构化模式返回当前结果和可机器识别的 unresolved Advisor 状态。主 Agent 判断需要用户决策时调用 `ask_user`：存在 live responder 时在同一 run 内得到回答，无 responder 时进入结构化澄清终态；两种路径都不计作修正失败。

## 9. 各运行模式的 Advisor 契约

结算与 `ask_user` 的模式契约分别见 [prompt-settlement.md](prompt-settlement.md) 与 [ask-user.md](ask-user.md)；本节只保留 Advisor 自身的模式行为。

请求—响应模式中 Advisor 引入的纯等待上限为 `(maxCorrectionCycles + 1) × terminalReviewTimeoutMs`，默认 `3 × 30 秒 = 90 秒`：每次 terminal checkpoint 的有界等待不超过 `terminalReviewTimeoutMs`，修正 run 本身是主 Agent 的真实工作，不计入该上限。调整这三个参数的任何一个都应重新按该公式评估请求模式延迟。

### 9.1 TUI（包括 daemon 托管）

- 主 Agent 与 Advisor 在各 turn 中并行推进，不同步等待每次审查。
- 候选 `agent_end` 后立即显示回答；Advisor 尚未完成时只显示状态，不把它解释成 TUI 的忙闲或结算闸门。
- 输入、提交和后续 prompt 执行始终保持现有行为，不新增 Advisor 专用输入队列或 prompt-start fence。
- terminal flush 立即审查最终 backlog，不受 30 秒最小 review 间隔限制；其 timeout 只结束本次审查，不阻塞 TUI。
- Advisor 状态固定显示在 TUI footer 的单行位置，不向聊天区追加状态日志。当前内置 footer 虽然有承载位但刻意渲染为空；首版只增加 Advisor 指示，不恢复被隐藏的 token、cost、model、cwd 或 context telemetry。
- Advisor 未启用时 footer 保持现状。启用后只显示紧凑状态：`Advisor: idle`、`Advisor: reviewing`、`Advisor: correcting`、`Advisor: unavailable` 或 `Advisor: unresolved`；内部 `catching_up` 合并显示为 `reviewing`。
- UI 只展示可验证的运行状态，不展示 Advisor chain-of-thought、trace 内容或模型调查过程。
- Advisor turn 正常结束且没有 accepted `report_findings` 时保持静默并回到 `idle`。实际 finding 在聊天流显示独立 Advisor 卡片；卡片显示严重度和正文，并与注入主 Agent 上下文的结构化消息共用同一 identity。
- `nit` 作为非打断卡片在下一 step boundary 投递；活跃状态下的 `concern`/`blocker` 进入 steering。终态文本后的迟到 `concern` 只显示卡片，迟到 `blocker` 才唤醒修正。
- Advisor 超时或不可用时更新降级状态，不能影响用户继续交互。
- 用户主动中断建立 abort fence，所有迟到 advice 只保留，不自动启动 run。
- detach/reattach 不应改变 Advisor 所属会话；worker 生命周期结束时必须 dispose。

daemon 若增加 Advisor 命令、事件或响应字段，按“可选能力”处理。客户端必须先检查协商 capability，老客户端和老 daemon 均应继续完成普通会话启动与交互。

### 9.2 Print

- 可通过 `--advisor` 为本次进程和 session 临时启用，不修改 settings。
- `getContinuationMessages` 仍用于自然停止路径的快速修正；跨 run 修正由相同 `promptId` 关联。
- stdout 只输出最终 settled 的主 Agent 文本，不输出被 Advisor 推翻的中间候选文本。
- Advisor 不可用或超时时，stdout 仍输出主结果，stderr 输出简短警告。
- 进程退出后，该请求被标记为 released；Advisor 恢复不得追审并唤醒旧工作。

### 9.3 JSON

- 可通过 `--advisor` 为本次进程和 session 临时启用，不修改 settings。
- 可以流式输出 Advisor 的非终态事件；`advisor_unavailable`、`unresolved_advisor` 使用结构化事件或字段表达，不依赖 stderr 文本解析。

### 9.4 RPC

- RPC host 可通过 `--advisor` 为其 session 临时启用；连接 daemon 创建 session 时使用协商后的 `advisorEnabled` 参数。
- 结构化 `advisor_unavailable`/`advisor_unresolved` 作为可选能力协商；未声明能力的客户端继续收到原有主结果契约。

### 9.5 ACP

- ACP host 可通过 `--advisor` 为其 session 临时启用；连接 daemon 创建 session 时使用协商后的 `advisorEnabled` 参数。
- Prime 专属 Advisor 状态放入可忽略的 namespaced `_meta` 或协议允许的扩展位置，保持 ACP 标准响应有效。

## 10. 故障策略

Advisor 属于质量增强路径，不应成为主 Agent 的单点故障。

这里的 fail-open 只适用于 Advisor 已成功启用后的运行时故障。显式 enable 的前置校验发生在接受 prompt/session create 之前，失败时没有候选主结果可释放。

| 故障 | 行为 |
| --- | --- |
| 显式 enable 时 model 缺失/非法/不可解析，或其 provider 本地未配置认证 | 通过现有 available-model 解析 fail-closed；CLI 非零退出，daemon session create 结构化失败，TUI 内 `/advisor on` 仅命令失败 |
| 单次模型请求超时 | 取消该 review，记录状态；请求模式进入有界 fail-open |
| 现有 retry chain 结束后凭据/provider/model 仍不可用 | 标记 `unavailable`，当前 review fail-open，不再叠加 Advisor 私有重试 |
| 队列持续增长 | 合并 delta；达到资源上限后释放请求并报告降级 |
| runtime 崩溃/重建 | 递增 epoch，丢弃旧结果，只从恢复点处理新工作 |
| 会话退出 | dispose 并取消在途任务，不投递迟到结果 |

单次 review 的 provider/auth 恢复完全沿用子 `AgentSession` 当前 retry 配置，`reviewTimeoutMs` 是包含这些重试在内的外层总预算，其默认值必须能容纳整条现有 retry 链（见第 11 节的校验规则）；Advisor manager 不再按 batch 自建 sleep、fallback 或 retry counter。一次最终失败使当前 prompt 按模式 fail-open，并把 Advisor 标记为 `unavailable`；只要未触发暂停，后续新 delta 可在正常 30 秒调度边界再次尝试，成功后清零连续失败计数。连续 3 个 review 最终失败后暂停 Advisor，避免 daemon/TUI 对永久错误持续消耗资源；仅 `/advisor off` 后再 `on`、Advisor 配置重载或新 session 清除该暂停。暂停不改变用户持久化的 enabled 设置。

模式反馈：

- TUI/daemon：显示 Advisor 状态，保留可查询诊断；故障不阻塞交互。
- Print：主结果照常输出，警告写 stderr。
- JSON/RPC/ACP：主结果照常返回，同时提供结构化 `advisor_unavailable`。

恢复后只处理尚未 released 的当前请求或新产生的 transcript，不追溯唤醒已经交付的历史任务。

上述模式反馈只描述成功启用后的运行时故障；启动前配置错误按 fail-closed 路径返回，不伪装成 `advisor_unavailable` 后继续执行 prompt。

## 11. 配置与启用

Prime 当前没有 `modelRoles` 抽象，首版应复用现有 settings 合并和模型解析方式，新增单一嵌套对象：

```json
{
  "advisor": {
    "enabled": false,
    "model": "anthropic/claude-sonnet-4-5",
    "thinkingLevel": "high",
    "reviewTimeoutMs": 120000,
    "minReviewIntervalMs": 30000,
    "terminalReviewTimeoutMs": 30000,
    "immuneTurns": 3,
    "maxCorrectionCycles": 2
  }
}
```

这是已接受的首版配置方向；具体 schema 仍需在实现计划阶段通过现有 `SettingsManager` 类型和覆盖规则核对：

- `enabled` 默认关闭，避免用户无感增加模型调用和费用。
- `advisor.model` 是 canonical `provider/model` 字符串，也是启用 Advisor 的硬性前置条件。Prime 不继承主 Agent 模型，也不在缺失配置时选择默认模型。
- 启用时直接通过现有 `ModelRegistry.getAvailable()` 和模型解析器判断可用性，不增加 Advisor 专用凭据校验器，也不发送联网探测请求。该列表已排除本地未配置认证的 provider；key 失效、OAuth 刷新失败、限流或网络故障等只能在真实请求中确定的问题按运行时 `unavailable` 处理。
- `advisor.thinkingLevel` 可选，省略时默认 `high`。不属于 Prime 合法 thinking level 枚举的值属于配置错误并阻止启用；合法但目标模型不支持的值沿用 Prime 现有规则确定性 clamp，并分别保留 requested/effective level 供状态查询。
- 配置的 Advisor 模型在 runtime 创建时独立解析并固定；主 Agent 后续切换模型不影响 Advisor。显式 `advisor.model` 可选择任意 provider，不增加额外的跨 provider 授权、限制或 UI 警告；trace 内容将到达该 provider 的事实作为残余风险写入配置文档（见第 14 节）。
- `enabled: true` 但 model 缺失、非法或不可解析时，进程启动 fail-closed 并返回可操作的配置错误，不创建主任务或 Advisor runtime。
- 不接受 `{ "provider": "...", "id": "..." }` 对象或裸 model id；单字符串避免 provider/id 半配置，并直接复用 Prime 现有 canonical model reference 解析与错误信息。
- `reviewTimeoutMs` 默认 120000：它是覆盖整条现有 provider/session retry 链的外层总预算，而现有 `retry.provider.maxRetryDelayMs` 默认即 60000。配置值小于 provider 单请求 timeout 与最大退避之和时属于自相矛盾配置——预算连一次顶格退避都容纳不下，等于静默禁用复用的 retry 链——按配置错误在启用时 fail-closed，与 model 校验走同一路径。
- `terminalReviewTimeoutMs` 是请求—响应模式 terminal checkpoint 的等待上限，默认 30000；Advisor 附加纯等待上限 = `(maxCorrectionCycles + 1) × terminalReviewTimeoutMs`，默认 90 秒（见第 9 节）。
- 全局与项目级配置采用现有 merge 语义。
- timeout、30 秒最小 review 间隔、immune window 和修正上限有安全边界并经过校验。
- Advisor 不增加独立 retry 配置：请求级和 Agent run 级重试复用现有 `retry.provider` 与 `retry.*`；`reviewTimeoutMs` 只提供覆盖整条重试链的 Advisor 外层总预算，模型保持固定。
- Advisor 的只读工具权限独立于主 Agent 权限，不能因继承配置获得写能力。

TUI 提供 session 级命令：

- `/advisor on`：为当前 session 启用已配置的 Advisor，不修改持久化 settings；model 缺失或不可解析时仅该命令失败，现有主 session 继续运行且 Advisor 保持 disabled；已有 transcript 只作为背景，finding 从 `enabledAtCursor` 之后开始。
- `/advisor off`：为当前 session 停用 Advisor，终止其后续调度并使在途结果失效，不修改持久化 settings。
- `/advisor status`：显示 enabled override、`no_model`/runtime 状态、已配置模型、requested/effective thinking level、backlog/review coverage、最近错误、token/cost 和修正轮次，不改变状态。

session override 的优先级高于 settings，并随该 session 生命周期保存和恢复；它不能串到其他 session。无参数或未知子命令返回明确 usage，不采用隐式 toggle，避免误触改变费用行为。Prime 当前将需要跨 TUI/daemon 保持语义的命令定义在 `core/slash-commands.ts`，并由 `AgentSession` 执行；`/advisor` 应沿用同一 session command 路径，而不是做成仅存在于 `interactive-mode.ts` 的本地 UI 命令。

所有直接启动模式提供统一的 `--advisor` 一次性开关，包括 TUI、Print、JSON、RPC 和 ACP：

- `--advisor` 在 runtime 创建前请求把当前 session override 设为 enabled，不修改全局或项目 settings；它不选择模型，也不能绕过 `advisor.model` 的必填约束。model 配置无效时进程在接受 prompt 前以非零状态退出。
- 对 resume/attach 的 session，显式命令行 override 优先于该 session 已保存的 override；未传参数时沿用 session/settings 的正常解析。
- attach 到已存在的 daemon session 时（Print/JSON/TUI 的 continue/resume 路径同样适用），`--advisor` 通过 `/advisor on` 的既有 session command wire 通道生效，在接受第一个 prompt 前执行；fail-closed 语义与 TUI 内 `/advisor on` 完全对齐——model 无效时该命令返回结构化失败，client 进程非零退出且不发送 prompt，session 本身继续存活、Advisor 保持 disabled。该命令通道 capability-gated，老 daemon 明确报不支持，不静默降级。中途启用自动落入 §6.3 的 `enabledAtCursor` baseline 语义；共享 session 下任一 client 启用的 override 对全体 attached client 可见，与 `/advisor on` 同语义，非特例。
- 首版只增加明确的正向开关，不增加隐式 toggle；非 TUI 调用方若需关闭已在 settings 中启用的 Advisor，应使用显式配置覆盖。
- daemon 进程本身没有全局 `--advisor` 状态。daemon 创建 session 时，通过 capability-gated 的可选 `advisorEnabled: true` 参数表达同一 session override；老 daemon 不支持该 capability 时，client 必须明确报不支持，不能静默声称已启用。daemon worker 无法解析配置模型时，session create 返回结构化失败且不创建 session，不影响 daemon 中其他 session。

## 12. 持久化与可观测性

Advisor 使用自己的 `SessionManager` 和私有 session tree 保存 transcript、compaction、成本和诊断，不混入主对话 transcript。主 transcript 中只保留实际投递给主 Agent 的 advice 及其 review 引用，以便恢复主执行语义。私有 compaction 只处理已审查、已解决历史；固定保留集合及 review/settlement 真值放在 compaction summary 之外的结构化状态中。

至少暴露以下运行状态：

- enabled/disabled/unavailable；
- 当前 state、backlog 范围和最后审查 turn；
- 最后一次 advice 的严重度与解决状态；
- review 次数、修正循环次数、token/cost；
- 最近错误与超时原因。

持久化格式必须允许未来扩展多 Advisor，但首版运行时只实例化一个。恢复时可从主 session JSONL 回放执行 trace，并恢复或重建 Advisor 私有 transcript/cursor；无论采用哪种方式，都必须通过 session lineage 与 epoch 阻止恢复前在途请求的迟到输出。

daemon worker 重启时未结算 prompt 的恢复与最小 settlement ledger 见 [prompt-settlement.md](prompt-settlement.md)；Advisor 贡献其中的 review coverage、修正次数与 epoch 字段。与 Advisor 直接相关的恢复规则：

- 重启前的在途模型结果全部按 epoch 作废，不能迟到写入新 runtime。
- 未终态且未 abort/released 的 outcome 重新核对 trace coverage，必要时重新发起 Advisor review。
- 已终态 outcome 不可重开；恢复后的 Advisor 只处理新工作。

## 13. 协议兼容性

Advisor 的纯内部队列和 runtime 不构成 wire change。以下变化必须分别分类（settlement 与 `ask_user` 的 wire 变化分别见 [prompt-settlement.md](prompt-settlement.md) 与 [ask-user.md](ask-user.md)）：

| 变化 | 建议分类 |
| --- | --- |
| daemon 新 Advisor status/event/command | capability-gated |
| daemon 创建 session 的可选 `advisorEnabled` 参数 | capability-gated；客户端发送前必须检查能力 |
| daemon 既有响应增加可选 metadata | capability-gated，并验证老客户端忽略能力 |
| RPC 新结构化 Advisor 状态（`advisor_unavailable`/`advisor_unresolved`） | capability-gated；若无协商机制则版本化 |
| ACP namespaced `_meta` 中的 Advisor 状态 | 在 ACP 允许未知 metadata 的前提下 backward-compatible |
| Print stderr 警告 | backward-compatible，不改变 stdout 主结果 |

Advisor 不改变现有 `agent_end` 的 run 终态含义，而是依赖更高层的 prompt settlement。每个实际 daemon wire change 仍必须同步更新 `DAEMON_SCHEMA_REVISION`、命令/事件兼容映射，并覆盖 new-client/old-daemon 与 old-client/new-daemon。只有不兼容变化或启动开始依赖新行为时才按现有规则评估 `DAEMON_PROTOCOL_VERSION` bump；Advisor 本身不得成为无 capability gate 的启动依赖。

## 14. 安全与隐私边界

- 发送给 Advisor 的 trace 执行结构化排除（§6.3：provider 原始载荷、认证信息、env 快照、daemon 控制消息按构造剔除），v1 不做内容级凭据扫描——regex 秘密识别漏报是常态且会误伤证据，做一个漏的版本只会制造“已过滤”的虚假安全感。系统自身持有的凭据（认证 header、env）全部位于结构层，被结构化排除完整覆盖。
- 已声明的残余风险：tool-call 参数、IPython 输出、错误与 traceback 的内容会到达 `advisor.model` 所属 provider，信任级别与主模型 provider 相同；`advisor.model` 配置为另一家 provider 时即构成跨 provider 内容共享，属用户显式配置的选择，在配置文档提示，不加 UI 警告。
- Advisor 工具由 `baseToolsOverride` 和 allowlist 强制限定为专用 `read`、`grep`、`glob` 与受控 `git_read`，用户配置不能恢复 IPython、写入或外部副作用能力；文件读取只经 `FileSystemView`（v1 本机实现），`git_read` 以硬化参数的受控子进程运行且 allowlist 排除一切网络子命令，均不扩张 worker 进程的 OS 读取权限。
- Advisor 不访问主 Agent 的 live kernel、namespace、snapshot、socket 或未进入 trace 的内存状态。
- advice 作为不可信模型输出进行长度限制、转义和 schema 校验。
- blocker 只能触发主 Agent 的新推理，不能绕过工具权限或自动批准危险操作。
- 用户中断、会话销毁和请求 released 都是不可被模型文本覆盖的本地硬边界。
- post-turn Advisor 不是事前安全屏障；Git 也不能恢复未跟踪文件、数据库、外部系统和已泄漏信息。

## 15. 测试与验收

使用 `packages/coding-agent/test/suite/harness.ts` 和 faux provider，不调用真实 provider、API key 或付费 token。`ask_user` 与 prompt settlement 的验收清单分别见 [ask-user.md](ask-user.md) 与 [prompt-settlement.md](prompt-settlement.md)。Advisor 至少覆盖：

1. 正常路径：多 turn 任务的全部 trace 被增量提交并在候选终态审查，无问题时用户和主 transcript 均无 Advisor 消息。
2. 默认、模型、命令与启动 override：未配置时 Advisor 不创建 runtime 或产生费用；`advisor.model` 只接受 canonical `provider/model` 字符串，缺失/非法/不可解析或 provider 本地未配置认证时无法启用且不继承主模型；启用复用 `ModelRegistry.getAvailable()`、不发联网探测；`advisor.thinkingLevel` 省略时为 `high`，非法枚举阻止启用，模型不支持时正确 clamp 且 status 同时显示 requested/effective level；`reviewTimeoutMs` 小于 provider 单请求 timeout 与最大退避之和的自相矛盾配置同样 fail-closed；`enabled: true`/`--advisor` 在接受 prompt 前 fail-closed，daemon create 原子失败，TUI 内 `/advisor on` 仅命令失败并保持 disabled；`/advisor off|status` 和有效的 `on` 只修改当前 session override，`off` 后在途结果不投递；daemon 参数受 capability gate，老 daemon 明确拒绝而不静默降级；attach 已有 daemon session 时 `--advisor` 经 session command 通道生效并保持同样的 fail-closed 语义，命令失败不影响 session 本身与其他 attached client。
3. 中途启用：当前有效 transcript 进入只读 baseline，旧内容不产生 finding、不计入 coverage；只审查 `enabledAtCursor` 后的新 delta，反复 `off`/`on` 不回补停用期间的历史。
4. 审查对象：错误用户前提、错误推理、执行缺陷和错误结果都能通过具体 message/evidence 被指出；不要求额外分类字段，偏好不被误判为事实错误。
5. 严重度：三种 severity 的展示和系统路由符合表格定义；系统不解析或执行 Advisor 给出的处理动作，主 Agent 自行判断如何回应。
6. review 输出、多 finding 与重复抑制：正常 Advisor turn 无 `report_findings` 调用时静默通过；有问题时 1/3 个 findings 以一个非空批次提交，超限裁剪、优先级排序、批次内编号和单次聚合投递均正确；普通文本不投递，多余调用被 emission guard 抑制且不触发重试；等价 finding 在 `awaiting_main` 期间保持逻辑未解决但不重复显示/steering，升级可重新投递；`nit` 不阻塞 settlement。
7. Trace：Advisor 可见 session trace 中的 IPython 输入、输出、错误和 traceback，但无法访问 live kernel、namespace 或 snapshot。
8. Advisor prompt 与 policy context：内置 system prompt 覆盖正确性、静默、完整结果判断、severity、只读核验和 advice 边界且不可被覆盖；effective system prompt、适用规则、工具权限和运行模式仅以带边界标签的 review context 按 version/hash 初始化与增量更新；注入内容不能改变 Advisor 身份、协议或工具权限，敏感运行值被排除；首版不加载 WATCHDOG 类第三层规则。
9. 背压与触发：review 只在 backlog 含候选终态 delta 或 terminal flush 时启动，`in_progress` delta 只扩展 backlog 与 cursor、不产生模型调用；连续 review 启动间隔不少于 30 秒，多个 turn 被合并且无遗漏；无新候选终态不轮询，settlement flush 不受冷却限制。
10. Continuation 顺序：工具、steer、follow-up、goal 和 autonomous continuation 正常运行；自然停止时优先使用 Advisor terminal checkpoint。
11. 活跃状态：主 Agent 活跃期间不因当前 prompt 的 WIP delta 产生审查调用或投递；迟到 `nit`/`concern` 按 §4.3 活跃行路由；迟到 `blocker` 在当前 provider/tool 批次完成后的最早安全边界优先 steer，不调用 `requestAbort()`，不强杀工具。
12. TUI 状态：候选 `agent_end` 后立即显示回答；Advisor review 状态可见但不阻塞 B 的提交和执行；A 的迟到 finding 保留原 identity 并按当时主状态投递。
13. Footer 与卡片：Advisor 未启用时 footer 仍为空；启用后 footer 只有一行紧凑状态。实际 finding 使用独立 Advisor 卡片，同一结构化消息同时进入主 Agent 上下文，状态更新本身不产生聊天消息。
14. 用户中断：三种严重度均不能自动恢复已 abort 的会话。
15. 过期保护：切换、fork、恢复和 dispose 后旧 review 不投递；普通 compaction 不丢失 Advisor cursor。
16. 跨 prompt 迟到：同一 session/epoch 内 A finding 在 B 到达后保留 A 的 `promptId`、`reviewId` 与范围，不做 generation stale/rebase；B 已活跃时正常 steer，仍停在 A 终态时 late concern 只保留卡片、late blocker 可唤醒；B admission 封口 A 的修正循环，A 按 coverage 追平后的结果结算 `completed`/`unresolved_advisor`，steer 进 B 的修正属于 B 的时间线且 A 终态不重开。
17. 修正与反驳：主 Agent 无需 Advisor 专用回执即可完成修正、给出可复查反驳证据或提出澄清问题；普通 WIP 不清除 `awaiting_main`，有效修正/terminal 复审中相同问题继续阻塞但不制造重复卡片，静默通过才清除，到达上限后只报告最新一批问题。
18. 故障与重试复用：显式 enable 的模型配置错误在 prompt 前 fail-closed；成功启用后复用 `retry.provider` 与 `AgentSession` retry chain 且始终使用配置的 Advisor 模型，`reviewTimeoutMs` 覆盖整条链；单次最终失败 fail-open，后续新 delta 可恢复，连续 3 次最终失败后暂停直到 off/on、配置重载或新 session；transport/runtime 丢失不能误报 completed。
19. 协议：daemon/RPC 能力协商和双向跨版本场景通过。
20. 权限隔离：Advisor 只能调用强制只读工具，配置不能恢复写工具或 IPython；`read`/`grep`/`glob` 的 IO 只经 `FileSystemView`（v1 本机实现，根为主 session cwd 加 worker 可读路径，支持跨仓库）；`git_read` 只接受 allowlist 子命令、强制硬化参数、拒绝 `fetch`/`pull` 等网络子命令，textconv/external diff/fsmonitor 均不被触发；Advisor 消息不会进入自身 delta，私有 transcript 不污染主 transcript。
21. 成本：审查 token/cost 独立统计；候选终态触发与队列合并确实减少调用次数，1–3 turn 的短 prompt 每 prompt 至多一次 review 调用（外加修正复审）。
22. Trace 压缩：未审查 delta、尚未完成响应/复审的 review 批次、当前证据和结构化真值固定保留；仅压缩已审查旧历史，主/Advisor 任一 compaction 都不改变 cursor、coverage 或 settlement。

完成标准不是单个 TUI 演示可用，而是共同核心语义、全部入口、错误路径、协议降级和上述状态流转均有自动化证据。

## 16. 分阶段落地

整体交付按六个可独立验收的切片推进；切片 0–2 的详细范围见关联文档：

| 切片 | 内容 | 所属文档 | 依赖 |
| --- | --- | --- | --- |
| 0 | TUI editor-surface FIFO dialog arbiter（修复现有对话框互踩隐患） | [ask-user.md](ask-user.md) | 无 |
| 1 | `PromptSettlementTracker` + `PromptOutcome` + 各模式结算 | [prompt-settlement.md](prompt-settlement.md) | 无 |
| 2 | 通用 `ask_user` + `UserInputBroker` + live/fallback/pending 全链路 | [ask-user.md](ask-user.md) | 0、1 |
| 3 | Advisor 核心：子 runtime、只读工具、cursor、队列、findings、terminal checkpoint | 本文档 | 1 |
| 4 | Advisor TUI/daemon 面：footer、卡片、迟到投递、capability | 本文档 | 3 |
| 5 | 持久化与运维面：ledger 集成、重启重建、诊断、默认值调参 | 本文档 + [prompt-settlement.md](prompt-settlement.md) | 2、3、4 |

切片 2 与切片 3 互不依赖，可并行。

Advisor 部分的预计实现触点：

- `src/core/agent-session-runtime.ts`：持有 Advisor 子 runtime，装配模型、认证、settings、telemetry 和资源所有权。
- `src/core/agent-session.ts`：在 `turn_end` 异步提交 trace，将快速 Advisor checkpoint 接入 `_getContinuationMessages`，并桥接 prompt settlement 的 review coverage 与 correction lineage。
- `src/core/advisor/`：新增子 runtime factory、queue、cursor、schema、delivery router、terminal checkpoint 和 settlement bridge。
- `src/core/advisor/system.md`：定义不可被项目内容覆盖的 Advisor 身份、审查范围、静默行为、severity 与 `report_findings` 契约。
- `src/core/tools/read.ts`、`grep.ts`、`glob.ts`、`git-read.ts`：通用只读工具实现，不进入 `allToolNames`/`ToolName` union（沿 `bash.ts`/`edit.ts` 先例），由 Advisor 经 `baseToolsOverride` 装配。
- `src/core/filesystem-view.ts`（或等价位置）：本设计新增的薄 `FileSystemView` 接口与 v1 本机实现；`read`/`grep`/`glob` 面向该接口编写，`git_read` 为受控子进程、不经该接口。
- `src/core/slash-commands.ts` 与 `agent-session.ts`：注册并执行 session-scoped `/advisor on|off|status`。
- `src/core/settings-manager.ts`：配置类型、默认值、合并和校验（含 `reviewTimeoutMs` 与 retry 链的自洽校验）。
- `src/cli/args.ts`、`command-registry.ts` 与 runtime/daemon create 装配：解析并传播 `--advisor` session override。
- `src/modes/interactive/components/footer.ts` 与 `interactive-mode.ts`：显示一行 Advisor 状态，不恢复其他 footer telemetry。
- `src/modes/interactive/components/`：新增独立 Advisor finding 卡片，消费主 transcript 中的结构化 Advisor custom message。
- `src/modes/daemon/`：能力协商、schema、事件转发和跨版本测试。
- `test/suite/`：基于 harness/faux provider 的需求回归与跨模式状态测试。

### 切片 3：Advisor 核心（依赖切片 1）

- 定义逻辑 advice、review 批次 identity 与展示序号、epoch 和 mode policy 类型；先建立 faux provider 的失败测试与确定性 queue/state-machine 测试。
- 实现完整但受限的 Advisor `AgentSessionRuntime`、增量 cursor、候选终态触发的单飞队列、合并和去重。
- 定义 `FileSystemView` 接口并交付 v1 本机实现；实现 `core/tools/` 下的通用 `read`、`grep`、`glob`（面向该接口）与受控 `git_read`（子命令 allowlist + 硬化参数），并验证 `baseToolsOverride` 与 allowlist 无配置逃生口。
- 将快速有界等待接入主 `AgentSession._getContinuationMessages`，排在既有普通 continuation 之后；接通 `concern`/`blocker` 修正、反驳复审、fail-open outcome 与 settlement bridge。

### 切片 4：Advisor TUI/daemon 面（依赖切片 3）

- 接入内部 turn-end trace enqueue、生命周期 fence 和 correction trigger。
- 实现 Advisor footer 状态、finding 卡片、终态 concern 保留/blocker 唤醒、活跃 steering 和用户 abort fence，不改变 TUI 现有输入调度。
- 增加 capability-gated daemon 状态/事件及跨版本测试。
- 验证 Print、JSON、RPC、ACP 组合同一 session outcome 契约；多个 run 可以产生多个 `agent_end`，但每个 prompt 只有一个终态 outcome。

### 切片 5：持久化与运维面（依赖切片 2、3、4）

- 增加 Advisor session artifact、settlement ledger 集成、重启重建、按 `promptId` 状态查询和诊断。
- 覆盖 worker 重启、连接断开/重连、旧 epoch 结果迟到和无法完整恢复 lineage 的状态测试。
- 补充配置与用户文档。
- 基于真实使用数据调整 timeout、immune window 和修正上限默认值。

每个切片都应形成可运行、可验证的完整交付；不得以占位 runtime、假 Advisor 结果或仅覆盖 happy path 的方式提前宣告完成。

## 17. 风险与反证信号

| 风险 | 早期信号 | 缓解 |
| --- | --- | --- |
| Advisor 造成明显延迟和成本 | 请求结算 P95 超出 `(maxCorrectionCycles + 1) × terminalReviewTimeoutMs` 基线、token 成本持续升高 | 候选终态触发、队列合并、独立模型选择、有界 timeout、默认 opt-in |
| 两个 Agent 形成纠错回环 | 同类 advice 重复、修正次数频繁触顶 | 去重、immune window、修正上限、聚合单条建议 |
| 迟到结果污染新任务 | advice 丢失 A 的 review identity，或被误当作 B 的 finding | 稳定 `promptId`、`reviewId`、epoch、cursor、abort/released fence，并让主 Agent 看到当前完整上下文 |
| 协议演进破坏老客户端 | 老客户端无法 attach/start | capability gate、schema map、双向兼容测试、本地降级 |
| Advisor 获得过多权限 | 审查过程产生工作区或外部副作用 | `baseToolsOverride`、allowlist、独立只读工具集和无配置逃生口 |
| 完整 trace 泄露敏感信息 | Advisor 收到系统凭据，或跨 provider 意外共享 | 结构化排除（§6.3）、跨 provider 残余风险声明与配置文档提示 |

settlement 与 `ask_user` 的风险表分别见 [prompt-settlement.md](prompt-settlement.md) 与 [ask-user.md](ask-user.md)。

若生产数据表明多数任务的审查延迟超过主任务本身、修正命中率长期很低，或 fail-open 频率过高，应重新评估审查触发粒度和默认启用策略，而不是简单增加等待时间。

## 18. 保留的演进空间

当前边界刻意保留以下可逆选项：

- 从单 Advisor 扩展到多个命名 Advisor，共享 queue 接口但使用独立 cursor/runtime。
- 为特定高风险工具增加 pre-tool policy hook，与 post-turn Advisor 分工而非混合。
- 在确定性规则下为长时 autonomous run 恢复 WIP（`in_progress`）阶段的提前审查（例如仅投递 `blocker`、仅 autonomous 模式启用）；首版为控制短 prompt 成本不默认开启。
- 引入更细的同步 backlog 策略，但仍由 terminal checkpoint 与 prompt settlement 控制，不阻塞普通 `turn_end`。
- 为 `FileSystemView` 增加远程/容器实现，使 Advisor 只读工具无改动地继承主 Agent 的非本机文件视图；`git_read` 随之演进。
- 在具备进程级 sandbox 后，为 Advisor 增加可选的受限 IPython。评估时注意已核实的成本：平台沙箱矩阵（Linux Landlock / macOS `sandbox-exec`，Windows 无像样的用户态只读方案）、“禁网”与 ipykernel 默认 TCP loopback 传输冲突（需改 `ipc://` 或精细放行）、forkserver 与沙箱不兼容只能走冷启动；且只读 fs 下测试/构建跑不起来，它验证不了运行行为，净增益只是更强的读取分析。
- 按任务类型选择更便宜或更强的 Advisor 模型，而不改变主 Agent API。

需要重新审议本决策的触发条件：Advisor 必须跨机器运行、必须在工具执行前提供强制授权、需要多 Advisor 法定人数，或 Prime 的所有模式统一迁移到 daemon 托管。除此之外，首版应保持 root `AgentSessionRuntime` 的资源所有权和单 Advisor 模型。

## 19. 与 oh-my-pi Advisor 的关系

本方案参考了 oh-my-pi 已验证的几项机制：按 turn 记录增量 transcript、单飞异步 drain、积压合并、无问题静默、三档严重度、重复抑制、immune window 和独立 Advisor 上下文。

Prime 不直接复制其实现，原因是两者的系统边界不同：

- Prime 的 root `AgentSessionRuntime` 是完整 session 及子运行时的资源和生命周期所有者，适合持有一等 Advisor 子运行时。
- Prime 需要同时定义 TUI（含 daemon 托管）的 footer 状态、finding 卡片与迟到投递，以及 Print/JSON/RPC/ACP 的结算语义。
- Prime daemon 有明确的 capability、schema revision 和双向跨版本要求。
- Prime 当前没有 `modelRoles` 配置抽象，应复用自身的 settings、`ModelRegistry` 和认证链。
- oh-my-pi 在每个 turn 后即可启动一次审查调用；Prime 首版保留每 turn 的 delta 提交与合并，但把审查启动推迟到候选终态与 terminal flush，避免最常见短 prompt 的双倍审查成本，WIP 提前审查保留为演进选项。
- oh-my-pi 默认仅给 Advisor `read`、`grep`、`glob`，但允许通过 `WATCHDOG.yml` 扩权，且工具运行在隔离 `ToolSession` 中并遵循常规审批；Prime 首版选择更严格的强制只读、不可配置扩权边界，并在该边界内额外提供受控 `git_read`，补上 oh-my-pi 工具集缺失的“变更基线/聚合 diff”证据源。
- oh-my-pi 支持 `WATCHDOG.md`/`WATCHDOG.yml` 追加 reviewer-only 项目规则；Prime 首版只使用不可覆盖的内置 Advisor prompt 加主 Agent effective policy context，不引入第三层规则发现与冲突优先级。

`ask_user` 相关的 oh-my-pi 对照（工具注册、批次语义、note、卡片、草稿、FIFO queue、`/tree` 重答等）见 [ask-user.md](ask-user.md)。

Prime 明确采用 oh-my-pi 的一项用户可见语义：同一 Advisor 消息同时注入主 Agent 上下文并渲染为可见卡片；终态迟到 concern 只保留卡片，blocker 才自动唤醒。Prime 仍不以 oh-my-pi 作为运行时依赖或兼容性目标，且保留自身的单 Advisor、强制只读、显式必填 `advisor.model`、PromptOutcome 和跨模式结算设计。

oh-my-pi 的 emission guard 每个 update 最多接受一条 advice，适合持续交互式 steering。Prime 为避免 Print/JSON/RPC/ACP 在同一次结算中逐条发现问题、反复调用模型，保留每个 update 最多一次 `report_findings` 调用、单批最多 3 条独立 finding；对主 Agent 和 TUI 仍只产生一条聚合消息/卡片。

## 20. Prime 源码事实依据

本设计依赖以下当前源码契约；实施前若这些契约变化，应先回到本设计重新核对。settlement 与 `ask_user` 相关的源码事实分别见 [prompt-settlement.md](prompt-settlement.md) 与 [ask-user.md](ask-user.md)。

- `packages/agent/src/agent.ts`：event subscriber 的 Promise 会被等待，因此 `turn_end` listener 只能快速入队，不能直接等待 Advisor 模型调用。
- `packages/agent/src/types.ts`：`getContinuationMessages` 是 host-owned continuation，并且不得让异常逃逸破坏 Agent loop。
- `packages/coding-agent/src/core/agent-session.ts`：`_getContinuationMessages` 已承载 goal 与 autonomous continuation；Advisor terminal checkpoint 应排在这些普通 continuation 之后。
- `packages/coding-agent/src/core/agent-session.ts`：`baseToolsOverride` 与 `allowedToolNames` 是现成的 session 工具边界扩展点。
- `packages/coding-agent/src/core/tools/index.ts`：当前 `allToolNames` 只注册 `ipython`；`bash.ts`/`edit.ts` 等实现存在于 `core/tools/` 但未进入 `ToolName` union，是“通用工具实现、不进主 Agent 默认集”的现成先例。Prime 尚无可直接复用的内置 `read`、`grep`、`glob`。
- `packages/coding-agent/src/core/tools/ipython.ts` 与 `src/core/kernel/`：现有 IPython 配置和 kernel manager 没有进程级只读 sandbox；kernel 为 ipykernel + zeromq 本机子进程（direct spawn 或 forkserver），与 worker 同 OS 用户。受限 IPython 的成本判断依据于此。
- `packages/coding-agent/src/core/`：当前不存在任何 filesystem/exec-environment 适配器抽象，也不存在 trace sanitizer/redact 基础设施；`FileSystemView` 与结构化排除是本设计新增的工作，不是对现有机制的复用。
- `packages/coding-agent/src/main.ts`：Print/JSON 在 continue/resume 路径可经 `DaemonAgentConnection.attach` 连接已存在的 daemon session，因此 `--advisor` 必须同时定义 create（`advisorEnabled` 参数）与 attach（session command 通道）两条生效路径。
- `packages/coding-agent/src/core/agent-session-config.ts`：执行模式是 `interactive | print | json | rpc | acp`；daemon 是承载/传输边界，不是替代这些语义的第六种 Agent execution mode。
- `packages/coding-agent/src/core/slash-commands.ts`：需要跨 client/session 保持语义的内置命令通过 `SESSION_SLASH_COMMAND_NAMES` 标记，并由 `AgentSession` 路径执行；Advisor 开关不能只挂在 TUI 本地 handler。
- `packages/coding-agent/src/cli/args.ts`：当前顶层 parser 统一解析 TUI、text、JSON、RPC、ACP 与 daemon execution mode 的启动参数；`--advisor` 应在这里成为一等 boolean，而不是落入 extension `unknownFlags`。
- `packages/coding-agent/src/core/model-resolver.ts`：现有解析器支持 canonical `provider/modelId` 引用；Advisor 应复用该模型注册表与认证解析能力，但不走主模型的默认选择或 fallback 链。
- `packages/coding-agent/src/core/model-registry.ts`：`getAvailable()` 已通过 `hasConfiguredAuth()` 排除本地未配置认证的模型；Advisor 无需另建凭据预检或发送探测请求。
- `packages/coding-agent/src/core/sdk.ts` 与 `settings-manager.ts`：provider 请求已统一使用 `retry.provider.timeoutMs/maxRetries/maxRetryDelayMs`（`maxRetryDelayMs` 默认 60000）；Advisor 子 runtime 应复用，不再包一层 provider retry。`reviewTimeoutMs` 的默认值与校验规则必须与这些默认值自洽。
- `packages/coding-agent/src/core/agent-session.ts`：现有 auto-retry 已处理 retryable provider/auth error、指数退避、认证来源失效标记、retry-chain completion 与 abort；Advisor manager 只增加外层 review deadline 和连续最终失败暂停，不复制该状态机。
- `packages/coding-agent/src/modes/interactive/components/footer.ts`：Prime 品牌 TUI 的 footer 承载位存在，但当前 `render()` 刻意返回空数组并隐藏 token、cost、model、cwd 和 context telemetry；Advisor 可复用该固定位置而不恢复其他信息。
- `packages/coding-agent/src/modes/daemon/daemon-protocol.ts`：当前 protocol/version 常量和 schema revision 受兼容性规则约束，任何 Advisor wire 扩展都必须按 capability 与跨版本测试治理。
