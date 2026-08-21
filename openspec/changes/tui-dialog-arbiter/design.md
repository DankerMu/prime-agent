# Design: TUI Editor-Surface FIFO Dialog Arbiter

## Context

`interactive-mode.ts` 的 `editorContainer` 是编辑器与所有非 overlay 对话框共用的展示面。当前 8 类占用者各自执行 `clear() + addChild()`，并各自持有"恢复编辑器"的私有逻辑：

| 占用者 | 稳定定位符号 | 备注 |
| --- | --- | --- |
| extension `select`（`ExtensionSelectorComponent`） | `showExtensionSelector` / `hideExtensionSelector` | 带 abort signal + timeout；`showExtensionConfirm` 是它的封装，不独占容器，随 select 一并覆盖 |
| extension `input` | `showExtensionInput` / `hideExtensionInput` | 带 abort signal + timeout |
| extension `editor` | `showExtensionEditor` / `hideExtensionEditor` | 无 signal、无 timeout |
| extension 自定义非 overlay UI | `showExtensionCustom` / `restoreEditor` | 组件工厂可返回 `Promise<Component>`，保存并恢复 editor 文本 |
| `showSelector` 系应用选择器 | `showSelector` 的 `done` 回调 | 5 个调用方，部分调用方在 `done()` 后继续异步工作或重复调用 `done()` |
| hot-reload box | `handleReloadCommand` / `dismissReloadBox` | 非交互占位；结算触发点与展示点解耦 |
| gist export loader（`BorderedLoader`） | `handleShareCommand` / `restoreEditor` | 可取消；结算触发与展示解耦；持有临时文件清理 |
| `setCustomEditorComponent` | 同名方法 | **非对话框**：替换编辑器本体，但其无条件 `clear()` 同样会抹掉展示中对话框（本 change 一并修复，见 D6） |

除上述 show/hide 对之外，还有一条**强制关闭路径**：`resetExtensionUI()` 在 session invalidate、`session_replaced` 与 `/reload` 时无条件调用三个 `hideExtensionX()`——它们各自 `clear()` 容器且**不 resolve 对应 Promise**（今天就存在的 Promise 泄漏），最后调用 `setCustomEditorComponent(undefined)`。符号是迁移定位基线；源码行号会随 upstream 漂移，不作为契约。

并发时后到者直接清空先到者：先到对话框的组件从容器消失，其 resolve/reject 回调再也不会被 UI 触发，Promise 悬空、焦点丢失。grill 已拍板（凭证分支"阶段 1 太肥，重新切片"）：本 arbiter 作为独立切片 0 先行交付，是 `ask_user`（切片 2）的前置。

## Goals / Non-Goals

**Goals:**

- 单一 FIFO 队列串行化全部非 overlay editor-surface 对话框；并发请求按到达顺序展示，互不清空。
- 每个请求恰好结算一次（answer / cancel / abort / 构造失败 / 展示前外部结算 / 强制关闭 / session dispose）。
- 排队未展示的请求被 abort **或以任意路径结算**时直接移除，不闪现。
- 结算后恢复到**结算时刻**的当前编辑器并恢复焦点。
- `setCustomEditorComponent` 与 `resetExtensionUI` 两条容器写入路径改为 arbiter 感知，消除全部绕过路径。
- 迁移后 `interactive-mode.ts` 无绕过 arbiter 的对话框级 `editorContainer.clear()`/`addChild()`。
- 保持每类对话框既有的单实例行为（timeout、abort 返回值、文本保存恢复）不变；四处**已声明**的行为收敛见 D7。

**Non-Goals:**

- 不实现 `ask_user` 对话框本身（切片 2，`ask-user.md`）。
- 不改 overlay 机制（`showOverlay`/`showFullPaneOverlay`）、footer、通知。
- 不把 `setCustomEditorComponent` 作为队列项——它不排队；本 change 只把它的容器写入改为对话框感知（D6）。
- 不改 daemon/RPC extension UI 的 wire 语义；本 change 纯 TUI 进程内。
- 不引入优先级、插队或抢占语义——`ask_user` 未来需要的"重开请求进入共享 FIFO"用普通入队表达。

