# 通用 `ask_user` 会话能力设计

> 状态：架构方向已接受，尚未进入实现；本文从 advisor-architecture.md 拆出，`ask_user` 独立于 Advisor 存在与交付
>
> 日期：2026-08-16
>
> 范围：`packages/coding-agent` 的 TUI、daemon、Print、JSON、RPC 与 ACP 入口
>
> 关联：[Prompt Settlement 架构设计](prompt-settlement.md)（fallback 终态依赖 `PromptOutcome`）、[Advisor 架构设计](advisor-architecture.md)（Advisor finding 是主 Agent 调用本能力的上游证据之一）

## 1. 结论

当主 Agent 判断必须由用户补充信息或选择时，不使用私有回执或普通文本猜测，而是调用 Prime 通用的 `ask_user` 会话能力。它是主 Agent 的通用内置工具，不属于 Advisor 输出 schema，也不由 Advisor 直接调用；即使 Advisor 未启用，主 Agent 也能在本身缺少必要信息时调用它。

该能力由 session-owned `UserInputBroker` 根据当前入口是否存在可交互 responder（响应端）选择路径：有 responder 时在当前 tool call 内等待回答，返回正常 tool result，并继续同一个 Agent run；同一 assistant batch 的多个 ask 调用按原始顺序独立串行。没有 responder、responder 断开或入口不支持交互时，才将当前与尚未执行的询问持久化为有序 pending queue，正常结束当前 run，并以 `PromptOutcome(needs_user_input)` 结算当前 prompt。两条路径共享同一问题与答案契约，不从 assistant 文本猜测状态。

root 主 Agent 的普通 coding session 始终注册 `ask_user`，不增加 `ask.enabled` 用户设置；TUI、Print、JSON、RPC 与 ACP 看到同一个工具，只由 responder 能力决定 live 或 fallback。Advisor 和其他受限 child runtime 仍通过现有 `baseToolsOverride/allowedToolNames` 排除它；测试或嵌入式调用方也可显式构造不含该工具的专用 session，但这不是普通用户配置。这样不会出现审查方要求主 Agent 询问、工具却因全局开关关闭的矛盾状态。

## 2. 目标与非目标

### 2.1 目标

- 所有入口使用同一个通用 `ask_user` 会话契约：可交互入口在同一 run 内获得回答，无 responder 时以结构化 `needs_user_input` 结束当前 prompt，而不是从 assistant 文本猜测“这是问题”。
- live 与 fallback 共享同一问题与答案 schema；持久化值不因展示层被截断或改写。
- 用户主动取消与 transport 丢失是两种不同状态，永不合并为同一个布尔值。
- TUI 占用 editor surface 的所有非 overlay 对话框统一串行，修复现有互相覆盖的隐患。

### 2.2 非目标

- 不用 `ask_user` 代替工具执行前的权限、安全或人工审批，也不得用它请求密码、token 等敏感凭据。
- 首版不提供历史 `ask_user` 重新作答。`/tree` 选中既有 ask tool result 时沿用普通树导航，不重开问题、不改写旧结果，也不创建 sibling answer branch；需要改变方向时由用户在目标分支继续发送普通 prompt。
- fallback 后不新增 `answer_user` 命令或第二套提交协议。
- 首版不提供 ask timeout 配置或参数。
- 首版问题不提供模型生成的 `header`；未来若 TUI 需要短标签，应由 host 从问题文本派生或通过兼容扩展增加。

## 3. 工具契约

### 3.1 调用与问题结构

每次调用必须包含 1–4 个问题；该约束在工具参数校验时执行，并由 live responder、fallback 持久化与恢复共同复用，不能由某个 UI adapter 私自放宽。一次调用以现有 `toolCallId` 关联当前 ask 实例，模型不提供额外的 `question.id`：批内问题与答案按不可变数组下标映射，结构化结果同时重复问题文本；fallback 以 `promptId + toolCallId` 定位整次询问。ACP form 等 transport 需要字段键时，由 adapter 临时生成 `q0`、`q1`，这些键不进入模型契约或持久 identity。

每个问题必须包含 `question` 与 `options`，且 `options.length` 只能是 `0` 或 `2–4`：空数组表示纯文本输入，2–4 个预设项表示选择题，运行时统一增加“其他”自由输入；单个选项和超过 4 个选项均在工具参数校验阶段拒绝。工具 schema 不增加冗余的 `kind: "text" | "select"`；各 responder 根据 `options.length` 渲染，fallback 也保存同一原始结构。选项包含 `label`，并可提供短纯文本 `description` 和 Markdown `preview`。问题、label 与 description 必须在没有 preview 时仍足以作答；preview 是补充展示，不能承载唯一必要信息。

多问题 UI 由 host 显示 `问题 1/4` 一类序号；Print 与结构化模式只使用完整问题文本。

### 3.2 字符串规范化

模型生成的 `question` 与 option `label` 先 trim，结果必须非空；label 再做 Unicode NFC 规范化。可选 `description`/`preview` 仅用 trim 判断是否全空白：全空白视为未提供，非空时保留原文，避免改写 Markdown。用户提供的纯文本答案和 `customInput` 必须至少包含一个非空白字符，但校验通过后保留原始字符串，不做 trim；`note` 全空白时视为未提供，非空时同样保留原文。ANSI 与终端控制字符只在 TUI 展示边界过滤，持久化值和结构化协议不静默改写。

option label 经 trim 和 Unicode NFC 规范化后必须非空，并在同一问题内保持大小写敏感的唯一性；规范化后的值作为持久化与 `selectedOptions` 返回值。重复 label 在工具参数校验阶段拒绝。运行时的“其他”等控制项以内部 sentinel 表达，不混入 `selectedOptions`；其最终显示名称随 UI 契约确定，不要求模型伪造控制项 label。

### 3.3 单选、多选与答案

