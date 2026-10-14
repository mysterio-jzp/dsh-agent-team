# 人类待办清单（human todos）—— 开发侧

- **来源**：仓库外的需求拆分稿《agent-team插件-需求拆分与原型范围.md》§二 E（需求 9：人类待办清单）的 **Host 半**；拆分稿本身不入库。
- **基准**：本工作项切在重建尖 `46ef35a` 上的分支 `feat/human-todos`。
- **状态**：Host 半（账本 ＋ 模型工具 ＋ 文档）已实现；界面半未开始。**最后核对 2026-10-14**。
- **当前前沿**：@插件开发 落 Host 半并跑四道门；界面半（讨论页内清单、认领／回复入口、频道入口徽标）待 @jzp 排期，切分支由 @代码审核 做。⛔ 界面正稿与原型不在这里 —— 在 `.scratch/active/proto-e-human-todos/`（@UI设计师，已冻结）；⛔ 谁都不搬谁的在办目录。
- **完成条件**：账本事实、模型工具、正式文档三面齐全，且四道门（`typecheck`／`npm test`／`build`／`check:artifact`）全绿；界面半另起一笔，判据＝与冻结原型一致。
- **正式文档出口**：`docs/team-collaboration/tools.md`＋`tools.zh.md`（`team_todo` 段与工具数）、`README.md`＋`README.zh.md`、`packages/tool-agent-team/README.md`＋`README.zh.md`、`CHANGELOG.md`。

## 做了什么

| 面 | 落地 |
|---|---|
| 事实 | 新 op kind `team/human-todo-changed`；`AgentTeamHumanTodo` 带 `channelRef`／`threadRef`／发起者／标题＋`normalizedTitle`／状态，认领者与序列、答复消息 ref、结案者与序列可选 |
| 去重 | 键＝`(threadRef, normalizedTitle)`（NFKC→trim→空白折叠→小写），**不是** `requestId`：未结案时重复分发不写记录、返回已存在那条并带 `changed: false`；`closed`／`cancelled` 释放该键 |
| 状态机 | 动作＝目标状态（`claim`／`answer`／`close`／`cancel`）；已达目标不写记录；终态只接受重复自身；`answer` 只认**人类本人在同一 Thread** 的消息，其它动作拒绝 `messageRef` |
| 权限 | `dispatch` 仅 Member（且该 workspace 成员）；`claim`／`answer` 仅人类主体；`close`／`cancel` 发起者与人类都可 |
| 投影 | ref kind `'todo'`；scope＝workspace／channel／thread 三层；`humanTodos`（读者范围：人类看全 workspace，成员只看自己发起的）＋`humanTodosByThread` |
| 频道计数 | Channel 级属性、不随读者变：覆盖该 workspace 全部 active 频道（含 0），只数未结案（`pending`／`claimed`／`answered`）—— 频道入口徽标的数就是这个 |
| 清单投影 | 清单＝**除撤回外的全部**（未结案三态 ＋ 结案，任何读者一致）；撤回项不在清单、也不计入徽标，事实仍留在账本与讨论时间线（判据见 `issues/02-withdrawal-off-the-checklist.md`） |
| 工具 | `team_todo`（`dispatch`／`list`／`close`／`cancel`），commit 结果渲染这条待办并明说本次是否写了记录（⛔ 不静默返回旧对象） |
| 席位 | 人类侧 `@Remote('changeHumanTodo')`／`@Remote('humanTodos')`；Agent 侧 `dispatchHumanTodoForAgent`／`changeHumanTodoForAgent`／`humanTodosForAgent` |
| 清册 | `AGENT_TEAM_TOOL_NAMES`、`member-context`、`cordis.patch.yml` 工具族散文与用法 bullet 同步加上 `team_todo` |

**⛔ 这一笔零 CSS、零界面改动**：既有的两处对比度问题（未读徽标 4.28:1、头像色相多数不达标）不在这一笔里，也不存在"本批新面继承"的问题 —— 本批新增的待办徽标底色在冻结原型里是达标值，属界面半。

## 留痕

- 测试：`packages/agent-team/tests/human-todos.spec.ts`（新建，11 用例＝Host 半 10 ＋ 撤回过滤 1）、`operation-protocol.spec.ts`（fixture ＋ 同 requestId 重放）、`packages/tool-agent-team/tests/team-tools-render.spec.ts`（6 个渲染用例）、`shipping.spec.ts`／`typert-generation.spec.ts`（清册与 Remote 名单）。
- 文档：见上「正式文档出口」。
