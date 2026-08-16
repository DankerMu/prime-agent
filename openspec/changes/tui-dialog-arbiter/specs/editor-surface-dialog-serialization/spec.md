# Spec: editor-surface-dialog-serialization

## ADDED Requirements

### Requirement: FIFO 展示顺序

所有占用 `editorContainer` 的非 overlay 对话框请求 MUST 进入单一先进先出队列；同一时刻至多一个对话框可见，后到请求 MUST NOT 清空或替换正在展示的对话框。

#### Scenario: 并发请求按到达顺序展示

- WHEN 对话框 A 正在展示时，对话框 B、C 依次到达
- THEN B、C 进入队列不展示；A 结算后展示 B，B 结算后展示 C，各自的 Promise 按各自结算值 resolve

#### Scenario: 两种先后顺序对称

- WHEN extension `select` 与应用 `showSelector` 选择器以任一先后顺序并发请求
- THEN 先到者完整展示并可结算，后到者排队等待；两种顺序下均无 Promise 悬空、无容器互踩

#### Scenario: 结算回调内同步重入按普通入队处理

- WHEN 请求 A 的结算回调在同步执行流中发起请求 B
- THEN B 按普通入队处理并在 A 的清理完成后展示；交接间隙编辑器不获得中间焦点，不产生递归展示

### Requirement: Settle-once 结算

每个对话框请求 MUST 恰好结算一次；结算路径为回答、取消、abort、组件构造失败、展示前外部结算、强制关闭（`cancelKind`）或 session dispose（`disposeAll`）之一，后到的重复结算 MUST 为 no-op（不 throw、不二次 resolve/reject）。signal abort MUST 以名称为 `AbortError` 的错误 reject；`cancelKind`/`disposeAll` MUST 使用请求级 cancel result factory 保持调用方取消值，未提供 factory 时 reject `AbortError`；cancel factory throw MUST 仅以原始 error reject 该请求并继续处理其他项。result MUST 保持原生 Promise 的 await/reject 语义，并被内部观察，未 await 的 fire-and-forget 请求不得产生 unhandled rejection。

#### Scenario: 回答与 abort 竞争

- WHEN 当前对话框的 `done` 回调与其 abort signal 几乎同时触发
- THEN 先到者决定结算值，后到者不产生第二次 resolve/reject，队列正常推进到下一项

#### Scenario: 二次 done 为 no-op

- WHEN 调用点在结算回调路径上对同一请求第二次调用 `done`
- THEN 第二次调用无任何效果，不影响后续项的展示与结算

#### Scenario: 同步构造异常

- WHEN 出队请求的 `show` 同步抛出异常
- THEN 该请求以 reject 结算恰好一次，editor-surface 恢复当前编辑器，队列继续推进下一项

#### Scenario: 异步组件工厂 reject

- WHEN 出队请求的 `show` 返回的 Promise reject（异步组件工厂构造失败）
- THEN 该请求以 reject 结算恰好一次，editor-surface 恢复当前编辑器，队列继续推进下一项

#### Scenario: 迟到的异步构造结果被丢弃

- WHEN 出队请求的 `show` Promise 尚未 resolve 时该请求已被 abort 或 dispose 结算，随后 Promise resolve 出组件
- THEN 该组件不进入容器并被调用其 `dispose?.()`，不产生第二次结算，队列状态不受影响

#### Scenario: session dispose 清空队列并进入终态

- WHEN 存在一个展示中对话框与两个排队请求时执行 `disposeAll()`，随后又调用 `present`
- THEN 展示中对话框按自身 cancel 值结算一次并 dispose 组件，两个排队请求各按自身 cancel 值结算一次并各调用 `onEvict` 一次且从未展示；后续 `present` 立即按 cancel 语义结算且不入队、不触碰容器；重复 `disposeAll()` 与空队列 dispose 为幂等 no-op

#### Scenario: dispose 同步清理先于 UI 停止

- WHEN session 拆卸路径（`stop()`）执行
- THEN `disposeAll()` 在 `ui.stop()` 之前同步完成请求终态标记、abort listener 移除、`onEvict` 或组件 dispose，且此后 arbiter 不再调用 UI；原生 Promise reaction 保持 JavaScript 微任务语义，不要求同步执行

#### Scenario: 展示组件与未展示资源按所有权清理

- WHEN 一个已展示请求结算，另一个 queued 请求被移除，第三个异步 constructing 请求被移除后组件才迟到 resolve
- THEN 已展示组件 `dispose?.()` 恰好一次且不调用 `onEvict`；queued 请求只调用 `onEvict` 一次；constructing 请求在移除时调用 `onEvict` 一次并在迟到组件到达后额外 dispose 该组件一次；任一清理钩子抛错都不改变请求结果或阻断队列推进

