#!/usr/bin/env node
/**
 * 生成 dsh-agent-team 本轮界面正稿原型（C / D / E / B 四份）。
 *
 * 为什么用生成器：仓内规范要求原型是**单文件、可离线打开**的
 * （`.scratch/active/<work>/prototype/*.html` 先例即如此），而四份原型必须
 * 共用同一套设计令牌与外壳样式。把共享层放这里一份，别再手抄四遍。
 *
 * 用法：node .scratch/active/proto-kit/generate.mjs
 * 产出：写进各工作项目录的 prototype/ 下；⛔ 生成物不要手改，改本文件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const kit = dirname(fileURLToPath(import.meta.url))
const repo = resolve(kit, '../../..')
const scratch = join(repo, '.scratch/active')

const tokensCss = readFileSync(join(kit, 'tokens.css'), 'utf8')
const shellCss = readFileSync(join(kit, 'proto.css'), 'utf8')

const SHARED_JS = String.raw`
  const params = new URLSearchParams(location.search)
  const forcedTheme = params.get('theme')
  if (forcedTheme === 'dark' || forcedTheme === 'light') {
    document.documentElement.dataset.theme = forcedTheme
  }
  const forcedDevice = params.get('device')
  if (forcedDevice === 'mobile') document.documentElement.dataset.forcedDevice = 'mobile'

  const $ = (sel, root = document) => root.querySelector(sel)
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

  // 控制条：主题 / 宽度
  const themeSeg = $('#themeSeg')
  const deviceSeg = $('#deviceSeg')
  if (themeSeg) {
    const applyTheme = (value) => {
      if (value === 'auto') delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = value
      $$('button', themeSeg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)))
    }
    themeSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return
      applyTheme(btn.dataset.value)
    })
    applyTheme(forcedTheme ?? 'auto')
  }
  if (deviceSeg) {
    const applyDevice = (value) => {
      $$('[data-frame]').forEach((frame) => {
        frame.dataset.device = value === 'mobile' ? 'mobile' : 'desktop'
      })
      $$('button', deviceSeg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)))
    }
    deviceSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return
      applyDevice(btn.dataset.value)
    })
    applyDevice(forcedDevice === 'mobile' ? 'mobile' : 'desktop')
  }

  // 视图切换（讨论 / 产物 / 任务）：按帧作用域 —— 同一页要画多帧，
  // ⛔ 不能用 id（id 全页唯一），所以查询都收在本帧内。
  $$('[data-view-tabs]').forEach((viewTabs) => {
    const frame = viewTabs.closest('.frame')
    const panels = $$('[data-view-panel]', frame)
    const show = (view) => {
      panels.forEach((p) => { p.hidden = p.dataset.viewPanel !== view })
      $$('button', viewTabs).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)))
      if (view !== 'artifacts') closePaneIn(frame)
    }
    viewTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return
      show(btn.dataset.view)
    })
    viewTabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      const tabs = $$('button', viewTabs)
      const i = tabs.indexOf(document.activeElement); if (i < 0) return
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
      next.focus(); show(next.dataset.view)
    })
  })

  // 右侧预览面板：点产物条目才展开（已拍：默认不常驻），Esc 关闭，焦点回触发者。
  // 面板本身是布局级的（落地走 layout.openRightbar／closeRightbar），
  // 这里画的只是它里面的那个 tab。
  const paneRoots = $$('[data-pane-root]')
  const frameOf = (el) => el.closest('.frame') ?? document
  const paneIn = (frame) => (frame.querySelector ? frame.querySelector('[data-pane-root]') : null)
  let paneTrigger = null
  const setPaneOpen = (open, trigger) => {
    if (!paneTrigger) { if (!trigger) return }
    const root = paneTrigger ? paneIn(frameOf(paneTrigger)) : null
    if (!root) return
    root.hidden = !open
    const main = frameOf(root).querySelector('.main')
    if (main) main.dataset.pane = open ? 'open' : 'closed'
    $$('[data-artifact]', frameOf(root)).forEach((card) => card.setAttribute('aria-current', String(open && card === paneTrigger)))
  }
  const closePaneIn = (frame) => {
    const root = paneIn(frame); if (!root || root.hidden) return
    const previous = paneTrigger
    root.hidden = true
    const main = frame.querySelector('.main'); if (main) main.dataset.pane = 'closed'
    $$('[data-artifact]', frame).forEach((card) => card.setAttribute('aria-current', 'false'))
    paneTrigger = null
    if (previous) previous.focus()
  }
  window.closePaneIn = closePaneIn
  window.openPaneFor = (card) => {
    const frame = frameOf(card)
    const root = paneIn(frame); if (!root) return
    paneTrigger = card
    const body = root.querySelector('[data-pane-body]')
    const source = card.dataset.docId ? document.getElementById(card.dataset.docId) : null
    if (body && source) body.innerHTML = source.innerHTML
    const title = root.querySelector('[data-pane-title]'); if (title) title.textContent = card.dataset.title
    const path = root.querySelector('[data-pane-path]'); if (path) path.textContent = card.dataset.path
    root.hidden = false
    const main = frame.querySelector('.main'); if (main) main.dataset.pane = 'open'
    $$('[data-artifact]', frame).forEach((c) => c.setAttribute('aria-current', String(c === card)))
  }

  document.addEventListener('click', (e) => {
    const card = e.target.closest('[data-artifact]')
    if (card) { e.preventDefault(); window.openPaneFor(card); return }
    const closer = e.target.closest('[data-pane-close]')
    if (closer) { closePaneIn(frameOf(closer)); return }
    const opener = e.target.closest('[data-pane-open-now]')
    if (opener) {
      const first = opener.closest('.frame').querySelector('[data-artifact]')
      if (first) window.openPaneFor(first)
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const open = paneRoots.filter((r) => !r.hidden && (paneTrigger ? frameOf(paneTrigger) === frameOf(r) : true))
    if (open.length) closePaneIn(frameOf(open[0]))
  })
  // 每帧面板的初始态由 data-pane-open 给：展开态单独占一帧（⛔ 不用查询串切态）
  paneRoots.forEach((root) => { root.hidden = root.dataset.paneOpen !== 'true' })

  // 待办 / 认领这类"目标状态"动作：重复点击不产生第二条事实（幂等），
  // 原型上只把结果画出来 —— 点完变成已认领，按钮改成"已认领"，并且
  // 明确提示"这次没有新建/没有变更"。
  const toast = $('#toast')
  let toastTimer = 0
  const say = (text) => {
    if (!toast) return
    toast.textContent = text
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.hidden = true }, 2600)
  }
  window.say = say
  document.addEventListener('click', (e) => {
    const claim = e.target.closest('[data-claim-todo]')
    if (claim) {
      const card = claim.closest('.todoCard')
      const already = card.dataset.state === 'claimed' || card.dataset.state === 'answered'
      if (!already) {
        card.dataset.state = 'claimed'
        const tag = $('.stateTag', card)
        tag.dataset.state = 'claimed'
        tag.innerHTML = '<span class="dot"></span>已认领'
        $('.claimedBy', card).hidden = false
      }
      claim.setAttribute('aria-pressed', 'true')
      say(already ? '这条待办已经是「已认领」，本次没有产生新记录' : '已认领 · 认领人与时刻已记入账本')
      return
    }
    const close = e.target.closest('[data-close-todo]')
    if (close) {
      const card = close.closest('.todoCard')
      const settled = card.dataset.state === 'closed'
      if (!settled) {
        card.dataset.state = 'closed'
        const tag = $('.stateTag', card)
        tag.dataset.state = 'closed'
        tag.innerHTML = '<span class="dot"></span>已结案'
      }
      say(settled ? '这条待办已经结案，本次没有变更' : '已结案 · 结案人与时刻已记入账本；条目仍留在清单里')
      return
    }
    const restate = e.target.closest('[data-restate]')
    if (restate) {
      say('这条待办已存在（同一件事），本次没有新建')
      return
    }
    const tab = e.target.closest('[data-pane-tab]')
    if (tab) {
      $$('[data-pane-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === tab)))
      $$('[data-pane-view]').forEach((v) => { v.hidden = v.dataset.paneView !== tab.dataset.paneTab })
    }
  })

  // 截图/深链用：?demo=claimed 直接把第一条待办画成已认领态
  if (params.get('demo') === 'claimed') {
    const first = $('[data-claim-todo]')
    if (first) first.click()
  }
`

function document_({ title, note, body, extraStyle = '', mobile = false }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${mobile ? `
<script>/* 移动档由生成器直接产出：帧按移动设备渲染，⛔ 不靠运行时改 DOM */</script>` : ''}
<style>
${tokensCss}
${shellCss}
${extraStyle}
</style>
</head>
<body>
${body}
<div class="protoToast" id="toast" role="status" aria-live="polite" hidden></div>
<script>
${SHARED_JS}
</script>
</body>
</html>
`
}

