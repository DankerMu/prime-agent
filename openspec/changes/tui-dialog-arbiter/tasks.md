# Tasks: TUI Editor-Surface FIFO Dialog Arbiter

## Workflow fixture

Fixture level: expanded（每个子 issue 从其 `Suggested fixture level` 起步；共享 change 因并发、取消、共享状态与 teardown 命中 mandatory expanded trigger）
Project profile: Prime Agent TypeScript monorepo（`openspec/project-profile.md`）

Must preserve:
- 现有 extension UI 返回值、abort 映射、单对话框焦点与文本行为；overlay/footer 不进入队列。
- 未迁移调用点在渐进 PR 中继续工作；每个子任务保持独立可合并。

Seams under test:
- Seam 1：`DialogArbiter.present` / `settle` / `cancelKind` / `disposeAll`，用假组件确定性验证状态机。
- Seam 2：extension UI context 与 `showSelector` 真实入口，验证调用点确实经共享 arbiter。

Risk packs considered:
- Public API / CLI / script entry: not selected - 不新增 CLI/wire API；extension 既有返回契约由 compatibility pack 覆盖。
- Config / project setup: not selected - 无配置变化。
- File IO / path safety / overwrite: selected - gist loader 持有临时文件，evict/dispose 必须只清理本次导出的文件。
- Schema / columns / units / field names: not selected - 无 schema/格式变化。
- Auth / permissions / secrets: not selected - 不改变 gist 认证或权限边界。
- Concurrency / shared state / ordering: selected - FIFO、settle-once、重入、abort/cancel/dispose 竞争是核心。
- Resource limits / large input / discovery: not selected - 队列仅进程内且无发现/大输入面；dispose 提供有界生命周期清理。
- Legacy compatibility / examples: selected - 保持全部既有 dialog 调用方的返回值、焦点与单实例行为。
- Error handling / rollback / partial outputs: selected - 同步/异步构造失败、迟到组件、临时文件和 session teardown 必须闭合。
- Release / packaging / dependency compatibility: not selected - 无依赖或打包面变化。
- Documentation / migration notes: selected - 四项可观察行为收敛必须与 proposal/spec/changelog 一致。
- TUI focus/render lifecycle: selected - editor-surface 唯一所有权、动态恢复目标、无中间焦点。
- Session/extension teardown lifecycle: selected - `resetExtensionUI`、`session_replaced`、reload 与 `stop()` 顺序。

Required evidence:
- 每组任务列出的具体场景测试，输入与期望值以对应 spec scenario 为 oracle。
- 从 `packages/coding-agent` 运行每个新增/修改的具体 Vitest 文件，全部通过；根目录 `npm run check` 通过。
- `openspec validate tui-dialog-arbiter --strict --no-interactive` 通过；GitHub CI 全部可见 build/test checks 通过。

Invariant Matrix:
- Governing invariant: editor-surface 任一时刻最多一个非 overlay 对话框可见，每个请求只经历一次终止且所有 UI/资源所有权在终止时闭合。
- Source of truth: `DialogArbiter` 的 current/queue/disposed 状态与每请求 settle-once 状态。
- Producers: extension UI context、`showSelector` 调用方、reload box、gist loader。
- Validators/preflight: pre-aborted 检查、disposed 检查、request kind/cancel policy。
- Storage/cache/query: 进程内 FIFO queue；无持久化。
- Public entrypoints: extension select/confirm/input/editor/custom 与应用 selector 命令。
- Downstream consumers: dialog result Promise、editorContainer children、TUI focus、reload/share 流程。
- Failure/rollback/stale state: abort、cancelKind、disposeAll、同步/异步构造失败、迟到 resolve、editor 替换、临时文件清理。
- Evidence/readiness: Seam 1 状态机测试、Seam 2 集成场景、负向容器写入检查、CI。
- Regression rows:
  - A 可见且 B/C 入队 -> A/B/C 依次展示，各自只结算一次。
  - queued/constructing/visible 项被 abort/cancel/dispose -> 不闪现或立即撤下，后继正常，清理恰好一次。
  - 未改 overlay/footer 与单对话框调用方 -> 保持现有立即显示和返回契约。

