# Design: TUI Editor-Surface FIFO Dialog Arbiter

## Context

`interactive-mode.ts` 的 `editorContainer` 是编辑器与所有非 overlay 对话框共用的展示面。当前 8 类占用者各自执行 `clear() + addChild()`，并各自持有"恢复编辑器"的私有逻辑：

| 占用者 | show / restore 位置 | 备注 |
| --- | --- | --- |
| extension `select`（`ExtensionSelectorComponent`） | 3797 / 3809 | 带 abort signal + timeout；`confirm`（3819-3826）是它的封装，不独占容器，随 select 一并覆盖 |
| extension `input` | 3872 / 3884 | 带 abort signal + timeout |
| extension `editor` | 3911 / 3922 | 无 signal、无 timeout |
| extension 自定义非 overlay UI | 4107 / 4060（`restoreEditor` 闭包） | 组件工厂可返回 `Promise<Component>`（4043-4049），保存并恢复 editor 文本 |
| `showSelector` 系应用选择器 | 7454-7460（`done` 回调） | 5 个调用方（7478/7989/8204/8249/8320），其中 8249/8320 在 `done()` 后继续异步工作 |
| hot-reload box | 8793 / 8800 | 非交互占位；结算触发点（8838/8849）与展示点解耦 |
| gist export loader（`BorderedLoader`） | 8969 / 8976 | 可取消；结算触发与展示解耦；持有临时文件清理 |
| `setCustomEditorComponent` | 3940 / 4024 | **非对话框**：替换编辑器本体，但其无条件 `clear()` 同样会抹掉展示中对话框（本 change 一并修复，见 D6） |

除上述 show/hide 对之外，还有一条**强制关闭路径**：`resetExtensionUI()`（3521-3541）在 session invalidate（1068）、`session_replaced`（5090）与 `/reload`（8780）时无条件调用三个 `hideExtensionX()`——它们各自 `clear()` 容器且**不 resolve 对应 Promise**（今天就存在的 Promise 泄漏），最后调用 `setCustomEditorComponent(undefined)`。

并发时后到者直接清空先到者：先到对话框的组件从容器消失，其 resolve/reject 回调再也不会被 UI 触发，Promise 悬空、焦点丢失。grill 已拍板（凭证分支"阶段 1 太肥，重新切片"）：本 arbiter 作为独立切片 0 先行交付，是 `ask_user`（切片 2）的前置。

## Goals / Non-Goals

**Goals:**

