# Tasks: Prompt Settlement（切片 1）

## 1. PromptSettlementTracker 核心

- [x] 1.1 新建 `src/core/prompt-settlement.ts`：导出 D1 类型/API；每次 `acquire` 返回独立实例，同 promptId/kind允许并存并按实例计数；D2 cancel→failed→completed，lease 1→0同步终态，终态后 acquire抛错、其他变更no-op；`waitForOutcome`/`outcome` 对已终态记录（含 released）分别 resolve/返回同一对象，未知 id 分别 reject/返回 `undefined`；`settleAll(status, reason, options?: { released?: boolean })` 一律把 reason 写入记录 `settleReason`，并在 `options.released` 为 true 时把 released fence 与终态在同一次 persist 中写入；status 为 `failed` 时额外填 `outcome.failure.reason` 与记录 `failureReason`，为 `cancelled` 时不填 `outcome.failure`
- [x] 1.2 tracker 单测（Seam 1，假时钟/`emit`/`persist`）：完整 happy-path 字段（admit `sessionEpoch`，默认 `finalMessageIds=[]`/`traceGeneration=0`，recordFinalMessage 追加、bump 递增，`advisor:"disabled"`，无 `pendingQuestions`/`failure`，`admittedAt`/`settledAt` 取时钟）且 admission persist一次不emit、终态再persist/emit一次；同 promptId/kind 两个独立 run lease先放一个不终态；run→retry→compaction 先取后放无空窗与先放后取同步提前终态/acquire抛错反例；cancel优先于failure，failed run有 `failure.reason === failureReason` 且无 `settleReason`，cancelled无 `failure`/`failureReason`；终态后二次 mutation/lease release no-op；`settleAll("failed")` 有 `failure.reason === failureReason === settleReason`，`settleAll("cancelled", "session_disposed", {released:true})` 对每个eligible prompt仅追加一次终态persist/emit且无failure，重复no-op；unknown `waitForOutcome` reject/`outcome` undefined，`isSettling` 对unknown/active/terminal分别false/true/false，duplicate admit抛错；`snapshot`深复制；`restore`同id最后一条胜出、active可继续、terminal/released只读且`waitForOutcome`/`outcome`返回同一对象且不persist/emit；区分 `PromptLease.release()`、`tracker.release(promptId)`（仅已终态置released并persist一次，active/unknown与重复调用no-op）和 `settleAll(...,{released:true})`

Suggested fixture level: compact - 纯状态机，确定性单测即可穷举，但它承载后续全部组的正确性基线
Minimal mergeable slice: atomic - 新文件无调用方，合并即绿不改变任何行为

## 2. action promptId 与主 run lease

- [ ] 2.1 turn action 增非空 `promptIds` 与对应 `runLeases`；公共 action单 owner、internal inherit可多 owner。create只准备候选/lineage；`_admitSessionInput` 通过所有检查后、enqueue前：default admit并 acquire一个 run lease，inherit校验全部 owners仍 settling并逐个 acquire（同kind实例可并存）；任一失败则不入队。session command无字段；tracker emit接线、persist暂no-op
- [ ] 2.2 preparing禁止重复 acquire；`"all"` batching只汇总 action owners到 `_lastRunPromptIds`/`_currentRunOwners`。completion/error/实际取消只释放action已有 leases，错误先 recordFailure。default取消先 requestCancel再release；inherit非-abort取消只release；终态 owner的inherit action放弃不入队。pre-admission无 record/lease；保证无0-lease accepted action或永久 settling
- [ ] 2.3 `promptAndSettle(...): Promise<PromptOutcome | undefined>`：以本次调用私有 admission 回调捕获 actual turn id；accepted turn 无论旧 completion resolve/reject都返回 tracker 的 completed/failed/cancelled，非 turn成功返回 undefined、非 turn失败与 admission 拒绝仍 reject。公共 `prompt` 也接受候选 id与一次性 settlement-admission 回调（供 connection/RPC）；新增 outcome 查询/event；并发/重复候选 id不得串调用
- [ ] 2.4 行为测试（Seam 2）：单 run completed；provider terminal error与 abort分别返回 failed/cancelled outcome而非 completion rejection；两个排队 prompt独立；`"all"` batching 的全部 owners 各持一个共享 run 的 action lease且都不提前结算；tool 阻塞；steer/followUp 新 identity；session/extension/handled 非 turn返回 undefined且失败仍 reject；clearQueue cancelled；coalesce/disposing/重复 id reject无 record；并发候选 id不串；`promptAndWait` 回归；后台不阻塞

