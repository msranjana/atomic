# Pi Workflow Authoring Reference

Use this when creating or editing user-facing workflow definition files for `@bastani/workflows`.

## Where workflow files live

Atomic/pi discovers workflows from these user-facing locations, in this override order:

1. Configured project files from `.atomic/extensions/workflow/config.json` (`workflows.<name>.path`). Legacy `.pi/...` config paths are also considered.
2. Project-local files in `.atomic/workflows/*.{ts,js,mjs,cjs}`. Legacy `.pi/workflows/` is also checked.
3. Configured global files from `~/.atomic/agent/extensions/workflow/config.json`. Legacy `~/.pi/...` config paths are also considered.
4. User-global files in `~/.atomic/agent/workflows/*.{ts,js,mjs,cjs}`. Legacy `~/.pi/agent/workflows/` is also checked.
5. Package-provided files from installed Atomic/pi packages.
6. Bundled workflows shipped with `@bastani/workflows`.

Package-provided workflows can be exposed either explicitly through the app-name manifest key in `package.json` or implicitly through a conventional directory:

```json
{
  "name": "my-atomic-workflows",
  "keywords": ["pi-package"],
  "atomic": {
    "extensions": ["./src/index.ts"],
    "workflows": ["./workflows"]
  }
}
```

- For Atomic, prefer `atomic.workflows` and `atomic.extensions` in new examples.
- `pi.workflows` and `pi.extensions` remain backwards-compatible shims for existing pi packages.
- If no manifest declares workflows, conventional `workflows/` is auto-discovered. Singular `workflow/` is also accepted.
- App-level config similarly prefers `<appName>Config` (for example `atomicConfig`); legacy `piConfig` is still read as a shim.

In a normal consumer project, import from the package:

```ts
import { defineWorkflow } from "@bastani/workflows";
```

If you are editing an existing workflow file, follow the import style already used nearby.

## Authoring shape

```ts
import { defineWorkflow } from "@bastani/workflows";

export default defineWorkflow("my-workflow")
  .description("Short description shown in workflow listings.")
  .input("prompt", {
    type: "text",
    required: true,
    description: "Task or question for the workflow.",
  })
  .run(async (ctx) => {
    const prompt = String(ctx.inputs.prompt);

    const scout = await ctx.task("scout", {
      prompt: `Map the relevant context for: ${prompt}`,
      context: "fresh",
    });

    const reviews = await ctx.parallel([
      { name: "quality", prompt: "Inspect quality risks using this context: {previous}", previous: scout },
      { name: "runtime", prompt: "Inspect runtime concerns using this context: {previous}", previous: scout },
    ], { concurrency: 2 });

    const final = await ctx.task("synthesis", {
      prompt: "Synthesize findings and recommend next steps.",
      previous: reviews,
    });

    return { summary: final.text, reviewer_count: reviews.length };
  })
  .compile();
```

`prompt` and `task` are aliases for task text. Prefer `prompt` inside authored workflow files because it mirrors the lower-level `stage.prompt(...)`; `task` remains useful in direct tool calls and chain examples.

## Builder facts

- `defineWorkflow(name)` requires a non-empty string name.
- Names normalize for lookup: trim, lowercase, whitespace/underscore to hyphen, remove other punctuation, collapse hyphens.
- `.description(text)` sets the listing text.
- `.input(key, schema)` declares typed user inputs.
- `.run(fn)` defines the workflow body.
- `.compile()` returns the workflow definition for discovery.

## Inputs

Supported input schema types are:

- `text` / `string`: optional `default: string`
- `number`: optional `default: number`
- `boolean`: optional `default: boolean`
- `select`: required `choices: string[]`, optional `default: string`

All schemas support `description` and `required`. Prefer explicit descriptions because `/workflow inputs <name>`, `/workflow <name> --help`, and the input picker show them to the user. Runtime validation rejects unknown keys, missing required values, type mismatches, and select values outside `choices`; it does not coerce strings like `"3"` to numbers.

## Run context

`ctx.inputs` contains resolved inputs.

Prefer high-level primitives:

- `ctx.task(name, options)` — one tracked stage + prompt, returns `WorkflowTaskResult`.
- `ctx.parallel(steps, options?)` — run independent task steps together; supports shared task/session defaults plus `concurrency` and `failFast`.
- `ctx.chain(steps, options?)` — run dependent task steps sequentially; supports shared task/session defaults.
- `ctx.ui` — human-in-the-loop primitives when a run needs user input.

