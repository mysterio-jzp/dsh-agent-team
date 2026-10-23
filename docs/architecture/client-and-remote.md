# Typed Remote and Client boundaries

English | [中文](client-and-remote.zh.md)

## Typed Remote
`@Remote` annotations on the Team service are inputs to `scripts/generate-typert.mjs`, which uses Harness `WorkspaceAnalyzer` and `FaceModelEmitter` to emit Host and Client artifacts under `packages/agent-team/lib/`.

```text
Host face declaration → generate:typert → Typert Host + Remote client → ctx.remote.$mount(...) → Client remote service
```

`InvocationDescriptor` is local reflection metadata, not a wire message. Wire fields remain explicit typed values. Update declarations/tests, regenerate, and run typecheck/build; never hand-edit artifacts.

Read requests state their purpose instead of sharing one projection shape. `view` takes `includeCatalog` only when the caller wants the Task/Thread/Claim catalog of the whole request scope — the address book the model-facing `team_view` renders; the Client's reads never ask for it and render the page they requested.

## Remote failure vocabulary
Generated Remote methods resolve a `RemoteResult`: `{ ok: true, value }` carries the business result, `{ ok: false, error }` carries a failure whose stable `code` discriminates and whose `details` the code narrows without a cast.

- Business rejections — `unread_required`, `stale_revision`, `confirmation_required` — stay result unions: they are the normal control flow the Client already models, not Remote errors.
- An expected cross-Remote failure that needs its own Client branch is thrown as a `RemoteError`; the owner declares its code by merging it into `RemoteErrorDetailsMap`, and Team merges its codes into the public types entry both faces compile against. Team's first code is `team/attachment-not-found`: the attachment read separates a gone cache entry from every other failure.
- Clients branch on `code`, never on message text — the message is a human diagnostic, not contract. Unknown codes and unclassified Host exceptions arrive as `gateway/internal`, so each branch keeps a generic fallback: the attachment preview settles a not-found into the expired chip, caches no other failure, and lets a later render retry the Host.

## Client plugin and slot composition
The external Client plugin leaves the shipped Shell as outer-layout owner. Team adds one footer entry and owns no panel of its own: it reaches the conversation seat by shadowing, and shadows three seats:

```text
sidebar.footer.action       additive Team entry, order 100
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
sidebar.settings            Team shadow, priority -100
```

Activation mounts `agentTeamRemote`, waits for `remote.agentTeam`, then registers the Team entry and the mode shadows. `dsh.client.inject` describes the module graph but does not guarantee apply order or service readiness; use `ctx.slots.inject()` when a declaration may appear later.

Team mode owns the conversation seat, not a panel: `TeamNavigation.mode` is the one criterion for whether the mode stands, and its seat is the `main` shadow keyed `conversation`, which paints while that mode holds and no Channel Session view is embedded.

The entry at the sidebar's foot beside the shipped Settings row clears whatever global panel holds the column and then flips the mode. Keeping that selection clear is also what leaves the shell's right rail available, because the shell hides the rail's Session content while any panel is selected; a global panel taking the column therefore ends the mode.

A null selection is left alone — an embedded Channel Session view clears the panel to own the column and the mode has to survive that. A restored mode paints through its own seat without selecting anything, and a panel already selected at mount keeps the column while the mode stands down.

A slot parent's `children` declaration is both render site and authority. Team's `sidebar.workspaces` shadow must not redeclare shipped `sidebar.workspaces.directoryFlow`; Harness SlotCore rejects duplicate live declarations. Do not copy private WorkspaceBrowser, ConversationRoot, Shell, or private CSS. Use public Harness services and exports, such as `ctx.workspaces.pickDirectory()`, and record limitations rather than depending silently on private implementation.

## Client data and presentation boundary
Client components do not reach into `ctx`, the operation ledger, or Host classes. Data and callbacks arrive through slot owner props, runtime props, declared stores, or injected faces. Presentation consumes Host projections and local navigation state and does not invent durable facts.