## Decisions

**D1：独立类 `DialogArbiter`，宿主注入容器操作，落 `src/modes/interactive/dialog-arbiter.ts`。**
API 形态：

```ts
present<T>(request: {
  show(done: (value: T) => void): { component: DialogComponent; focus: Component } | Promise<{ component: DialogComponent; focus: Component }>;
  kind: "extension" | "app" | "placeholder";
  signal?: AbortSignal;
  cancel?(): T;
  onEvict?(): void;
}): { result: Promise<T>; settle(value: T): void }
```

`DialogComponent` 是 `Component & { dispose?(): void }`。使用显式 union 而非仓库中不存在的 `MaybePromise` 别名。

- `show` 可同步返回或返回 Promise（`showExtensionCustom` 的异步工厂需要）；同步 throw 或异步 reject 时该项 reject 结算恰好一次、恢复编辑器、继续出队。任何未挂载终止（含构造失败）都执行 `onEvict` 一次。异步 resolve 晚于该项结算（abort/dispose/settle 竞争胜出）时组件不入容器并调用其 `dispose?.()`；已展示组件在任意终止路径也调用 `dispose?.()` 恰好一次。组件 dispose 或 onEvict 抛错不得阻断结算或队列推进。
- `settle(value)` 是展示前后统一可用的外部结算句柄：展示前调用 → 该项从队列移除、以 value 结算、**不展示**；展示后调用 → 等价于 `done(value)`。
- `signal` abort 一律以名称为 `AbortError` 的 `Error` reject；调用点按既有契约映射（extension select/input 为 `undefined`）。`cancelKind`/`disposeAll` 调用请求的 `cancel()` 生成该请求的取消值；缺少 `cancel` 时同样以 `AbortError` reject。arbiter 不猜泛型 `T`。`cancel()` throw 时以该原始 error reject 当前请求并继续处理其他项；构造失败同样保留原始 error。
- `result` 是原生 Promise。arbiter 必须在返回前附加内部 rejection observer，避免 fire-and-forget 的 app/placeholder 请求在 teardown 或构造失败时产生进程级 unhandled rejection；这不改变调用方 `await result` 时观察到的 rejection。
- `onEvict` 仅用于**从未挂载**的项被 abort、外部 settle、cancelKind 或 dispose 移除时的调用方资源清理，并恰好调用一次；已挂载组件由其 `dispose?.()` 清理，正常情况下二者互斥。例外是异步 constructing 项先被 evict、组件随后迟到 resolve：evict 时先调用 `onEvict`，迟到组件到达后仍须单独 `dispose?.()`，因为它不是 eviction 当下可清理的同一资源句柄。清理钩子抛错不得改变请求结果或阻断后继。
- arbiter 内部 busy 语义覆盖 queued、constructing、visible、待微任务交接、完整 editor 恢复 episode 与永久 disposed；只有 current/queue/交接/恢复均空且 arbiter 仍可用时为空闲。D6 所需的只读查询方法在任务 2 与首个生产消费者 `setCustomEditorComponent` 同 PR 暴露并测试，不在任务 1 先交付零消费者 API；查询不得暴露队列本体。
- arbiter 通过宿主注入的 `replaceEditorSurface(component?: Component)`、`setFocus(component: Component | null)`、`requestRender()` 与 `getCurrentEditor()` 四个操作成为唯一对话框展示 owner；`undefined` 表示清空 surface。初始请求从空闲 editor 进入异步 constructing 时保留 editor 与焦点直到组件 ready，保持既有 custom UI 行为。A 已可见并结算而 B 尚在 queued/async constructing 时，则先清空 A 并聚焦 `null`，不得留下已 dispose 的 A 接收输入，也不得短暂恢复/聚焦 editor；B ready 后再挂载并 render。挂载可见对话框和最终恢复 editor 后各请求一次 render。恢复期间每轮在全部同步 host callbacks 后重读动态 `getCurrentEditor()`；identity 改变则仅在下一微任务重试（不递归且先于 timer），最多 8 轮。第 8 轮仍不收敛时 fail closed：clear surface、focus null、render 一次，保持 busy 且不再安排微任务，直到 terminal `disposeAll()`。host callback error 按 ownership 处理：mounted cleanup error 被隔离且不改变已选 outcome，剩余 phase 继续；mount error 以原始 identity reject owning request 并进入正常 cleanup；stale-clear / restore / failClosed 的 replace/focus/render 同样按 cleanup 隔离（每 phase 捕获、不改已选 outcome、剩余 phase 继续：stale-clear 后仍构造后继，restore 后仍按 identity 重读/重试，failClosed 后保持 busy）。不允许绕过 settleResult、产生未观察 continuation，或因 handoff 微任务 throw 卡住 `handoffPending`。`replaceEditorSurface` 注入闭包是迁移完成后唯一允许执行对话框级 `editorContainer.clear()/addChild()` 的路径。

