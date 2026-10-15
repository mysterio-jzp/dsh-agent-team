# Req7 — Work-domain directory sets

## Frozen behavior

Source: the approved context-isolation design, §10.2–10.4. This work extends the Req5 Host work-domain binding already present at `6d6c02f`.

- A directory set is ordered: item 1 is the domain Session's cwd; later entries are additional directories declared in the domain's instructions and accessed by absolute path.
- A Channel stores its default set; a Member×Channel membership may override it. A missing override inherits the Channel default.
- No configured set preserves current behavior: the Thread's Channel Workspace root is the Session cwd. No filesystem discovery or inference.
- At most four directories. An unavailable/missing directory refuses activation with a useful diagnostic.
- No Harness `additionalDirectories` integration, new model-facing tool, or UI work in this Host slice.
- Paths from a prior domain must not be injected as bare relative paths into a different domain.

## Frozen binding snapshot

Architecture froze the update semantic on 2026-10-15 (see §10.2 and §10.4 of the approved design): the first successful `member-scope-session-bound` operation snapshots the effective complete ordered directory set for that domain. Resolve it from the Member×Channel override, otherwise the Channel default, otherwise the Workspace root in effect at that bind. The current and later Session generations for that domain retain the snapshot; later config edits affect only domains not yet bound. Do not silently rebind an existing domain to move its cwd or directory set; migration is outside this change.

## Out of scope

- Changing Req5's thread bucket identity or context isolation behavior.
- Exposing `memberScopeSessions` to the Client; this is a separate Host→Client contract that must be scoped by architecture.
- Req5 UI or the `proto-b` pure-scratch integration, which remains separately sequenced.
