# Tasks: Prompt Settlement（切片 1）

## 1. PromptSettlementTracker 核心

- [x] 1.1 新建 `src/core/prompt-settlement.ts`：导出 D1 类型/API；每次 `acquire` 返回独立实例，同 promptId/kind允许并存并按实例计数；D2 cancel→failed→completed，lease 1→0同步终态，终态后 acquire抛错、其他变更no-op；`waitForOutcome`/`outcome` 对已终态记录（含 released）分别 resolve/返回同一对象，未知 id 分别 reject/返回 `undefined`；`settleAll(status, reason, options?: { released?: boolean })` 一律把 reason 写入记录 `settleReason`，并在 `options.released` 为 true 时把 released fence 与终态在同一次 persist 中写入；status 为 `failed` 时额外填 `outcome.failure.reason` 与记录 `failureReason`，为 `cancelled` 时不填 `outcome.failure`
- [x] 1.2 tracker 单测（Seam 1，假时钟/`emit`/`persist`）：完整 happy-path 字段（admit `sessionEpoch`，默认 `finalMessageIds=[]`/`traceGeneration=0`，recordFinalMessage 追加、bump 递增，`advisor:"disabled"`，无 `pendingQuestions`/`failure`，`admittedAt`/`settledAt` 取时钟）且 admission persist一次不emit、终态再persist/emit一次；同 promptId/kind 两个独立 run lease先放一个不终态；run→retry→compaction 先取后放无空窗与先放后取同步提前终态/acquire抛错反例；cancel优先于failure，failed run有 `failure.reason === failureReason` 且无 `settleReason`，cancelled无 `failure`/`failureReason`；终态后二次 mutation/lease release no-op；`settleAll("failed")` 有 `failure.reason === failureReason === settleReason`，`settleAll("cancelled", "session_disposed", {released:true})` 对每个eligible prompt仅追加一次终态persist/emit且无failure，重复no-op；unknown `waitForOutcome` reject/`outcome` undefined，`isSettling` 对unknown/active/terminal分别false/true/false，duplicate admit抛错；`snapshot`深复制；`restore`同id最后一条胜出、active可继续、terminal/released只读且`waitForOutcome`/`outcome`返回同一对象且不persist/emit；区分 `PromptLease.release()`、`tracker.release(promptId)`（仅已终态置released并persist一次，active/unknown与重复调用no-op）和 `settleAll(...,{released:true})`

Suggested fixture level: compact - 纯状态机，确定性单测即可穷举，但它承载后续全部组的正确性基线
Minimal mergeable slice: atomic - 新文件无调用方，合并即绿不改变任何行为

## 2. action promptId 与主 run lease

