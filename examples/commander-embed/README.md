# commander-embed

Mount an atomic workflow under a parent Commander CLI by calling `runWorkflow({ workflow, inputs })` inside a Commander action — alongside a plain Commander sibling command. No re-entry boilerplate: the SDK ships its own orchestrator entry script.

## Run

```bash
bun install
bun run cli.ts greet --who=Alex
bun run cli.ts status                # plain Commander sibling
bun run cli.ts --help                # all commands
```

## What's here

- `claude/` — the embedded workflow
- `cli.ts` — parent Commander tree with `greet` (workflow) and `status` (plain command)