状态与所有权表（请求终态统一为 `settled`，arbiter 生命周期终态为 `disposed`）：

| From | Event / guard | To | Result 与清理 owner | 允许的 UI 操作 |
| --- | --- | --- | --- | --- |
| new | arbiter disposed | settled | 请求级 cancel 值或 AbortError；`onEvict` 一次 | 无 |
| new | signal 已 aborted | settled | AbortError；`onEvict` 一次 | 无 |
| new | arbiter idle | constructing | 调用 `show(done)`；abort listener 归 arbiter | 初始 async 构造期间保留 editor/focus；同步 ready 才挂载 |
| new | current/queue/handoff 非空 | queued | 请求与 listener 归 FIFO | 无 |
| queued | 成为队首 | constructing | 调用 `show(done)` | 若前项曾可见，surface 已空/focus=null；否则不改 UI |
| queued | abort / settle / cancelKind / disposeAll | settled | 对应结果；移除 listener；`onEvict` 一次 | 无 |
| constructing | show sync throw / async reject | settled | 原始 error；移除 listener；`onEvict` 一次 | 不挂载；进入 handoff |
| constructing | done / settle / abort / cancelKind / disposeAll 先到 | settled | 先到结果；移除 listener；`onEvict` 一次 | 不挂载；进入 handoff或 disposed |
| constructing | component ready 且请求仍 active | visible | component/focus 所有权转给 arbiter | replace(component)、focus、render |
| settled-after-constructing | component 或 rejection 迟到 | settled | 迟到 component `dispose?.()` 一次；迟到 rejection 已观察 | 无 |
| visible | done / settle / abort / cancelKind | settled + handoff | 先到结果；移除 listener；已挂载 component `dispose?.()` 一次，不调用 onEvict | replace(undefined)、focus(null)、render；禁止中间 editor focus |
| visible | disposeAll | settled + disposed | 请求级 cancel；移除 listener；component dispose 一次 | replace(undefined)、focus(null)、render；不得安排恢复/后继 |
| handoff | 活跃后继存在 | constructing | FIFO 取下一项；跳过已 settled 项 | 保持 surface 空/focus=null，直至 ready |
| handoff | 无后继且未 disposed | restoring | 动态读取当前 editor | replace(editor)、focus(editor)、render；全部同步 callback 后重读 identity |
| restoring | identity 一致且无重入请求 | idle | 清除恢复状态 | 无额外 UI 操作 |
| restoring | identity 改变且未达 8 轮 | restoring | 保存实际 surface identity 仅用于 stale 比较 | 下一微任务用动态当前 editor 重试，不同步递归 |
| restoring | 第 8 轮仍不一致 | fail-closed busy | 清除保存 identity、停止调度 | replace(undefined)、focus(null)、render；保持 busy 直到 disposeAll |
| any non-disposed | disposeAll | disposed | current 与 queue 同步逐项 cancel/清理；mounted cleanup phase 在每个外部 callback 前推进，使重入 disposeAll 返回前完成 component dispose、surface clear、focus null、render；取消 handoff/restore；幂等 | 只清除 arbiter 已挂载的 dialog；之后永不触碰 UI |