Boundary-surface checklist:
- Shared helper root: `DialogArbiter` 是唯一 editor-surface dialog owner。
- Public entrypoints: extension UI context 与应用 selectors 全量迁移。
- Read/write/cleanup: editorContainer/focus 写入集中；gist 临时文件只由所属请求清理。
- Stale/idempotency: settle-once、abort listener 移除、迟到 async result dispose、terminal `disposeAll`。
- Unchanged consumers: overlay/footer、daemon/RPC wire、prompt stash 与 editor replacement 语义。

Non-goals:
- 不实现 `ask_user`，不改 overlay/footer，不引入优先级/抢占，不改 daemon/RPC wire。

## 1. DialogArbiter 核心

- [x] 1.1 新建 `src/modes/interactive/dialog-arbiter.ts`：实现 design D1 的 `present<T>`（同步/异步 `show`、`{ result, settle }`、`kind`、`signal`、请求级 `cancel`、`onEvict`）、FIFO 与 settle-once 状态机。覆盖 done/settle/abort/构造失败/cancelKind/disposeAll 竞争；pre-aborted 不入队；已挂载组件由 dispose 清理、未挂载请求由 onEvict 清理，constructing 项被 evict 后迟到的组件仍单独 dispose；内部观察 result rejection；微任务边界出队；动态 `getCurrentEditor()` 恢复；`disposeAll` 进入永久终态，后续 present 不触碰 UI。
- [x] 1.2 在 `InteractiveMode` 构造器中实例化 arbiter（注入支持 `undefined` 清空的 `replaceEditorSurface`、支持 `null` 的 `ui.setFocus`、`ui.requestRender`、`getCurrentEditor`），并把 `disposeAll()` 挂载在 `stop()` 内、位于 `this.ui.stop()` **之前**；此任务不迁移任何调用点。
- [x] 1.3 在 `packages/coding-agent/test/dialog-arbiter.test.ts` 完成 Seam 1 测试，逐条覆盖 design D1 状态与所有权表：FIFO 与两种顺序对称；done vs abort 与二次 done；同步 throw/异步 reject；迟到 async resolve；排队与 constructing abort 不闪现；pre-aborted；展示前 settle；`onEvict`/组件 dispose 按所有权恰好一次且抛错不阻断；`cancelKind` 只取消匹配 kind 并使用请求 cancel 值，cancel throw 只 reject 该项；无 cancel 时 AbortError；result rejection 已被内部观察且 await 仍 reject；dispose 幂等、同步清理先于 UI stop、之后 present 不触碰 UI；动态恢复目标；同步重入不递归；初始 async constructing 保留 editor，A 结算至异步 B ready 期间 surface 为空且 focus 为 null、从不聚焦 editor 或保留已 dispose A。固定命令：从 `packages/coding-agent` 运行 `npx tsx ../../node_modules/vitest/dist/cli.js --run test/dialog-arbiter.test.ts`，期望退出 0 且所有 transition assertions 通过。

Suggested fixture level: expanded - 虽为进程内状态机，但共享并发、取消、异步构造与 terminal teardown 命中 mandatory expanded trigger；atomic slice 必须同时交付 design D1 全生命周期/所有权契约、完整 Seam 1 evidence 与 InteractiveMode stop-order 挂线。
Minimal mergeable slice: atomic - 新文件 + 实例化与 dispose 挂线 + `test/dialog-arbiter.test.ts` 全 transition evidence；无对话框调用点经过它，合并即绿且不改变现有用户行为

## 2. `setCustomEditorComponent` 对话框感知

- [x] 2.1 在 `DialogArbiter` 暴露与内部状态一致的只读 busy 查询（不暴露队列），并改写 `setCustomEditorComponent`：arbiter 空闲时保持现有 `clear()+addChild()+setFocus()`；arbiter 忙时只更新 `this.editor`/`editorComponentFactory`/prompt stash，不触碰容器、不抢焦点（新编辑器由结算时的动态恢复目标装上）
- [x] 2.2 行为测试：busy 查询覆盖 queued/constructing/visible/交接/disposed 与 idle；对话框展示期间调用 `setEditorComponent(factory)` 与 `(undefined)`，断言容器 children 仍是对话框组件、焦点仍在对话框、其 `done` 仍可结算，结算后容器为替换后的编辑器；队列为空时替换立即生效（现有行为回归）；调用开始时 arbiter 空闲、但 extension factory 同步重入 `present()` 并挂载对话框时，busy 判断必须发生在 factory/editor/stash 更新之后，断言该对话框不被随后容器写入抹掉，结算后恢复 factory 创建的新编辑器。固定 seam 为 `test/dialog-arbiter.test.ts` 与 `test/interactive-mode-custom-editor.test.ts`；从 `packages/coding-agent` 运行 `npx tsx ../../node_modules/vitest/dist/cli.js --run test/dialog-arbiter.test.ts test/interactive-mode-custom-editor.test.ts`，期望退出 0 且所有状态、容器与焦点断言通过。