问题支持可选 `multi`，默认 `false`，但 `options: []` 与 `multi: true` 的组合非法。单选答案必须是恰好一个预设选项或一段 custom input，不能同时存在；多选答案可包含多个不重复的预设选项，并可附加一段 custom input。两种模式统一返回原问题文本、`selectedOptions: string[]`、可选 `customInput` 与可选答案级 `note`，避免按题型分裂结果协议。`note` 对该题整组答案生效，不绑定具体 option；这样单选可以表达“选择 A，但有附加条件”，多选也不会丢失归属。

非空选项题可提供 `recommended?: number`，其值必须是有效的原始 `options` 数组下标。它只表达主 Agent 的推荐：TUI 显示独立标识，结构化模式与 fallback 原样携带下标，但任何 adapter 都不得修改原始 label、自动作答或由此引入 timeout 默认选择。`options: []` 时禁止设置 `recommended`。

### 3.4 declined 与 chatRedirect

整次 ask 还支持 host-owned `declined: true` 正常结果，表达“用户拒绝回答，但允许 Agent 继续”。它不是模型 option、custom input、`chatRedirect` 或取消；declined result 不携带选择、custom input 或 note，同一 assistant batch 的后续独立 ask 仍继续展示。主 Agent 收到后自行采用保守默认或解释为何无法继续。TUI/RPC/daemon 显示“跳过并继续”，ACP 标准 `decline` 映射到该结果；ACP `cancel` 与 live 用户取消仍 abort 当前 prompt。fallback pending 可逐项 declined，并作为独立 answer block 持久化。

TUI 及支持该 affordance 的 RPC/daemon responder 提供 host-owned“先讨论”控制项。它不是选项答案、custom input 或取消：选择后当前 ask 返回正常 tool result，details 标记 `chatRedirect: true` 并保留原问题文本，主 Agent 在同一 run 中解释或讨论。该 assistant batch 中尚未展示的后续 ask 不再弹出，各自获得明确 deferred tool result；主 Agent 讨论后自行决定是否重新询问。Print/JSON/ACP fallback 不需要专门控制项，用户可在下一 prompt 直接表达讨论意图。

### 3.5 tool result 与历史

live ask 的 tool result 同时提供简洁的人类可读文本与结构化 details，二者表达同一结算。details 只重复问题文本、`declined`、规范化后的选择、custom input、note 和题型所需字段；完整 options、description 与 preview 已保存在原 tool call 参数中，不在 result 中复制，通过 `toolCallId` 关联即可恢复。TUI 将完成结果持久展示为 Ask 卡片，显示问题和最终答案或 declined 状态；resume/export 复用同一 tool call/result 对。fallback 后产生的回答则作为带旧引用的新 user message 追加，不能回写、替换或伪造旧 fallback tool result。

### 3.6 无 timeout、无专属 payload 上限

首版不提供 ask timeout 配置或参数。live responder 一直等待到用户回答、用户主动取消或 responder 明确变为 unavailable；后者进入持久化 fallback。Print/JSON 直接走 fallback，不启动等待 timer。`recommended` 永远不能触发按时自动选择，避免用户阅读 preview 或暂时离开时被系统代答。

首版遵循 oh-my-pi，不增加 ask 专属的字符数、字节数或总 payload 上限；问题、选项、preview、custom input 复用 Prime 通用 tool/message/protocol 资源边界。TUI 只限制可视布局：对话框使用有界高度和滚动视图，问题标题与 description 使用行数预算，preview 可滚动查看；不得为了适配界面截断持久化值或发送给主 Agent 的答案。未来若需要更严格的 payload budget，应在通用消息/协议层统一治理，而不是只限制 `ask_user`。

### 3.7 调用时机的内置工具说明

`ask_user` 的内置工具说明采用 oh-my-pi 的 default-to-action 原则：主 Agent 必须先穷尽当前上下文、代码、配置、文档、历史和可用工具；只有不同方案存在必须由用户决定的实质取舍时才询问。如果多个方案均可接受，则选择最保守、最标准的方案并继续，同时说明所选默认。用户前提错误且纠正会改变目标、范围或产品意图，也属于必须询问的实质取舍。

工具说明同时规定：不要询问能够自行查证的事实；相关问题优先放在同一次调用中，label 保持简短、差异写入 description，有真实优选时设置 `recommended`；不要由模型添加运行时“其他”控制项；不得用 `ask_user` 代替权限审批、安全策略或请求密码、token 等敏感凭据。host 只硬校验 schema、权限和状态边界，不尝试用关键词分类器判断模型是否“本该询问”。

## 4. `UserInputBroker` 与执行路径

Prime 应在 session 层提供统一的 `UserInputBroker`，把工具 schema、交互 transport 和 prompt settlement 解耦。

### 4.1 autonomous 例外

autonomous 是唯一不按 responder 能力进入 live/fallback 的 root session 策略例外。Prime 现有 autonomous 契约明确无人类输入；启用时工具仍保持注册，但 broker 不弹 UI、不建立 pending queue，也不产生 `needs_user_input`，而是立即闭合为明确的 `human_unavailable_in_autonomous` tool result，让同一 run 按现有 continuation prompt 采用保守假设并验证。该状态不是 transport unavailable。关闭 autonomous 后立即恢复普通 live/fallback 路径，无需重建工具集。

### 4.2 执行路径

```text
ask_user(toolCallId, questions)
  -> autonomous 已启用
       -> 返回 human_unavailable_in_autonomous tool result
       -> 不展示、不持久化 pending，同一 Agent run 继续
  -> 有可交互 responder
       -> 建立仅存于当前 runtime 的 live request
       -> tool execution 等待结构化 answer
       -> 返回完整正常 tool result
       -> 清理 live request，同一 Agent run 继续
  -> 无 responder / responder 断开 / 模式不支持
       -> 将问题实体化为可持久化 pending question
       -> 返回完整的 fallback tool result
       -> shouldStopAfterTurn 正常结束当前 run
       -> PromptOutcome(needs_user_input)
       -> 用户后续通过普通 prompt 通道回答并建立同一 session 的新 prompt
  -> 用户明确取消
       -> 请求当前 session prompt abort
       -> 工具执行器生成明确的 aborted tool result
       -> PromptOutcome(cancelled)
       -> 不保存 pending question，不允许主 Agent 自动继续
```