同一请求只允许表中第一条终止边生效；后到 done/settle/abort/cancel/dispose 都是 no-op。`onEvict` 与已挂载 component dispose 由挂载所有权区分；constructing 被 evict 后迟到的 component 是新到达句柄，仍单独 dispose。恢复 target 永远动态读取；保存的 editor identity 只判断当前 surface 是否 stale。每条表中 transition 都由 `packages/coding-agent/test/dialog-arbiter.test.ts` 在 Seam 1 断言。

备选：(a) 在 `InteractiveMode` 内联队列字段——被否：该类已近万行，且 arbiter 需要独立单测；(b) 每类对话框自持锁——被否：两两组合的互踩矩阵测不完，正是现状的成因。

**D2：恢复目标在结算时动态取 `getCurrentEditor()`，不在入队时捕获。**
理由：队列期间可能发生 `setCustomEditorComponent` 替换编辑器；捕获旧引用会把已废弃的编辑器塞回容器。**现存实例**：`handleReloadCommand` 的 `previousEditor` 被失败分支使用，而 `/reload` 期间 `resetExtensionUI` 会执行 `setCustomEditorComponent(undefined)` 替换编辑器——迁移后该分支收敛到动态目标（行为变更声明见 D7）。extension 自定义 UI 的 `restoreEditor` 本身动态读取 `this.editor`，无捕获问题；其真实风险是请求时创建的 `savedText` 快照——文本回写规则见 D8。

**D3：reload box 与 gist loader 也走队列。**
它们同样占用 editor-surface；不入队就仍是互踩源。二者经 D1 的 `settle` 句柄结算：结算先于展示到达时直接移除不展示（陈旧占位框不上屏）。重载/导出流程本身**不等待占位框展示**——占位框只是可见反馈；队列空时保留现有 `requestRender(true) + nextTick` 先画后干时序，队列非空时流程照常推进。

gist loader 额外持有本次 export 的临时文件与活动 `gh gist create` 子进程。每次 invocation 使用独立、不可冲突的 temp path，禁止复用进程级 `session.html`；文件 ownership 仅在 export 开始后建立，并收敛为带 once guard 的 invocation-local 幂等清理函数：已挂载项由组件 `dispose` 调用，未挂载项由 `onEvict` 调用，二者按 D1 ownership 互斥；export reject 即使留下部分文件也由同一函数回滚。用户 abort 经 `show` 内 `done`，terminal `disposeAll` 经 request `cancel`；两者都杀死尚活跃的所属子进程。命令以 invocation-local terminal claim 与 outcome Promise 对称观察 dialog terminal 和子进程 completion，使 process-first 与 cancel-first 都由同步 claim 的真正先到边胜出；迟到 close/error 只被观察，不得二次结算、清理或触碰已停止 UI。认证 preflight 失败发生在 export/ownership 之前，不得删除同名既有文件；export 尚未创建 arbiter request 时发生 terminal teardown，则只清理本次 path，不再发出 UI error 或启动子进程。

备选：(a) 改成 overlay——被否：改变现有 UX 且超出本切片范围；(b) 只在 loader `onAbort` 杀进程/删文件——被否：queued 项和 terminal teardown 不经过 mounted callback，会继续泄漏资源并允许迟到 UI。