- [x] 2.1 turn action 在 accepted 后具有非空 `promptIds` 与逐 owner 独立 `runLeases`；公共 action 单 owner、internal inherit可多owner。create只准备候选或私有 `{inherit: owners}` lineage，不写tracker，并集中由实际primary message派生classification：heartbeat/RLM primary及显式staging exclusion无candidate/identity，prefix/next-turn不改变primary语义；restore snapshot仅以primary customType重派生marker作wire backstop。`ActionStore.assertCanEnqueue`与disposing、coalesce、action-id/候选-id检查全部在tracker admission前；fresh default同步`admit({sessionEpoch})`+`acquire("run")`再enqueue。inherit全部owners验证后逐一acquire，失败只逆序释放本action siblings。identity-bearing turn enqueue后隔离回调`{supported:true,promptId}`；成功session/extension/handled/background-excluded turn在legacy completion后回调`{supported:true}`无id，失败不虚报；tracker emit接session event，persist暂no-op
- [x] 2.2 preparing禁止重复acquire；`"all"` batching只把本批turn actions的`promptIds`去重写入owner snapshots。所有identity-bearing execution policy先等待现有main-run retry chain，再以最终stopReason error/aborted置failure/cancel fence；这里只延长组2 run lease，不新增组3 retry lease。pump failure先recordFailure；单一idempotent helper只消费已存leases并清空引用。default实际clear/mutate先requestCancel再release；inherit非-abort只release；terminal/busy inherit放弃。deferred rollback保持同id/run lease且无outcome；ordinary requestAbort不移除visible queued owner，实际clear才cancel。recovery不序列化live identity/lease并按primary重派生background；identity-bearing restore把历史`completionIncludesRetryChain:false`归一为true，excluded background保留历史timing。保证无0-lease accepted action、early terminal或永久settling；主动abort ownership清理与dispose released fence仍属组6；组2 finalMessageIds为空
- [x] 2.3 `promptAndSettle(...): Promise<PromptOutcome | undefined>`：以本次调用私有一次性admission callback捕获actual accepted turn id并复用既有completion时序；有id时无论旧completion resolve/reject都以tracker cached outcome为真值，无id的成功non-turn在现有completion后返回undefined，non-turn失败与admission拒绝仍按原错误reject。公共`prompt` options接受候选`promptId`与一次性`{supported:true,promptId?}` callback；候选只在turn accepted时占用，成功non-turn可复用；callback throw按observer隔离，不回滚accepted action；unfinished action/completion已占用的`agentMessageId`在新deferred前reject，禁止跨call coalesce串线。新增`getPromptOutcome`/`waitForPromptOutcome`与AgentSession-only `prompt_outcome` event；in-process main/watcher与daemon binding临时过滤该event，外部AgentConnection union/wire不扩；并发/重复候选id不得串调用；`PromptOutcome`沿单一类型来源公开给API消费者
- [x] 2.4 行为测试（Seam 2，faux provider）：单run对象identity/empty message ids；provider error、aborted、pump throw与stale signal；两个queued/`"all"` owners/tool gate/steer+followUp；non-turn truth table；clear/mutate与idempotency；真实inherit partial rollback/drop/release-only；preflight/coalesce/disposing/duplicate candidate/action/lifecycle/completion id；parallel/throwing callbacks；ordinary/background recovery primary+prefix；pending heartbeat非阻塞；direct subscribe与adapter过滤；prompt family timing。追加Round1/Phase6.2 closure：heartbeat/RLM primary经restore followUp/steer、sendCustomMessage streaming/triggerTurn、`_prompt` customMessage均无identity/outcome，普通custom仍有identity；成功excluded turn一次no-id callback、pump failure零callback、observer throw隔离；identity-bearing customTrigger retry enabled error→stop持run lease到最终一个completed，retry disabled一个failed；ordinary requestAbort保留visible B lease/no outcome、clear才cancel；真实deferred preparation rollback保持lease/no outcome、resume后一个completed；历史false-policy普通turn restore归一true并跨retry最终completed，retry disabled仍failed，background restore保留false且零outcome。retry lease/compaction、主动abort ownership、dispose fence、message ids、ledger与外部wire仍分后续组

Suggested fixture level: compact - 首次把 tracker 挂进 session，是所有模式依赖的基线路径
Minimal mergeable slice: atomic - 只覆盖主 run 一种 lease；retry/compaction 未挂线时它们不存在于测试路径，合并保绿

## 3. retry lease

- [x] 3.1 将同步 `agent_end` pre-arm 与 `_handleRetryableError` defensive fallback 两处 retry-window 建立收敛到同一 idempotent helper：仅在 `_retryPromise` 不存在时捕获当下 `_lastRunPromptIds` 去重 owner 快照，先对全部 identity-bearing owners逐个 `acquire("retry")`，成功后才发布 Promise/resolve/lease state；部分 acquire 失败逆序释放本次 siblings且不留下半开window。一个 retry chain（含多个 error `agent_end`）每owner恰一份retry lease。所有成功、耗尽、禁用、sleep cancel、overflow/compaction结束和 `abortRetry` 路径继续只经 `_resolveRetry`，由其先detach Promise/resolve/captured leases，再逐实例release恰一次并唤醒原waiters；重复resolve/abort为no-op。excluded/background或无action owner时允许零lease retry window。不得读取后续可能变化的owner snapshot，不改retry event/attempt/backoff/AgentMessageOutcome语义
- [x] 3.2 faux-provider与focused lifecycle测试必须直接证明retry lease存在，而非只凭group-2 run lease遮蔽：单owner error→success在首个/第二个 `agent_end` 之间恰有一次`acquire(id,"retry")`、无outcome，最终release一次且一个completed；`"all"` A/B共享run时两owner各恰一retry lease、期间均无outcome、最终各completed一次；连续多个retryable errors仍不重复acquire；max retry耗尽release后各自failed/run_error；defensive fallback走同一owner/acquire逻辑；abortRetry/sleep-cancel与重复resolve释放captured leases恰一次、无retry lease残留。保留现有retry/auth/overflow-compaction/accepted-agent-message事件、attempt、backoff与queue时序测试