Suggested fixture level: compact - 首次把 tracker 挂进 session，是所有模式依赖的基线路径
Minimal mergeable slice: atomic - 只覆盖主 run 一种 lease；retry/compaction 未挂线时它们不存在于测试路径，合并保绿

## 3. retry lease

- [ ] 3.1 `_retryPromise` 建立的两处（`:3396`、`:10241`）对 `_lastRunPromptIds` 的每个去重 owner `acquire("retry")`，在 `_retryResolve` 置空处逐个 release；顺序保证：先为全部 owners 获取 retry lease，再释放各自 run lease
- [ ] 3.2 行为测试：单 prompt faux provider 先 error 后成功 → 一个 promptId、两个 `agent_end`、一个 `completed` 且在 retry 完成后才产生；retry 耗尽 → `failed/run_error`；`"all"` batching 的两个 prompt 共享 retry 时，两者都不在 retry 前结算且各仅一个 outcome

Suggested fixture level: compact - 涉及 lease 交接顺序，是设计 §8 第 4 条竞态的真实路径
Minimal mergeable slice: atomic - 单一挂点 + 配套测试，独立合并保绿

## 4. post-compaction continuation lease 与 traceGeneration

- [ ] 4.1 `_schedulePostCompactionContinue` 置 `Scheduled=true` 时捕获 `_lastRunPromptIds` owner 快照并逐 id `acquire("compaction_continuation")`；`_cancelPostCompactionContinue`（含 `_clearQueuedAutonomousContinuations`、auto-refine 分支失效等非 abort 调用方——只 release 不 `requestCancel`）、`_runScheduledPostCompactionContinue` 各提前 return 与 `agent.continue()` 返回/抛出后逐个 release；reschedule 沿用同一 owner/lease 组，绝不回读可能被后续 run 覆盖的 `_lastRunPromptIds`；compaction 完成回调对该 compaction owner 快照逐 id `bumpTraceGeneration`
- [ ] 4.2 行为测试：threshold compaction 触发 continuation，outcome 在 continuation run 结束后产生、`traceGeneration === 1`（无 compaction 为 0；A 终态后 B 的 compaction 不改 A）、`agent_end` 两次；`"all"` batching 的 owner 全部等待同一 continuation 且 generation 各 +1；A continuation 在 B 后执行仍只归 A owner 快照；continuation 因排队清空被取消（非 abort）→ 恰好一个 `completed` outcome；abort 取消 → `cancelled`（放组 6.2）

Suggested fixture level: compact - timer 持有的 continuation 是现状 `AgentMessageOutcome` 丢失的核心场景
Minimal mergeable slice: atomic - 单一挂点 + 配套测试，独立合并保绿

## 5. autonomous threshold continuation 继承 lineage

- [ ] 5.1 `_queueAutonomousContinuationForThresholdCompaction` 创建 action 时传 `lineage: { inherit: ownerSnapshot }`，其中 ownerSnapshot 是触发 continuation 的共享 run 全部去重 promptIds；同一 continuation action 只入队/执行一次。`_clearQueuedAutonomousContinuations` 取消该 action 时对全部 inherited owners 走组 2.2 的 inherit 分支（只 release、不 `requestCancel`）
- [ ] 5.2 行为测试：goal 模式下 threshold compaction 排队 autonomous continuation，单 owner 时 action.promptIds 等于原 prompt；`"all"` 共享 run 时 action 继承全部 owners 但只执行一次；每个 outcome 均单次且在 continuation 完成后产生

Suggested fixture level: none - 一行 options 透传 + 组 2.2 取消路径复用
Minimal mergeable slice: atomic - 单调用点，依赖组 2/4，独立合并保绿

## 6. cancel 路径：abort、admission 后未执行、dispose

- [ ] 6.1 `requestAbort` 保留真实可见用户队列，但先移除当前 owners的所有 internal inherited autonomous actions（不受默认 queueVisible迷惑）并释放已有 run leases，取消/释放 compaction leases，再对当前 owners requestCancel；current action completion释放自身 lease。clear/mutate/abortAndClearQueue按组2只释放实际移除action。dispose原子 settleAll released，不先release
- [ ] 6.2 测试：普通 abort当前 owners cancelled、真实用户队列lease保留且可恢复；已入队 threshold inherit action被摘除，resume不对终态owner acquire/不抛；continuation leases cancelled；abortAndClearQueue才清用户队列；dispose一次终态persist/emit且released；重复no-op

Suggested fixture level: compact - abort 与 dispose 各有独立触发，需逐条场景
Minimal mergeable slice: atomic - 取消语义一组内闭环，依赖组 2/4，独立合并保绿