所有路径都必须依照 Prime 现有工具执行/abort 机制闭合 tool call，不在 provider transcript 中留下悬空调用。live responder 路径不会产生中间 `PromptOutcome`，当前 prompt settlement 保持进行中；fallback 路径不使用 abort 伪装结算，并必须把问题数据放进结构化 outcome。连接断开必须被识别为 responder `unavailable`，不能与用户主动取消混为同一个布尔值。用户主动取消建立与普通用户中断相同的硬停止 fence；后续 Advisor finding、goal 或 autonomous continuation 不得自动恢复该 prompt。

### 4.3 批次支配

`ask_user` 支配所在的整个 assistant tool-call 批次，但只抑制非 ask 工具。host 先收集该批所有参数有效的 `ask_user`，按 assistant 原始顺序逐个执行；每个调用保持自己的 `toolCallId`、1–4 个问题、独立 UI 提交和独立 tool result，不合并、不做语义去重，也不设置整批问题总上限。所有非 ask sibling 均不执行，但仍产生按原始顺序排列的明确 tool result，说明“因等待用户回答而未执行”。

若 live responder 完成全部 ask，主 Agent 在所有完整 tool results 之后继续同一 run。若在第 N 个 ask 时 responder 变为 unavailable，第 N 个及之后尚未执行的 ask 按原始顺序进入 pending queue；之前已回答的调用保留正常结果，所有未回答调用获得闭合的 fallback tool result，`shouldStopAfterTurn` 依非空 pending queue 停止 run。若用户在任一 ask 主动取消，则 abort 当前 prompt，之后尚未执行的 ask 获得 aborted tool result，不形成 pending queue。不得并行打开多个 selector，不得先执行非 ask sibling 再询问。

该规则由 host 在工具执行前基于整条 assistant message 确定，不依赖 tool-call 排列顺序或模型自觉。它同时适用于当前 `sequential` 和 `parallel` 工具执行模式，从而确保澄清前不发生其他副作用。

### 4.4 校验边界

`UserInputBroker` 是所有 responder 答案的最终校验边界，不能信任 TUI、RPC、daemon 或 ACP adapter 已经正确约束输入。校验至少覆盖回答数量与问题数组顺序、字段类型、`selectedOptions` 的规范化 label 成员关系与唯一性、单选/多选/custom input 组合、note 契约，以及 declined 与其他答案字段互斥。非法 live answer 不闭合 tool call，也不转换为取消或 fallback：RPC/daemon 返回结构化错误并保留同一逻辑 request 供重试；ACP 重新 elicitation 同一 `toolCallId`，允许更新短期 transport request ID。pending answer 非法时拒绝对应新 prompt admission，保留 queue 与已答断点。只有 responder 明确 unavailable 才进入 fallback，非法 option 不得自动降级为 custom input。

### 4.5 fallback 后的回答

fallback 后不新增 `answer_user` 命令或第二套提交协议。旧 prompt 已经终态化，用户的下一次输入通过各模式既有 prompt 通道建立新 prompt：TUI/RPC/daemon 可以提交结构化选择，Print/JSON/ACP 也可提交普通文本；host 将可见答案与旧 `promptId/toolCallId` 引用归一化为主 Agent 可见的用户消息。新 prompt 成功 admission 时原子消费对应 pending queue；提交失败则保留队列。用户输入无论是回答、拒绝还是改换话题，都视为对旧等待状态的显式处理，旧 outcome 不重开。

## 5. TUI 交互契约

- `ask_user` 使用 TUI responder 显示聚焦式问题 UI，在 tool execution 内无超时等待回答；回答作为正常 tool result 返回后，同一 Agent run 继续。用户明确取消时终止当前 prompt 并建立 abort fence，不转成 pending question。该等待属于明确的用户交互状态，不由 Advisor footer 代替。
- `ask_user` 出现时若主编辑器已有草稿，对话框正常显示但暂不取得输入所有权，并提示用户先提交或清空当前草稿。草稿继续由现有编辑器处理：提交时仍按 Prime 既有 `steer`/`followUp` 规则排队，清空或提交导致编辑器为空后，输入所有权才切换给 ask 对话框。草稿不得被丢弃、覆盖或隐式解释为 ask 答案。
- TUI 在当前高亮选项存在 `preview` 时显示对应 Markdown 预览区域；切换选项只更新该区域，不把 preview 追加成聊天消息，也不改变实际选择结果。preview 作为不可信模型输出过滤 ANSI 与终端控制字符，并服从现有 Markdown renderer 的宽度与转义规则。
- TUI ask 对话框使用有界高度和滚动视图；问题标题与 description 可视行数受预算约束，preview 完整保留并可滚动查看。布局省略或折叠不得修改 transcript、fallback payload 或 tool result 中的原值。
- TUI 额外显示“先讨论”运行时控制项；选择后以 `chatRedirect` 正常闭合当前 ask，并让主 Agent 在同一 run 回应，不建立 pending queue 或 abort fence。
- TUI 还显示整次 ask 级“跳过并继续”；选择后返回 `declined: true` 正常 result，让同批后续 ask 和主 Agent 继续。它与“先讨论”和取消保持独立。
- TUI 在提交单题答案前允许添加或编辑整题 note；note 与选择/custom input 分开显示并一同返回，不绑定当前高亮行。
- live ask 完成后在聊天记录中保留完成态 Ask 卡片，显示问题、选择/custom input 与答案级 note；卡片由原 tool call 参数和结构化 result 共同渲染，不在 result 重复 options、description 或 preview。fallback 后的回答显示为新的 user message，不修改旧卡片或旧 tool result。

### 5.1 pending queue 的展示与恢复

TUI 初次打开或重新 attach 到存在 pending queue 的 session 时，自动用正常 ask 选择器展示队首问题，并按队列顺序继续展示后续问题；这是对新 prompt 输入的辅助界面，不复活旧 live Promise、transport request 或旧 prompt outcome。每个 ask 仍以自己的 `toolCallId` 独立作答，答案按原顺序逐项持久化；host 不在中途启动主 Agent，只有整条 pending queue 都已回答时才将多个独立 answer block 组合为一个可见 user message，通过一次既有 prompt admission 恢复执行。该组合只是传输和恢复边界，不合并问题、答案或 identity。

