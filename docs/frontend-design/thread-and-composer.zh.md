# 时间线、composer 与入口行

[English](thread-and-composer.md) | 中文

## 时间线滚动（timeline-scroll）
- 策略：读者停留在底部（距底 <48px 视为 pinned）时跟随新内容；不在底部时不打扰。
- 确认合同：Thread 打开期间到达的事实一律自动做持久 `readThread` 确认。pinned 读者当场看见，滚离底部的读者由纯跳转提示引导回底。确认失败时回退为既有 error surface。不存在任何手动读取动作。
- 打开即清零：打开 Thread 直接滚动到最后一条。有界批次若返回剩余未读，Client 以串行循环自动续读（每轮 mint 新 requestId 复用 Host 幂等缓存语义）。连续 50 轮未清零视为异常并显示错误提示。
- 前插更早历史时按 scrollHeight 差值补偿 scrollTop，视口内容不跳动。
- 更旧 facts 由时间线自己的「加载更早消息」入口翻页，首绘的历史读取决定它是否出现。读取被拒或抛错时该入口保持存在，从屏上最旧的 fact 往回翻，并由它自己的 error surface 报告失败，而不是让更旧的 facts 永远卡在一个不会出现的控件后面。
- 跳转：`scrollToBottom` 立即滚到底部；「↓ N 条新更新」提示按钮只滚到底、无读取语义，读者回到底部即消失。
- contentKey 必须随渲染事实变化（当前用 `长度:末位factKey` 组合串）。

## Composer 与 @mention
- textarea 自增高（上限 336px），Channel / Thread composer 出现时自动聚焦且不滚动时间线。Enter 发送、Shift+Enter 换行。IME composition 期间 Enter 不触发发送。发送期间输入框保持聚焦但只读，避免重复提交。发送按钮点击不抢走焦点，发送完成后可直接继续输入。未关注 Member 的首次发送返回确认提醒时，保留草稿与收件人。输入框自动恢复焦点，第二次 Enter 可直接确认发送。composer 卡片沿用 DSH 默认静态表面描边（`border: 0` + l2 elevation 发丝线 + `--dsw-elevation-soft`）。`focus-within` 不改它的颜色。
- mention 弹层向上展开，`role="listbox"`。textarea 以 `aria-controls/aria-activedescendant/aria-expanded` 关联弹层。↑↓ 循环、Tab/Enter 接受候选、Escape 关闭。外点关闭复用 `useDismissOnOutsidePointer`。高度钳制复用 `useAnchoredMaxHeight`（cap 320px）。高亮行始终通过 `scrollIntoView`（`block: 'nearest'`）保持在弹层可视区内。Thread 面通过 Human-only 的 `threadObservations` 读取 Host 成员快照（首屏并行读取，加每次 thread 域 wake）：当前关注者、带 follow 状态的 Thread Member，以及已移除成员 tombstone。
- 候选集是整个 Workspace 的参与者，并按可达程度排序：本 Thread 的关注者 → 本 Thread 其他成员与 Channel 参与者 → Workspace 其余。所有档位都可选，排序不是筛选；`@all` 仍只展开为 Channel 成员。接受候选后光标落点精确到插入文本之后；删除提及文本会同步收缩 recipients。
- `data-mention-inside` 表示写入范围内的参与关系：Thread 上，当前关注者和其他当前 Thread Member 都算在内；Channel 上，Channel participant 算在内。为 false 时名字降到 secondary label 档，行本身的对比度不变。它是范围提示，不承诺点名一定送达。
- Thread 草稿另有一条 Host 可达性警告。快照不可用时明确显示状态未知；快照可用时分别说明从未加入（直接 @ 不会送达，Human 确认并成功发送才会邀请）、已移除（直接 @ 不会送达，Human 确认并成功发送才会重新邀请）、已取消关注（@ 仍可达，确认后恢复普通提醒）。点选候选只修改草稿，不改变成员关系。Channel 顶层发送无需邀请确认，收件人都会加入新建的 Thread。
- 后续快照读取失败会使先前快照也失效；警告改为状态暂不可用并保留草稿。Host 提交回执含 `undeliveredMentions` 时，状态行列出未送达对象，乐观 mention 标记也会排除他们。
- 颜色承载行的范围区分，因此必须扛住宽度变化：窄于 600px 时身边的 description 被丢弃，区分仍留下。
- 表面语言：mention 弹层画的是共享的半透明菜单 token。按 shipped 毛玻璃配方补 `--dsw-menu-backdrop-filter` 与 elevation 描边/阴影，而不是当实底用。0.1.7 把这个 token 改成半透明却没改名。实底弹层会真实地读不清，而存在性检查全绿。配方本身见「设计语言对齐」表。
- 模式 chip（「作为任务」）：任何宽度都保留可见文字标签。窄于 560px 时改为缩工具组间距（`@container (max-width: 560px)`），而不是藏字。`aria-label`、`title`、`aria-pressed` 照旧承载模式语义。
- Channel Session 输入面即 shipped composer 本身，不做任何修改。Team 不注册任何 Channel Session 的 composer 表面：无接管、无 trigger sources、无 dock 提示条。键盘合同、命令与引用菜单、附件与普通会话完全一致。
- 收件人提示行：通知集合非空时在草稿与工具栏之间渲染 quiet 提示行（`.notifyRow`，`{ids}` 句柄列表）。发送前即可看到"将通知谁"。集合是菜单选中的 recipients 与正文手打 `@Handle` 的并集。`mentionedMemberIds` 从草稿派生，与 Host 同一套大小写不敏感、Unicode 词边界的规则。`@all` 按菜单的展开口径列出全部可投递 Member。空集合不占位。派生集合只用于显示，不进发送 payload。Channel 之外的名字在正文里只是散文，作为显式 recipients 会被拒绝。
- 提示行的措辞按表面分开：Thread 面用 `composerMentionTargets`「提及对象：{ids}」，因为未确认的 `@` 可能仍需 Human 确认、也可能当下送不到；Channel 面保留 `composerNotify`「将通知：{ids}」，因为那条发送会让每个收件人加入它新建的 Thread。措辞由表面决定，不由行的身份决定。
- 读者自己的 handle 是唯一一个必须「不读也能找到」的 mention chip，所以它是唯一离开 business 族的 chip。`[data-mention-human]` 用 success 档着色（error 与 warn 两族分别意味着失败与警示）。正文里写的是读者改名前的 handle 时，该 chip 同样被标记 —— 标记跟着身份走，不跟着拼写走。
- 草稿缓存：draft/recipients 不在页面局部。它们按 `channel:<channelRef>` / `thread:<threadRef>` 键存放。每 Client 上下文存一份 `TeamDraftStore`（`drafts.ts`）。它用单一 localStorage 键 `dsh.agent-team.drafts.v1`，写穿持久化，按 savedAt 淘汰最旧 ~50 条。切换视图或刷新后草稿与收件人原样恢复。发送提交成功即清除对应键，失败保留。Composer 挂载收敛会剔除不再匹配文本/已失效的收件人。Channel 的「作为任务」意图不进入草稿缓存：默认关闭，成功提交后再次复位关闭。
- taskless Thread 的「转为任务」是 Human-only durable mutation，不做乐观 overlay。成功后重新读取 Thread 与补充 Channel/Member 投影；unread/stale fence 时保留 Host 返回错误并重新读取相关事实。