- 单一 FIFO 队列串行化全部非 overlay editor-surface 对话框；并发请求按到达顺序展示，互不清空。
- 每个请求恰好结算一次（answer / cancel / abort / 构造失败 / 展示前外部结算 / 强制关闭 / session dispose）。
- 排队未展示的请求被 abort **或以任意路径结算**时直接移除，不闪现。
- 结算后恢复到**结算时刻**的当前编辑器并恢复焦点。
- `setCustomEditorComponent` 与 `resetExtensionUI` 两条容器写入路径改为 arbiter 感知，消除全部绕过路径。
- 迁移后 `interactive-mode.ts` 无绕过 arbiter 的对话框级 `editorContainer.clear()`/`addChild()`。
- 保持每类对话框既有的单实例行为（timeout、abort 返回值、文本保存恢复）不变；两处**已声明**的行为收敛见 D7。

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
  show(done: (value: T) => void): MaybePromise<{ component: Component; focus: Component }>;
  kind: "extension" | "app" | "placeholder";   // 强制关闭（D4）按 kind 定位
  signal?: AbortSignal;                        // abort 的注册与响应归 arbiter（D5）
  onEvict?(): void;                            // 未展示即被移除时的调用点清理钩子
}): { result: Promise<T>; settle(value: T): void }
```

- `show` 可同步返回或返回 Promise（`showExtensionCustom` 的异步工厂需要，见源码 4043-4049/4085）；异步 reject 时该项 reject 结算恰好一次、恢复编辑器、继续出队；异步 resolve 晚于该项结算（abort/dispose/settle 竞争胜出）时组件不入容器并调用其 `dispose?.()`——这比现状 4067-4117 的 `closed` 保护更进一步：现状 4087 对迟到组件只 `return` 不 dispose（组件泄漏），arbiter 补上 dispose 属 D7 声明的行为收敛之一。
- `settle(value)` 是展示前后统一可用的外部结算句柄：展示前调用 → 该项从队列移除、以 value 结算、**不展示**（reload box / gist loader 的结算触发点与展示点解耦，见源码 8838/8849/8989）；展示后调用 → 等价于 `done(value)`。
- arbiter 唯一拥有 `editorContainer.clear()/addChild()` 与 `setFocus` 的对话框路径；宿主提供 `getCurrentEditor()` 回调作恢复目标。
备选：(a) 在 `InteractiveMode` 内联队列字段——被否：该类已近万行，且 arbiter 需要独立单测；(b) 每类对话框自持锁——被否：两两组合的互踩矩阵测不完，正是现状的成因。

**D2：恢复目标在结算时动态取 `getCurrentEditor()`，不在入队时捕获。**
理由：队列期间可能发生 `setCustomEditorComponent` 替换编辑器；捕获旧引用会把已废弃的编辑器塞回容器。**现存实例**：reload 路径 8792 的 `const previousEditor = this.editor` 被失败分支 8849 使用，而 `/reload` 期间 3541 恰好会执行 `setCustomEditorComponent(undefined)` 替换编辑器——迁移后该分支收敛到动态目标（行为变更声明见 D7）。extension 自定义 UI 的 4060 `restoreEditor` 本身是动态读取 `this.editor`，无捕获问题；其真实风险是 `savedText` 快照（4056）——文本回写规则见 D8。

**D3：reload box 与 gist loader 也走队列。**
它们同样占用 editor-surface；不入队就仍是互踩源。二者经 D1 的 `settle` 句柄结算：结算先于展示到达时直接移除不展示（陈旧占位框不上屏）。重载/导出流程本身**不等待占位框展示**——占位框只是可见反馈；队列空时保留现状 8796-8797 的 `requestRender(true) + nextTick` 先画后干时序，队列非空时流程照常推进。
备选：改成 overlay——被否：改变现有 UX 且超出本切片范围。

**D4：settle-once 由 arbiter 强制；强制关闭是第一类批量结算入口。**
`done`/`settle`、abort、构造失败、dispose、强制关闭的竞争由内部状态机裁决，后到的结算调用是 no-op（不 throw，不二次 resolve）。三个批量/生命周期入口：

- `cancelKind(kind)`：`resetExtensionUI` 的 arbiter 化。当前项与排队项中 `kind === "extension"` 的，各按其取消语义结算恰好一次（修复现状 3807/3882/3921 的 Promise 泄漏）；其他 kind 的项保留在队列。调用点（1068/5090/8780）语义不变：只强制关闭 extension 对话框。
- `disposeAll()`：session dispose。当前项按取消语义结算，队列余项全部 evict；幂等，空队列 no-op。挂载在 `stop()`（9950）内且**先于** `this.ui.stop()`（9969）执行，保证结算回调仍作用在活的渲染器上；`teardownSessionUi`/`shutdown` 经由 `stop()` 覆盖。
- pre-aborted：`present` 时 `signal.aborted` 已为 true → 立即按 abort 语义结算，不入队、不触碰容器（保持现状 3770-3773 的即时返回）。

**D5：abort 的注册与响应上交 arbiter；调用点只做返回值映射与 timeout。**
signal 经 D1 的 `signal` 字段交给 arbiter：排队项 abort → evict 不闪现；展示项 abort → 结算并恢复编辑器。arbiter 内部以 abort 语义结算（reject(AbortError)），**调用点负责映射回既有返回值形态**——extension `select`/`input` 的 abort 与取消同为 `resolve(undefined)`（源码 3775-3778/3850-3853），AbortError 不得外泄给 extension host。timeout 留在调用点：组件的 `CountdownTimer` 在 `show()` 内构造时启动（extension-selector.ts:77-84），因此**排队期间不计时、自展示时刻起算**，超时回调走组件 onCancel → `done(undefined)` → 经 arbiter 结算，不自行清容器。
（原方案"abort 语义由调用点自理"被否：调用点的 `onAbort` 会直接 `hideExtensionX()` 清空正在展示的**别人**，并留下 arbiter 不知情的队列项——恰是要修的缺陷。）

**D6：`setCustomEditorComponent` 改为对话框感知，不进入队列。**
仅当 arbiter 空闲（容器由编辑器占用）时执行现有 `clear()+addChild()+setFocus()`；arbiter 忙时只更新 `this.editor`/`editorComponentFactory`/prompt stash，不触碰容器、不抢焦点——新编辑器由 D2 的动态恢复目标在结算时自然装上。该函数由此成为负向检查白名单中唯一的非 arbiter `clear()` 命中，且仅限空闲分支。
备选：维持无条件写入并在 spec 删除对应 scenario——被否：等于给互踩缺陷留一条被白名单保护的活路（extension 可经 `setEditorComponent` API 随时触发，types.ts:246）。

**D7：四处已声明的行为收敛（非"完全不变"）。**
(1) timeout 起算点：迁移前"请求时刻=展示时刻"同步成立；引入队列后统一为**自展示时刻起算，排队期间不计时**——extension 的 timeout 承诺变为"展示后 N 秒"，是两种可选语义中唯一不会在排队期间触发"自清容器"的那个。(2) reload 失败分支：恢复目标从 8849 的 `previousEditor` 收敛为动态当前编辑器。(3) 迟到异步组件从"只 return 不清理"（现状 4087）收敛为丢弃并 `dispose?.()`（修组件泄漏）。(4) 自定义 UI 的文本快照从"请求时刻"（现状 4056）收敛为"展示时刻"（D8，仅排队时可观测）。四处都写入 proposal 的 What Changes，不藏在"行为保持不变"里。

**D8：编辑器文本快照的配对规则。**
extension 自定义 UI 的 `savedText` 快照取自**出队展示时刻**的当前编辑器；结算时仅当当前编辑器仍是同一实例才回写，否则不回写（编辑器替换场景的文本迁移由 `setCustomEditorComponent` 既有 prompt stash 逻辑负责，4012-4022），避免旧文本覆盖 stash 或写错编辑器。

**D9：迁移是逐类替换，每类调用点一次一类；`resetExtensionUI` 的对应行随该类迁移。**
每类占用者的 show/hide 对改写为一次 `present` 调用；原 `hideExtensionX` 收敛进结算回调的同时，`resetExtensionUI` 中对应的 `hideExtensionX()` 调用改为 `arbiter.cancelKind` 覆盖（按类渐进：未迁移的类仍走旧 hide，已迁移的类经 arbiter 取消），保证每类迁移仍可独立合并保绿。

### Sketch seams under test

- **Seam 1（主）：`DialogArbiter.present`/`settle`/`cancelKind`/`disposeAll` 公共 API**——新引入但是本 change 的天然最高边界；FIFO、settle-once、evict、外部结算、异步工厂、恢复目标全部可在该边界用假组件与假时钟确定性驱动，无需真实 TUI 渲染。理由：唯一能覆盖全部并发排列的 seam。
- **Seam 2（集成抽查）：extension UI context 的 `select`/`confirm`/`input` 路径与 `showSelector` 真实路径**——经现有 extension 绑定发起并发对话框（含 extension × 应用选择器交叉配对），验证迁移后行为经由 arbiter。理由：证明调用点真的迁移了，防止"arbiter 存在但没人用"；现有测试（interactive-mode-effort-command.test.ts:118）stub 掉了 `showSelector` 本体，真实路径当前零覆盖。

## Risks / Trade-offs

- [重入：结算回调同步发起新对话框] → arbiter 在结算清理完成后再出队下一项（微任务边界），同步重入表现为普通入队，不递归展示；编辑器在交接间隙不获得中间焦点。仓库真实存在该模式（8334-8345 的 `done()` 后同步 `showExtensionSelector`；8249/8320 的 `done()` 后异步续作、且存在二次 `done()` 分支——二次结算为 no-op）。
- [dispose/强制关闭与结算竞争] → D4 状态机：先到者生效，后到 no-op；dispose、cancelKind、settle 三路竞争单测覆盖。
- [迁移遗漏产生新的绕过路径] → 收口以单测固化（非 lint）：读取 `interactive-mode.ts` 源文件，`editorContainer.clear(` 与对话框级 `addChild(` 的每处命中所在函数必须属于显式白名单（arbiter 容器操作注入闭包、`setCustomEditorComponent` 的 arbiter 空闲分支、1109 的构造期初始化挂载；1417/7203 是 `mainContainer.addChild(editorContainer)` 与布局枚举，不匹配 `editorContainer.clear(`/`editorContainer.addChild(` 精确模式，不在白名单内），失败信息打印越界行号；不用计数断言（会被增删抵消骗过）。
- [reload box 在队列中被前项阻塞，重载视觉反馈延迟或不出现] → 接受：重载本身照常执行且不等待占位框（D3）；结算先于展示则占位框整体略过。
- [timeout 起算点变化影响 extension 预期] → D7 已声明；排队期间不计时是不产生自清容器路径的唯一选择。
- [近万行宿主类的改动面] → 迁移按类分任务、每任务一小 PR，见 tasks。

## Migration Plan

新增 arbiter（不接调用点；实例化与 dispose 挂线随组 1）→ `setCustomEditorComponent` 对话框感知（D6，先于任何迁移，消除最后修改者互踩）→ 逐类迁移调用点（每类独立可合并、可回退，`resetExtensionUI` 对应行随类迁移）→ 负向检查收口。回滚 = 逐类还原调用点；arbiter 本身无状态持久化，删除无残留。

## Open Questions

（无——grill 凭证 7 分支全部已拍板，无遗留开放项落入本切片。）
