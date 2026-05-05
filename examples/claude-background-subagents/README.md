# claude-background-subagents

Two-stage Claude workflow that exercises the SDK's in-flight subagent gating. Stage 1 spawns three **background** subagents (`run_in_background: true`) and ends its turn immediately; stage 2 verifies all three finished before it started.

## Run

```bash
bun install
bun run claude-worker.ts
```

Each subagent writes a marker file under `/tmp/atomic-bg-<n>.txt` after a deterministic delay. Without the in-flight gating, stage 2 would race past the unfinished subagents and either find missing files or hit FD pressure on the tmux server.

## What's here

- `claude/` — the two-stage workflow definition
- `claude-worker.ts` — Commander entrypoint