/* ------------------------------------------------------------------ 共享片段 */

// 帧的设备档：桌面档画 1408，移动档画 390 —— 同一份页面源，两种交付图。
let frameDevice = 'desktop'
const frameDeviceDecl = () => ''

const stylesheetNote = (landing) => `<div class="toolbar">
  <h1>${landing.title}</h1>
  <span class="lead">${landing.lead}</span>
  <span class="spacer"></span>
  <div class="seg" id="themeSeg" role="group" aria-label="配色">
    <button type="button" data-value="auto">跟随系统</button>
    <button type="button" data-value="light">浅色</button>
    <button type="button" data-value="dark">深色</button>
  </div>
  <div class="seg" id="deviceSeg" role="group" aria-label="画布宽度">
    <button type="button" data-value="desktop">桌面 1408</button>
    <button type="button" data-value="mobile">移动 390</button>
  </div>
</div>
<div class="toolbar" style="margin-top:-8px">
  <span class="note">${landing.note}</span>
</div>`

const sidebar = ({ pending = 0 } = {}) => `<nav class="sidebar" aria-label="团队导航">
  <div class="sidebarHead">
    <span class="avatar avatarRing" data-size="md" style="--hue:212">数</span>
    <span class="workspace">数字员工</span>
  </div>

  <div class="groupTitle">频道</div>
  <a class="navRow" href="#"><span class="navIcon">#</span><span class="navText">数字员工</span>${pending ? `<span class="badge" data-tone="human" aria-label="${pending} 条待办需要我处理">${pending}</span>` : ''}</a>
  <a class="navRow" href="#" aria-current="page"><span class="navIcon">#</span><span class="navText">dsh-agent-team</span>${pending ? `<span class="badge" data-tone="human" aria-label="${pending} 条待办需要我处理">${pending}</span>` : ''}<span class="badge" data-tone="quiet" aria-label="3 条未读">3</span></a>
  <a class="navRow" href="#"><span class="navIcon">#</span><span class="navText">Jarvis 后端</span></a>

  <div class="groupTitle">我的收件箱</div>
  <a class="navRow" href="#"><span class="navIcon">@</span><span class="navText">未读讨论</span><span class="badge" data-tone="quiet">5</span></a>

  <div class="groupTitle">成员</div>
  <div class="memberRow" data-state="working">
    <span class="avatarWrap"><span class="avatar avatarRing" data-size="md" style="--hue:302">架</span><span class="presence"></span></span>
    <span class="who"><span class="name">软件架构师</span><br><span class="state">正在跑 · dsh-agent-team</span></span>
  </div>
  <div class="memberRow">
    <span class="avatarWrap"><span class="avatar avatarRing" data-size="md" style="--hue:174">插</span><span class="presence"></span></span>
    <span class="who"><span class="name">插件开发</span><br><span class="state">空闲 · 3 个桶</span></span>
  </div>
  <div class="memberRow">
    <span class="avatarWrap"><span class="avatar avatarRing" data-size="md" style="--hue:44">代</span><span class="presence"></span></span>
    <span class="who"><span class="name">代码审核</span><br><span class="state">空闲 · 2 个桶</span></span>
  </div>
  <div class="memberRow" data-state="suspended">
    <span class="avatarWrap" data-presence="idle"><span class="avatar avatarRing" data-size="md" style="--hue:212">U</span><span class="presence"></span></span>
    <span class="who"><span class="name">UI设计师</span><br><span class="state">已挂起</span></span>
  </div>
</nav>`

const avatarImg = (initial, hue, size) =>
  `<span class="avatar avatarRing" data-size="${size}" style="--hue:${hue}" aria-hidden="true">${initial}</span>`

const messageRow = ({ initial, hue, author, role, at, mentionsMe = false, grouped = false, quote, body, artifact, artifactLoading, artifactFailed }) => `
<div class="messageRow"${mentionsMe ? ' data-mentions-me="true"' : ''}${grouped ? ' data-grouped="true"' : ''}>
  <span class="identity">${grouped ? avatarImg(initial, hue, 'md') : avatarImg(initial, hue, 'md')}</span>
  <div class="messageCol">
    <div class="identityLine">
      <span class="author">${author}</span>
      ${role ? `<span class="role">${role}</span>` : ''}
      <span class="at">${at}</span>
      <span class="rowActions">
        <button class="iconBtn" type="button" title="回复这条" aria-label="回复 ${author} 的这条消息">↩</button>
        <button class="iconBtn" type="button" title="复制链接" aria-label="复制这条消息的链接">⧉</button>
      </span>
    </div>
    <div class="bubble">
      ${mentionsMe ? '<span class="mentionsMeBadge">有人@我</span>' : ''}
      ${quote ?? ''}
      ${body}
      ${artifact ?? ''}
      ${artifactLoading ?? ''}
      ${artifactFailed ?? ''}
    </div>
  </div>
</div>`

/**
 * 产物条目。正文**不**放 data 属性里：那里的 HTML 会把标记撕碎（2026-10-14 第一版
 * 就是这么坏的），所以正文按 id 引用一段 <template>，点击时拷进右侧面板。
 */
const artifactCard = ({ icon, title, path, range, doc, docId, current }) => `
<button class="artifactCard" type="button" data-artifact="true" data-title="${title}" data-path="${path}"${docId ? ` data-doc-id="${docId}"` : ''}
  ${current ? 'aria-current="true"' : ''} aria-label="打开产物预览：${title}">
  <span class="aIcon" aria-hidden="true">${icon}</span>
  <span class="aTitle">${title}</span>
  <span class="aMeta">${path}${range ? ` · <span class="aRange">${range}</span>` : ''}</span>
  <span class="aOpen" aria-hidden="true">›</span>
</button>
${doc && docId ? `<template id="${docId}">${doc}</template>` : ''}`

const quoteBlock = ({ who, what }) => `
<button class="quoteBlock" type="button" aria-label="跳到原文：${who}「${what}」">
  <span class="rule" aria-hidden="true"></span>
  <span class="qText"><span class="qWho">${who}</span> <span class="qWhat">${what}</span></span>
</button>`

