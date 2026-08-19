# TUI Editor-Surface FIFO Dialog Arbiter

## Why

`interactive-mode.ts` 中所有占用 `editorContainer` 的非 overlay 对话框（extension `select`/`input`/`editor`、extension 自定义非 overlay UI、`showSelector` 系应用选择器、reload box、gist loader）都直接 `editorContainer.clear()` 后替换内容，没有统一的 presentation queue。任一后到对话框会清空先到对话框的界面，使其等待中的 Promise 永远无法结算（丢失 resolve 路径、焦点悬空）——这是**当前就存在的缺陷**，也是通用 `ask_user` 能力（`packages/coding-agent/docs/ask-user.md` §5.2）的硬前置：ask 对话框接入前必须先有共享 arbiter，不能只给 ask 自身加局部锁。

## What Changes

- 新增 TUI-owned FIFO dialog arbiter：所有占用 `editorContainer` 的非 overlay 对话框请求进入单一先进先出队列，同一时刻最多一个对话框可见；当前项结算（回答、取消、abort、组件构造失败、展示前外部结算、强制关闭或 session dispose）后才展示下一项。
- 每个请求恰好结算一次；排队中尚未展示的请求以任意路径结算（abort、外部 `settle`、强制关闭、dispose）时从队列移除、不展示。
- 结算后焦点与 editor-surface 恢复到**结算时刻的**当前编辑器（尊重结算期间发生的 `setCustomEditorComponent` 编辑器替换）。
- 迁移全部既有对话框调用点到 arbiter（7 类）：extension `select`/`input`/`editor`（`confirm` 由 `select` 组合实现、随其覆盖）、extension 自定义非 overlay UI、`showSelector` 系应用选择器、hot-reload box、gist export loader。迁移后 `interactive-mode.ts` 中不再存在绕过 arbiter 的对话框级 `editorContainer.clear()`/`addChild()` 路径。
- `resetExtensionUI` 强制关闭路径改经 arbiter 的 `cancelKind("extension")`：只结算 extension 类对话框（修复该路径现状不 resolve 的 Promise 泄漏），非 extension 项保留在队列。
- `setCustomEditorComponent` 改为对话框感知：不进入队列，但 arbiter 忙时只更新编辑器引用与 prompt stash、不再清空展示中的对话框；空闲时保持现有立即替换行为。
- 既有单对话框行为保持不变：abort 返回值语义、extension UI 返回值契约与文本保存/恢复与迁移前一致（仅并发时序从"互踩"变为"排队"）。**四处已声明的行为收敛**：(1) per-dialog timeout 从"请求时刻起算"统一为"展示时刻起算，排队期间不计时"；(2) reload 失败分支的恢复目标从捕获的 `previousEditor` 收敛为结算时刻的当前编辑器；(3) 迟到的异步构造组件从"只丢弃不清理"收敛为丢弃并 `dispose?.()`（修组件泄漏）；(4) 自定义 UI 文本快照从请求时刻收敛为展示时刻（仅排队时可观测）。请求通过自身的 cancel result factory 保持原有取消返回值；未提供 factory 的泛型请求以 `AbortError` reject。
- editor 恢复是 arbiter-owned 的有界收敛过程：同步 host callback 内再次替换 editor 时，后续微任务重读动态当前 editor 并保持 busy 直至 surface/focus/identity 一致；连续 8 次仍不收敛则清空 surface、聚焦 null 并保持 busy，停止重试直到 `disposeAll()`，避免 stale input owner 与微任务风暴。
- 明确排除：overlay 通知与 footer 不进入队列、不被队列阻塞。

无 BREAKING 变化：单对话框场景除上述四处明确声明的行为收敛外保持原有契约；并发场景由未定义行为（互踩丢 Promise）变为定义行为（FIFO）。

## Capabilities

### New Capabilities

- `editor-surface-dialog-serialization`: `editorContainer` 非 overlay 对话框的 FIFO 排队、settle-once 结算、abort/dispose 处理、焦点与编辑器恢复，以及全部既有调用点的迁移覆盖。

### Modified Capabilities

（无——本仓库 `openspec/specs/` 为空，无既有 capability 受影响。）

## Impact

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`：迁移 7 类对话框调用点（`showExtensionSelector`、`showExtensionInput`、`showExtensionEditor`、`showExtensionCustom` 的非 overlay 分支、`showSelector`、`handleReloadCommand` 的 reload box、`handleShareCommand` 的 gist loader），外加两条非对话框容器写入路径的 arbiter 感知改造——`setCustomEditorComponent` 条件化容器写入，以及 `resetExtensionUI` 改经 `cancelKind`；以符号为定位基线，不依赖易漂移的源码行号。
- 新文件 `packages/coding-agent/src/modes/interactive/dialog-arbiter.ts`（或等价位置）。
- 无 wire/协议/持久化变化；无配置变化；纯 TUI 进程内重构。
- 下游依赖方：`ask-user.md` 切片 2 的 ask 对话框与 pending 重开请求将复用本 arbiter（本 change 不实现 ask）。
- 必读设计文档：`packages/coding-agent/docs/ask-user.md` §5.2（arbiter 约束）与第 10 节测试 21（对话框串行验收语义）。