## 7. finalMessageIds 记录

- [ ] 7.1 新增 `_currentRunOwners: string[]`：普通 dispatch 开始时设为本次所有 turn action 的去重 promptIds、dispatch completion settle 时清空（retry 续跑期间不清空）；`_runScheduledPostCompactionContinue` 调用 `agent.continue()` 前设为调度时捕获的 continuation owners、返回/抛出后清空；主 agent `message_end` 写入 assistant entry 处对每个 current owner `recordFinalMessage(owner, entryId)`；run 之外 owners 为空，不记录
- [ ] 7.2 行为测试：run → retry → compaction continuation 三条 assistant entry 按序出现在对应 `finalMessageIds`；`"all"` 共享 run 的 entry 同时归每个 owner；A 的 continuation 在 B 后执行时，B 消息只归 B、continuation 消息只归 A 的捕获 owners；后台 refine 消息不出现

Suggested fixture level: compact - 含 continuation 重排下的归属竞态场景
Minimal mergeable slice: atomic - 单挂点 + 断言，依赖组 4，独立合并保绿

## 8. ledger 写入

- [ ] 8.1 tracker `persist` 接 `sessionManager.appendCustomEntry("prime-agent.prompt-settlement", record)`：admission 写 `settling`，终态/released 写终态记录；record 形状按 persistence spec（`failureReason` 仅 failed、`settleReason` 来自 `settleAll`）
- [ ] 8.2 行为测试：正常 prompt 恰两条；retry/compaction 不增加记录；dispose 写 `released: true, settleReason: "session_disposed"` 终态且无 `failureReason`

Suggested fixture level: none - 机械写盘 + 计数断言
Minimal mergeable slice: atomic - 只写不读，合并保绿

## 9. 重启恢复

- [ ] 9.1 session 构造期（任何 listener 订阅前）扫描 custom entries 按 promptId 取最后一条 `restore`；`settling && !released` → `settleAll("failed", "runtime_restarted")` 并追加终态 entry，**不发出** `prompt_outcome` 事件；终态/released 只读；action recovery 恢复的 action 走 `lineage` 缺省（新 promptId）
- [ ] 9.2 行为测试：四种记录形态（settling / completed / released / settling→cancelled）重载结果，含 `waitForPromptOutcome` 对 released 终态 resolve；加载后订阅的 listener 收不到 `runtime_restarted` 的事件；恢复 action 拿新 promptId 且旧 id 为 failed

Suggested fixture level: compact - 恢复路径有四种输入形态，需逐一验证
Minimal mergeable slice: atomic - 读路径一组闭环，依赖组 8 的写格式

## 10. AgentConnection.promptAndSettle（in-process）

- [ ] 10.1 `agent-connection/types.ts` 增加 optional-outcome `promptAndSettle`，并给 `AgentConnectionPromptOptions` 增一次性 `settlementAdmission({ supported, promptId? })` 回调；in-process 的普通 `prompt` 对 turn回调 supported+id、非 turn supported无 id，`promptAndSettle` 直通 session；daemon 暂回调 unsupported并明确拒绝（组 12 替换）
- [ ] 10.2 单测：in-process 普通 turn 返回 outcome，session/extension/handled 非 turn在 completion 后返回 `undefined`；daemon 连接暂明确拒绝

Suggested fixture level: none - 接口透传
Minimal mergeable slice: atomic - 接口 + in-process 实现，daemon 实现由组 12 依赖本组

## 11. daemon 协议：capability、ACK promptId、事件、命令

- [ ] 11.1 protocol：capability、schema17、optional id/outcome/query；private supervisor→worker envelope给 prompt两命令与 headless命令带 `callerPromptSettlement`，public wire不暴露；compatibility map更新
- [ ] 11.2 worker产生完整内部 outcome；直连 worker send path与 supervisor worker-frame fanout均逐原 public client过滤事件；supervisor/worker命令入口按原调用方门控查询与响应字段。prompt即时、prompt_and_wait completion、非 turn无 id；CLI不渲染
- [ ] 11.3 测试：new/new turn与非 turn；old/new形状时序/legacy idle/无事件；new/old缺能力；同一 resident worker同时 old+new attach互不串响应、查询、idle、事件；证明 compatibility map之外存在真实 send-path过滤；schema快照

Suggested fixture level: compact - wire 变化必须覆盖双向跨版本矩阵
Minimal mergeable slice: atomic - 协议三件套共用同一 capability，拆开会发布半个 capability

## 12. daemon 连接 promptAndSettle

