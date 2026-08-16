# Tasks: TUI Editor-Surface FIFO Dialog Arbiter

## 1. DialogArbiter 核心

- [ ] 1.1 新建 `src/modes/interactive/dialog-arbiter.ts`：`present<T>` API（design D1 签名：`show` 支持同步返回或返回 Promise；返回 `{ result, settle }` 外部结算句柄；`kind` 标签；`signal` 归 arbiter；`onEvict` 清理钩子）、FIFO 队列、settle-once 状态机（done/settle/abort/构造失败/`cancelKind`/`disposeAll` 竞争裁决，后到 no-op）、pre-aborted 立即结算不入队、迟到异步构造结果丢弃并 `dispose?.()`、微任务边界出队、`getCurrentEditor()` 动态恢复目标
- [ ] 1.2 在 `InteractiveMode` 实例化 arbiter（注入 `editorContainer` 容器操作闭包、`ui.setFocus`、`getCurrentEditor`），并把 `disposeAll()` 挂载在 `stop()`（9950）内、位于 `this.ui.stop()`（9969）**之前**；此任务不迁移任何调用点
- [ ] 1.3 arbiter 单测（Seam 1，假组件 + 假时钟驱动）：FIFO 顺序与两种先后顺序对称、settle-once 竞争（done vs abort、二次 done no-op）、同步构造异常、异步工厂 reject、迟到异步 resolve 丢弃、排队项 abort 不闪现、pre-aborted 不入队、展示前外部 `settle` 不展示且队列直通后继、`onEvict` 恰好一次、`cancelKind` 只结算匹配 kind 且余项保留、dispose 清空（幂等 + 结算回调发生在 UI 停止前的顺序断言）、动态恢复目标（队列期间替换编辑器）、结算回调同步重入不递归且无中间焦点

Suggested fixture level: compact - 进程内并发状态机，确定性假组件单测即可全覆盖，无跨模块或 wire 风险
Minimal mergeable slice: atomic - 新文件 + 实例化与 dispose 挂线，无对话框调用点经过它（disposeAll 对空队列是 no-op），合并即绿不改变任何现有行为

## 2. `setCustomEditorComponent` 对话框感知

- [ ] 2.1 改写 `setCustomEditorComponent`（3933-4027）：arbiter 空闲时保持现有 `clear()+addChild()+setFocus()`；arbiter 忙时只更新 `this.editor`/`editorComponentFactory`/prompt stash，不触碰容器、不抢焦点（新编辑器由结算时的动态恢复目标装上）
- [ ] 2.2 行为测试：对话框展示期间调用 `setEditorComponent(factory)` 与 `(undefined)`，断言容器 children 仍是对话框组件、焦点仍在对话框、其 `done` 仍可结算，结算后容器为替换后的编辑器；队列为空时替换立即生效（现有行为回归）

Suggested fixture level: compact - 修复一条活跃的互踩路径（extension 可经 `setEditorComponent` API 随时触发），需专门场景验证
Minimal mergeable slice: atomic - 单函数条件化改写 + 配套测试；arbiter 尚无调用点时忙分支不可达，合并保绿

## 3. 迁移 extension select（含 confirm）

- [ ] 3.1 将 `showExtensionSelector`/`hideExtensionSelector`（3797/3809）改写为一次 `arbiter.present`（kind: extension）：signal 交给 arbiter，调用点将 abort 结算映射回 `undefined`（AbortError 不外泄）；timeout 与 `{ tui, timeout }` 选项逐字透传给组件构造（`show` 内构造，计时自展示起算）；`resetExtensionUI`（3525）中对应的 `hideExtensionSelector()` 改为 `arbiter.cancelKind` 覆盖
- [ ] 3.2 行为测试基线：带 timeout 的 `select` 单独展示至超时（假时钟），断言 resolve 值为 `undefined` 且容器恢复编辑器；排队期间不计时（spec"排队期间不触发超时"scenario）；排队项 abort 后 Promise resolve `undefined`、从未入容器、队首不受影响
- [ ] 3.3 集成测试（Seam 2）：经 extension UI context 并发发起两个 `select`，验证 FIFO 展示、各自结算、焦点恢复；附一个 `confirm` 用例断言其返回 `boolean` 且经 arbiter 排队

Suggested fixture level: compact - 首个真实调用点迁移，承载 timeout/abort 行为基线，需集成路径证明 arbiter 被实际使用
Minimal mergeable slice: atomic - 单调用点替换 + 其行为基线测试，独立合并保绿（confirm 经 select 自动覆盖，无独立改动）

## 4. 迁移 extension input

- [ ] 4.1 将 `showExtensionInput`/`hideExtensionInput`（3872/3884）改写为 `arbiter.present`（kind: extension），沿用任务 3 的 signal/timeout/映射模式；`resetExtensionUI`（3528）对应行改为 `cancelKind` 覆盖

Suggested fixture level: none - 与任务 3 同模式的机械替换，行为由任务 3.2 建立的 timeout/abort 基线模式与组 1 单测覆盖
Minimal mergeable slice: atomic - 单调用点替换，独立合并保绿

## 5. 迁移 extension editor

- [ ] 5.1 将 `showExtensionEditor`/`hideExtensionEditor`（3911/3922）改写为 `arbiter.present`（kind: extension，无 signal/timeout）；`resetExtensionUI`（3531）对应行改为 `cancelKind` 覆盖（修复该路径现状不 resolve 的 Promise 泄漏）

