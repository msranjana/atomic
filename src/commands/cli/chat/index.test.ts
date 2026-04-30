import { describe, expect, test } from "bun:test";
import { buildLauncherScript } from "./index.ts";

const TERMINAL_ENV_KEYS = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM"] as const;

const sampleTerminalEnv: Record<string, string> = {
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "en_US.UTF-8",
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
};

function withMockPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  }
}

describe("buildLauncherScript", () => {
  test("builds a PowerShell launcher with cwd, env, args, and exit code", () => {
    const { script, ext } = withMockPlatform("win32", () =>
      buildLauncherScript(
        "copilot",
        ["--debug"],
        "C:\\repo",
        { ATOMIC_AGENT: "copilot" },
      )
    );

    expect(ext).toBe("ps1");
    expect(script).toContain('Set-Location "C:\\repo"');
    expect(script).toContain('$env:ATOMIC_AGENT = "copilot"');
    expect(script).toContain('& "copilot" @("--debug")');
    expect(script).toContain('if ($LASTEXITCODE -is [int]) { $atomicExitCode = $LASTEXITCODE }');
    expect(script).toContain("exit $atomicExitCode");
    expect(script).not.toContain("Invoke-AtomicSessionCleanup");
  });

  test("builds a bash launcher without tmux input suppression", () => {
    const { script, ext } = withMockPlatform("linux", () =>
      buildLauncherScript(
        "claude",
        ["--dangerously-skip-permissions"],
        "/repo",
        { ATOMIC_AGENT: "claude" },
      )
    );

    expect(ext).toBe("sh");
    expect(script).toContain('cd "/repo"');
    expect(script).toContain('export ATOMIC_AGENT="claude"');
    expect(script).toContain('"claude" "--dangerously-skip-permissions"');
    expect(script).toContain("atomic_exit_code=$?");
    expect(script).not.toContain("exec ");
    expect(script).not.toContain("stty -echo -icanon");
    expect(script).not.toContain("atomic_original_tty_state");
    expect(script).not.toContain("trap atomic_cleanup");
  });

  describe("terminal env key exports", () => {
    test("bash launcher exports LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
      const { script, ext } = withMockPlatform("linux", () =>
        buildLauncherScript("claude", [], "/repo", sampleTerminalEnv)
      );

      expect(ext).toBe("sh");
      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`export ${key}="${sampleTerminalEnv[key]}"`);
      }
    });

    test("PowerShell launcher sets LANG, LC_ALL, LC_CTYPE, TERM, COLORTERM", () => {
      const { script, ext } = withMockPlatform("win32", () =>
        buildLauncherScript("claude", [], "C:\\repo", sampleTerminalEnv)
      );

      expect(ext).toBe("ps1");
      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`$env:${key} = "${sampleTerminalEnv[key]}"`);
      }
    });

    test("bash launcher emits export lines for all five terminal env keys when merged with other env", () => {
      const envVars = { ...sampleTerminalEnv, ATOMIC_AGENT: "claude" };
      const { script } = withMockPlatform("linux", () =>
        buildLauncherScript("claude", [], "/repo", envVars)
      );

      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`export ${key}=`);
      }
      expect(script).toContain('export ATOMIC_AGENT="claude"');
    });

    test("PowerShell launcher emits $env: assignments for all five terminal env keys when merged with other env", () => {
      const envVars = { ...sampleTerminalEnv, ATOMIC_AGENT: "copilot" };
      const { script } = withMockPlatform("win32", () =>
        buildLauncherScript("copilot", [], "C:\\repo", envVars)
      );

      for (const key of TERMINAL_ENV_KEYS) {
        expect(script).toContain(`$env:${key} =`);
      }
      expect(script).toContain('$env:ATOMIC_AGENT = "copilot"');
    });
  });
});