选中要回答的 Message 会把目标说两遍，而且两处都必须看得见：Message 本身加一圈描边，composer 里出现一条引用条，写明父消息并引用它的第一行，旁边紧跟取消。描边用 ring 而不是填充，理由与「有人@我」的标记相同 —— 气泡的材质不能随状态改变。引用条落在 composer 卡片内部、输入框上方，因此目标与草稿被读成一个动作；取消会同时清掉引用条与描边。

发送时带上父消息的 ref，Host 因此记录这条引用并向父消息作者送达；发送成功会清掉目标，切换 Thread 同样会清掉，所以过期的引用永远不会跟着下一次 Enter 一起出去。

Human 待办只在回复提交后绑定，并且只消费一次回答目标。发送失败时保留仍有效的目标供重试；完整的 Host 清单确认目标已结案或不存在时，立即使目标失效，包括回复发送期间。消息提交后如果绑定失败，composer 用中性状态保留真实原因并说明消息已发送，不把消息标成发送失败，也不在下一条普通消息上重试绑定。

## Thread / Task 入口行（channel 时间线内）
- 语义：每个 top-level Channel 消息进入其 Thread 的唯一入口，形态是正文下方**一行**安静的行——既陈述状态，也负责开门。点击走 `selectThread`，不把 Task 作为独立导航层。`Task #N` 是 home Channel 内 durable Task creation 的展示编号，不是稳定身份。跨视图导航使用 branded Task ref。
- 方位（本条的硬约束）：入口的任何状态都**不放在身份行上**。一个 run 里的后续消息没有自己的身份行内容，状态簇停在那里只会孤零零地悬在行尾；而任何靠右的落点都要读者为真正想看的价值横穿整列。状态改为**领起入口行**：与上方正文同一个左缘，且整条 feed 的所有入口共用一个 x。shipped DSH 的行也是这么做的（`SkillRow` 折叠态的首位槽、`JobListAction` 触发钮「点在前、计数在后」）。
- 状态簇（`.stateCluster`）：taskful 入口依次是三样东西。第一，Task 在办 Claim 的所有者头像叠放。第二，`taskStatusDot(status)` 对应的 8px `TeamStateDot`。第三，本地化状态词。`in_progress`→ongoing、`in_review`→warning、`done`→done 走共享 `StateDot`。`todo` 是空心圆环、`closed` 是 tertiary 安静点。五个状态共用同一套形态语言。Claim 是 Host 事实而非装饰。只有 `in_progress`/`in_review` 的 Task 才有所有者。`released` 的 Claim 已不是工作，所有者按 Claim 顺序去重。done/closed 的 Task 不留叠放：那段历史状态词已经说完了。taskless 入口不虚构状态点。
- `TeamAvatarStack` 是 18px 交叠圆圈，用共享成员色相，最多 3 枚 + `+N` 一枚。相邻两面靠 2px 环分开，环把自己从叠放所在的表面上切出来。取值与两层画法见下文「收件箱」入口段。Inbox 页行与 Channel feed 入口行都落在页面底色上。圆圈本身是装饰，所以整个叠放是一个 `role="img"`，标签写出完整名单（`claimers`）。
- 入口行的其余部分：12px/18px tertiary、`fit-content`、自身无底色无边框。hover 与 `:focus-visible` 只做两件事：文字提亮到 primary，chevron 前推 2px（120ms，reduced-motion 下关闭）。焦点环 2px 主题色。 状态之后接「这条入口是什么」。taskful 是 `Task #N`。taskless 在有后续动态时是本地化 Thread label，入口消息仍是最新事实时是 `replyAction`（回复）。 有后续动态时追加 `· 最近活动 <HH:mm>`，与 Inbox 行共用同一个近度标签。今天就是裸时刻。「不是今天的第一天」才带日子词（`昨天 HH:mm`）。判据是 Host 的 `lastActivityAt` 不同于入口消息自己的 `occurredAt`，即「这条消息之后事情又动过」。精确本地时刻挂控件的 `title`。 **只有还没走完的工作才印这个时间**：`done` / `closed` 的 Task 只印 `Task #N`。旁边的状态词已经说明没有在动。这个时刻印出来，只是把它的了结时刻在每一行重复一遍。精确时刻仍留在控件的 `title` 上，一次悬停即可看到。

  taskless 的 Thread 没有终态，所以讨论照旧印出近度：它没有状态词、没有状态点、没有所有者叠放，近度就是它全部的状态行。 **消息计数已退场**：这里读者真正要行动的量是未读，不是正文有多少。 390 窄列下入口行整体换行（`flex-wrap`）：门文案落到状态下一行，而不是把行撑出阅读列。