const previewPane = ({ title, path, doc, docId, paneOpen }) => `
<aside class="previewPane" data-pane-root="true" aria-label="产物预览"${paneOpen ? '' : ' hidden'} data-pane-open="${paneOpen}">
  <div class="previewHead">
    <div style="min-width:0;flex:1">
      <div class="docName" data-pane-title="true">${title}</div>
      <div class="docPath" data-pane-path="true">${path}</div>
    </div>
    <button class="iconBtn" type="button" data-pane-close="true" aria-label="关闭预览面板">✕</button>
  </div>
  <div class="previewTabs" role="tablist" aria-label="预览视图">
    <button type="button" role="tab" data-pane-tab="doc" aria-selected="true">预览</button>
    <button type="button" role="tab" data-pane-tab="source" aria-selected="false">源码</button>
  </div>
  <div class="annotation" style="margin:8px 12px 0">⬆ 这里画的只是<b>右侧栏里的一个 tab</b>（<code>documentpreview</code> 的 <code>text</code> 类型）。整条右栏是布局级的，开合走 <code>layout.openRightbar</code>／<code>closeRightbar</code> —— ⛔ 原型不是在自己页面里手搓一条右栏，也不是把右栏塞进讨论页的布局里。</div>
  <div class="docBody" data-pane-view="doc" data-pane-body="true">${doc}</div>
  ${doc && docId ? `<template id="${docId}">${doc}</template>` : ''}
  <div class="docBody" data-pane-view="source" hidden>
    <pre style="font-size:12px;margin:0;white-space:pre-wrap"># ${title}

1  说明：这是同一个 tab 类型的"源码"读数。
2  ⛔ 原型不新造读文件的通道 —— 落地走 Harness 现成的
3  @deepseek-ai/dsh-api-workspace-files Remote，
4  与对话页右侧面板是同一条。</pre>
  </div>
</aside>`

const pageHead = ({ crumb, title, sub, tabs, actions = '' }) => `
<header class="pageHead">
  <div style="min-width:0">
    <div class="back">${crumb}</div>
    <h2>${title}</h2>
    <p class="sub">${sub}</p>
  </div>
  <div class="actions">${actions}</div>
</header>
${tabs}
`

const viewTabs = (items) => `<div style="padding:10px 16px 0">
  <div class="tabs" data-view-tabs="true" role="tablist" aria-label="讨论页视图">
    ${items.map((it, i) => `<button type="button" role="tab" data-view="${it.view}" aria-selected="${i === 0}">${it.label}</button>`).join('\n    ')}
  </div>
</div>`

const scopeBar = () => `
<div class="workspaceScope">
  <span>本域涉及目录</span>
  <span class="roots">
    <span class="rootChip" data-primary="true">dsh-agent-team（默认根）</span>
    <span class="rootChip">ai_product/数字员工</span>
  </span>
  <span class="tag">工作域 ＝ thread:7245ae87…</span>
</div>
<div style="padding:0 16px"><div class="annotation">这条只在成员视角显示，是只读事实（需求 7 §待确认第 3 条按默认处理：写进域说明，⛔ 不新增工具）。</div></div>`

/* --------------------------------------------------------------- C 讨论页 */

const docPreviewBody = `
<h1>dsh-agent-team 需求拆分与原型范围</h1>
<p><b>这份稿子回答 @jzp 18:11 的指令</b>：「将任务拆分一下，先出原型图。再落开发任务。」</p>
<h2>一、拆分总表（5 条需求 → 5 个工作项）</h2>
<p>把已登记的 5 条需求拆成 <span class="hit">5 个工作项</span>，逐项给范围／依赖／要不要原型、原型画什么、原型的验收判据。</p>
<p><code>prototype/*.html</code> 单文件、可离线打开 —— 先例两份（bubbles.html／reply.html）。</p>
<h2>二、逐工作项</h2>
<p>C 产物跳转 ＋ 讨论页右侧预览面板：产物从会话产物面自动带出，点击即在本面板打开；账本只存路径与元数据。</p>
<h2>三、排期顺序</h2>
<p>第 1 批：原型线 ＋ 账本/Host 侧实现线并行。第 2 批：原型冻结后写 <code>spec.md</code>，再落客户端界面增量。</p>`

const msgHuman = messageRow({
  initial: 'J', hue: 212, author: '@jzp', role: '人类', at: '18:11',
  body: `<p>@插件开发 @UI设计师 @代码审核 @软件架构师 将任务拆分一下，<b>先出原型图</b>。再落开发任务。</p>`,
})

const msgMentioned = (ns = 'msg') => messageRow({
  initial: '架', hue: 302, author: '@软件架构师', role: '成员', at: '18:16', mentionsMe: false,
  body: `<p>拆分已落地成稿：<span class="ref">数字员工/doc/design/agent-team插件-需求拆分与原型范围.md</span>（5 条需求 → 5 个工作项 A–E，逐项给范围／依赖／原型范围与判据／未拍口径的影响）。</p>`,
  artifact: artifactCard({
    icon: 'MD', title: 'agent-team插件-需求拆分与原型范围.md',
    path: '数字员工/doc/design/agent-team插件-需求拆分与原型范围.md',
    doc: docPreviewBody, docId: `doc-split-${ns}`,
  }),
})

const msgQuote = messageRow({
  initial: '插', hue: 174, author: '@插件开发', role: '成员', at: '09:22',
  quote: quoteBlock({ who: '@软件架构师', what: '「账本／Host 侧那一列全部可以在原型出图之前先落」' }),
  body: `<p>收到，我先落账本侧的其中一笔。原型冻结前我不动任何客户端界面代码。</p>`,
})

const artifactEntry = (p) => artifactCard(p)

const artifactStates = `
<div class="sectionLabel">产物条目的四种状态（同一张卡，四种读数）</div>
<div style="display:grid;gap:12px;padding:10px 16px 4px;max-width:760px">
  ${artifactEntry({
    icon: 'MD', title: 'agent-team插件-需求拆分与原型范围.md',
    path: '数字员工/doc/design/agent-team插件-需求拆分与原型范围.md',
    doc: docPreviewBody, docId: 'doc-split-states', current: true,
  })}
  <button class="artifactCard" type="button" disabled aria-busy="true">
    <span class="aIcon" aria-hidden="true">MD</span>
    <span class="aTitle">正在读取…</span>
    <span class="aMeta">数字员工/doc/design/agent-team插件-需求拆分与原型范围.md</span>
    <span class="aOpen" aria-hidden="true"></span>
  </button>
  <button class="artifactCard" type="button" aria-describedby="failWhy">
    <span class="aIcon" aria-hidden="true" style="background:var(--proto-warn-tertiary);color:var(--proto-warn-label)">!</span>
    <span class="aTitle" style="color:var(--proto-label-secondary)">prototype/reply.html（已删除）</span>
    <span class="aMeta">数字员工/.scratch/active/thread-message-reply/prototype/reply.html</span>
    <span class="aOpen" aria-hidden="true">↻</span>
  </button>
  <div class="warnCard" id="failWhy">
    <b>文件读不到：它已经不在了。</b>
    <span>产物条目存的是路径，不是字节 —— 所以文件被删/改名后要现读现报，⛔ 不许用缓存副本假装成功。出路：按路径重新生成，或让发起的那位成员改条目。</span>
  </div>
  <div class="emptyState">
    <span class="avatar" data-size="lg" style="--hue:212;background:var(--proto-hover-solid);color:var(--proto-label-tertiary)">—</span>
    <b style="color:var(--proto-label-secondary)">这条消息没有产物</b>
    <span>只在消息真的带出产物时才画这张卡；⛔ 不留空占位（空态是"不画"，不是"画一个空卡"）。</span>
  </div>
</div>
<div style="padding:0 16px 16px"><div class="annotation">四态验收：正常（可点，面板打开）／加载（禁用 + aria-busy）／失败（文案说清是"文件没了"还是"不在允许目录内"，并给一条出路）／空（不画卡）。</div></div>`