New Channel composition defaults to taskless and exposes default-off 「作为任务」 for atomic Task creation. Taskless Threads retain reply/read/follow/Inbox behavior but gate status, Claims, and resolution controls until promotion. Promotion is non-optimistic and followed by rereading Thread and supplemental projections.

The Human Client consumes the Host's Inbox projection, never keeps a parallel Inbox authority, and acknowledges nothing by opening the page. That projection is the 「收件箱 / Inbox」 queue: a merged per-Workspace badge and page covering each reader's whole unread slice, where mentions are counted inside it, never its admission rule.

It also carries a second 「最近活跃」 slice that an Agent's Inbox never does — the Threads that reader has written a Message in, so a Thread they replied to is theirs whether or not they follow it. That slice is newest activity first, each Workspace's own slice bounded to ten while the merged page shows at most five.

The Thread composer and member manager consume the Host's `threadObservations` snapshot: current followers, Thread members with follow state, and removed-member ids. Candidate selection changes only the draft; invitations and re-invitations require a confirmed successful Human send. `removeThreadMember` is an explicit Human-only mutation, and the Client refreshes Host projections after its result rather than removing a row optimistically.

Team navigation mode, Workspace selection, the last Channel/Thread, and the Inbox page position are browser-persisted; unread and Attention are Host-owned.

The Team sidebar keeps Channels/Agents ordering as a browser-only `localStorage` preference, merged over Remote defaults.

An embedded Channel Session uses the shipped composer unmodified: the Team registers no Channel Session composer surface — no seat shadow, no trigger sources, no dock strip. rc.1 moved the trigger-menu overlay into `conversation.composer.bar`'s children, where a shadowing entry would inherit — and strand — the overlay. The Team's own command/member reference entry points carried no irreplaceable value over the shipped vocabulary, so they were removed together.

Ordinary and Channel Sessions share the same composer and vocabulary. Reuse public primitives and `--dsw-*` tokens, keep CSS in CSS Modules, and preserve Team mode restoration and narrow layouts.

## Opening a cached attachment in the right rail
A non-image attachment block opens its cached copy in the Shell's right rail. The read is `getAttachment` against the Host's cache; the address is a `dsh-resource://file/…` in the Session scope, so the rail's fallback text type claims it and dispatches by extension.

`ctx.sidebarRight.openResource` returns `void` and reports nothing: for a Session that is on screen but was never adopted it records no tab and raises no error, which makes "the rail took the address" and "nothing happened" indistinguishable at the call site.

The block therefore reads the rail's own `openTabs` record after opening and looks for the addressed tab. The record decides this, never the tab count: the rail focuses an existing tab instead of adding one, so a second click on the same attachment leaves the count unchanged while opening exactly as asked.

Three outcomes stay separate, because only the first is a fact the call established:

- **The addressed tab is recorded** — opened.
- **A registered type refuses the address or none claims it** — `unsupported`, stated as no available viewer.
- **Neither an error nor a recorded tab** — `unknown`. `open` answers nothing, so this call cannot say why; it says only that it could not confirm the open.

**The `unknown` branch is covered by unit tests only — there is no real-interface reading of it**, because reaching that state on the real surface needs a forged Host selection state. Do not read it as machine-verified.

Three layers stay distinct, and the wording keeps them distinct:

- **No registered type claims the address** — `openResource` throws, and the block says the format has no available viewer.
- **A viewer claimed the address and could not decode the bytes** — the viewer states this inside its own panel; Team never sees it. A binary, non-UTF-8 file lands here, because the Host routes unknown extensions to plain-text reading rather than refusing them.
- **The cache entry is gone** — `team/attachment-not-found`, rendered as an expired copy the sender must re-send.

The Host's viewer says 「该格式文件暂时无法预览」 where the block says 「这个格式没有可用的查看器」. The two phrasings stay different on purpose: the viewer knows it claimed the file and could not decode it, while Team only knows nobody claimed it. Unifying the wording would make one side assert something it does not know.

The rail's header shows the viewer-supplied absolute cache path, which contains the Host user name. Team does not mask it — the path is the viewer's own presentation — and sharing a screenshot of it outside the team discloses the user name and local directory layout.