- 未读胶囊：计数「这条 Thread 上有多少需要**我**」的动态，也是 taskless 讨论唯一能携带的簇成员。数据来自 Channel 本次 refresh 本就要发的 Workspace Inbox 整片未读。Host 的三类合并判断才是权威：我 follow 的 Thread 上的活动、提到我的、我的 Task/Claim 变化。Client 用 `threadRef` join 进列表，**绝不**用 `item.mentions` 自行推导。未读为 0 是「没有徽标」而不是「显示 0」，超过 99 显示 `99+`。它就是共享计数胶囊（见「计数胶囊」），因此不会与侧栏入口、Inbox 行之间产生漂移。未读读取失败时**清空徽标**，而不是展示读者已不能信任的计数。失败文案走其他读取失败同样的 inline 失败行。
- `aria-label` 依卡型与计数而定。未读为 0 用 `openTask`/`openThread`，带计数用 `openTaskUnread`/`openThreadUnread`。胶囊本身 `aria-hidden`，计数经这枚「开门」控件自己的 label 抵达读屏。这个通道把数字和数字所属的 Thread 绑在一起。状态簇留在控件**外面**：带 label 的 button 会把后代从可访问性树上剪掉，放进去等于让所有者叠放自己的名字沉默。

### 状态胶囊与弹层
- Thread 状态用公共 `Pill`（与 `Task #N` 同行）。Channel Member 数与在线数等元信息用 `.headerMeta` 行内分隔。内容是 `memberCount` + `onlineCount`，error/unavailable 不计为在线。
- Claims 折叠用公共 `DisclosureRow`（`expandOnRowClick`，标题 `Claims · N`）。键盘闭环由原语保证。Claim 行缩进对齐标题文字。
- 所有弹层走公共 `Modal`：打开时焦点入内容区，关闭后焦点回到触发按钮（`queueMicrotask` 延迟聚焦模式）。
