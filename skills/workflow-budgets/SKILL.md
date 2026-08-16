---
name: workflow-budgets
description: Size pi-workflows run budgets from the task instead of guesses, pin providers, and avoid the retry loop of tight shared turn/output caps. Use when authoring a workflow script's `meta.limits`, when a workflow keeps dying on "Workflow turn/output token/wall limit exceeded", or when asked to plan parallel workflow slices.
---

# Workflow budgets that don't kill healthy agents

The pi-workflows extension enforces `meta.limits` literally across the whole
run. The dominant real-world failure is **not** stuck agents — it is healthy
agents killed by budgets that were sized too small, retried with slightly
larger guesses, and killed again.

## Defaults (applied when a group is omitted)

| Group                | Default         | Notes                                             |
| -------------------- | --------------- | ------------------------------------------------- |
| `total.turns`        | 400             | Shared across **all** agents in the run           |
| `total.outputTokens` | 200_000         | Shared; includes whole-file reads and bash output |
| `agent.wallMs`       | 1_800_000 (30m) | Per agent wall clock                              |
| `workflow.wallMs`    | 7_200_000 (2h)  | Whole-run wall clock                              |
| `total.costUsd`      | none            | Provider-dependent; set only if you must          |

Omission is safe: omitted groups use these protective defaults. **Prefer
omitting a group over setting a tight cap.**

## Sizing rules (when you must cap)

- **`total.turns` is a shared pool.** Allow ~40–60 turns per agent plus
  headroom for verification phases — reviewers burn turns re-running
  checks (`git diff`, `rg`, `tsc`, `bun test`). `turns = agents × 50 + 40`.
- **`total.outputTokens` is also shared** and counts every `read`/`bash`
  result. Budget ~5–10k output tokens per expected agent deliverable, then
  add the verification overhead. `outputTokens = agents × 8_000 + 20_000`.
- **`agent.wallMs`** for implementation agents: ≥ 15 minutes. Review-only
  agents can be tighter (≥ 5m). Long adapters/Effect refactors routinely
  take 15–30m of productive work.
- **Floors:** if you cap at all, keep `turns ≥ 40`, `outputTokens ≥ 20k`,
  `agent.wallMs ≥ 10min`, or the draft will carry a budget advisory and
  likely die mid-work.
- **Concurrency:** thin parallel slices beat deep serial phases — small
  slices finish inside budgets; but never share _writers_ on the same files.

## Providers and auth

- Pin `provider` on every agent when auth differs from the session default:
  `agent(prompt, { provider: "openai-codex", model: "gpt-5.6-luna" })`.
- An unauthenticated default provider fails **every** agent in <1s at
  launch, and the run can still report `completed` — check for
  `No API key found for <provider>` in agent errors.

## Reading the failure modes

- `Workflow turn limit of N exceeded` → the shared pool ran out; count
  turns per phase and raise `total.turns` (or split into smaller slices).
- `Workflow output token limit of N exceeded` → reads/bash dumps burned the
  shared output pool. The charged agent may be innocent — a sibling consumed
  it. Raise the cap or have agents use targeted reads (offsets/limits).
- `Agent wall limit of N ms exceeded` → that one agent needed more wall
  time; raise `agent.wallMs` rather than re-running it.
- `completed — 0/N agents ok` → auth or budget killed everything at launch;
  the script itself returned. Fix the cause, not the status.
- If a sibling died with a generic abort while another agent tripped a
  budget, the run's `workflow.json` `termination.code` is authoritative.