Suggested fixture level: compact - 修复一条活跃的互踩路径（extension 可经 `setEditorComponent` API 随时触发），需专门场景验证
Effective fixture level: expanded - `editorContainer` 与 focus 所有权命中项目 profile 的 domain expanded trigger；busy 查询还覆盖 constructing、handoff 与永久 disposed 状态，不能按单一同步条件分支降级。Selected risk packs: concurrency/shared state/ordering、legacy compatibility、TUI focus/render lifecycle；error/rollback 由任务 1 已交付的 settle/cleanup 状态机证据继承，本任务不新增错误通道。
Minimal mergeable slice: atomic - 单函数条件化改写 + 配套测试；arbiter 尚无调用点时忙分支不可达，合并保绿

## 3. 迁移 extension select（含 confirm）

- [x] 3.1 将 `showExtensionSelector`/`hideExtensionSelector` 改写为一次 `arbiter.present`（kind: extension，`cancel: () => undefined`）：signal 交给 arbiter，调用点只将 signal `AbortError` 映射回 `undefined`、其他构造/运行错误原样 reject；timeout 与 `{ tui, timeout }` 选项逐字透传给组件构造（`show` 内构造，计时自展示起算）；selector 组件改由 arbiter 的 mounted ownership 持有，移除 `extensionSelector` 字段与旧 hide 方法；`resetExtensionUI` 中对应的 selector hide 路径改为无条件 `arbiter.cancelKind("extension")`，尚未迁移的 input/editor 仍走 legacy hide。
- [x] 3.2 行为测试基线：带 timeout 的 `select` 单独展示至超时（假时钟），断言 resolve 值为 `undefined` 且容器恢复编辑器；排队期间不创建 selector/倒计时、不计时（spec"排队期间不触发超时"scenario），展示后才完整计时；经真实 `createExtensionUIContext().select` 传入已 aborted signal 时立即 resolve `undefined` 且不触碰 arbiter/UI；排队项 abort 后 Promise resolve `undefined`、从未入容器、队首不受影响；用只替换 `dialogArbiter.present` result 的最小错误映射 harness 注入普通 `Error`，断言真实 `showExtensionSelector` 仅吞 `AbortError`、其他 error 原样 reject。
- [x] 3.3 集成测试（Seam 2）：在同一宿主 harness 的共享 arbiter 中先放入一个可控 app-kind blocker，再经真实 `createExtensionUIContext().select` 发起 `select`，断言 blocker 未结算时 selector/timeout 未启动且容器仍是 blocker，结算后 selector 才展示；这项所有权断言证明 context 使用宿主同一个 arbiter，而不是本地队列。另经 context 并发两个 `select` 验证 FIFO/各自结算/焦点恢复，以 `confirm` 断言 boolean 返回及共享队列路径，并以真实 `resetExtensionUI` 取消 visible+queued select，断言两者各 resolve `undefined`、后项不闪现；在 active connection request map 放入可观察的 `cancelLocal`，断言 transport cancellation/response 发起先于 `dialogArbiter.cancelKind("extension")`。固定 seam 为 `packages/coding-agent/test/interactive-mode-extension-select.test.ts`；从 `packages/coding-agent` 运行 `npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-extension-select.test.ts test/dialog-arbiter.test.ts test/extension-selector.test.ts`，期望退出 0 且全部调用点、计时、FIFO、abort/reset、焦点与返回值断言通过。

Suggested fixture level: compact - 首个真实调用点迁移，承载 timeout/abort 行为基线，需集成路径证明 arbiter 被实际使用
Effective fixture level: expanded - 首个生产 `present()` consumer 同时激活共享 FIFO、AbortSignal、倒计时与 `resetExtensionUI` 批量 teardown，命中 mandatory shared-entrypoint/cancellation trigger 和项目 TUI/extension teardown domain trigger。Selected risk packs: concurrency/shared state/ordering、error handling/rollback、legacy compatibility、TUI focus/render lifecycle、session/extension teardown lifecycle。
Minimal mergeable slice: atomic - 单调用点替换 + 其行为基线测试，独立合并保绿（confirm 经 select 自动覆盖，无独立改动）

