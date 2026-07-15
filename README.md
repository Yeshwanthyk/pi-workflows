# pi-workflows

Local Pi package extracted from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) for personal evaluation.

It provides model-authored, multi-agent workflows with ordered phases, bounded parallel fan-out, structured outputs, background execution, persisted artifacts, and a permission-restricted JavaScript orchestration sandbox.

## Install locally

```sh
pi install /Users/yesh/code/personal/pi-workflows
```

Reload an existing Pi session with `/reload`.

## Interface

- `workflow` tool
- `/workflows` dashboard and run inspection
- DSL primitives: `phase()`, `agent()`, `parallel()`, and `args`

Run artifacts are written under `~/.pi/agent/workflows/<runId>/`.

## Development

```sh
npm install
npm run check
npm test
```

## Provenance and licensing

See [`NOTICE.md`](NOTICE.md). The upstream repository did not declare a license at the extracted revision, so this repository is intentionally private/local and marked `UNLICENSED`.