Use `ctx.stage(name, options?)` only when you need lower-level session control. `StageContext` supports:

- `prompt(text, options?)`, `complete(text, options?)`
- `steer`, `followUp`, `subscribe`
- session metadata: `sessionId`, `sessionFile`
- model/thinking controls: `setModel`, `setThinkingLevel`, `cycleModel`, `cycleThinkingLevel`
- state access: `agent`, `model`, `thinkingLevel`, `messages`, `isStreaming`
- tree navigation, compaction, and abort

## Human-in-the-loop UI

`ctx.ui` supports:

- `input(prompt): Promise<string>`
- `confirm(message): Promise<boolean>`
- `select(message, options): Promise<T>`
- `editor(initial?): Promise<string>`

These suspend the workflow until the user responds. In interactive pi/Atomic, prompts appear in the workflow graph/input UI opened by F2 or `/workflow connect <run-id>`, not as modal chat dialogs. Always make the surrounding stage/output clear enough that the user knows what decision they are making.

## Task/session options

Common task/stage options include:

- `prompt` or `task`
- `previous` for handoff context; `{previous}` placeholder inserts it, otherwise context is appended
- `context: "fresh" | "fork"`
- `model`, `fallbackModels`, `thinkingLevel`
- `output`, `outputMode`, `reads`, `worktree`, `maxOutput`, `artifacts`, `sessionDir`, `cwd`
- `mcp: { allow?: string[], deny?: string[] }`

`fallbackModels` retries transient provider/model failures with the primary `model` first, then each fallback, then the current pi-selected model when available. It is for rate limits, quota/auth/provider outages, unavailable models, network timeouts, and 5xx errors — not workflow-code errors, tool failures, validation failures, or cancellations. Use provider-qualified IDs when bare IDs would be ambiguous.

Chain defaults:

- first missing task uses `{task}` from chain options/root direct task
- later missing tasks use `{previous}`
- missing tasks in chain-parallel groups use `{previous}`

## Deterministic code vs stages

A stage should correspond to an LLM/session interaction. Put pure deterministic work directly in `.run()` or helper functions, not in a standalone stage. Examples: parsing, filesystem writes, JSON validation, git queries, and formatting. Pair deterministic parsing/validation with a nearby LLM call when it is part of that stage's output handling.

## Registries and programmatic execution

Use `createRegistry()` when code needs to group definitions explicitly:

```ts
import { createRegistry, defineWorkflow } from "@bastani/workflows";

const alpha = defineWorkflow("alpha").run(async () => ({})).compile();
const registry = createRegistry().register(alpha);
registry.names();
registry.get("alpha");
```

`@bastani/workflows` is an Atomic/pi package extension. Atomic loads extensions from the app-name package manifest key (for example `atomic.extensions`); legacy `pi.extensions` remains supported for existing packages. The extension registers the `workflow` tool, `/workflow` command, renderers, widgets, and lifecycle hooks. Use these user-facing surfaces:

- `/workflow <name> key=value ...` inside pi.
- The `workflow` tool for LLM-driven orchestration and direct one-off runs.
- `runWorkflow(definition)` for explicit library/script usage.

Programmatic runner example:

```ts
import { runWorkflow, type WorkflowOptions } from "@bastani/workflows";

const definition = {
  mode: "workflow",
  workflow: "deep-research-codebase",
  inputs: {
    prompt: "map workflow sdk",
    max_partitions: 1,
    max_concurrency: 4,
  },
} as const;

const options: WorkflowOptions = {};

await runWorkflow(definition, options);

await runWorkflow({
  mode: "parallel",
  task: "Audit auth changes",
  tasks: [
    { name: "security", task: "Review security risks" },
    { name: "runtime", task: "Review runtime risks" },
  ],
  concurrency: 2,
  reads: ["research/context.md"],
  output: "research/auth-audit.md",
  outputMode: "inline",
  maxOutput: { lines: 2000 },
  artifacts: true,
});
```

The programmatic definition object mirrors the workflow tool for named runs, direct single-task runs, parallel `tasks`, mixed `chain` runs, direct options, and stage/session options.

Workflow stage sessions follow Atomic SDK directory defaults: resource discovery starts from `.atomic` locations (`~/.atomic/agent`, `<cwd>/.atomic`) and also considers legacy `.pi` locations where the SDK supports multiple config directories. Passing `agentDir` on a stage/task is an explicit user override; passing `resourceLoader` makes that loader responsible for discovery, while `cwd`/`agentDir` still affect session naming and tool path resolution.