Suggested fixture level: expanded - 上游建议compact；retry与shared-state transition属于mandatory expanded trigger，且两处建立/多处结束共享mutable lifecycle
Repair intensity: high - 任一owner漏acquire、重复acquire或resolve漏release会造成提前终态或永久settling，并污染后续compaction/abort/persistence切片
Minimal mergeable slice: atomic - 单一retry-window helper、唯一release funnel与配套faux-provider oracle，独立合并保绿

## 4. post-compaction continuation lease 与 traceGeneration

- [x] 4.1 `_runAutoCompaction`进入异步边界前捕获当次去重run owners；successful threshold/requested逐owner `bumpTraceGeneration`一次（含已安装batch owners且由action run lease覆盖的pre-turn成功）；failed/skipped/cancelled、manual、overflow及真正无identity owner的background/private compaction不bump。generation与continuation解耦：只有`willRetry`、`shouldContinueAfterCompaction`或requested失败后同一run必须resume才建立/扩展runtime-only settlement window `{owners[i] ↔ leases[i], obligation/message snapshot, revision, scheduled|running|parked}`；既有scheduler flag/timer可为agent-level queued work、session action或#30前background continuation ownerless运行，但不创建/扩展settlement window。create/extend在旧ownership释放前all-or-nothing acquire missing owners；失败逆序release本次siblings、不改变旧window、不运行无lease obligation，并对本次无法覆盖的active owners fail closed为`run_error`。busy/pump/`already processing`只rearm原scheduler obligation；ownerless generic wake保留既有agent-queue `continue()`或session pump分流，但绝不回读 `_lastRunPromptIds` 或改变settlement window。direct-runner在install captured owners→clear stale terminal→`agent.continue()`→wait group3 retry/event queue→terminal fence→restore→detach-close/rearm全段持queued-work pause；随后release pause，以其现有pump schedule作为权威post-fence wake（或release后显式schedule），再触发post-close auto-refine，禁止吞掉期间`_resolveRetry`/close的唯一唤醒。pump分支不得持pause，先记录window identity/revision与tracked message snapshot，await当前pump/action/event completion，再按message是否消费和revision是否变化close或rearm。任一路径revision变化均表示新真实obligation，旧完成不得close。manual compact先park timer/window（含`skipAbort:true`），成功resume同一tuple；普通失败/取消cancel owners后close，`skipAbort:true`失败/skipped resume。单一detach-first close exact-once release：非abort无work/branch invalidation只release；`abortRetry()`先对overflow continuation owners `recordFailure("run_error")`再close；`requestAbort`/update-restart以及#29过渡期dispose只对window owners先`requestCancel`再close，#31再把session-wide `settleAll(...,{released:true})`移到dispose close之前并补齐current/inherited owners。successful overflow的initial error为provisional，willRetry建窗后不写failure，recovery最终terminal才定状态。组7仅复用owners做message attribution
- [x] 4.2 direct lease/generation + faux-provider测试不得只看timer flag：threshold/requested single与`"all"` owners在旧lease释放前各exact acquire、最终continuation后exact release/completed，generation +1；successful compaction无post-work仍bump且零window/timer；owned pre-turn success只bump即将执行batch且不额外建窗，无compaction、ownerless pre-turn/background、failed/skipped/cancelled/manual/overflow均不bump。A timer被B普通run重排仍只归A，unrelated queued B/generic wake不扩owner；B自己的真实obligation原子扩展missing owners。busy/pump/`already processing`只rearm；continuation provider retry取captured-owner retry leases，continuation再compaction保留window且generation到2；queued B在terminal fence前provider calls=0，pause release后恰启动/完成一次且不覆盖owner/stopReason，证明post-fence wake未丢。overflow recovery success与terminal-error两支均预排独立B：A分别completed/no provisional failure或`failed/run_error`，overflow不bump；A fence/close前B provider calls=0，pause release后恰1且B按自身identity完成。manual success和`skipAbort:true` failure复用同一lease，普通manual failure、requestAbort、update-restart及dispose过渡路径cancel+release once；branch/no-work等非abort取消release-only completed。create/extend第二owner acquire失败时本次siblings回滚、零unowned continue、affected owners fail closed且旧window不变。保留既有100ms、queue/auto-refine/manual/compaction/retry/auth/action-race事件与行为；#31另测完整可见队列/inherited action/dispose released fence