## 4. 迁移 extension input

- [x] 4.1 将 `showExtensionInput`/`hideExtensionInput` 改写为一次 `arbiter.present`（kind: extension，`cancel: () => undefined`）：signal 交给 arbiter，调用点只将实际 signal `AbortError` 映射为 `undefined`，其他构造/运行错误原样 reject；`ExtensionInputComponent` 在 `show` 内构造并逐字接收 title、placeholder 与 `{ tui, timeout }`，mounted ownership 归 arbiter；移除 `extensionInput` 字段与旧 hide 方法。`resetExtensionUI` 已无条件调用 `cancelKind("extension")`，删除 input legacy hide 分支，尚未迁移的 editor 仍保留。
- [x] 4.2 caller-level 兼容证据：经真实 `createExtensionUIContext().input` 和宿主同一个 arbiter，在 app-kind blocker 后排队一个带 distinctive title/placeholder/timeout 的 input，断言 blocker 期间 input/CountdownTimer 不构造、不改容器/焦点，释放后展示；以真实组件 render 标题、共享 TUI 触发的 timer/render 和完整 timeout tick 证明 title/TUI/timeout 逐字透传，超时 resolve `undefined`、dispose 恰好一次并恢复 editor/focus；placeholder 在现有组件中是无可观察行为的 `_placeholder` 参数，因此以生产 callsite 的位置参数 wiring 审计证明，不为测试新增产品状态。另以独立 submit 场景输入文本并断言返回原字符串；覆盖 pre-aborted signal -> `undefined` 且无 component/timer/UI/queue residue、visible signal abort -> `undefined`、real reset 同时结算 visible+queued input 且 queued 从未构造；用窄 `present` rejection 注入普通 error 与无实际 signal abort 的同名 `AbortError`，断言均保持原始 rejection。固定 seam 为 `packages/coding-agent/test/interactive-mode-extension-input.test.ts`；从 `packages/coding-agent` 运行 `npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-extension-input.test.ts test/dialog-arbiter.test.ts`，期望退出 0 且全部值、timer/FIFO、pre/visible abort、reset、ownership、参数 wiring 与焦点断言通过。

Suggested fixture level: none - 与任务 3 同模式的机械替换，行为由任务 3.2 建立的 timeout/abort 基线模式与组 1 单测覆盖
Effective fixture level: expanded - 虽复用既有模式，但本 PR 把 input 的 AbortSignal/timeout/mounted cleanup 接入共享队列并删除 `resetExtensionUI` 的 raw container owner，命中 mandatory cancellation/shared-state trigger 与项目 `editorContainer`、focus、reset domain trigger。Selected risk packs: concurrency/shared state/ordering、error handling/rollback、legacy compatibility、TUI focus/render lifecycle、session/extension teardown lifecycle。
Minimal mergeable slice: atomic - input show/hide 对 + reset input legacy 分支 + caller-level compatibility proof；其他 dialog 类不动

## 5. 迁移 extension editor

- [x] 5.1 将 `showExtensionEditor`/`hideExtensionEditor` 改写为一次 `arbiter.present`（kind: extension，`cancel: () => undefined`，无 signal/timeout）：`ExtensionEditorComponent` 只在 `show` 内构造并逐字接收 `this.ui`、`this.keybindings`、title、prefill 与 submit/cancel callbacks，mounted ownership/focus/restore 归 arbiter；移除 `extensionEditor` 字段与旧 hide 方法。`resetExtensionUI` 已无条件调用 `cancelKind("extension")`，删除 editor legacy hide 分支，使 visible/queued editor 的 Promise 均以 `undefined` 恰好结算一次，不再泄漏；构造/运行错误保持原始 rejection。
- [x] 5.2 caller-level 行为证据：经真实 `createExtensionUIContext().editor` 和宿主同一个 arbiter，在 app-kind blocker 后排队 editor，断言 blocker 期间 editor 不构造、不改容器/焦点，释放后展示；用 distinctive title/prefill 和真实组件 submit 路径断言返回完整多行字符串并恢复 editor/focus。另用自定义 `tui.select.cancel` binding 驱动真实 user cancel -> `undefined`；以真实 `resetExtensionUI` 同时结算 visible+queued editor，断言两项各 resolve `undefined`、queued 从未构造/闪现、最终恢复 editor/focus/idle；用窄 `present` rejection 注入普通 error 与同名 `AbortError`（editor 无 signal），断言均保持原始 rejection。固定 seam 为 `packages/coding-agent/test/interactive-mode-extension-editor.test.ts`；从 `packages/coding-agent` 运行 `npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-extension-editor.test.ts test/dialog-arbiter.test.ts`，期望退出 0 且值、FIFO、user cancel、强制关闭 settle-once、error、ownership 与焦点断言全部通过。