**D4：settle-once 由 arbiter 强制；强制关闭是第一类批量结算入口。**
`done`/`settle`、abort、构造失败、dispose、强制关闭的竞争由内部状态机裁决，后到的结算调用是 no-op（不 throw，不二次 resolve）。三个批量/生命周期入口：

- `cancelKind(kind)`：`resetExtensionUI` 的 arbiter 化。当前项与排队项中 `kind === "extension"` 的，各经请求级 `cancel()`（缺省 AbortError）结算恰好一次；其他 kind 的项保留在队列。现有调用点语义不变：只强制关闭 extension 对话框。
- `disposeAll()`：session dispose。当前项与队列余项都经各自 cancel 语义结算，清理同步完成；幂等，并把 arbiter 置为永久 disposed 终态。之后的 `present` 必须立即按 cancel 语义结算且不得触碰容器，不能让 teardown 后的迟到请求重新激活 UI。挂载在 `stop()` 内且**先于** `this.ui.stop()` 执行。可同步验证的顺序契约是：请求状态、abort listener 移除、`onEvict`/组件 dispose 与容器停止触碰均在 `ui.stop()` 前完成；原生 Promise 的 `.then/.catch` reaction 按 JavaScript 微任务语义随后运行，不声称同步完成。
- pre-aborted：`present` 时 `signal.aborted` 已为 true → 立即以 AbortError 结算，不入队、不触碰容器；调用点负责映射回既有返回值。

**D5：abort 的注册与响应上交 arbiter；调用点只做返回值映射与 timeout。**
signal 经 D1 的 `signal` 字段交给 arbiter：排队项 abort → evict 不闪现；展示项 abort → 结算并恢复编辑器。arbiter 内部 reject 名称为 `AbortError` 的 `Error`，**调用点负责映射回既有返回值形态**——extension `select`/`input` 的 abort 与取消同为 `resolve(undefined)`，AbortError 不得外泄给 extension host。`cancelKind`/`disposeAll` 是不同来源：它们走请求级 `cancel()`，使 extension `editor` 这类无 signal 请求也能 resolve `undefined`。abort listener 在任何终态路径移除。timeout 留在调用点：组件的 `CountdownTimer` 在 `show()` 内构造时启动，因此**排队期间不计时、自展示时刻起算**，超时回调走组件 onCancel → `done(undefined)` → 经 arbiter 结算，不自行清容器。
（原方案"abort 语义由调用点自理"被否：调用点的 `onAbort` 会直接 `hideExtensionX()` 清空正在展示的**别人**，并留下 arbiter 不知情的队列项——恰是要修的缺陷。）

**D6：`setCustomEditorComponent` 改为对话框感知，不进入队列。**
仅当 arbiter 空闲（容器由编辑器占用）时执行现有 `clear()+addChild()+setFocus()`；arbiter 忙时只更新 `this.editor`/`editorComponentFactory`/prompt stash，不触碰容器、不抢焦点——新编辑器由 D2 的动态恢复目标在结算时自然装上。该函数由此成为负向检查白名单中唯一的非 arbiter `clear()` 命中，且仅限空闲分支。
备选：维持无条件写入并在 spec 删除对应 scenario——被否：等于给互踩缺陷留一条被白名单保护的活路（extension 可经 `setEditorComponent` API 随时触发，types.ts:246）。

**D7：四处已声明的行为收敛（非"完全不变"）。**
(1) timeout 起算点：迁移前"请求时刻=展示时刻"同步成立；引入队列后统一为**自展示时刻起算，排队期间不计时**——extension 的 timeout 承诺变为"展示后 N 秒"，是两种可选语义中唯一不会在排队期间触发"自清容器"的那个。(2) reload 失败分支：恢复目标从捕获的 `previousEditor` 收敛为动态当前编辑器。(3) `showExtensionCustom` 迟到异步组件从"只 return 不清理"收敛为丢弃并 `dispose?.()`（修组件泄漏）。(4) 自定义 UI 的文本快照从"请求时刻"收敛为"展示时刻"（D8，仅排队时可观测）。四处都写入 proposal 的 What Changes，不藏在"行为保持不变"里。

