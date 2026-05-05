import { describe, expect, test } from "bun:test";
import {
  buildAttachedFooterCommand,
  buildAttachedFooterCloseHooks,
  resolveAttachedFooterCliPath,
} from "../../../packages/atomic-sdk/src/runtime/attached-footer.ts";

function decodeEncodedCommand(cmd: string): string {
  const prefix = "pwsh -NoProfile -EncodedCommand ";
  expect(cmd.startsWith(prefix)).toBe(true);
  return Buffer.from(cmd.slice(prefix.length), "base64").toString("utf16le");
}

describe("attached footer command harness", () => {
  test("builds the POSIX footer command with bash-safe quoting", () => {
    const cmd = buildAttachedFooterCommand({
      runtime: "/opt/bun/bin/bun",
      cliPath: "/repo/src/cli.ts",
      windowName: "atomic-wf-claude-ralph-a$b`c!",
      agentType: "claude",
      platform: "linux",
    });

    expect(cmd).toBe(
      '"/opt/bun/bin/bun" "/repo/src/cli.ts" _footer --name "atomic-wf-claude-ralph-a\\$b\\`c\\!" --agent "claude"',
    );
  });

  test("builds a Windows footer command that invokes paths through PowerShell", () => {
    const cmd = buildAttachedFooterCommand({
      runtime: "C:\\Program Files\\Bun\\bun.exe",
      cliPath: "C:\\Users\\alexlavaee\\atomic repo\\src\\cli.ts",
      windowName: "atomic-wf-copilot-ralph-abcd1234",
      agentType: "copilot",
      platform: "win32",
    });

    expect(decodeEncodedCommand(cmd)).toBe(
      "& 'C:\\Program Files\\Bun\\bun.exe' 'C:\\Users\\alexlavaee\\atomic repo\\src\\cli.ts' '_footer' '--name' 'atomic-wf-copilot-ralph-abcd1234' '--agent' 'copilot'",
    );
  });

  test("Windows command literals preserve metacharacters without bash escaping", () => {
    const cmd = buildAttachedFooterCommand({
      runtime: "C:\\Users\\alexlavaee\\.bun\\bin\\bun.exe",
      cliPath: "C:\\repo\\src\\cli.ts",
      windowName: "wf's $HOME `tick` bang!",
      platform: "win32",
    });

    const script = decodeEncodedCommand(cmd);
    expect(script).toContain("'wf''s $HOME `tick` bang!'");
    expect(script).not.toContain("\\!");
    expect(script).not.toContain("\\$HOME");
  });

  test("returns an explicit override verbatim", () => {
    // Mirrors Claude Code SDK's pathToClaudeCodeExecutable semantics — the
    // override IS the resolution. Bare command names round-trip so the shell
    // can PATH-resolve them at exec time.
    expect(resolveAttachedFooterCliPath("/usr/local/bin/atomic")).toBe(
      "/usr/local/bin/atomic",
    );
    expect(resolveAttachedFooterCliPath("atomic")).toBe("atomic");
  });

  test("default resolution lands inside @bastani/atomic-sdk (never a sibling package)", () => {
    // Pre-fix bug: the resolver walked into a sibling `atomic/` package
    // looking for the user-facing CLI, which broke SDK-only consumers.
    // The new resolver delegates to `import.meta.resolve` so it stays
    // inside the SDK's own published layout.
    const cli = resolveAttachedFooterCliPath();
    expect(cli).toContain("atomic-sdk");
    expect(cli.endsWith("cli.ts") || cli.endsWith("cli.js")).toBe(true);
  });

  test("builds guarded footer close hooks for tmux", () => {
    expect(buildAttachedFooterCloseHooks("%1", "%2")).toEqual([
      {
        event: "pane-exited",
        command: "if -F '#{==:#{hook_pane},%1}' 'kill-pane -t %2'",
      },
      {
        event: "after-kill-pane",
        command: "kill-pane -t %2",
      },
    ]);
  });

  test("builds unguarded footer close hooks for psmux", () => {
    expect(
      buildAttachedFooterCloseHooks("%1", "%2", { guardAgentPane: false }),
    ).toEqual([
      { event: "pane-exited", command: "kill-pane -t %2" },
      { event: "after-kill-pane", command: "kill-pane -t %2" },
    ]);
  });
});