Suggested fixture level: none - 同模式机械替换且参数面更小；强制关闭结算语义由组 1 的 `cancelKind` 单测与组 10 的集成场景覆盖
Effective fixture level: expanded - editor 无 AbortSignal/timeout，`resetExtensionUI` 是唯一强制结算入口；本 PR 修复真实 Promise 泄漏并转移共享 surface/focus ownership，命中 mandatory cancellation/shared-state trigger 与项目 `editorContainer`、focus、reset domain trigger。Selected risk packs: concurrency/shared state/ordering、error handling/rollback、legacy compatibility、TUI focus/render lifecycle、session/extension teardown lifecycle。
Minimal mergeable slice: atomic - editor show/hide 对 + reset editor legacy 分支 + caller-level leak/compatibility proof；其他 dialog 类不动

## 6. 迁移 extension 自定义非 overlay UI

- [x] 6.1 仅将 `showExtensionCustom` 的非 overlay 分支及其 `restoreEditor` 所有权改写为一次 `arbiter.present`（kind: extension，无通用 cancel 值，强制关闭时以 `AbortError` reject）：factory 只在 `show` 内调用，其 Promise 映射为 `{ component, focus: component }`，异步 reject 与迟到 resolve/dispose 交给 arbiter 状态机；展示时记录当前 editor 实例及其文本快照，任一结算路径仅在 `this.editor` 仍为该实例时回写文本。overlay 分支的 `showOverlay`、动态/static options、`onHandle`、close/dispose 与错误语义不改且不入队。
- [x] 6.2 caller-level 行为证据经真实 `createExtensionUIContext().custom` 与宿主同一个 arbiter：app-kind blocker 后入队 custom，断言 blocker 期间 factory 不调用且 editor 文本随后变化时，释放后才调用 factory并以展示时刻文本为快照；同一 editor 在 visible 期间被改写后，`done` 返回原值、dispose 恰好一次，文本恢复到展示快照且 editor/surface/focus 恢复。另在 queued/visible 生命周期经 `setCustomEditorComponent` 替换 editor，断言 custom 不抢 surface、结算不把旧快照写入新实例且动态恢复新 editor/focus。
- [x] 6.3 failure/teardown 与 sibling compatibility 证据：异步 factory 原始 reject 经真实 caller 按 identity reject，恢复 editor/focus并推进后继；真实 `resetExtensionUI` 使 visible 与 queued custom 各以 `AbortError` 恰好 reject、queued factory 从未调用；constructing custom 被 reset 后迟到 resolve 的组件不挂载且 dispose 恰好一次。overlay custom 在 app-kind blocker 存在时仍立即调用 factory/showOverlay，static/dynamic options、`onHandle`、done 值与 dispose 保持既有行为且不触碰 arbiter surface。固定 seam 为 `packages/coding-agent/test/interactive-mode-extension-custom.test.ts`；从 `packages/coding-agent` 运行 `npx tsx ../../node_modules/vitest/dist/cli.js --run test/interactive-mode-extension-custom.test.ts test/dialog-arbiter.test.ts`，期望退出 0 且上述 FIFO、快照/实例配对、error/reset/late cleanup、overlay assertions 全部通过。

Suggested fixture level: compact - 含两处真实行为规则（异步工厂接入、快照配对），需专门场景验证而非纯机械替换
Effective fixture level: expanded - 既有 public extension UI entrypoint 接入共享 FIFO 与缺省 cancellation，且直接转移 `editorContainer`、focus、async component 与 reset teardown 所有权，命中 mandatory shared-state/cancellation 和项目 domain triggers。Selected risk packs: concurrency/shared state/ordering、error handling/rollback、legacy compatibility、TUI focus/render lifecycle、session/extension teardown lifecycle。
Minimal mergeable slice: atomic - 仅非 overlay 分支 + caller-level tests；overlay 与其他 dialog 类不动，独立合并保绿