**D8：编辑器文本快照的配对规则。**
extension 自定义 UI 的 `savedText` 快照取自**出队展示时刻**的当前编辑器；结算时仅当当前编辑器仍是同一实例才回写，否则不回写（编辑器替换场景的文本迁移由 `setCustomEditorComponent` 既有 prompt stash 逻辑负责，4012-4022），避免旧文本覆盖 stash 或写错编辑器。

**D9：迁移是逐类替换，每类调用点一次一类；`resetExtensionUI` 的对应行随该类迁移。**
每类占用者的 show/hide 对改写为一次 `present` 调用；原 `hideExtensionX` 收敛进结算回调的同时，`resetExtensionUI` 中对应的 `hideExtensionX()` 调用改为 `arbiter.cancelKind` 覆盖（按类渐进：未迁移的类仍走旧 hide，已迁移的类经 arbiter 取消），保证每类迁移仍可独立合并保绿。

### Sketch seams under test

- **Seam 1（主）：`DialogArbiter.present`/`settle`/`cancelKind`/`disposeAll` 公共 API**——新引入但是本 change 的天然最高边界；FIFO、settle-once、evict、外部结算、异步工厂、恢复目标全部可在该边界用假组件与假时钟确定性驱动，无需真实 TUI 渲染。理由：唯一能覆盖全部并发排列的 seam。
- **Seam 2（集成抽查）：extension UI context 的 `select`/`confirm`/`input` 路径与 `showSelector` 真实路径**——经现有 extension 绑定发起并发对话框（含 extension × 应用选择器交叉配对），验证迁移后行为经由 arbiter。理由：证明调用点真的迁移了，防止"arbiter 存在但没人用"；现有 `interactive-mode-effort-command.test.ts` stub 掉了 `showSelector` 本体，真实路径当前零覆盖。

## Risks / Trade-offs

- [重入：结算回调同步发起新对话框] → arbiter 在结算清理完成后再以微任务出队下一项，同步重入表现为普通入队，不递归展示；编辑器在交接间隙不获得中间焦点。仓库真实存在 `done()` 后同步发起 extension selector、异步续作和二次 `done()` 路径——二次结算必须为 no-op。
- [dispose/强制关闭与结算竞争] → D4 状态机：先到者生效，后到 no-op；dispose、cancelKind、settle 三路竞争单测覆盖。
- [迁移遗漏产生新的绕过路径] → 收口以单测固化（非 lint）：读取 `interactive-mode.ts` 源文件，`editorContainer.clear(` 与 `editorContainer.addChild(` 的每处命中所在函数必须属于显式白名单（arbiter 的 `replaceEditorSurface` 注入闭包、`setCustomEditorComponent` 的 arbiter 空闲分支、构造器初始化挂载），失败信息打印实际行号；不用计数断言（会被增删抵消骗过）。
- [reload box 在队列中被前项阻塞，重载视觉反馈延迟或不出现] → 接受：重载本身照常执行且不等待占位框（D3）；结算先于展示则占位框整体略过。
- [timeout 起算点变化影响 extension 预期] → D7 已声明；排队期间不计时是不产生自清容器路径的唯一选择。
- [近万行宿主类的改动面] → 迁移按类分任务、每任务一小 PR，见 tasks。

## Migration Plan

新增 arbiter（不接调用点；实例化与 dispose 挂线随组 1）→ `setCustomEditorComponent` 对话框感知（D6，先于任何迁移，消除最后修改者互踩）→ 逐类迁移调用点（每类独立可合并、可回退，`resetExtensionUI` 对应行随类迁移）→ 负向检查收口。回滚 = 逐类还原调用点；arbiter 本身无状态持久化，删除无残留。

## Open Questions

（无——grill 凭证 7 分支全部已拍板，无遗留开放项落入本切片。）
