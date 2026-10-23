# Typed Remote 与 Client 边界

[English](client-and-remote.md) | 中文

## Typed Remote
Remote methods 通过 Team service 的 `@Remote` annotations 声明。`scripts/generate-typert.mjs` 使用 Harness `WorkspaceAnalyzer` 和 `FaceModelEmitter`，在 `packages/agent-team/lib/` 下生成 Host 和 Client artifacts。

稳定流程如下：

```text
Host face declaration
        │ generate:typert
        ▼
Typert Host artifact + Remote client artifact
        │ ctx.remote.$mount(...)
        ▼
Client remote service
```

`InvocationDescriptor` 是 local reflection metadata，不是 wire message。Wire request 和 response fields 保持为显式 typed values。修改 Remote 时更新 declaration 和 tests。重新生成，然后运行 typecheck/build。不要手工编辑 artifact。

读取请求各自声明用途，不共用一种投影形状。只有当调用方要整个请求 scope 的 Task/Thread/Claim catalog（模型侧 `team_view` 渲染的 address book）时才传 `includeCatalog`。Client 的读取从不传它，只渲染自己请求的那一页。

## Remote failure vocabulary
生成的 Remote methods resolve 为 `RemoteResult`。`{ ok: true, value }` 携带业务结果，`{ ok: false, error }` 携带失败：稳定的 `code` 是判别字段，`details` 随 `code` 收窄，无需 cast。

- 业务拒绝（`unread_required`、`stale_revision`、`confirmation_required`）保持 result union。它们是 Client 已经建模的正常控制流，不是 Remote error。
- 需要 Client 独立分支的预期跨 Remote 失败以 `RemoteError` 抛出。owner 通过向 `RemoteErrorDetailsMap` merge 声明自己的 code。Team 把 codes merge 进两个 face 共同编译的公开 types 入口。Team 的第一个 code 是 `team/attachment-not-found`。attachment read 把已消失的 cache entry 与其他一切失败分开。
- Client 按 `code` 分支，绝不解析 message 文本。message 只是人类诊断，不是契约。未知 code 与未分类的 Host 异常以 `gateway/internal` 到达，因此每个分支都保留通用 fallback。attachment preview 把 not-found 结算为过期 chip。其它失败一律不缓存，下一次渲染重试 Host。

## Client plugin 和 slot composition
Team browser plugin 是 external Client plugin。Shipped Shell 继续拥有 outer layout。Team 增加一个 additive footer entry、自己不拥有 panel，并动态 shadow 三个 seats：

```text
sidebar.footer.action       additive Team entry, order 100
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
sidebar.settings            Team shadow, priority -100
```

Browser activation 顺序是：

```text
Client plugin apply
  → ctx.remote.$mount(agentTeamRemote)
  → ctx.inject(['remote.agentTeam'], ...)
  → register Team entry and mode shadows
```

`dsh.client.inject` 描述 client module graph；它不保证 apply order、service readiness 或 slot declaration order。如果 declaration 可能稍后出现，使用 `ctx.slots.inject()`。registration 跟随 declaration lifetime，并随 owning fiber disposal。

Team mode 拥有 conversation seat，而不是一个 panel：`TeamNavigation.mode` 是 mode 是否成立的唯一判据，它的 seat 是 key 为 `conversation` 的 `main` shadow —— 该 shadow 在 mode 成立且没有嵌入 Channel Session 视图时绘制。侧边栏底部、shipped 设置行旁边的入口先清空占据中栏的 global panel，再翻转 mode；保持这个 selection 为空也是 Shell 右侧栏可用的前提，因为只要有任何 panel 被选中，Shell 就不画右栏里的 Session 内容。因此另一个 panel 拿走中栏即结束 mode。

selection 为 null 时 Team 不介入：嵌入的 Channel Session 视图会清空 panel 来独占中栏，mode 必须活过这一段。恢复的 mode 通过自己的 seat 绘制，不选中任何东西；挂载时已有 panel 被选中时，那个 panel 保留中栏，mode 主动让位。

Slot parent 的 `children` declaration 同时是 render site 和 render authority。两个存活的 parent entries 不能声明同一个 child slot。特别是 Team 的 `sidebar.workspaces` shadow 不得重新声明 shipped `sidebar.workspaces.directoryFlow`。即使 Team entry priority 更高，Harness SlotCore 也会拒绝这个 duplicate。不要复制 private WorkspaceBrowser、ConversationRoot、Shell 或 private CSS 来规避它。

Team feature 需要现有 Harness capability 时，使用 public service 或 package export。对于 directory selection，先检查 `ctx.workspaces.pickDirectory()` 和 `host.pickDirectory` path，再考虑 Team-specific picker。如果 public contract 无法表达目标 composition，就记录这个 limitation。选择 Team-owned plugin 或新设计。不要静默依赖 private implementation details。

## Client data 和 presentation boundary
`packages/client-agent-team/src/client/` 下的 components 不接触 `ctx`、operation ledger 或 Host classes。Data 与 callbacks 通过 Client slot contract 进入，包括 owner props、runtime props、declared store 或 inject face。Presentation layer 只消费 Host projections 和本地 navigation state。它不自行发明 durable facts。

UI work 的边界如下：