用户在中途按 `Esc` 时只收起当前选择器：已完成答案保持持久化，当前及后续未答项保持 pending，下次从第一个未答项继续。若用户关闭选择器后直接发送普通文本，则明确放弃全部剩余 pending；host 将已答 answer block、剩余问题被放弃的状态与该普通文本一同规范化为新 user prompt，并仅在 admission 成功后原子消费整条队列。自动展示不得阻止用户收起选择器后继续正常编辑。

pending 选择器收起后不增加 `/answer_user`、专用命令或新硬编码快捷键。主编辑器为空且仍有未答 pending 时显示 `Pending question — Enter to answer` 一类提示；执行现有可配置的 editor submit action 重新请求展示第一个未答项。若 editor 非空，同一 submit action 保持普通 prompt 语义并按上段放弃剩余 pending；queue 清空后，空提交恢复现有 no-op。若其他非 overlay 对话框正在占用 editor surface，重开请求进入共享 FIFO arbiter。

### 5.2 editor-surface FIFO dialog arbiter

TUI responder 不能只给 ask 建一个局部锁。Prime 所有占用 `editorContainer` 的非 overlay 对话框必须通过同一个 FIFO dialog arbiter 展示，包括 `ask_user`、extension `select`/`confirm`/`input`/`editor` 及应用内同类 selector；否则任一后到对话框直接清空容器后，会让先前等待的 Promise 失去界面且无法完成。当前项回答、取消或 abort 后才展示下一项；尚未展示就 abort 的请求从队列移除。每次结算必须恢复正确焦点并推进队列。overlay 通知、Advisor footer 和不占用 editor surface 的展示不进入该队列。

现有 `interactive-mode.ts` 中 extension `select`/`input`/`editor`、custom 非 overlay UI 与应用 selector 都会直接清空并替换 `editorContainer`，没有统一 presentation queue——这是今天就存在的对话框互踩隐患，arbiter 作为独立切片先行交付（见第 12 节）。

## 6. daemon 多 responder 契约

daemon 若增加相关命令、事件或响应字段，按“可选能力”处理。客户端必须先检查协商 capability，老客户端和老 daemon 均应继续完成普通会话启动与交互。已 attach 且声明 UI 能力的 daemon client 可作为 live `ask_user` responder；最后一个可用 responder detach 时，broker 将未回答问题转换为持久化 fallback，并结束当前 run，不能让 tool execution 永久等待。capable client reattach 后由 daemon 提供完整 pending queue，客户端自动展示队首；重连 transport 不复用断线前的 request ID。

同一 session 有多个 capable responder 时，daemon 将逻辑 ask 广播给所有已 attach responder，broker 原子接受第一条校验通过的答案。daemon 随即广播 settled 事件，让其他客户端关闭重复选择器；非法答案不参与竞速，迟到合法答案返回结构化 `already_settled`，不能退化成 unknown request。单个 capable responder detach 不影响 live wait，只有最后一个 capable responder 消失才进入 fallback；普通不具备 UI capability 的 attached client 不计入该判断。pending 重连展示采用相同 first-valid-wins 规则。

多 responder 下第一条明确的 live `cancel` 与第一条有效答案同样具有全局结算权：broker 原子 abort 当前 prompt，并广播 settled 关闭所有副本。attached capable client 已拥有同等 session 输入/中断权限，不引入额外 owner 选举。socket 关闭、进程崩溃、capability detach 或 UI transport failure 仍只表示该 responder unavailable；只要还有 capable responder 就继续等待，最后一个消失才 fallback。已经 fallback 的 pending 选择器按 `Esc` 仍只是本地收起，不能追溯取消旧 prompt。

## 7. 各模式映射

模式映射遵循 responder 能力，而不是为每个入口复制工具语义：TUI、具备 UI responder 的 direct RPC、已 attach 的 capable daemon client，以及声明 ACP experimental form elicitation 能力的客户端可在同一 run 内回答；Print 和 JSON 没有 responder，进入结构化 fallback；RPC/daemon 连接断开或 ACP 客户端不支持 elicitation 时也进入 fallback。fallback question 必须持久化，以便后续展示和回答；live Promise、transport request ID 和 UI 组件状态不得持久化。

`needs_user_input` 的 `PromptOutcome` 语义与 Print/JSON 退出码 `2` 的定义见 [prompt-settlement.md](prompt-settlement.md)。

### 7.1 Print

- Print 没有 live responder；`ask_user` 将问题写入 stdout，产生结构化 `needs_user_input` outcome 后结束本次进程。
- Print 在对应选项下输出 preview 的原始 Markdown 文本，不尝试生成 ANSI 富渲染；stdout 仍包含完整可作答内容。
- 后续 Print 调用以普通输入建立新 prompt；host 在 session 存在 pending queue 时附加旧引用并消费队列，不要求新的 CLI answer 参数。

### 7.2 JSON

- JSON 没有 live responder；`ask_user` 产生包含问题数据的 `prompt_outcome(needs_user_input)`，不得等待不可到达的交互响应。
- JSON 的 question payload 原样保留每个选项的 `description` 与 `preview`，不做展示层转换。
- JSON 调用方用现有 prompt 输入提交后续普通文本；若未来在既有 prompt payload 内增加可选结构化 answers，必须独立做 schema 兼容分类，但首版不要求它。

### 7.3 RPC 与 daemon

