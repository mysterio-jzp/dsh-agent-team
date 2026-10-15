# 01 — Persist work-domain directory configuration

**What to build:** A Human can configure an ordered Channel default directory set and a Member×Channel override, and a work domain snapshots its effective set on first successful Session binding so its cwd and declared directories remain stable across later config edits and Session generations.
**Blocked by:** None — the Host configuration and first-bind snapshot semantics are frozen.
**Status:** complete

- [x] Channel defaults and Member×Channel overrides are durable ledger facts with typed Host update operations; an absent override inherits the Channel default.
- [x] Operation replay and same-request retry preserve exact ordered paths; clear operations remove config rather than infer it from the filesystem.
- [x] Reject malformed or over-limit sets at the write boundary; do not require existence until activation.
- [x] First successful domain binding snapshots the complete effective ordered set: Member override, then Channel default, then the Thread's Channel Workspace root. Later config edits do not alter the bound domain or its replacement Sessions.
- [x] At activation, validate each directory in the domain snapshot, use item 1 as cwd, declare later items in that domain's instructions, and fail the domain with a useful diagnostic if any configured directory is unavailable.
- [x] With no configured Channel/member set at binding, snapshot the Thread's Channel Workspace root; no additionalDirectories or new model-facing tool.
- [x] Tests cover Channel default, Member override, inheritance, clear, config/snapshot cold replay and idempotency, missing-path activation refusal, stable cwd/instructions across edits and replacement Sessions, and no cross-domain bare relative path leakage.
- [x] Keep Req5 UI and the `memberScopeSessions` Client projection outside this issue.
