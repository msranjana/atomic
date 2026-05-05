# sequential-describe-summarize

Two stages passing data via `s.save()` → `s.transcript(handle)` — the canonical handoff pattern between sessions.

## Run

```bash
bun install
bun run claude-worker.ts --topic="Bun"
```

## What's here

- `claude/` — the two-stage workflow definition
- `claude-worker.ts` — Commander entrypoint

Stage 1 describes the topic and saves its session id; stage 2 reads stage 1's transcript path and summarizes it. The handle returned by `ctx.stage(...)` is how downstream stages address upstream output.