- direct RPC 复用现有 `extension_ui_request`/`extension_ui_response` responder：支持该能力且连接存活时，同批 `ask_user` 在 tool execution 内独立串行等待回答并继续同一 run；未协商、连接断开或 responder 不可用时，将当前及剩余调用转换为有序持久化 pending queue，并以结构化 `needs_user_input` 完成该次 prompt。
- RPC/daemon 的 capable responder 接收结构化 preview 并可按自身 UI 展示；fallback 和持久化不得丢弃该字段。
- RPC/daemon capable responder 可声明并返回 `chatRedirect`；不支持该 affordance 的客户端仍可正常选择、custom input 或走 fallback，不能因此失去基础 ask 能力。
- RPC/daemon capable responder 可返回整次 ask 级 `declined`；它正常闭合当前 tool call 并继续后续 ask，不得映射成 cancel、unavailable 或 custom input。
- RPC/daemon 的结构化 answer 可携带答案级 `note`；不支持 note 的 responder 仍可提交基础答案，该字段保持可选。
- RPC/daemon responder 的答案在 broker 校验通过前不得 resolve live ask；非法 response 的 command 返回结构化 validation error，并允许客户端针对同一逻辑 request 重新提交。该错误既不是用户取消也不是 responder unavailable。
- fallback 后 RPC/daemon client 仍使用既有 prompt command 提交结构化选择或普通文本；不增加 `answer_user` command。新 prompt ACK 成功后 pending queue 才能被消费。

### 7.4 ACP

- 客户端声明 `elicitation.form` 时，`ask_user` 通过 ACP SDK 的 experimental form elicitation 在当前 `session/prompt` 内获得回答并继续；option description 映射到标准 enum description，Markdown preview 放入 Prime namespaced `_meta`，支持的客户端可富展示，其他客户端可安全忽略。未声明或交互连接丢失时，保持标准 `end_turn`，并在协议允许的 namespaced `_meta` 中返回 `needs_user_input` 与完整问题数据。不得把 `request_permission` 误用为通用问答协议。
- ACP form 为每题增加可选的普通 string note property；客户端不填写时不产生 note，不依赖 Prime 私有 UI 控件。
- ACP `decline` 映射为整次 ask 的 `declined: true` 正常结果；ACP `cancel` 才映射为用户主动取消并 abort 当前 prompt，两者不得合并。
- ACP form 返回值仍由 broker 按共同 answer schema 校验；非法值不进入 tool result，host 以同一 `toolCallId` 重新发起 elicitation，可使用新的 ACP request ID。只有连接丢失或 capability 消失才进入 fallback。
- ACP fallback 的后续回答是新的标准 `session/prompt`；host 结合 session pending queue 建立旧引用，不要求 ACP 增加 Prime 私有 answer method。

## 8. 持久化与恢复

- live Promise、transport request ID 和 UI 组件状态不持久化；fallback pending question 必须持久化，以便后续展示和回答。
- daemon client 通过已协商的 UI responder 串行回答 live `ask_user`；最后一个可用 responder detach 时，当前及剩余未回答调用按序转换为持久化 fallback，而不是仅取消 UI Promise、丢失问题或无限等待。重连后自动展示队首 pending 并按序处理，但不复用旧 transport request ID；`Esc` 只收起 UI，不消费或取消 pending。
- worker 重启后，无法恢复的当前及剩余 live asks 必须按原始顺序实体化为 pending queue 并进入 `needs_user_input` fallback，不能尝试复活旧 Promise。
- fallback pending queue 的逐项结构化答案在选择后立即持久化，但不单独启动 Agent；全部回答完成后通过一次新 prompt admission 提交有序 answer blocks。中途 `Esc` 或重启保留断点；普通文本显式放弃剩余项。整条 queue 只在最终 prompt admission 成功后原子消费，失败或再次断开时保留，且始终不改变旧 `needs_user_input` outcome。

settlement ledger 中 pending queue 与 answer blocks 字段的归属见 [prompt-settlement.md](prompt-settlement.md)。

## 9. 协议兼容性

| 变化 | 建议分类 |
| --- | --- |
| daemon/RPC 复用既有 extension UI responder 回答 `ask_user` | 既有能力内实现；若新增问题 schema、状态或断线 fallback 字段，则相应部分 capability-gated |
| RPC/daemon responder 的 `chatRedirect` affordance | 可选 UI capability；不支持时只降级该控制项，不影响基础 ask |
| daemon/RPC 的 `ask_user` pending question queue 与 `needs_user_input` outcome | capability-gated，并覆盖多 ask 串行、部分已答、断线转换、新客户端/旧 daemon 与旧客户端/新 daemon |
| daemon 多 responder 的 ask settled/`already_settled` 事件与响应 | capability-gated；新 daemon 向 capable clients 广播并以首个有效答案结算，旧客户端忽略未知 settled 事件仍可由请求结束清理 |
| fallback answer 提交 | 复用既有 prompt command/method；不新增 wire command，结构化 answers 若后续加入则单独 capability/schema 分类 |
| ACP experimental `elicitation.form` 的 `ask_user` live responder | capability-gated，客户端未声明时不得调用 |
| ACP namespaced `_meta` 中的 `ask_user` fallback 状态 | 在 ACP 允许未知 metadata 的前提下 backward-compatible |
| ACP namespaced `_meta` 中的 option preview | backward-compatible 的可选展示增强；标准 description 必须独立可作答 |

每个实际 daemon wire change 仍必须同步更新 `DAEMON_SCHEMA_REVISION`、命令/事件兼容映射，并覆盖 new-client/old-daemon 与 old-client/new-daemon 双向场景。

## 10. 测试与验收

使用 `packages/coding-agent/test/suite/harness.ts` 和 faux provider，不调用真实 provider、API key 或付费 token。至少覆盖：

