# review-fix-loop

Draft → loop(review → fix) with bounded iterations and early exit on a `CLEAN` verdict. A reliable review gate that shows how a stage's return value (`handle.result`) drives TypeScript control flow.

## Run

```bash
bun install
bun run claude-worker.ts --topic="adopting Bun" --max_iterations=3
```

## What's here

- `claude/` — workflow with the bounded review loop
- `claude-worker.ts` — Commander entrypoint

The loop is a plain `for` with an `if (verdict === "CLEAN") break;` — no DSL, no state machine. That's the workflow SDK's whole pitch.
