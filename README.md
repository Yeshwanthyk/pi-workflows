# pi-workflows

Local Pi package extracted from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) for personal evaluation.

It provides model-authored, multi-agent workflows with deterministic draft previews, ordered phases, bounded parallel fan-out, structured outputs, concurrent background execution, clean cancellation, persisted artifacts, and a permission-restricted JavaScript orchestration sandbox.

## Install locally

```sh
pi install /Users/yesh/code/personal/pi-workflows
```

Reload an existing Pi session with `/reload`.

## Interface

- `workflow` tool: submit `{ preview, script, args?, background? }` to prepare an immutable draft; after a newer user response, submit `{ draftId }` to execute it
- `workflow_cancel` tool: abort one exact active run and wait for clean settlement
- `/workflow-draft [draftId]` source-split review for pending immutable drafts
- `/workflow-saved [name]` lists validated reusable definitions
- `/workflows` dashboard and run inspection
- DSL primitives: `phase()`, bounded progress-only `log()`, `agent()`, `parallel()`, streaming `pipeline()`, and `args`
- Protective budget defaults (omitted `limits` groups are no longer
  unbounded): 400 total turns, 200k total output tokens, 30-minute
  per-agent wall, 2-hour run wall. Drafts warn when declared budgets fall
  below sizing floors; `skills/workflow-budgets/SKILL.md` documents the
  sizing rules for authors

Drafts are written under `~/.pi/agent/workflows/drafts/<draftId>/draft.json`; run artifacts are written under `~/.pi/agent/workflows/<runId>/`. Run `/workflow-draft <draftId>` to review the plan and exact immutable source side by side; pressing `a` only prefills an explicit approval message for you to submit. Multiple approved background workflows share a process-global capacity pool.

Saved workflow files are discovered in precedence order from
`<cwd>/.pi/workflows/<name>.js`, `<cwd>/.agents/workflows/<name>.js`, and
`~/.pi/agent/workflows/<name>.js`. They must be regular, non-symlink files no
larger than 512 KiB with static workflow metadata. Preparing one snapshots its
exact source, SHA-256, and provenance into the same immutable draft flow; it
never bypasses review or the newer-user-response approval boundary.

## Development

```sh
npm install
npm run check
npm test
```

## Workflow performance harness

The deterministic CLI harness runs the production workflow parser, permissioned
sandbox, controller, persistence path, and extracted execution core with an
offline synthetic agent seam:

```sh
npm run harness -- validate tools/workflow-harness/scenarios/basic-sequential.json
npm run harness:smoke
npm run harness:bench -- --out /tmp/workflow-baseline.json
npm run harness -- compare /tmp/workflow-baseline.json /tmp/workflow-candidate.json
```

`run` executes once, `bench` aggregates warmup/measured iterations, and
`compare` fails with exit code 3 when a compatible candidate stage exceeds the
larger of 20% or 2 ms over baseline. Synthetic runs use temporary project and
artifact directories and never read credentials or the user's workflow history.
Live-provider benchmarking is intentionally outside this deterministic baseline.

## Provenance and licensing

See [`NOTICE.md`](NOTICE.md). The upstream repository did not declare a license at the extracted revision, so this repository is intentionally private/local and marked `UNLICENSED`.