1. 注册与排除：root 主 Agent 在所有模式始终注册该工具且无普通用户开关；Advisor/受限 child runtime 通过 allowlist 排除，测试/嵌入式专用 session 可显式不装配；Advisor 关闭时主 Agent 仍可使用。
2. 调用结构：每个调用严格包含 1–4 个问题，只以自己的 `toolCallId` 关联，模型不提供 `question.id` 或 `header`，调用内问题按不可变数组下标映射、由 host 显示序号，结果重复问题文本，ACP 所需 `q0` 等字段键仅为 adapter 内部细节。
3. options 契约：每题 `options` 必填且长度只能为 0 或 2–4：空数组渲染纯文本输入，非空数组渲染选择并自动提供“其他”，所有模式和 fallback 使用同一结构，非法数量在工具参数阶段拒绝。选项可携带短纯文本 `description` 与 Markdown `preview`；问题/label/description 在无 preview 时仍须可作答。TUI 高亮时富渲染过滤后的 preview；Print 输出原始 Markdown；JSON/RPC/daemon 原样保留；ACP 用标准 description 加 Prime `_meta`，忽略扩展不影响作答。
4. label 与答案：option label 经 trim/NFC 后非空并在同题内大小写敏感唯一，规范值用于持久化与答案；运行时控制项使用 sentinel，不混入 `selectedOptions`。`multi` 默认 false，纯文本题不得启用；单选只能返回一个预设项或 custom input，多选可返回多个不重复预设项并附加 custom input，结果统一为 `selectedOptions` 加可选 `customInput`。非空选项题可用合法下标 `recommended` 标记推荐项；各模式显示/传输该提示但不得改 label 或自动选择，纯文本题禁止该字段。
5. 等待语义：首版无 timeout；live responder 只因回答、主动取消或 unavailable 结束，Print/JSON 立即 fallback。
6. 批次支配：同一 assistant batch 的全部有效 ask 按原始顺序独立串行，每个保持独立 UI 提交与 tool result，不合并、不去重、不设整批问题上限；只有非 ask sibling 被抑制并获得明确 tool result，sequential/parallel 两种执行模式结果一致。
7. live 完成与 fallback：TUI、capable direct RPC、已 attach 的 capable daemon client 和支持 ACP form elicitation 的客户端逐个等待回答，全部完成后继续同一 run。Print/JSON、无 responder、断线和不支持 elicitation 的 ACP 将当前及剩余 ask 按序放入持久化 pending queue，并以 `PromptOutcome(needs_user_input)` fallback，不用 abort 伪装结算；此前已回答结果保留。fallback 后结构化选择或普通文本都通过既有 prompt 通道建立新 prompt，携带旧引用，并只在 admission 成功时原子消费队列；旧 outcome 不重开。
8. 取消：用户主动取消产生当前及剩余 aborted tool results 与 `PromptOutcome(cancelled)`、不保存未回答问题且不能被 Advisor/goal 自动恢复；transport 断线不得误判为取消。live Promise 不持久化，daemon detach/restart 转换后不丢失问题或复活旧 transport request，各模式均不无限等待。
9. chatRedirect：TUI 与 capable RPC/daemon 选择“先讨论”后，当前 ask 返回 `chatRedirect` 正常结果，同批后续 ask 返回 deferred 结果，主 Agent 在同一 run 讨论后自行决定是否重问；该动作既不是答案也不是取消。
10. 调用策略：主 Agent 会先穷尽已有信息源，只在必须由用户决定的实质取舍上询问；多个方案都可接受时采用保守标准默认；不会用 ask 代替权限/安全策略或索取敏感凭据。相关问题优先同次调用、有真实优选才设置推荐；这些行为由工具说明与模型测试约束，不引入关键词硬分类。
11. 资源与布局：不增加 ask 专属 payload 上限，合法内容完整进入持久化与 tool result；TUI 通过有界高度、标题/description 行预算和滚动视图保持可用，不能用静默截断伪装成功。
12. 答案附注：单选、多选、纯文本和 custom input 均可携带一个可选的答案级 note；note 不绑定 option，TUI/RPC/daemon/ACP 映射一致，不支持的 responder 可省略。
13. 结果与历史：live result 的可读文本与结构化 details 等价，完成态 Ask 卡片在 resume/export 后仍能由 tool call 参数和 result 正确重建；result 不复制 options/description/preview。fallback answer 只追加带旧引用的可见 user message，旧 tool result、旧 outcome 与旧卡片不可变。
14. responder 校验：答案数量/顺序错误、未知或重复 option、单选多值、非法 custom input 组合、错误字段类型、非法 note，以及 declined 与答案字段并存均被 broker 拒绝；RPC/daemon 可用同一逻辑 request 重试，ACP 以相同 `toolCallId` 重新 elicitation，tool call 在有效答案前保持等待；pending admission 失败保持 queue/断点，断线才 fallback，非法 option 永不转成 custom input。
15. decline：TUI/RPC/daemon 的“跳过并继续”和 ACP `decline` 都生成无选择/custom/note 的 `declined: true` 正常 result，同批后续 ask 继续；ACP `cancel` 与 live cancel 仍 abort；fallback pending 可逐项持久化 declined answer block，resume 后不误作普通文本或 unavailable。
16. daemon 多 responder：两个 capable client 同时收到 ask，首个有效答案原子胜出并触发 settled 广播，另一端关闭选择器且迟到提交得到 `already_settled`；首个非法答案不胜出；任一端明确 live cancel 全局 abort 并关闭其他副本，socket/capability detach 不误判为取消；单端 detach 继续等待，最后一个 capable responder detach 才 fallback，仍 attach 的非 capable client 不能阻止 fallback；pending 重连时 `Esc` 仅本地收起。
17. 字符串规范化：question/label trim 后空值被拒，label NFC 后执行唯一性；description/preview 全空白变为未提供而非空字段，非空 Markdown 原文不变；纯文本/custom input 全空白被拒但合法原文首尾空白保留；note 全空白省略、非空原文保留；TUI 过滤 ANSI/控制字符只影响渲染，不改变持久化、result 或协议 payload。
18. TUI 草稿：ask 出现前已有的普通草稿、图片草稿和粘贴快照均继续归主编辑器所有；ask 可见但输入受保护，提交后按原选择进入 `steer` 或 `followUp` 队列，清空后直接解锁 ask；任何路径都不丢草稿、不将其当作答案，并在 ask 完成或取消后恢复正常编辑器焦点。
19. pending 重连：TUI 启动和 daemon reattach 自动展示第一个未答项并保持顺序；每项答案按自己的 `toolCallId` 持久化且不提前启动 Agent，全部完成后一次 admission 生成含有序 answer blocks 的新 prompt；中途 `Esc`、再次断线和 worker 重启均从持久化断点继续，普通文本提交已有答案并显式放弃剩余项；最终 admission 失败不消费 queue，旧 outcome 不重开，断线前 transport request ID 永不复用。
20. pending 重开：选择器收起后只有 editor 为空且 queue 未清空时显示按实际 submit keybinding 渲染的提示；空提交经 FIFO arbiter 重开第一个未答项，非空提交执行普通文本/放弃语义；queue 清空后提示消失且空提交恢复 no-op，不添加硬编码键检查或 answer command。
21. 对话框串行：ask 与 extension select/confirm/input/editor、应用 selector 以两种先后顺序并发请求时严格 FIFO，后到项不能清空或悬挂先到项；回答、取消、当前 abort、排队 abort、组件构造异常和 session dispose 均恰好结算一次、恢复正确焦点并继续或清空队列；overlay 与 Advisor footer 不受阻塞。
22. autonomous：工具名称始终存在，但启用状态下无论 TUI、RPC、daemon 或 headless 是否有 responder，调用都立即得到 `human_unavailable_in_autonomous` 并继续同一 run，不创建 UI、pending 或 `needs_user_input`；off 后下一次调用恢复正常路径，动态切换不重建工具集，也不把 autonomous 拒绝误报为 transport failure；autonomous human-unavailable 不误用退出码 `2`。
23. 历史导航：`/tree` 选择已经完成的 ask tool result 只执行现有普通导航，不重新打开 responder、不自动恢复 Agent，也不创建替代答案分支。

