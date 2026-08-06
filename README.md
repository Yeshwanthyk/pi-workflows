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
- `/workflows` dashboard and run inspection
- DSL primitives: `phase()`, `agent()`, `parallel()`, and `args`

Drafts are written under `~/.pi/agent/workflows/drafts/<draftId>/draft.json`; run artifacts are written under `~/.pi/agent/workflows/<runId>/`. Press `Ctrl+O` on a prepared draft result to review its preview, phases, limits, artifact path, and exact immutable script before approval. Multiple approved background workflows share a process-global capacity pool.

## Development

```sh
npm install
npm run check
npm test
```

## Provenance and licensing

See [`NOTICE.md`](NOTICE.md). The upstream repository did not declare a license at the extracted revision, so this repository is intentionally private/local and marked `UNLICENSED`.