- Channel composer 默认创建 taskless Thread。它提供默认关闭的「作为任务」控件，以原子创建 Task。 taskless Thread 保留 normal read/reply/inbox behavior。promotion 之前隐藏 Task status、Claims 和 Task-resolution controls。 Promotion 是 durable、non-optimistic 的 Host mutation。成功后 Client 重新读取 Thread 和 supplemental projections。它不在本地合成 Task。

  Human Client 消费 Host 的 Inbox 投影，但绝不维护并行 Inbox authority。投影有两片。第一片是「收件箱 / Inbox」队列：合并各 Workspace 的徽标与页，覆盖读者的整片未读。mention 只在其中计数，绝不是准入条件。第二片是该读者写过 Message 的「最近活跃」段。回复过的 Thread 无论是否 follow 都算他的。按最新活跃降序，Host 侧每个 Workspace 上限 10，合并到页面上最多 5 条。第二片永不进入 agent 的 Inbox。打开页不确认任何内容。

  Thread reads 使用 Host projections（`readThread`、`threadHistory`）和 Host mutations（replies、promotion、Task actions、Human-only `removeThreadMember`）。当前 Thread UI 不提供 follow/unfollow Attention controls；composer 与成员管理器通过 `threadObservations` 读取 Host 成员快照（followers、带 following 状态的 `threadMembers`、`removedMemberIds`），但不渲染 observation 历史。候选选择只写草稿；成功发送或成员移除后，Client 重读 Host projection，不乐观改成员状态。Browser 会持久化四样东西：Team navigation mode、Workspace selection、最近选中的 Channel 或 Thread，以及 Inbox 页位置。回到 Team 时恢复位置。unread 与 Attention 不持久化。

  Agent Inbox 仍由 Host 持有，并通过 `team_inbox` 提供。
- Sidebar row order（Channels/Agents）是每个 browser 的 Human presentation preference，保存在 `localStorage`。加载时折叠到 Remote default order 上。保留的 refs 保持顺序，移除的 refs 丢弃，新的 refs 追加。它从不成为 ledger fact。Whole-row native drag 复用 Harness list interaction model。它是 Team-owned rows 唯一的重排控件。
- 嵌入的 Channel Session 使用未修改的 shipped composer。Team 不注册任何 Channel Session 的 composer 表面。它不接管 seat，没有 trigger sources，没有 dock 提示条。rc.1 把 trigger-menu overlay 移进了 `conversation.composer.bar` 的 children。接管者会一并继承渲染义务，并使 overlay 悬空。Team 自有的命令/成员引用入口相对 shipped 词汇表不再有不可替代的价值，因此一并移除。普通会话与 Channel Session 共享同一 composer 与词汇表。
- 有对应能力时复用 public Harness primitives 和 `--dsw-*` theme tokens。
- CSS 保持在 CSS Modules 中；不要 import private Harness CSS。
- Runtime presence 必须与 Claim 和 Task state 分离。
- Task resolution controls 会修改 Task 和 Claim。Closed Task 对 replies 和 new Attention 是 terminal。reopen 会恢复 open Task，但不会恢复此前的 Attention。
- Message、Activity、Claim 和 Task 的 presentation 要保持区分且用户可读。不要暴露 opaque refs 或 internal enums。
- Durable mutations 不做 optimistic update。失败时保留 input，并渲染下一份 Host projection。
- 保持 Team mode enter/leave、refresh recovery、slot restoration 和 narrow layout behavior。
## 在右侧栏打开缓存附件
非图片附件块把它的缓存副本开到 Shell 右侧栏。读取走 `getAttachment` 打 Host 缓存；地址是 Session 作用域的 `dsh-resource://file/…`，由右侧栏的兜底文本类型认领，再按扩展名分发。

`ctx.sidebarRight.openResource` 返回 `void`、不上报任何东西：对一个已在屏、但从未被 adopt 的 Session，它既不记录标签页也不抛错，于是「右侧栏收下了地址」与「什么都没发生」在调用点无法区分。

附件块因此在开完之后读右侧栏自己的 `openTabs` 记录，找那个地址对应的标签页。判定依据是这个记录，绝不是标签页总数：右侧栏对已存在的标签页是**聚焦**而非新增，所以对同一附件再点一次时总数不变，但打开是照常发生的。

三种结果保持分开，因为只有第一种是这次调用真正确立的事实：

- **记录里存在目标标签页** —— 已打开。
- **注册的类型拒绝该地址，或无人认领** —— `unsupported`，陈述为没有可用的查看器。
- **既没抛错、也没有对应标签页** —— `unknown`。`open` 什么也不回答，所以这次调用说不出原因，只能说自己没能确认打开。

**`unknown` 这一支只有单测覆盖，没有真实界面读数**，因为在真实界面上要走到那个状态，得伪造 Host 的选择状态。不要把它读成真机已验。

三层事实保持分开，文案也保持分开：

- **没有注册的类型认领这个地址** —— `openResource` 抛错，块上陈述「这个格式没有可用的查看器」。
- **查看器认领了地址但解不开字节** —— 查看器在自己的面板里陈述，Team 完全看不到。二进制非 UTF-8 文件落在这里，因为 Host 对未知扩展名退回纯文本读取，而不是拒收。
- **缓存条目已不存在** —— `team/attachment-not-found`，渲染成「附件副本已被清理，请让发送方重发」。

Host 查看器说「该格式文件暂时无法预览」，而块上说「这个格式没有可用的查看器」。两种说法**有意不统一**：查看器知道它认领了却没解开，Team 只知道没人认领。统一措辞会让其中一方断言它并不知道的事。

右侧栏头部显示查看器给出的绝对缓存路径，其中含 Host 用户名。Team 不做遮蔽——那是查看器自己的呈现——而把含该路径的截图对外分享，会泄露用户名与本地目录结构。


UI redesign 已完成。需要理解当时的取舍时，查 [`.scratch/archive/2026-08/ui-redesign/`](../../.scratch/archive/2026-08/ui-redesign/)。它是历史设计背景，不是当前实现权威。UI 改动的当前验收规则见 [`development/README.zh.md`](../development/README.zh.md)。