const artifactsList = (ns) => `
<div class="sectionLabel">这条讨论带出的全部产物（按消息时间倒序）</div>
<div style="display:grid;gap:10px;padding:10px 16px 16px;max-width:820px">
  ${artifactEntry({
    icon: 'MD', title: 'agent-team插件-需求拆分与原型范围.md',
    path: '数字员工/doc/design/agent-team插件-需求拆分与原型范围.md',
    doc: docPreviewBody, docId: `doc-split-list-${ns}`, current: true,
  })}
  ${artifactEntry({
    icon: 'MD', title: 'agent-team插件-需求整理.md',
    path: '数字员工/doc/design/agent-team插件-需求整理.md',
    range: 'L188-L198', docId: 'doc-needs',
    doc: '<h1>需求 8 ｜交付产物在讨论消息里可点击跳转</h1><p>要什么：「支持在讨论消息里面进行产物交付…我可以点击直接跳转。」</p><h2>已拍</h2><p>产物从该会话的产物面自动带出；点击行为＝打开预览面板。</p>', docId: `doc-needs-${ns}`,
  })}
  ${artifactEntry({
    icon: 'MD', title: 'agent-team插件-上下文隔离设计.md',
    path: '数字员工/doc/design/agent-team插件-上下文隔离设计.md', docId: `doc-iso-${ns}`,
    doc: '<h1>上下文隔离（会话管理）设计</h1><p>一个 Member 每个工作域一个会话桶；同一 Member 仍单 turn 串行。</p>',
  })}
  ${artifactEntry({
    icon: 'DIFF', title: 'rework/upstream-20261013 重建分支（工作区变更）',
    path: 'dsh-agent-team · 31 个文件冲突', docId: `doc-diff-${ns}`,
    doc: '<h1>工作区变更集</h1><p>来自 Harness 的 deliverables/workspace-changes 面：按 git 记的工作区变更。⛔ 插件不自造「什么算产物」。</p>',
  })}
</div>
<div style="padding:0 16px 16px"><div class="annotation">路径基准＝该消息所属工作域的默认根（待拍项，默认如此）；条目上永远显示完整相对路径，因为它就是点击后要读的那个坐标。</div></div>`

const cBody = `
${stylesheetNote({
  title: 'C · 产物跳转 ＋ 讨论页右侧预览面板',
  lead: '需求 8 ｜ 对应工作项 C',
  note: '已拍：产物从会话产物面自动带出／点击＝打开预览面板／把对话页右侧面板迁到讨论页。⛔ 不复制渲染、⛔ 不新造读文件通道；面板复用同一个 documentpreview tab 类型与 workspace-files Remote。点任意产物卡片即可展开右侧面板（Esc 或 ✕ 关闭）。<b>已拍：面板默认不常驻、点开才出现</b>。还有一条待拍会决定这一笔能不能成立：预览地址里的 <b>session 作用域</b>取「产物所属成员会话」还是「客户端当前会话」（建议前者、取不到回退后者）—— 它决定「人类没开任何会话时讨论页能不能打开预览」。',
})}
<div class="stage">
  <div class="frameWrap">
    <div class="frameLabel"><b>讨论页 · 桌面 1408×860</b> —— 左侧栏 ＋ 时间线；右侧面板点产物才展开</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}" style="--frame-h:960px">
      ${sidebar()}
      <div class="main" data-pane="closed">
        ${pageHead({
          crumb: 'dsh-agent-team · 讨论',
          title: '将任务拆分一下，先出原型图',
          sub: 'task:1ce1ce20 · 进行中 · 5 位成员 · 24 条事实',
          actions: '<button class="pillBtn" type="button">跳到最新</button><button class="pillBtn" type="button">全部标记已读</button>',
          tabs: viewTabs([
            { view: 'thread', label: '讨论 24' },
            { view: 'artifacts', label: '产物 4' },
            { view: 'board', label: '任务' },
          ]),
        })}
        ${scopeBar()}
        <div class="timeline" data-view-panel="thread">
          <div class="daySeparator">2026-10-14</div>
          <div class="unreadBoundary">5 条未读</div>
          ${msgHuman}
          ${msgMentioned('a')}
          ${msgQuote}
          <div class="activityRow">
            <span class="who">@代码审核</span><span>认领了这笔 Task 的交付轴</span><span class="at">09:20</span>
          </div>
          <div class="typeRow" style="padding:10px 0 0 32px;color:var(--proto-label-tertiary);font-size:12px">…（后续消息）</div>
        </div>
        <div class="timeline" data-view-panel="artifacts" hidden>${artifactsList('a')}</div>
        <div class="timeline" data-view-panel="board" hidden>
          <div class="noteCard" style="max-width:640px">
            <b>任务视图</b>
            <span>讨论带 Task 时，这个页签就是那笔 Task 的视图（一个讨论至多一个 Task）。产物条目也在这里列出，方便按 task 收口。</span>
          </div>
        </div>
      </div>
      ${previewPane({
        title: 'agent-team插件-需求拆分与原型范围.md',
        path: '数字员工/doc/design/agent-team插件-需求拆分与原型范围.md',
        docId: 'pane-doc-split-a',
        paneOpen: false,
      })}
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>产物条目四态</b> —— 正常／加载／失败／空</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}" style="--frame-h:780px">
      <div class="main">
        ${pageHead({
          crumb: 'C · 产物条目',
          title: '四种读数（同一张卡）',
          sub: '失败态必须说清是哪一种失败，并给一条出路',
          actions: '',
          tabs: '',
        })}
        ${artifactStates}
      </div>
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>讨论页 · 面板已展开（1408）</b> —— 点产物条目后的一态；深链 <code>?pane=open</code></div>
    <div class="frame" data-frame="true" data-device="${frameDevice}">
      ${sidebar()}
      <div class="main" data-pane="open">
        ${pageHead({
          crumb: 'dsh-agent-team · 讨论',
          title: '将任务拆分一下，先出原型图',
          sub: 'task:1ce1ce20 · 进行中 · 5 位成员 · 24 条事实',
          actions: '<button class="pillBtn" type="button" data-pane-open-now="true">打开右侧面板</button>',
          tabs: viewTabs([
            { view: 'thread', label: '讨论 24' },
            { view: 'artifacts', label: '产物 4' },
            { view: 'board', label: '任务' },
          ]),
        })}
        ${scopeBar()}
        <div class="timeline timelineNarrow" data-view-panel="thread">
          ${msgHuman}
          ${msgMentioned('b')}
        </div>
        <div class="timeline" data-view-panel="artifacts" hidden>${artifactsList('b')}</div>
        <div class="timeline" data-view-panel="board" hidden></div>
      </div>
      ${previewPane({
        title: 'agent-team插件-需求拆分与原型范围.md',
        path: '数字员工/doc/design/agent-team插件-需求拆分与原型范围.md',
        doc: docPreviewBody, docId: 'pane-doc-split-b',
        paneOpen: true,
      })}
    </div>
  </div>
  <div class="frameWrap">
    <div class="frameLabel"><b>讨论页 · 移动 390×780</b> —— 面板改全屏抽屉</div>
    <div class="frame" data-frame="true" data-device="mobile">
      <div class="main">
        ${pageHead({
          crumb: '‹ 返回讨论列表',
          title: '将任务拆分一下…',
          sub: '5 位成员 · 3 条未读',
          actions: '',
          tabs: '',
        })}
        <div class="timeline" data-compact="true">
          ${messageRow({
            initial: '架', hue: 302, author: '@软件架构师', role: '成员', at: '18:16',
            body: `<p>拆分已落地成稿。</p>`,
            artifact: artifactCard({
              icon: 'MD', title: '需求拆分与原型范围.md',
              path: '数字员工/doc/design/agent-team插件-需求拆分与原型范围.md',
              doc: docPreviewBody, docId: 'doc-split-mobile', current: true,
            }),
          })}
          <div class="annotation" style="margin:12px 0 0">窄宽度下右侧面板不常驻：点产物条目后，面板以整屏抽屉打开（顶部保留"关闭"与返回讨论的路径），Esc 同样可关。</div>
        </div>
      </div>
    </div>
  </div>

</div>
`