## 11. 与 oh-my-pi 的关系

本设计复用了 oh-my-pi `ask` 的多项已验证交互语义，但按 Prime 的系统边界重新定界：

- oh-my-pi 的 `ask.enabled` 默认 true，但 `ask` 只在 `session.hasUI` 时注册，并在 tool execution 内等待 UI 回答；用户取消时调用 `context.abort()` 并抛出 `ToolAbortError`；“Chat about this”则返回 `chatRedirect` 正常结果，让 live Agent turn 继续。Print、JSON 与 ACP 等 headless 入口不会得到该工具。它要求模型为每个问题提供语义 `id`，主要用于批内答案映射和历史重新作答；`options` 必填但未限制最小数量，运行时提供自定义输入；timeout 可配置但默认关闭。Prime 复用其交互语义，但让 root 主 Agent 在所有模式始终拥有工具且不提供普通用户开关，通过 `UserInputBroker` 和持久化 fallback 覆盖 headless 入口；Advisor/受限 child runtime 仍由 allowlist 排除。
- oh-my-pi 没有 question、option、preview、custom input 或整次 ask 的硬大小上限；它以约 70% 终端高度、滚动视图、标题/description 行预算限制可视布局，而不是截断原始值。Prime 首版沿用这一边界，任何通用 payload hardening 留在 message/protocol 层处理。
- oh-my-pi 允许用 `n` 给当前 option/Other 添加 note，但每题结果只有一个 `note`，多选时也不返回其 option 归属。Prime 保留一个 note 的简单结果形态，但将其明确为整题答案附注，避免行绑定信息在跨模式映射中丢失。
- oh-my-pi 在 live ask 完成后持久展示包含问题与答案的 Ask 卡片，并让 tool result 同时携带可读文本和结构化 details。Prime 复用该可审计展示，但避免在 result 重复原 tool call 已保存的完整 options、description 与 preview；fallback answer 继续采用追加式新 user message。
- oh-my-pi 在 ask 出现时若主编辑器已有草稿，会让 ask 保持可见但通过 input guard 将按键继续路由给草稿编辑器，并提示先提交或清空；草稿清空后 ask 才接管输入。Prime 复用该交互，同时让草稿提交继续走自身已有的 `steer`/`followUp` 队列语义。
- oh-my-pi 通过统一的 FIFO presentation queue 串行化占用共享 editor surface 的 ask、selector、input 和 editor，避免后到 UI 覆盖先前仍在等待的 Promise。Prime 采用相同约束，并扩展到自身所有非 overlay editor-surface selector。
- oh-my-pi 允许在 `/tree` 选择旧 ask tool result 后重新打开问题，将新答案写成同一 tool call 下的 sibling branch 并恢复 Agent。Prime 首版明确不复制该便利功能：它不影响正常 ask、fallback 恢复或正确性，却会扩大树导航、恢复执行和 daemon 协议范围。
- oh-my-pi 的 `ask` 使用 `concurrency = "exclusive"` 串行化 selector，但不会抑制同一 assistant message 的 sibling tools。Prime 复用 selector 串行语义：同批多个 ask 独立按序执行；同时采用更强的批次支配规则抑制所有非 ask sibling，以保证询问发生前不执行同批副作用。
- oh-my-pi 的 `ask.md` 以提示词而非本地分类器约束调用时机：默认行动，先穷尽代码/配置/文档/历史，仅在必须由用户权衡的实质差异上询问；多个选项都可接受时采用保守标准默认。Prime 复用这一原则，并额外明确禁止用 ask 代替权限/安全策略或索取凭据；Prime 已确定的 0 或 2–4 选项硬 schema 取代其仅写在提示词里的 2–5 建议。

## 12. 分阶段落地

`ask_user` 占整体交付计划中的切片 0 与切片 2（总表见 [advisor-architecture.md](advisor-architecture.md) 第 16 节）：

### 切片 0：editor-surface FIFO dialog arbiter

- 在 `src/modes/interactive/interactive-mode.ts` 增加 TUI-owned FIFO arbiter，将 extension `select`/`confirm`/`input`/`editor`、custom 非 overlay UI 与应用 selector 全部收敛到同一串行队列。
- 独立验收：现有 extension UI 并发请求不再互相清空容器或悬挂 Promise；overlay 与普通输入调度不受影响。
- 不依赖 `ask_user` 或 settlement，可独立合入。

### 切片 2：`ask_user` 全链路（依赖切片 0 与 prompt-settlement 切片 1）

