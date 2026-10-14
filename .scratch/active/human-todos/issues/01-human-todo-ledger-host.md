# 01 — 待办事实与去重键（Host 半）

**What to build**

成员在讨论（Thread）里给人类派一条待办；人类在同一讨论的清单里看到它、认领它、用一句话答复它，然后它结案。同一个成员重试一次、**或者换个成员、换个请求号把同一件事再说一遍**，清单里都只有一条 —— 第二个人看到的是"这件事已经有人提了"，而不是清单里长出第二条。

判据的口径是用户视角：清单里的条目**数与状态**必须能从账本事实重放得出，且"谁欠谁动作"从不因为重试或第二个成员而改变。

**Blocked by**

无。界面半（讨论页内的清单、认领／回复入口、频道入口徽标）另起一笔，阻塞在 @jzp 的排期与原型冻结之后；本票只做 Host 半。

**Status**

implemented（Host 半已完成，待四道门读数与代码审核核交付面）。

**验收判据**

1. **同一个键重复分发 ⛔ 不新建**，且结果里**明说"没有新建"**（不是静默返回旧对象）。
2. **不同 `requestId` 描述同一件事**归一到同一条 —— 账本既有的 `byRequest` 幂等只挡"同一 `requestId` 重放"，挡不住这一点，而需求要的正是它。
3. 已认领／已回复时**重复操作不改状态**；越权动作（非发起者改别人的待办、非人类主体做人类动作）**不成立**。
4. 人类动作走**人类主体**（`agentTeamHumanActor()`），⛔ 不借用成员身份。
5. **回放后状态一致**：同一串事实重放得出同一条待办、同一状态。
6. **事实形状**：待办必须带 `channelRef` ＋ `threadRef` ＋ 幂等键 ＋ 发起者 ＋ 状态（认领者与时刻）—— 少了 `channelRef`，"频道下未结案数"就无从聚合，频道入口那个徽标也就做不出来。

**已定口径（照此实现，不再逐条问）**

- 去重键＝`(threadRef, normalizedTitle)`，`normalizedTitle` 经 NFKC→trim→空白折叠→小写；`closed`／`cancelled` **释放**该键。
- 动作＝目标状态：`claim`→`claimed`、`answer`→`answered`、`close`→`closed`、`cancel`→`cancelled`；已达目标⇒不写记录；`claim` 落在 `answered` 上**不改状态**；终态只接受重复自身。
- `answer` 要求 `messageRef` 指向**人类本人在同一 Thread 里**的消息；其它动作拒绝 `messageRef`。
- 权限：`dispatch` 仅 Member；`claim`／`answer` 仅人类；`close`／`cancel` 发起者与人类都可。
- **频道计数＝Channel 属性，不随读者变**：覆盖该 workspace 全部 active 频道（含 0），只数未结案（`pending`／`claimed`／`answered`）；Thread 级 scoped 读取也照此。读取范围（`todos`）才是读者相关的：人类看全 workspace，成员只看自己发起的。
- 不带 `baseRevision`（待办是与 `team/thread-attention-changed` 同类的域写入），因此**没有** `unread_required`／`stale_revision`。
- 工具渲染：`changed`＝本次是否写了记录；同 `requestId` 重放带已存记录的 `receipt`。