/* ------------------------------------------------------ E 人类待办与 claim */

const todoCard = ({ state, title, origin, body, claimed, answered, who = '插', hue = 174 }) => `
<div class="todoCard" data-state="${state}">
  <div class="todoHead">
    <span class="avatar avatarRing" data-size="lg" style="--hue:${hue}" title="发起者">${who}</span>
    <div style="flex:1;min-width:0">
      <div class="tTitleRow">
        <span class="tTitle">${title}</span>
        <span class="stateTag" data-state="${state}">${state === 'pending'
          ? '<span class="dot"></span>待认领'
          : state === 'claimed' ? '<span class="dot"></span>已认领'
          : state === 'answered' ? '<span class="dot"></span>已回复'
          : '<span class="dot"></span>已结案'}</span>
      </div>
      <div class="tOrigin">${origin}</div>
    </div>
  </div>
  <div class="todoBody">${body}</div>
  <div class="todoFoot">
    <span class="actor claimedBy"${state === 'pending' ? ' hidden' : ''}>
      ${avatarImg('架', 302, 'sm')} 已由 <b>@jzp</b> 认领 · 2026-10-14 09:31
    </span>
    <span class="grow"></span>
    ${state === 'closed'
      ? '<span class="actor">2026-10-14 10:02 由发起者与人类双方结案</span>'
      : `<button class="pillBtn" type="button" data-claim-todo="true" aria-pressed="${state === 'pending' ? 'false' : 'true'}">认领</button>
         <button class="pillBtn" type="button" data-variant="${state === 'pending' ? 'quiet' : 'primary'}">在讨论里回复…</button>
         <button class="pillBtn" type="button" data-close-todo="true">结案</button>`}
  </div>
  ${answered ?? ''}
</div>`