- `src/core/user-input/`：新增 session-owned `UserInputBroker`、问题/答案与 responder 结果类型、多 ask 串行调度、live/fallback 转换、pending queue 持久化和 transport adapter 边界。
- `src/core/tools/` 与 `src/core/tools/index.ts`：新增通用 `ask_user` 工具定义、root 默认注册与批次支配调度；ask 调用之间独立串行，只抑制非 ask sibling，且不进入 Advisor 受限工具集；不增加普通用户 enable 开关。
- `src/core/tools/ask-user.md`：定义 default-to-action、先穷尽信息源、仅询问实质取舍、保守默认、选项表达以及禁止权限替代/凭据请求的不可配置内置工具说明。
- `src/core/agent-session.ts`：只在 `ask_user` fallback 时依非空 pending queue 触发 `shouldStopAfterTurn`。
- `src/modes/interactive/`：ask 对话框、草稿保护、preview、note、pending 重连/重开。
- `src/modes/rpc/`：把既有 extension UI request/response 接为 live responder。
- `src/modes/daemon/`：UI responder 生命周期、first-valid-wins、settled/`already_settled`、最后 capable responder detach 时的 fallback 转换。
- `src/modes/acp/acp-mode.ts`：capability-gated experimental form elicitation，及不支持客户端的 `end_turn` + namespaced metadata fallback。
- 先建立 faux provider 的失败测试，再以可独立验收的切片接通多调用串行与非 ask sibling 抑制、live answer、断线 fallback、独立 tool result、条件式 `shouldStopAfterTurn`、pending queue、持久化和全模式 outcome。

## 13. Prime 源码事实依据

本设计依赖以下当前源码契约；实施前若这些契约变化，应先回到本设计重新核对：

- `packages/agent/src/agent-loop.ts`：正常 turn 在工具结果追加并发出 `turn_end` 后调用 `shouldStopAfterTurn`；返回 true 时正常发出 `agent_end`，可作为 `ask_user` fallback 闭合 tool call 后的停止边界。live responder 回答后不设置该停止条件，Agent 继续处理下一 turn。
- `packages/agent/src/agent-loop.ts`：同一 assistant message 的 tool calls 默认整批准备并可并行执行；只有整批每个结果都设置 `terminate` 才会提前结束工具续跑。因此 `ask_user` 需要 host-enforced 批次规划：ask calls 改为按序执行，非 ask calls 生成 suppressed results；fallback 停止不依赖每个 tool result 的 `terminate` 合取值。
- `packages/agent/src/agent-loop.ts` 与 `packages/coding-agent/src/core/agent-session.ts`：工具等待期间 abort 会生成明确的 `Tool execution aborted` 错误结果；`requestAbort()` 同时取消当前 Agent、retry、compaction 和 session-owned continuation。用户主动取消 `ask_user` 应复用这条硬停止路径，而 transport 断线不得调用它。
- `packages/coding-agent/src/core/autonomous.ts`：默认 continuation prompt 明确声明 autonomous 模式没有 human input，并要求模型在想提问时采用合理假设后继续验证；因此 `ask_user` 在该状态必须返回确定性的 human-unavailable result，而不能建立 `needs_user_input` fallback。
- `packages/coding-agent/src/core/tools/index.ts`：当前 `allToolNames` 只注册 `ipython`，Prime 尚无可直接复用的内置 `ask_user`。
- `packages/coding-agent/src/core/extensions/types.ts` 及交互模式绑定：Prime 已有 `select`、`confirm`、`input`、`editor` UI 抽象，可作为 TUI `ask_user` responder 的实现素材，但当前不是 session-owned 通用 broker。
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：现有 extension `select`/`input`/`editor`、custom 非 overlay UI 与应用 selector 都会直接清空并替换 `editorContainer`，没有统一 presentation queue；`ask_user` 接入前必须增加共享 arbiter，不能仅串行 ask 自身。
- `packages/coding-agent/src/modes/rpc/rpc-extension-ui-context.ts`：direct RPC 已用随机 request ID 发出 `extension_ui_request` 并等待 `extension_ui_response`，可复用为 live `ask_user` responder；request ID 是短期 transport 关联，不应成为持久问题 identity。
- `packages/coding-agent/src/modes/daemon/daemon-extension-binding.ts` 与 `daemon-mode.ts`：daemon 已有 extension UI pending resolver 和能力检查，但最后客户端 detach 时当前行为是取消 pending UI；`ask_user` 需要把该 transport 丢失转换为持久化 fallback，而不是沿用取消即丢弃。
- `packages/coding-agent/src/modes/daemon/daemon-extension-binding.ts` 与 `daemon-mode.ts`：现有 dialog request 会广播给所有 capable clients，第一条 response 删除共享 resolver，后续响应变成 unknown request；detach 只在 session 没有任何 client 时取消 pending，而不是检查最后一个 UI-capable responder。ask 协议需把这些行为收敛为 first-valid-wins、settled 广播、`already_settled` 和最后 capable responder fallback。
- `@agentclientprotocol/sdk` 当前依赖版本提供 capability-gated experimental form elicitation；Prime 的 ACP adapter 尚未使用它。其 enum option 原生包含 title 与 description，但没有标准 rich preview 字段，`_meta` 允许可选扩展。支持客户端可通过该能力成为 live responder，Prime preview 通过 namespaced `_meta` 降级，其他客户端走标准 `end_turn` 与 metadata fallback。
- `@agentclientprotocol/sdk` 1.3.0：elicitation form 原生支持 `type: "array"` 多选、带 title/description 的 `anyOf` items 和 `string[]` 返回值；标准 response 明确区分 `accept`、`decline` 与 `cancel`。Prime 可直接映射既定 multi schema，并必须保留 decline/cancel 差异。
- `packages/coding-agent/src/modes/acp/acp-stop-reason.ts`：当前 ACP stop reason 不包含 `needs_user_input`；通用 `ask_user` 需保持标准 `end_turn`，并通过协议允许的结构化 metadata 表意，不能自创 stop reason。
