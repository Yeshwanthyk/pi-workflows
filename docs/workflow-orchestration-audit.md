# Workflow orchestration audit

**Scope:** current pi-workflows orchestration, with only the smallest justified action
recorded below. This is an audit, not a proposal for a broader orchestration
platform.

## Current strengths

- Draft execution has a deliberate approval boundary: immutable draft/artifact
  matching plus same-session and same-cwd checks (`extensions/workflows/drafts.ts`,
  `extensions/workflows/index.ts`).
- Run cancellation is typed, first-reason-wins, settlement-aware, and bounded;
  child teardown shares the same abort/settle authority (`extensions/workflows/controller.ts`,
  `extensions/workflows/cancellation.ts`, `extensions/shared/child-session.ts`).
- Capacity, budgets, progress projections, and durable run artifacts are explicit
  and test-covered (`extensions/workflows/limits.ts`, `controller.ts`,
  `artifacts.ts`). Child sessions also deny recursive orchestration tools
  (`extensions/shared/child-session.ts`).
- The quality gate is intentionally low-noise: Oxlint correctness plus the seven
  Anti-Slop rules already clean in the repository. The adoption evidence is
  `/tmp/pi-workflows-scouts/oxlint.md` (§§4a, 4c, 5); the vendored source is
  `tools/oxlint/anti-slop/`.

## Ranked findings

### 1. Act now — cross-session cancellation (fixed here)

`activeRuns` is process-global, so `workflow_cancel` must authorize against the
launching Pi session, not only `runId`. The public tool now passes
`ctx.sessionManager.getSessionId()` (`extensions/workflows/index.ts`), and
`cancelActiveWorkflowRun` rejects a mismatched `details.sessionId`
(`extensions/workflows/cancellation.ts`). The focused regression test remains in
`extensions/workflows/cancellation.test.ts` and proves that the other session
cannot trigger the controller while same-session cancellation still settles.

Original gap and exact evidence: `/tmp/pi-workflows-scouts/architecture.md` §4e,
which identified `index.ts:577` calling cancellation without a session gate and
ranked the fix at §6(1).

### 2. Defer — workflow parent-ref, mailbox, and resume features

Do not add parent-reference graphs, cross-session mailboxes, or workflow resume
in this change. Pi's current contract deliberately says there is no run resume;
a failed run is re-run (`extensions/workflows/index.ts` header and
`/tmp/pi-workflows-scouts/architecture.md` §4b). Keep the existing draft/artifact
persistence and per-run completion promise as the present boundary.

The comparison evidence shows these are substantial lifecycle systems, not small
follow-ups: Claude records `ownerAgentId`/`parentAgentId` and `pendingMessages`,
with persisted `queued_command` mailboxes and transcript reconstruction
(`/tmp/pi-workflows-scouts/claude.md` §§3–4); Codex uses
`core/src/agent/control.rs`, `core/src/agent/control/spawn.rs`,
`core/src/session/input_queue.rs`, and the durable graph migration
`state/migrations/0021_thread_spawn_edges.sql`
(`/tmp/pi-workflows-scouts/codex.md` §§1, 3, 5). Those capabilities remain
explicitly deferred rather than inferred from this audit.

### 3. Claude/Codex comparison — evidence for future shaping, not scope

| Concern                  | Claude evidence                                                                                                    | Codex evidence                                                                                                                                 | Current pi fit                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Ownership and completion | `taskRegistry`/`ownerAgentId` plus `task-notification` inbox delivery (`/tmp/pi-workflows-scouts/claude.md` §§1–3) | `AgentControl`, `AgentPath`, and parent provenance (`core/src/agent/control.rs`, `core/src/turn_metadata.rs`)                                  | Pi has session-owned runs, completion promises, and activity events; the cancellation gate closes the immediate isolation hole. |
| Mailbox and wake-up      | Persisted `queued_command` and `pendingMessages` (`/tmp/pi-workflows-scouts/claude.md` §4)                         | `InputQueue` mailbox is in-memory; completion mail is `trigger_turn=false` (`core/src/session/input_queue.rs`, `core/src/session/handlers.rs`) | Pi's current promise/follow-up behavior is sufficient for now; no mailbox feature is justified by this task.                    |
| Resume and lifecycle     | `resumeSessionId`/`sessionStore` and transcript reconstruction (`/tmp/pi-workflows-scouts/claude.md` §3–4)         | V2 restore/lazy reload in `core/src/agent/control/spawn.rs`; persisted edges in `state/migrations/0021_thread_spawn_edges.sql`                 | Pi intentionally has no workflow resume; preserve that explicit non-goal.                                                       |

These reports are local scout evidence, not claims that pi should replicate
Claude or Codex: `/tmp/pi-workflows-scouts/architecture.md`,
`claude.md`, `codex.md`, and `oxlint.md`.