const eBody = `
${stylesheetNote({
  title: 'E · 人类待办清单（在讨论页内，与 claim 并排可辨）',
  lead: '需求 9 ｜ 对应工作项 E',
  note: '已拍：不要优先级／同一讨论允许多条／认领＝仅标记＋可见／必须幂等／<b>清单放在讨论页里面</b>。这一页画三件事：① 讨论页内的待办视图；② 频道行的入口徽标（那个数由 Host 派生，⛔ 不由客户端把各讨论的待办相加）；③ 待办与 claim 并排对比。点「认领」看状态流转与幂等提示，点「结案」看人类自己把它收掉。<b>本批人类侧只有这三个动作：认领／在讨论里回复／结案</b>（认领＝仅标记＋可见；发起者向人类分发的入口在成员工具侧，不在这张清单上）。',
})}
<div class="stage">
  <div class="frameWrap">
    <div class="frameLabel"><b>讨论页 · 待办视图（桌面 1408）</b> —— 清单在讨论页内，明细与频道徽标是同一批事实</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}">
      ${sidebar({ pending: 2 })}
      <div class="main">
        ${pageHead({
          crumb: 'dsh-agent-team · 讨论',
          title: '将任务拆分一下，先出原型图',
          sub: 'task:1ce1ce20 · 进行中 · 待办 2（1 条待认领／1 条已认领）',
          actions: '',
          tabs: viewTabs([
            { view: 'thread', label: '讨论 24' },
            { view: 'board', label: '待办 2' },
          ]),
        })}
        <div class="timeline" data-view-panel="board">
          <div class="noteCard" style="max-width:840px">
            <b>这一屏与侧栏那个徽标是同一批事实的两个读数</b>
            <span>徽标＝该频道下<b>全部未结案</b>的待办数（由 Host 聚合下发，含已认领未回复）；这一屏＝本讨论里的<b>明细</b>。⛔ 客户端不加总各讨论来凑这个数 —— 那只数得到"已经加载过的讨论"，会随视图跳。</span>
          </div>
${todoCard({
  state: 'pending',
  title: '确认建表脚本的字符集与排序规则', who: '插', hue: 174,
  origin: '@插件开发 于 2026-10-14 09:28 分发 · 本讨论 · 挂在 task:1ce1ce20',
  body: '枚举表的 DDL 里 <code>VARCHAR</code> 统一 <code>utf8mb4_0900_ai_ci</code>，与既有表 <code>utf8mb4_general_ci</code> 不同。要么新建表用新排序规则（老表不动），要么全表统一。需要你拍一个。',
})}
${todoCard({
  state: 'claimed',
  title: '确认成员头像是否只收上传图片', who: 'U', hue: 212,
  origin: '@UI设计师 于 2026-10-14 09:12 分发 · 本讨论',
  body: '默认只收 <code>image/*</code>（与人类头像同一口径），⛔ 不内置图形／emoji。',
})}
${todoCard({
  state: 'answered',
  title: '待办项谁可结案', who: '架', hue: 302,
  origin: '@软件架构师 于 2026-10-13 15:10 分发 · 本讨论',
  body: '默认发起者与人类都可结案。',
  answered: '<div class="noteCard"><b>@jzp 的回复（2026-10-14 09:40）</b><span>两者都可。回完这条就按你的默认落库。</span><span style="color:var(--proto-label-tertiary)">这条回复同时是讨论里的一条人类消息，并绑定到本条待办 —— 讨论时间线里它带「回复待办」标记，点标记跳回本条目。</span></div>',
})}

          <div class="sectionLabel" style="margin:16px 0 0">同一屏里的成员 Claim（⛔ 不是待办：它归成员，人类不认领）</div>
          <div class="claimRow">
            <div class="cHead">
              <span class="cMark">CLAIM</span>
              ${avatarImg('架', 302, 'sm')}<span class="cWho">@软件架构师</span>
              <span class="at" style="color:var(--proto-label-caption);font-size:11px">2026-10-13 18:11 · active</span>
            </div>
            <div class="cText">把 @jzp 口述的需求整理成「需求清单 ＋ 设计正稿 ＋ 逐条待确认」三件套。</div>
          </div>
          <div class="claimRow">
            <div class="cHead">
              <span class="cMark">CLAIM</span>
              ${avatarImg('代', 44, 'sm')}<span class="cWho">@代码审核</span>
              <span class="at" style="color:var(--proto-label-caption);font-size:11px">2026-10-13 18:12 · active</span>
            </div>
            <div class="cText">给这次拆分补上交付轴：每个增量落哪条分支、折成一笔、按类别的门禁判据与折推由我管。</div>
          </div>
          <div class="annotation">并排的判据（非作者也要一眼看懂）：待办＝<b>指向人类的一个请求</b>，有"待认领/已认领/已回复/已结案"四个状态词，动作是"认领／在讨论里回复"；claim＝<b>成员自己认下的方向</b>，只有 active/done，动作归成员自己。</div>
        </div>
        <div class="timeline" data-view-panel="thread" hidden>
          ${messageRow({
            initial: 'J', hue: 212, author: '@jzp', role: '人类', at: '09:40', mentionsMe: false,
            body: `<p>两者都可。回完这条就按你的默认落库。</p><p style="color:var(--proto-label-tertiary);font-size:12px">↩ 回复待办「待办项谁可结案」 — 点这里跳回那条待办</p>`,
          })}
        </div>
      </div>
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>频道入口徽标</b> —— 那个数由 Host 派生，点得进去</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}" style="--frame-h:420px">
      ${sidebar({ pending: 2 })}
      <div class="main">
        ${pageHead({
          crumb: 'E · 入口徽标',
          title: '频道列表上的待办计数',
          sub: '与讨论页内清单对得上：入口是合计，讨论页是明细',
          actions: '',
          tabs: '',
        })}
        <div class="todoList" style="gap:14px">
          <div class="noteCard" style="max-width:820px">
            <b>两种"数什么"</b>
            <span>① 只数<b>还没被任何成员认领</b>的（真正欠你动作的）；② 数该频道下<b>全部未结案</b>的（含已被认领但没回复/没结案）。<b>本图按 ② 画</b>（拆分稿 §五 的建议默认）：既然"认领＝仅标记＋可见"，认领就不改变"这件事还没结"。改成 ① 只影响这一处的数，不影响版式。</span>
            <span>徽标可点：点它列出<b>该频道里有未结待办的讨论</b>（清单在讨论页里，所以这个数是唯一的跨讨论信号）。</span>
          </div>
          <div style="max-width:420px;background:var(--proto-sidebar);border-radius:var(--proto-radius-md);padding:10px 8px">
            <div class="groupTitle">频道</div>
            <a class="navRow" href="#"><span class="navIcon">#</span><span class="navText">数字员工</span><span class="badge" data-tone="human" aria-label="2 条待办需要我处理">2</span></a>
            <a class="navRow" href="#" aria-current="page"><span class="navIcon">#</span><span class="navText">dsh-agent-team</span><span class="badge" data-tone="human" aria-label="2 条待办需要我处理">2</span></a>
            <a class="navRow" href="#"><span class="navIcon">#</span><span class="navText">Jarvis 后端</span></a>
            <div class="annotation" style="margin:8px 6px 0">没有未结待办的频道⛔ 不画徽标（为 0 隐藏）—— 与 shipped 的计数徽标同一条语言。</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>状态流转：待认领 → 已认领 → 已回复 → 已结案</b> —— 点一次「认领」试幂等</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}" style="--frame-h:1120px">
      <div class="main">
        ${pageHead({ crumb: 'E · 状态流转', title: '四个状态签', sub: '认领＝仅标记 ＋ 可见；重复点击⛔ 不产生第二条事实；撤回的待办不进这张清单', actions: '', tabs: '' })}
        <div class="todoList">
          ${todoCard({ state: 'pending', title: '确认建表脚本的字符集与排序规则', origin: '@插件开发 09:28 分发 · 本讨论', body: '点「认领」看这一条怎么变；再点一次看幂等提示。' })}
          ${todoCard({ state: 'pending', title: '审批把右侧预览面板迁到讨论页', origin: '@软件架构师 09:30 分发 · ⚠ 与另一条同键（同一件事重复分发过）', body: 'Host 按 (工作域, 规范化标题) 判重：重复分发**不新建**，返回已存在的那一条并明确告诉发起者"这次没有新建"。' })}
          ${todoCard({ state: 'answered', title: '确认成员头像是否只收上传图片', origin: '@UI设计师 09:12 分发 · 本讨论', body: '默认只收 image/*（与人类头像同一口径），⛔ 不内置图形 / emoji。', answered: '<div class="annotation">人类在讨论里回复过 ⇒ 时间线那条消息带「回复待办」标记，点它能跳回本条目。</div>' })}
          ${todoCard({ state: 'closed', title: '待办项谁可结案', origin: '@软件架构师 10:13 分发 · 本讨论', body: '默认发起者与人类都可结案。<b>已结案的条目仍留在清单里</b> —— 它是"这件事办完了"的记录；撤回的不留。' })}
        </div>
      </div>
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>移动 390</b> —— 待办在讨论页内单列</div>
    <div class="frame" data-frame="true" data-device="mobile">
      <div class="main">
        ${pageHead({ crumb: '‹ 讨论', title: '将任务拆分一下…', sub: '待办 2', actions: '', tabs: '' })}
        <div class="todoList">
          ${todoCard({ state: 'pending', title: '确认建表脚本的字符集与排序规则', origin: '@插件开发 09:28 分发', body: '需要你拍一个。' })}
          ${todoCard({ state: 'claimed', title: '确认成员头像是否只收上传图片', origin: '@UI设计师 09:12 分发', body: '默认只收图片。' })}
        </div>
      </div>
    </div>
  </div>
</div>
`

/* ------------------------------------------------------- D 成员边界页 */

const memberRowD = ({ active, hue, initial, name, desc, stateText, hasAvatar }) => `
<div class="navRow"${active ? ' aria-current="page"' : ''} style="align-items:flex-start;padding:8px">
  ${hasAvatar
    ? `<span class="avatar avatarRing" data-size="lg" style="--hue:${hue}">${initial}</span>`
    : `<span class="avatar avatarRing" data-size="lg" style="--hue:${hue};background:var(--proto-hover-solid);color:var(--proto-label-tertiary)">${initial}</span>`}
  <span class="who" style="flex:1;min-width:0">
    <span class="name" style="font-weight:600">${name}</span><br>
    <span class="state" style="color:var(--proto-label-tertiary);font-size:11px">${desc}</span><br>
    <span class="state" style="color:var(--proto-label-tertiary);font-size:11px">${stateText}</span>
  </span>
</div>`

