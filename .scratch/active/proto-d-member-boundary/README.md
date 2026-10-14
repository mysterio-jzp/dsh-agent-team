# proto-D · 成员边界页（头像 ＋ agent.md）

**状态**：原型已出（2026-10-14），等 @jzp 对「界面正稿总览」§三 那几条拍板后即可冻结。
**最后核对**：2026-10-14
**当前前沿**：原型与截图已落（`prototype/` ＋ `materials/`）；⛔ 未写任何产品代码 —— 客户端界面等原型冻结。
**完成条件**：@jzp 认可形态 → 写 `spec.md` 决策快照 → 界面笔落地（判据见 `validation/设计判据.md`）。
**正式文档出口**：`spec.md`（本目录）＋ `validation/设计判据.md`；需求正稿在
`数字员工/doc/design/agent-team插件-需求拆分与原型范围.md` §二 D。

## 怎么看
- `prototype/member-boundary.html`：单文件、可离线双击打开。顶部控制条可切明暗与桌面/移动，同页并排画了多个状态帧。
- `prototype/member-boundary.mobile.html`：移动档（帧按 390 宽渲染），由生成器产出，⛔ 不用手改。
- `materials/`：明暗 × 桌面/移动的交付截图（2× 像素密度）。
- ⛔ 生成物不要手改：改 `.scratch/active/proto-kit/` 下的共享层或 `generate.mjs`，再跑
  `node .scratch/active/proto-kit/generate.mjs` 与 `bash .scratch/active/proto-kit/shoot.sh`。