- [ ] 12.1 daemon connection：普通 prompt按 capability/ACK回调 supported/id；promptAndSettle先订阅，以随机候选id发 prompt_and_wait。成功response有id等event、无id返回undefined；failure response先查缓存再get_prompt_outcome(candidate)，有outcome返回failed/cancelled，无outcome才透传非turn/admission error；缺能力/断线拒绝
- [ ] 12.2 测试：outcome早于response；turn terminal error/abort返回结构化outcome；session/extension非turn成功undefined、失败reject；断线/capability缺失reject

Suggested fixture level: compact - 客户端时序（事件先于 ACK）是真实竞态
Minimal mergeable slice: atomic - 单类单方法 + 测试，依赖组 10/11

## 13. RPC 模式与 RpcClient

- [ ] 13.1 `rpc-mode.ts`：`prompt` 通过 connection settlementAdmission 生成 additive `data: { promptSettlement: "supported", promptId? }`；unsupported 保持旧响应形状；outcome 原样转发
- [ ] 13.2 `rpc-client.ts`：旧方法 JSDoc；新 `promptAndSettle` 三路：supported+id 等 outcome，supported无 id返回 undefined，缺 marker明确拒绝；turn超时形状与旧方法一致
- [ ] 13.3 RPC 测试：retry 双 `agent_end`；supported非 turn不等 agent_end；old rpc-mode与新 rpc-mode+old daemon均明确拒绝；旧 prompt/promptAndWait忽略 additive data且不变；turn超时

Suggested fixture level: compact - 公开导出的 RpcClient 是 userspace，需回归旧方法
Minimal mergeable slice: atomic - 两文件同一契约，依赖组 2

## 14. print-mode 与 docs/json.md

- [ ] 14.1 Print逐条 optional promptAndSettle；completed/undefined才继续，failed/cancelled立即停止剩余messages并跳过gate；输出/退出码仍由terminal transcript逻辑决定
- [ ] 14.2 docs/json：turn-only outcome、忽略未知事件、closed-union风险
- [ ] 14.3 测试：多agent_end单outcome；failed/cancelled fail-fast且不进gate；普通turn顺序/JSON；`/goal status` command result与退出码不变、无伪ledger/event

Suggested fixture level: compact - 入口行为变化 + 退出码回归
Minimal mergeable slice: atomic - 单入口 + 文档，依赖组 10（in-process）/组 12（daemon 路径）；`waitForHeadlessCompletion` 仍为旧实现，行为只更保守

## 15. acp-mode

- [ ] 15.1 ACP用 optional outcome；completed/undefined才进gate；failed沿turnFailure抛错，cancelled返回cancelled，二者不进gate；仅定义outcome时附meta
- [ ] 15.2 测试：retry completed；failed JSON-RPC error/no gate；cancelled/no gate；compact/refine非 turncompletion、无meta、不误用旧失败；标准字段不变

Suggested fixture level: compact - 外部协议响应形状变化
Minimal mergeable slice: atomic - 单入口，依赖组 10/12；`waitForHeadlessCompletion` 仍为旧实现

## 16. headless-completion 改为 outcome 组合

- [ ] 16.1 自由函数删global idle；internal gate continuation用promptAndSettle且undefined fail closed。public命令/connection不变；supervisor按原public client在private envelope传callerPromptSettlement，直连worker按本地caller生成，handler仅false时legacy idle。前置14/15
- [ ] 16.2 测试：自由函数gate outcomes、后台不拖；supervisor与直连worker的capable跳过/old等待；同一resident worker old/new不串

Suggested fixture level: compact - 替换 waitForIdle 是行为变化，需 gate 循环真实路径
Minimal mergeable slice: atomic - 单函数改写，无签名/wire 改动，依赖组 2 与组 14/15（调用方已迁移），独立合并保绿

## 17. 收口验证

- [ ] 17.1 跨模式契约测试：同一 retry+compaction turn 场景下 Print/JSON/RPC/ACP 各只产生一个 `prompt_outcome`、允许多个 `agent_end`、RPC ACK 即时；in-process/daemon 对 turn 与非 turn 的 `PromptOutcome | undefined` 行为一致；Print slash 与 ACP `/compact` userspace 回归全绿
- [ ] 17.2 `docs/prompt-settlement.md` 状态行更新为"切片 1（Advisor/ask_user 无关部分）已实现"，并在文首列出 proposal Non-goals 指向主题 3/4 的遗留清单；`npm run check` 与 coding-agent 分片全绿

Suggested fixture level: compact - 跨全部模式的收口场景
Minimal mergeable slice: atomic - 纯测试与文档，依赖组 2-16（合并顺序：…→10→11→12→14/15→16）