const dBody = `
${stylesheetNote({
  title: 'D · 成员边界页（头像 ＋ agent.md）',
  lead: '需求 6 ｜ 对应工作项 D',
  note: '已拍默认：头像只收上传图片、只有人类侧能改、agent.md 入口用"打开文件"按钮、改完下次激活生效（页面上要提示这一句）。这一页把头像在**三处呈现**的尺寸与裁切、未设置时的回退态、以及 agent.md 的入口都钉死。',
})}
<div class="stage">
  <div class="frameWrap">
    <div class="frameLabel"><b>成员编辑页 · 桌面 1408</b> —— 左名册，右编辑</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}">
      ${sidebar()}
      <div class="main">
        ${pageHead({
          crumb: '团队设置 · 成员',
          title: '编辑成员 · @软件架构师',
          sub: '成员身份与展示信息；⛔ 改这里不改它的记忆与技能',
          actions: '<button class="pillBtn" type="button">取消</button><button class="pillBtn" data-variant="primary" type="button">保存</button>',
          tabs: '',
        })}
        <div style="display:flex;flex:1;min-height:0">
          <div style="width:260px;flex:none;box-shadow:1px 0 0 var(--proto-border-l1);overflow-y:auto;padding:10px 8px">
            ${memberRowD({ active: true, hue: 302, initial: '架', name: '@软件架构师', desc: '需求分解、接口与验收判据', stateText: '活跃 · 3 个会话桶', hasAvatar: true })}
            ${memberRowD({ hue: 174, initial: '插', name: '@插件开发', desc: '实现与门禁', stateText: '活跃 · 3 个会话桶', hasAvatar: true })}
            ${memberRowD({ hue: 44, initial: '代', name: '@代码审核', desc: '交付轴与折推', stateText: '活跃 · 2 个会话桶', hasAvatar: false })}
            ${memberRowD({ hue: 212, initial: 'U', name: '@UI设计师', desc: '界面正稿与样式评审', stateText: '已挂起', hasAvatar: false })}
          </div>
          <div class="editor" style="flex:1;min-width:0">
            <div class="field">
              <span class="label">头像</span>
              <div class="avatarEditor">
                <span class="avatar avatarRing" data-size="xl" style="--hue:302">架</span>
                <div style="display:grid;gap:8px;flex:1;min-width:0">
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="pillBtn" data-variant="primary" type="button">上传图片…</button>
                    <button class="pillBtn" type="button">移除头像</button>
                  </div>
                  <span class="hint" style="color:var(--proto-label-tertiary);font-size:12px">只收 <code>image/*</code>，与人类头像同一上限。每张留一个新的不可变引用，写新不覆盖旧 —— 所以"移除"是清空引用，不是删别人的图。</span>
                </div>
              </div>
            </div>

            <div class="hairline"></div>

            <div class="field">
              <span class="label">名称</span>
              <input class="input" value="@软件架构师" aria-label="成员名称">
            </div>

            <div class="field">
              <span class="label">说明<span style="color:var(--proto-label-tertiary);font-weight:400">（短说明：进名册与列表）</span></span>
              <input class="input" value="需求分解、接口与验收判据" aria-label="成员说明">
              <span class="hint">这条进账本，所以必须可回放。长人设⛔ 不放这里 —— 放下面那个文件。</span>
            </div>

            <div class="field">
              <span class="label">模型</span>
              <div style="display:flex;gap:8px">
                <select class="input" style="flex:1" aria-label="模型"><option>deepseek-v4</option><option>deepseek-v4-pro</option></select>
                <select class="input" style="width:200px" aria-label="推理强度"><option>reasoningEffort: high</option><option>medium</option></select>
              </div>
            </div>

            <div class="hairline"></div>

            <div class="field">
              <span class="label">成员说明文件 <code>agent.md</code></span>
              <div class="fileRow">
                <span class="avatar" data-size="sm" style="--hue:212;background:var(--proto-hover-solid);color:var(--proto-label-secondary)">MD</span>
                <span>agent.md</span>
                <span class="meta">1.2 KiB · 最后修改 2026-10-14 08:40</span>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="pillBtn" type="button">打开文件</button>
                <button class="pillBtn" type="button" data-variant="quiet">在访达中显示</button>
              </div>
              <span class="hint">这是这位成员的<b>长说明／人设</b>，放在它的私有命名空间（与 <code>memory.md</code> 同级，只有它与 Host 能读）。⛔ 内容不进账本；⛔ 与上面的短说明不自动同步。入口按已拍默认＝<b>「打开文件」按钮 ＋ 页内只读简介</b>，⛔ 不在页内嵌一个编辑器（那会变成两套真源）。</span>
            </div>

            <div class="noteCard">
              <b>生效时机</b>
              <span>改动在<b>下次激活</b>时生效（当轮不换装）。保存后页面上给这一句提示 —— 否则你会以为没生效。</span>
            </div>

            <div class="field">
              <span class="label">头像的三处呈现（同一张图，三种尺寸）</span>
              <div style="display:grid;gap:10px;background:var(--proto-hover);border-radius:var(--proto-radius-md);padding:12px">
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="width:120px;color:var(--proto-label-tertiary);font-size:12px">成员行 · 24</span>
                  <span class="avatarWrap"><span class="avatar avatarRing" data-size="md" style="--hue:302">架</span><span class="presence"></span></span>
                  <span style="font-size:13px">@软件架构师</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="width:120px;color:var(--proto-label-tertiary);font-size:12px">消息气泡 · 24</span>
                  <span class="avatar avatarRing" data-size="md" style="--hue:302">架</span>
                  <span class="bubble" style="padding:6px 10px">这条消息的作者座位</span>
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <span style="width:120px;color:var(--proto-label-tertiary);font-size:12px">提及芯片 · 18</span>
                  <span class="mention" style="display:inline-flex;align-items:center;gap:4px"><span class="avatar avatarRing" data-size="sm" style="--hue:302">架</span>@软件架构师</span>
                </div>
                <div class="annotation" style="margin:2px 0 0">三处都用同一条色相规则（<code>hsl(memberHue 42% 46%)</code>）与"首字母回退"：图还没解码或读不到字节时，座位不塌、也不留白洞。</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>头像的边界态</b> —— 未设置 / 上传中 / 解码失败 / 成员视角</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}" style="--frame-h:1120px">
      <div class="main">
        ${pageHead({ crumb: 'D · 边界态', title: '头像的四种读数', sub: '每一种都要有明确落点，不留白洞', actions: '', tabs: '' })}
        <div class="editor" style="grid-template-columns:1fr 1fr;align-items:start">
          <div class="field">
            <span class="label">① 未设置</span>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="avatar avatarRing" data-size="xl" style="--hue:44;background:var(--proto-hover-solid);color:var(--proto-label-tertiary)">代</span>
              <span class="hint" style="color:var(--proto-label-tertiary);font-size:12px">回退＝首字母 ＋ 该成员的确定色相。上传区就是这一颗圆本身（点它即选文件）。</span>
            </div>
          </div>
          <div class="field">
            <span class="label">② 上传中</span>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="avatar avatarRing" data-size="xl" style="--hue:302;opacity:.5">架</span>
              <span class="hint" style="color:var(--proto-label-tertiary);font-size:12px">旧图继续显示（不闪白），进度压在圆环上；⛔ 不用整页 loading。</span>
            </div>
          </div>
          <div class="field">
            <span class="label">③ 解码失败（HEIC／坏字节）</span>
            <div style="display:flex;align-items:center;gap:10px">
              <span class="avatar avatarRing" data-size="xl" style="--hue:302">架</span>
              <span class="hint" style="color:var(--proto-label-tertiary);font-size:12px">Host 只校验声明类型，坏字节照样存得下 —— 所以座位必须能"画不出来就回退首字母"，并给一句"这张图没能显示"。</span>
            </div>
          </div>
          <div class="field">
            <span class="label">④ 成员视角（只读）</span>
            <div class="noteCard">
              <b>成员看不到"编辑"入口</b>
              <span>只有人类侧能改头像与 <code>agent.md</code>（已拍默认）。成员能读自己的 <code>agent.md</code>，但界面上没有上传/移除按钮。</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
`

/* ------------------------------------------------ B 工作域工作目录集 */

const rootRow = ({ primary, path, exists }) => `
<div class="fileRow" style="background:${exists ? 'var(--proto-hover)' : 'var(--proto-warn-tertiary)'}">
  <span style="color:var(--proto-label-tertiary);cursor:grab" aria-hidden="true">⋮⋮</span>
  <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${path}">${path}</span>
  ${primary ? '<span class="stateTag" data-state="claimed">默认根</span>' : ''}
  ${!exists ? '<span class="stateTag" data-state="pending">不存在</span>' : ''}
  <button class="iconBtn" type="button" aria-label="上移 ${path}">↑</button>
  <button class="iconBtn" type="button" aria-label="下移 ${path}">↓</button>
  <button class="iconBtn" type="button" aria-label="从目录集移除 ${path}">✕</button>
</div>`

