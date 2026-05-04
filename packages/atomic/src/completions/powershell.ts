/**
 * PowerShell completion script for the atomic CLI (Windows / cross-platform).
 *
 * Install: atomic completions powershell | Invoke-Expression
 *   or add to $PROFILE for persistence.
 *
 * On Windows the script also defines an `atomic` wrapper function. When
 * atomic auto-installs psmux/bun via winget/scoop/cargo/choco, those
 * package managers write to `HKCU\\Environment\\Path` — the registry
 * change persists for new shells but doesn't propagate into the parent
 * pwsh's `$env:Path`. The wrapper invokes the real binary and then
 * re-merges user PATH from the registry so a follow-up `psmux -V` in
 * the same shell just works (no relogin required).
 */
export const powershellCompletionScript = `
$__AtomicCompleter = {
    param($wordToComplete, $commandAst, $cursorPosition)

    $tokens = $commandAst.ToString().Substring(0, $cursorPosition) -split '\\s+' |
        Where-Object { $_ -ne '' }

    $agents  = @('claude', 'opencode', 'copilot')
    $shells  = @('bash', 'zsh', 'fish', 'powershell')

    # Parse command chain, skipping flags and their values
    $cmds = @()
    $skipNext = $false
    $prevToken = ''
    for ($i = 1; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i]
        if ($skipNext) { $skipNext = $false; continue }
        if ($t -match '^-') {
            if ($t -match '^(-a|--agent|-n|--name)$') { $skipNext = $true }
            $prevToken = $t
            continue
        }
        $cmds += $t
    }

    # Check if the previous non-word token is a value-expecting flag
    $lastToken = if ($tokens.Count -gt 1) { $tokens[-1] } else { '' }
    $prevFullToken = if ($tokens.Count -gt 2) { $tokens[-2] } else { '' }

    # Complete flag values
    if ($prevFullToken -match '^(-a|--agent)$' -or $lastToken -match '^(-a|--agent)$') {
        if ($lastToken -match '^(-a|--agent)$') {
            $agents | ForEach-Object {
                [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
            }
            return
        }
        $agents | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
        return
    }
    $completions = @()

    switch ($cmds.Count) {
        0 {
            # Top-level commands
            $completions = @(
                @{ text = 'init';        tip = 'Interactive setup with agent selection' }
                @{ text = 'chat';        tip = 'Start an interactive chat session' }
                @{ text = 'workflow';    tip = 'Run a multi-session agent workflow' }
                @{ text = 'session';     tip = 'Manage running tmux sessions' }
                @{ text = 'config';      tip = 'Manage atomic configuration' }
                @{ text = 'completions'; tip = 'Output shell completion script' }
            )
        }
        default {
            switch ($cmds[0]) {
                'init' {
                    $completions = @(
                        @{ text = '-a';      tip = 'Agent to configure' }
                        @{ text = '--agent'; tip = 'Agent to configure' }
                    )
                }
                'chat' {
                    if ($cmds.Count -eq 1) {
                        $completions = @(
                            @{ text = 'session'; tip = 'Manage running chat sessions' }
                            @{ text = '-a';      tip = 'Agent to chat with' }
                            @{ text = '--agent'; tip = 'Agent to chat with' }
                        )
                    } elseif ($cmds[1] -eq 'session') {
                        if ($cmds.Count -eq 2) {
                            $completions = @(
                                @{ text = 'list';    tip = 'List running sessions' }
                                @{ text = 'connect'; tip = 'Attach to a running session' }
                                @{ text = 'kill';    tip = 'Kill running sessions' }
                            )
                        } elseif ($cmds.Count -ge 3 -and $cmds[2] -eq 'kill') {
                            $completions = @(
                                @{ text = '-a';      tip = 'Filter by agent' }
                                @{ text = '--agent'; tip = 'Filter by agent' }
                                @{ text = '--all';   tip = 'Select all matching sessions' }
                                @{ text = '-y';      tip = 'Skip confirmation prompt' }
                                @{ text = '--yes';   tip = 'Skip confirmation prompt' }
                            )
                        } else {
                            $completions = @(
                                @{ text = '-a';      tip = 'Filter by agent' }
                                @{ text = '--agent'; tip = 'Filter by agent' }
                            )
                        }
                    }
                }
                'workflow' {
                    if ($cmds.Count -eq 1) {
                        $completions = @(
                            @{ text = 'list';    tip = 'List available workflows' }
                            @{ text = 'session'; tip = 'Manage running workflow sessions' }
                            @{ text = '-n';      tip = 'Workflow name' }
                            @{ text = '--name';  tip = 'Workflow name' }
                            @{ text = '-a';      tip = 'Agent to use' }
                            @{ text = '--agent'; tip = 'Agent to use' }
                        )
                    } elseif ($cmds[1] -eq 'list') {
                        $completions = @(
                            @{ text = '-a';      tip = 'Filter by agent' }
                            @{ text = '--agent'; tip = 'Filter by agent' }
                        )
                    } elseif ($cmds[1] -eq 'session') {
                        if ($cmds.Count -eq 2) {
                            $completions = @(
                                @{ text = 'list';    tip = 'List running sessions' }
                                @{ text = 'connect'; tip = 'Attach to a running session' }
                                @{ text = 'kill';    tip = 'Kill running sessions' }
                            )
                        } elseif ($cmds.Count -ge 3 -and $cmds[2] -eq 'kill') {
                            $completions = @(
                                @{ text = '-a';      tip = 'Filter by agent' }
                                @{ text = '--agent'; tip = 'Filter by agent' }
                                @{ text = '--all';   tip = 'Select all matching sessions' }
                                @{ text = '-y';      tip = 'Skip confirmation prompt' }
                                @{ text = '--yes';   tip = 'Skip confirmation prompt' }
                            )
                        } else {
                            $completions = @(
                                @{ text = '-a';      tip = 'Filter by agent' }
                                @{ text = '--agent'; tip = 'Filter by agent' }
                            )
                        }
                    }
                }
                'session' {
                    if ($cmds.Count -eq 1) {
                        $completions = @(
                            @{ text = 'list';    tip = 'List running sessions' }
                            @{ text = 'connect'; tip = 'Attach to a running session' }
                            @{ text = 'kill';    tip = 'Kill running sessions' }
                        )
                    } elseif ($cmds.Count -ge 2 -and $cmds[1] -eq 'kill') {
                        $completions = @(
                            @{ text = '-a';      tip = 'Filter by agent' }
                            @{ text = '--agent'; tip = 'Filter by agent' }
                            @{ text = '--all';   tip = 'Select all matching sessions' }
                            @{ text = '-y';      tip = 'Skip confirmation prompt' }
                            @{ text = '--yes';   tip = 'Skip confirmation prompt' }
                        )
                    } else {
                        $completions = @(
                            @{ text = '-a';      tip = 'Filter by agent' }
                            @{ text = '--agent'; tip = 'Filter by agent' }
                        )
                    }
                }
                'config' {
                    if ($cmds.Count -eq 1) {
                        $completions = @(
                            @{ text = 'set'; tip = 'Set a configuration value' }
                        )
                    } elseif ($cmds[1] -eq 'set') {
                        if ($cmds.Count -eq 2) {
                            $completions = @(
                                @{ text = 'telemetry'; tip = 'Telemetry setting' }
                            )
                        } elseif ($cmds[2] -eq 'telemetry') {
                            $completions = @(
                                @{ text = 'true';  tip = 'Enable telemetry' }
                                @{ text = 'false'; tip = 'Disable telemetry' }
                            )
                        }
                    }
                }
                'completions' {
                    $completions = @(
                        @{ text = 'bash';       tip = 'Bash completion script' }
                        @{ text = 'zsh';        tip = 'Zsh completion script' }
                        @{ text = 'fish';       tip = 'Fish completion script' }
                        @{ text = 'powershell'; tip = 'PowerShell completion script' }
                    )
                }
            }
        }
    }

    $completions | Where-Object { $_.text -like "$wordToComplete*" } | ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_.text, $_.text, 'ParameterValue', $_.tip)
    }
}

# Register for direct atomic.exe invocations.
Register-ArgumentCompleter -Native -CommandName atomic -ScriptBlock $__AtomicCompleter

# Windows-only: wrap the binary so PATH writes from auto-installs (psmux
# via winget/scoop/cargo, bun via winget/scoop) become visible in this
# shell without opening a new one. A child process (atomic.exe) cannot
# mutate its parent's $env:Path; the wrapper re-merges user PATH from
# the registry after each call so subsequent commands in the same
# session see the freshly-installed binaries.
#
# The function shadows atomic.exe in command resolution; non-native
# completer registration mirrors the same scriptblock so tab-complete
# behaviour is identical whether the user hits the function or the .exe.
if ($env:OS -eq 'Windows_NT') {
    Register-ArgumentCompleter -CommandName atomic -ScriptBlock $__AtomicCompleter

    function atomic {
        # Prefer the canonical install location; fall back to PATH for
        # \`bun install -g\` users and dev checkouts.
        $bin = Join-Path $env:LOCALAPPDATA 'atomic\\bin\\atomic.exe'
        if (-not (Test-Path $bin)) {
            $cmd = Get-Command atomic -CommandType Application -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if (-not $cmd) {
                Write-Error 'atomic binary not found at the canonical install location and not on PATH'
                return
            }
            $bin = $cmd.Source
        }

        & $bin @args
        $exitCode = $LASTEXITCODE

        # Re-merge HKCU\\Environment\\Path into the current shell so any
        # entries atomic's auto-installs wrote (psmux, bun, ...) are
        # reachable in this session without reopening it.
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($userPath) {
            $existing = @($env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
            foreach ($entry in ($userPath -split ';')) {
                $entry = $entry.Trim()
                if ($entry -and ($existing -notcontains $entry)) {
                    $env:Path = "$env:Path;$entry"
                    $existing += $entry
                }
            }
        }

        $global:LASTEXITCODE = $exitCode
    }
}
`;