#### Scenario: fire-and-forget rejection 被观察

- WHEN 未 await result 的 app/placeholder 请求因构造失败、abort 或缺省 cancel 语义而 reject
- THEN 进程不产生 unhandled rejection；调用方若 await 同一 result 仍观察到原始 rejection

### Requirement: 强制关闭（extension UI reset）

`resetExtensionUI` 语义的强制关闭 MUST 经 arbiter 的 `cancelKind("extension")` 实现：当前项与排队项中 kind 为 extension 的请求各按其取消语义结算恰好一次（消除现状不 resolve 的 Promise 泄漏），其他 kind 的请求保留在队列并按 FIFO 继续。

#### Scenario: session 切换关闭 extension 对话框

- WHEN extension `select` 正在展示、应用 `showSelector` 选择器排队时触发 `session_replaced`
- THEN select 以取消语义结算恰好一次（Promise resolve 为取消值，不泄漏）；应用选择器保留并随后正常展示

#### Scenario: /reload 期间的强制关闭与占位框共存

- WHEN extension `editor` 对话框（无 signal、无 timeout）展示中触发 `/reload`
- THEN 该对话框经 `cancelKind` 结算恰好一次，随后 reload box 正常入队展示与撤下，重载流程完成

### Requirement: 排队项展示前结算即移除

排队中尚未展示的请求以**任意路径**结算（abort、外部 `settle`、强制关闭、dispose）时 MUST 直接从队列移除并结算恰好一次，MUST NOT 被展示（不闪现）；abort 在出队后、组件挂载完成前到达时同样 MUST NOT 展示。

#### Scenario: 队列中段 abort

- WHEN 队列为 [A 展示中, B, C]，B 的 abort signal 触发
- THEN B 立即以 abort 语义结算且不展示；A 结算后直接展示 C

#### Scenario: 入队时 signal 已 aborted

- WHEN 调用 `present` 时请求的 signal 已处于 aborted 状态
- THEN 该请求立即按 abort 语义结算，不入队、不触碰容器（与迁移前的即时返回行为一致）

#### Scenario: 展示前被外部 settle

- WHEN 占位类请求（reload box / gist loader）入队后、展示前，其 `settle(value)` 被外部流程调用
- THEN 该请求以 value 结算恰好一次、从未展示；队首结算后直接展示其后继项或恢复编辑器，容器不残留占位框

#### Scenario: evict 时调用点清理恰好一次

- WHEN 携带 `onEvict` 的请求在未展示状态下被移除（abort、settle、cancelKind、dispose 任一路径）
- THEN 其 `onEvict` 被调用恰好一次（调用点得以清理临时文件、事件监听等资源），且与结算合计各恰好发生一次

### Requirement: 焦点与编辑器恢复

对话框结算后，arbiter MUST 将 editor-surface 恢复为**结算时刻**的当前编辑器并将焦点交还给它；恢复目标 MUST 动态获取，不得使用入队时捕获的编辑器引用。

#### Scenario: 队列期间编辑器被替换

- WHEN 对话框 A 展示期间 `setCustomEditorComponent` 将默认编辑器替换为自定义编辑器
- THEN A 结算后容器恢复为自定义编辑器且其获得焦点，旧默认编辑器不被塞回容器

#### Scenario: 初始异步构造与连续结算的焦点交接

- WHEN 初始异步请求 I 从空闲 editor 开始 constructing，或队列 [A, B] 中可见 A 结算而 B 同步 ready/仍在异步 constructing
- THEN I ready 前 editor 保持挂载与焦点；A 结算时立即从 surface 移除并 dispose，B 同步 ready 时焦点直接交给 B，异步 constructing 时 surface 暂为空且焦点为 null，B ready 后再获得焦点；A/B 交接不短暂聚焦 editor，B 结算后焦点才回到当前编辑器

#### Scenario: 文本快照只回写同一编辑器实例

- WHEN extension 自定义非 overlay UI 在展示时刻从当前编辑器快照文本，结算前编辑器被替换为新实例
- THEN 结算后不向新编辑器回写快照文本（文本迁移由编辑器替换路径的 prompt stash 负责），快照仅在结算时刻编辑器仍为同一实例时回写

### Requirement: timeout 自展示时刻起算