const bBody = `
${stylesheetNote({
  title: 'B · 工作域工作目录集',
  lead: '需求 7 ｜ 对应工作项 B',
  note: '已拍：频道给默认 ＋ 成员可在该频道内覆盖。原型按"目录不存在 ⇒ 拒绝该域激活并给诊断"画（未拍项第 2 条，默认拒绝）。另外画上限（默认 4）与成员视角的只读展示。',
})}
<div class="stage">
  <div class="frameWrap">
    <div class="frameLabel"><b>频道设置 · 桌面 1408</b> —— 默认目录集（有序）＋ 成员覆盖</div>
    <div class="frame" data-frame="true" data-device="${frameDevice}">
      ${sidebar()}
      <div class="main">
        ${pageHead({
          crumb: '团队设置 · 频道',
          title: '频道「dsh-agent-team」',
          sub: '默认工作目录集 · 成员可在本频道内覆盖',
          actions: '<button class="pillBtn" type="button">取消</button><button class="pillBtn" data-variant="primary" type="button">保存</button>',
          tabs: '',
        })}
        <div class="editor">
          <div class="field">
            <span class="label">默认工作目录集<span style="color:var(--proto-label-tertiary);font-weight:400">（有序；第 1 项＝本域会话的默认根）</span></span>
            <div style="display:grid;gap:8px">
              ${rootRow({ primary: true, path: '/Users/jiaozipan/jzp_private/aistudy/dsh-agent-team', exists: true })}
              ${rootRow({ path: '/Users/jiaozipan/jzp_private/starmerx/ai_product/数字员工', exists: true })}
            </div>
            <div class="fileRow" style="border:1px dashed var(--proto-border-l3);background:transparent">
              <input class="input" placeholder="加一个绝对路径…" aria-label="新增工作目录" style="box-shadow:none;background:transparent">
              <button class="pillBtn" type="button" disabled>添加</button>
            </div>
            <span class="hint">已到上限 4 个（这条列表还空着 2 个位置）；到达上限时"添加"禁用并说明原因，⛔ 不让点了以后才报错。</span>
          </div>

          <div class="warnCard">
            <b>激活被拒绝：目录集里有一个目录不存在</b>
            <span>目录集是账本里的配置，<b>不从文件系统推断</b>。所以某个目录被移走/改名时，这一域<b>不激活</b>并给出诊断，而不是悄悄换一个根继续跑 —— 换根会让它在错的仓库里干活。</span>
            <span style="display:flex;gap:8px;flex-wrap:wrap;margin-top:2px">
              <button class="pillBtn" type="button">编辑目录集</button>
              <button class="pillBtn" type="button" data-variant="quiet">暂时改用「dsh-agent-team」单根</button>
            </span>
          </div>

          <div class="field">
            <span class="label">成员覆盖（本频道内）</span>
            <div style="display:grid;gap:8px">
              <div class="fileRow">
                ${avatarImg('代', 44, 'sm')}
                <span>@代码审核</span>
                <span class="meta">用频道默认</span>
                <button class="pillBtn" type="button" data-variant="quiet">覆盖…</button>
              </div>
              <div class="fileRow">
                ${avatarImg('插', 174, 'sm')}
                <span>@插件开发</span>
                <span class="meta">已覆盖 · 2 个目录</span>
                <button class="pillBtn" type="button" data-variant="quiet">编辑覆盖</button>
              </div>
            </div>
            <span class="hint">覆盖是本频道内的：换频道不等于换掉它的覆盖，⛔ 覆盖也不改频道默认。两者关系在界面上永远写成"默认 → 覆盖后"。</span>
          </div>

          <div class="field">
            <span class="label">成员视角：我能干活的目录（只读）</span>
            <div class="workspaceScope" style="margin:0">
              <span>本域涉及目录</span>
              <span class="roots">
                <span class="rootChip" data-primary="true">dsh-agent-team（默认根）</span>
                <span class="rootChip">ai_product/数字员工</span>
              </span>
            </div>
            <span class="hint">这段话写进<b>域说明</b>——成员按绝对路径访问，沙箱本就允许。⛔ 不新增工具、⛔ 不让成员改它。</span>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="frameWrap">
    <div class="frameLabel"><b>移动 390</b> —— 目录集单列，行内动作收进菜单</div>
    <div class="frame" data-frame="true" data-device="mobile">
      <div class="main">
        ${pageHead({ crumb: '‹ 团队设置', title: '工作目录集', sub: '频道「dsh-agent-team」', actions: '', tabs: '' })}
        <div class="editor">
          <div class="field">
            <span class="label">默认目录集</span>
            <div style="display:grid;gap:8px">
              <div class="fileRow"><span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">dsh-agent-team</span><span class="stateTag" data-state="claimed">默认根</span><button class="iconBtn" type="button" aria-label="更多操作">⋯</button></div>
              <div class="fileRow"><span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">ai_product/数字员工</span><button class="iconBtn" type="button" aria-label="更多操作">⋯</button></div>
            </div>
          </div>
          <div class="warnCard"><b>一个目录不存在</b><span>该域不激活并给诊断；出路在下面的两个按钮。</span>
            <span style="display:flex;gap:8px"><button class="pillBtn" type="button">编辑</button><button class="pillBtn" type="button" data-variant="quiet">单根应急</button></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
`

/* ------------------------------------------------------------------ 写出 */

const targets = [
  { dir: 'proto-c-artifact-jump', name: 'artifact-jump.html', title: 'C · 产物跳转 ＋ 讨论页右侧预览面板', html: cBody },
  { dir: 'proto-d-member-boundary', name: 'member-boundary.html', title: 'D · 成员边界页（头像 ＋ agent.md）', html: dBody },
  { dir: 'proto-e-human-todos', name: 'human-todos.html', title: 'E · 人类待办清单（与 claim 并排可辨）', html: eBody },
  { dir: 'proto-b-workspace-roots', name: 'workspace-roots.html', title: 'B · 工作域工作目录集', html: bBody },
]

for (const target of targets) {
  /**
   * 两种交付图同源：桌面档画 1408，移动档画 390 ＋ 去掉原型控制条。
   * 在这里改标记（不靠运行时 JS）：headless 截图与查询串的时序靠不住。
   */
  const emit = (mobile) => {
    frameDevice = mobile ? 'mobile' : 'desktop'
    let body = target.html
    if (mobile) {
      body = body
        .replaceAll('data-device="desktop"', 'data-device="mobile"')
        .replaceAll('（桌面 1408）', '（移动 390）')
        .replaceAll('桌面 1408×860', '移动 390×780')
        .replaceAll('桌面 1408）', '移动 390）')
        .replace(/<div class="toolbar"[\s\S]*?<\/div>\n<div class="toolbar"[\s\S]*?<\/div>\n/g, '')
    }
    return document_({ title: `原型 · ${target.name}`, body, mobile })
  }
  const dir = join(scratch, target.dir)
  mkdirSync(join(dir, 'prototype'), { recursive: true })
  const file = join(dir, 'prototype', target.name)
  writeFileSync(file, emit(false), 'utf8')
  const mobileFile = join(dir, 'prototype', target.name.replace(/\.html$/, '.mobile.html'))
  writeFileSync(mobileFile, emit(true), 'utf8')
  console.log(`wrote ${file.replace(repo + '/', '')} ＋ ${mobileFile.replace(repo + '/', '')}`)
}
console.log('\n下一步：bash .scratch/active/proto-kit/shoot.sh 生成明暗/桌面移动截图')