Suggested fixture level: expanded - 上游建议compact；timer ownership、cancellation、retry handoff与shared-state transition属于mandatory expanded triggers
Repair intensity: high - continuation跨action/timer/run且可rearm、扩展owner或再次retry/compaction，任一空窗/串owner会不可逆提前终态或永久settling
Minimal mergeable slice: atomic - 一个continuation-window状态机、generation挂点与direct faux-provider oracle，独立合并保绿

## 5. autonomous threshold continuation 继承 lineage

- [x] 5.1 `_queueAutonomousContinuationForThresholdCompaction` 在进入 autonomous decision 的异步边界前捕获触发共享 run 的全部去重 prompt owners；非空时创建 action传`lineage: { inherit: ownerSnapshot }`且不再标`noSettlementIdentity`，同一 message 仍只入队/执行一个 action。真正零 owner 的 background/private调用保持既有 settlement exclusion。`_clearQueuedAutonomousContinuations` 取消 inherited action 时复用组2.2分支，对全部owners只release、不`requestCancel`。inherit admission拒绝/partial acquire失败时只回滚本次producer bookkeeping并恢复autonomous snapshot；tracked pump ownership只在action成功enqueue后发布
- [x] 5.2 行为测试：production threshold路径单owner action.promptIds等于原id且持独立run lease；`"all"`共享run继承全部ids但只创建/执行一次；每个outcome均单次且在inherited action与compaction continuation完成后产生；skipped/clear只释放inherited leases且owner自然completed；零owner路径仍无identity/outcome；用户`/goal`产生的goal context仍走default lineage获得新promptId；第二owner acquire失败与decision期间owner终态均零孤儿obligation/pump-owner/cancel fence

Suggested fixture level: expanded - 上游建议none；该options接线把background action切换为counted multi-owner lease producer，涉及shared-state ordering与cancellation，命中mandatory expanded trigger
Repair intensity: high - owner漏取/串取、重复action或clear误cancel会造成提前终态、永久settling或错误cancelled
Minimal mergeable slice: atomic - 单producer接线与行为oracle，依赖组2/4，独立合并保绿

Required evidence:
- single production threshold -> queued autonomous action exact `[A]` + one inherited run lease；first terminal后无outcome，continuation terminal后A恰一个completed
- `"all"` production threshold -> exactly one autonomous action with dedup `[A,B]`、每owner一份inherited run lease、provider continuation一次、A/B各一个completed
- same assistant重复queue / internal rearm -> 不新增action或lease，不重复执行
- skipped/clear before delivery -> inherited leases exact release、`requestCancel`零调用、remaining parent/window work自然settle
- second-owner acquire失败或decision期间owner终态 -> producer返回无obligation，child siblings rollback once、autonomous usage/maps/message/pending/pump-owner全回滚，prior window/messages与parent leases不变
- ownerless background/private threshold -> legacy action/timer行为保留，零prompt identity/lease/outcome
- `/goal` goal-context producer -> default lineage的新promptId，不继承触发它的旧owner
- focused settlement/compaction/autonomous/goal suites、root check/build、strict OpenSpec均exit 0

Risk packs:
- Public API / CLI / script entry: not selected - 无签名或公共入口变化；`/goal`仅做不变回归
- Config / project setup: not selected - autonomous/compaction/goal配置不变
- File IO / path safety / overwrite: not selected - 无文件读写
- Schema / columns / units / field names: not selected - runtime-only action字段已由组2定义，不改recovery/wire shape
- Auth / permissions / secrets: not selected - 无权限或secret边界
- Concurrency / shared state / ordering: selected - async前owner snapshot、multi-owner lease acquire、parent/window/action release顺序
- Resource limits / large input / discovery: not selected - owner集合按当前run去重有界；重复message不得新增action
- Legacy compatibility / examples: selected - ownerless scheduler、autonomous limits/gates、goal context新identity与100ms行为不变
- Error handling / rollback / partial outputs: selected - inherit admission失败/terminal owner由组2 all-or-nothing处理；clear只释放不cancel
- Release / packaging / dependency compatibility: not selected - 无dependency/export/build shape变化
- Documentation / migration notes: not selected - shared运行时状态文档由组17更新
- TUI focus/render lifecycle: not selected - 不触碰TUI
- Session/extension teardown lifecycle: selected - queued inherited action清理必须与#31主动abort边界分离

## 6. cancel 路径：abort、admission 后未执行、dispose