带 timeout 的对话框请求，其计时 MUST 自展示时刻（组件在 `show` 中构造）起算，排队期间 MUST NOT 计时；超时结算 MUST 经 arbiter 完成，调用点 MUST NOT 因超时自行清空容器。

#### Scenario: 排队期间不触发超时

- WHEN 对话框 A 展示中，带 30 秒 timeout 的 extension `select` B 排队，等待时间超过 30 秒后 A 结算
- THEN B 此时才展示并从展示时刻起计时 30 秒；排队期间 B 未结算、未展示、未清空容器

#### Scenario: timeout 结算值保持迁移前形态

- WHEN 单独展示一个带 timeout 的 extension `select` 且用户不操作直至超时
- THEN 其 Promise 以迁移前相同的超时结算值 resolve（`undefined`），容器恢复编辑器

### Requirement: 既有调用点全量迁移

extension `select`/`input`/`editor`（`confirm` 由 `select` 组合实现，随 select 一并覆盖）、extension 自定义非 overlay UI、`showSelector` 系应用选择器、hot-reload box 与 gist export loader MUST 全部经 arbiter 展示；`resetExtensionUI` 的强制关闭 MUST 经 `cancelKind`。迁移后 `interactive-mode.ts` 中 `editorContainer.clear()`/`editorContainer.addChild()` MUST 仅存在于注入给 arbiter 的容器操作闭包、`setCustomEditorComponent` 的 arbiter 空闲分支，以及构造期初始化挂载点。

#### Scenario: 迁移覆盖的负向检查

- WHEN 收口单测读取迁移完成后的 `interactive-mode.ts` 源文件并按精确模式 `editorContainer.clear(` 与 `editorContainer.addChild(` 定位每处命中所在函数
- THEN 每处命中都属于显式白名单（arbiter 容器操作注入闭包、`setCustomEditorComponent` 空闲分支、构造期初始化挂载），任何越界命中使测试失败并打印行号；不使用可被增删抵消的计数断言

#### Scenario: 非交互占位同样排队

- WHEN extension `select` 对话框展示期间触发 hot-reload
- THEN reload box 排队等待而不清空 select 对话框；select 结算后 reload box 展示（若其 settle 尚未到达），重载流程本身不等待占位框展示、照常完成

### Requirement: 单对话框行为保持不变

迁移 MUST NOT 改变各对话框既有的单实例语义：abort 返回值形态、extension UI 的返回值契约与文本保存/恢复保持迁移前行为；仅 proposal 明确列出的四处行为按新契约收敛：timeout 自展示起算、reload 失败恢复动态当前编辑器、迟到异步组件 dispose、自定义 UI 文本快照取自展示时刻。

#### Scenario: abort 返回值映射保持

- WHEN 带 signal 的 extension `select` 在排队或展示期间被 abort
- THEN 其 Promise 以 `undefined` resolve（与迁移前一致）；arbiter 内部的 abort 表示不外泄为 extension host 可见的异常

#### Scenario: 文本保存恢复保持

- WHEN extension 自定义非 overlay UI 展示前编辑器含有文本且结算时编辑器未被替换
- THEN 该 UI 结算后编辑器文本恢复为展示时刻快照内容，与迁移前行为一致

### Requirement: 队列排除项与编辑器替换感知

overlay 通知、footer 状态展示 MUST NOT 进入对话框队列，也 MUST NOT 被队列阻塞。`setCustomEditorComponent` MUST NOT 进入队列，且 MUST 对话框感知：arbiter 忙时（queued、异步 constructing、visible、待微任务交接或永久 disposed）只更新编辑器引用与 prompt stash、不触碰容器、不抢焦点；arbiter 空闲时保持现有立即替换行为。busy 的只读查询 seam MUST 与 `setCustomEditorComponent` 的首个生产消费者在同一迁移任务引入，不在裸核心 PR 暴露零消费者 API。

#### Scenario: overlay 不受阻塞

- WHEN 对话框队列非空时触发 overlay 通知与 footer 更新
- THEN 两者立即生效，不排队、不影响队首对话框

#### Scenario: 对话框展示期间替换编辑器不清空对话框

- WHEN 对话框展示期间调用 `setCustomEditorComponent`（含 `undefined` 恢复默认编辑器）
- THEN 容器 children 仍为该对话框组件、焦点仍在对话框、其 `done` 仍可正常结算；结算后容器恢复为替换后的编辑器

#### Scenario: 空闲时编辑器替换立即生效

- WHEN 队列为空、容器由编辑器占用时调用 `setCustomEditorComponent`
- THEN 替换立即生效（现有行为），新编辑器进入容器并获得焦点