## 7. 迁移 showSelector 应用选择器

- [ ] 7.1 将 `showSelector` helper 改写为 `arbiter.present`（kind: app，`cancel: () => undefined`），其全部调用方自动经队列，`done` 回调语义不变（二次 `done` 为 no-op，由 arbiter 保证）
- [ ] 7.2 集成测试：一条经真实 `showSelector` 路径的用例（thinking selector），断言展示、结算、焦点恢复（现有测试 stub 掉了 helper 本体，真实路径当前零覆盖）；一条 `extension select` 与 `showSelector` 反向并发的对称用例（spec"两种先后顺序对称"的真实配对）；断言真实调用方重复 `done()` 时第二次为 no-op

Suggested fixture level: compact - 一次改写影响 5 个应用选择器且真实路径无既有覆盖，需真实路径集成护栏
Minimal mergeable slice: atomic - 单 helper 替换 + 集成护栏，调用方零改动，独立合并保绿

## 8. 迁移 hot-reload box

- [ ] 8.1 将 `handleReloadCommand` 的 reload box 展示/dismiss 改写为 `arbiter.present`（kind: placeholder，`cancel: () => undefined`）：结算经 `settle` 句柄统一成功/失败分支，失败分支的 `previousEditor` 回退收敛为动态恢复目标（design D7）；命令开头的 `resetExtensionUI` 先行执行 `cancelKind`，占位框随后入队；队列空时保留 `requestRender(true) + nextTick` 先画后干时序，重载流程不等待占位框展示
- [ ] 8.2 行为测试：reload 失败分支结算后容器为结算时刻的当前编辑器（期间发生编辑器替换时不回退旧引用）；`settle` 先于展示到达时占位框整体略过且重载正常完成

Suggested fixture level: compact - 涉及外部结算时序与一处已声明行为变更，需专门场景验证
Minimal mergeable slice: atomic - 单调用点 + 配套测试，独立合并保绿

## 9. 迁移 gist export loader

- [ ] 9.1 将 `handleShareCommand` 的 `BorderedLoader` 展示/恢复改写为 `arbiter.present`（kind: placeholder，`cancel: () => undefined`）：完成路径经 `settle`，取消路径经组件 `onAbort` 映射到 `show` 内的 `done`（无外部 AbortSignal）；临时文件删除收敛为幂等清理函数，由展示组件 dispose 路径与未展示 `onEvict` 互斥覆盖，排队中被 dispose 时同样清理
- [ ] 9.2 行为测试：loader 排队期间 dispose，断言临时文件被删除、loader 从未展示、结算恰好一次

Suggested fixture level: compact - 含资源清理路径迁移（现状清理只在展示后路径上执行），需泄漏场景验证
Minimal mergeable slice: atomic - 单调用点 + 配套测试，独立合并保绿

## 10. 收口验证

- [ ] 10.1 负向检查单测（非 lint）：读取 `interactive-mode.ts` 源文件，匹配规则定死为 `editorContainer.clear(` 与 `editorContainer.addChild(` 两个精确模式，定位每处命中所在函数，断言全部属于显式白名单（arbiter 容器操作注入闭包、`setCustomEditorComponent` 空闲分支、1109 初始化挂载）；越界时失败并打印行号；不使用计数断言。注意：该检查只能证明命中位于白名单函数内，`setCustomEditorComponent` 空闲/忙分支守卫的正确性由任务 2.2 的行为测试保证。自校验：人为加一处绕过 `clear()` 确认检查变红后移除
- [ ] 10.2 全链路场景测试：extension `editor`（无 signal、无 timeout，只能靠 `cancelKind` 结算的一类）展示期间触发 hot-reload（该对话框被 `cancelKind` 结算恰好一次、占位框正常展示与撤下、重载完成）；extension select 展示中 + 应用选择器排队时触发 `session_replaced`（select 结算、应用选择器保留并随后展示）；对话框队列非空时 overlay 与 footer 不受阻塞；`teardownSessionUi` 路径 dispose（展示中 1 项 + 排队 2 项各结算一次，无"UI 已停止"类调用）

Suggested fixture level: compact - 跨全部迁移点的收口场景，需端到端 TUI 场景路径
Minimal mergeable slice: atomic - 纯测试与检查收口，不含实现改动，依赖组 2-9 全部完成后独立合并