- [x] 6.1 建立共享current-owner abort cleanup：入口复制`_currentRunOwners`；按internal autonomous message + nonempty inherit lineage + accepted owner交集识别child（不看`queueVisible`），整项删除action与message/snapshot-map/pending/pump bookkeeping并消费全部child leases；随后cancel/close continuation与matching retry，对captured current owners `requestCancel`，current action terminal/finally消费自身lease。`requestAbort`与`abortForUpdateRestart`复用，后者仍保留visible queue/recovery snapshot；clear/mutate/abortAndClearQueue仍只cancel实际移除的default actions。增加session-private one-shot dispose seal：direct `dispose()`在`_disposed=true`后立即seal；`disposeAsync()`保留graceful pre-drain，但在`_disposing=true`后、commit-fence abort controller与child/kernel/resource cleanup前seal；seal只调用一次`settleAll("cancelled","session_disposed",{released:true})`。后续window/retry/action leases仍detach/release exact-once，对terminal/released tracker record为no-op
- [x] 6.2 行为测试：production ordinary abort与`"all"` multi-owner child当前owners cancelled、prior failure仍cancel优先、child/window lease及bookkeeping exact cleanup，真正visible B保留同id/lease并resume completed；update restart同cleanup且B/waiter/recovery snapshot保留；clear/mutate/abortAndClearQueue实际移除才cancel B；direct/async dispose的1 running + 2 queued各一次cancelled/no-failure/released+settleReason，seal先于任一cleanup release/controller abort，同步reentry与重复调用no-op

Suggested fixture level: compact（overridden）- cancellation、shared-state transition与session teardown是mandatory expanded triggers
Fixture level: expanded
Repair intensity: high - owner/lease或dispose seal顺序错误会导致误cancel、提前终态、orphan inherit或未released terminal record
Minimal mergeable slice: atomic - agent-session abort/dispose共享取消语义 + focused tests，依赖组2/4/5，独立合并保绿

Required evidence:
- production threshold child + current A + visible B -> ordinary abort removes exact child/bookkeeping, releases child/window once, A cancelled once; B same identity/lease remains settling then resumes completed
- `"all"` A/B child + unrelated C -> one child removed as a unit, A/B each cancelled once, C untouched; repeated abort has no extra release/event
- update restart -> current descendants cancelled while visible queue, delivery waiter and recovery snapshot survive suspended pump
- clear/mutate/abortAndClearQueue -> only actually removed default action becomes cancelled
- direct `dispose()` and `disposeAsync()` with running/queued/window-or-retry ownership -> one seal precedes controller abort/first cleanup release; each prompt one `cancelled + released + session_disposed` terminal record/event, no failure; reentrant/repeated disposal no-op
- focused settlement/queue/action-race/update-restart/compaction-retry suites, root check/build and strict OpenSpec exit 0

Risk packs:
- Public API / CLI / script entry: not selected - signatures and wire unchanged
- Config / project setup: not selected - no config changes
- File IO / path safety / overwrite: not selected - ledger persist remains no-op until group8
- Schema / columns / units / field names: selected - dispose terminal record conditional fields are asserted
- Auth / permissions / secrets: not selected - no auth boundary
- Concurrency / shared state / ordering: selected - captured owners, leases, synchronous callbacks and cleanup order
- Resource limits / large input / discovery: not selected - bounded runtime-owned collections only
- Legacy compatibility / examples: selected - visible queue, restart, manual/retry/goal and ownerless behavior preserved
- Error handling / rollback / partial outputs: selected - orphan bookkeeping, partial/repeated/reentrant cleanup and cancel-over-failure
- Release / packaging / dependency compatibility: not selected - no exports/dependencies
- Documentation / migration notes: not selected - group17 owns final docs
- TUI focus/render lifecycle: not selected - no TUI change
- Session/extension teardown lifecycle: selected - direct/async dispose and abort families are the change surface

## 7. finalMessageIds 记录

- [ ] 7.1 消费组2已建立的 `_currentRunOwners: string[]` owner snapshot：普通 dispatch 延续本次所有 turn action 的去重 promptIds、dispatch completion settle 时清空（retry 续跑期间不清空）；`_runScheduledPostCompactionContinue` 调用 `agent.continue()` 前设为调度时捕获的 continuation owners、返回/抛出后清空；主 agent `message_end` 写入 assistant entry 处对每个 current owner `recordFinalMessage(owner, entryId)`；run 之外 owners 为空，不记录
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