Suggested fixture level: none - 同模式机械替换且参数面更小；强制关闭结算语义由组 1 的 `cancelKind` 单测与组 10 的集成场景覆盖
Minimal mergeable slice: atomic - 单调用点替换，独立合并保绿

## 6. 迁移 extension 自定义非 overlay UI

- [ ] 6.1 将自定义 UI 的非 overlay 分支（4107）及其 `restoreEditor` 闭包（4060）改写为 `arbiter.present`（kind: extension）：异步组件工厂经 `show` 的 Promise 返回值表达（构造失败与迟到 resolve 由 arbiter 状态机处理，保留现状 `closed` 保护语义）；文本快照改在 `show` 执行时（展示时刻）从当前编辑器获取，结算时仅同一实例才回写（design D8）
- [ ] 6.2 行为测试：展示前文本在结算后恢复（同实例）；队列期间 `setCustomEditorComponent` 替换编辑器后结算不回写快照且恢复到新编辑器；异步工厂 reject 经真实调用点原样 reject 给调用方

Suggested fixture level: compact - 含两处真实行为规则（异步工厂接入、快照配对），需专门场景验证而非纯机械替换
Minimal mergeable slice: atomic - 单调用点 + 其配套测试，独立合并保绿

## 7. 迁移 showSelector 应用选择器

- [ ] 7.1 将 `showSelector` helper（7452-7463）改写为 `arbiter.present`（kind: app），其全部 5 个调用方（7478/7989/8204/8249/8320）自动经队列，`done` 回调语义不变（二次 `done` 为 no-op，由 arbiter 保证）
- [ ] 7.2 集成测试：一条经真实 `showSelector` 路径的用例（thinking selector），断言展示、结算、焦点恢复（现有测试 stub 掉了 helper 本体，真实路径当前零覆盖）；一条 `extension select` 与 `showSelector` 反向并发的对称用例（spec"两种先后顺序对称"的真实配对）；断言 `done()` 被调用两次时第二次为 no-op（对应 8249 分支）

Suggested fixture level: compact - 一次改写影响 5 个应用选择器且真实路径无既有覆盖，需真实路径集成护栏
Minimal mergeable slice: atomic - 单 helper 替换 + 集成护栏，调用方零改动，独立合并保绿

## 8. 迁移 hot-reload box

- [ ] 8.1 将 reload box 展示/dismiss（8793/8800）改写为 `arbiter.present`（kind: placeholder）：结算经 `settle` 句柄（成功 8838 / 失败 8849 两分支统一），失败分支的 `previousEditor` 回退（8792/8849）收敛为动态恢复目标（design D7 已声明的行为变更）；`/reload` 开头（8780）的 `resetExtensionUI` 先行执行 `cancelKind`，占位框随后入队；队列空时保留 `requestRender(true) + nextTick` 先画后干时序，重载流程不等待占位框展示
- [ ] 8.2 行为测试：reload 失败分支结算后容器为结算时刻的当前编辑器（期间发生编辑器替换时不回退旧引用）；`settle` 先于展示到达时占位框整体略过且重载正常完成

Suggested fixture level: compact - 涉及外部结算时序与一处已声明行为变更，需专门场景验证
Minimal mergeable slice: atomic - 单调用点 + 配套测试，独立合并保绿

## 9. 迁移 gist export loader

- [ ] 9.1 将 `BorderedLoader` 展示/恢复（8969/8976）改写为 `arbiter.present`（kind: placeholder）：完成路径经 `settle` 结算，取消路径经组件的 `onAbort` 回调（8989）映射到 `show` 内的 `done`（该路径无 AbortSignal）；临时文件删除（8980 的 `fs.unlinkSync`）移入结算与 `onEvict` 共同覆盖的清理路径，排队中被 dispose 时同样清理
- [ ] 9.2 行为测试：loader 排队期间 dispose，断言临时文件被删除、loader 从未展示、结算恰好一次

Suggested fixture level: compact - 含资源清理路径迁移（现状清理只在展示后路径上执行），需泄漏场景验证
Minimal mergeable slice: atomic - 单调用点 + 配套测试，独立合并保绿

## 10. 收口验证

- [ ] 10.1 负向检查单测（非 lint）：读取 `interactive-mode.ts` 源文件，匹配规则定死为 `editorContainer.clear(` 与 `editorContainer.addChild(` 两个精确模式，定位每处命中所在函数，断言全部属于显式白名单（arbiter 容器操作注入闭包、`setCustomEditorComponent` 空闲分支、1109 初始化挂载）；越界时失败并打印行号；不使用计数断言。注意：该检查只能证明命中位于白名单函数内，`setCustomEditorComponent` 空闲/忙分支守卫的正确性由任务 2.2 的行为测试保证。自校验：人为加一处绕过 `clear()` 确认检查变红后移除
- [ ] 10.2 全链路场景测试：extension `editor`（无 signal、无 timeout，只能靠 `cancelKind` 结算的一类）展示期间触发 hot-reload（该对话框被 `cancelKind` 结算恰好一次、占位框正常展示与撤下、重载完成）；extension select 展示中 + 应用选择器排队时触发 `session_replaced`（select 结算、应用选择器保留并随后展示）；对话框队列非空时 overlay 与 footer 不受阻塞；`teardownSessionUi` 路径 dispose（展示中 1 项 + 排队 2 项各结算一次，无"UI 已停止"类调用）

Suggested fixture level: compact - 跨全部迁移点的收口场景，需端到端 TUI 场景路径
Minimal mergeable slice: atomic - 纯测试与检查收口，不含实现改动，依赖组 2-9 全部完成后独立合并
