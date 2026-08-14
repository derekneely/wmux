# wmux PowerShell Integration
# Injected automatically by wmux

$env:WMUX = "1"

# UTF-8 I/O so multi-byte input (Korean, Japanese, Chinese, emoji, accents)
# survives the conpty round-trip cleanly.
try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [System.Text.UTF8Encoding]::new()
    $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
} catch {}

# wmux CLI shortcut — Claude Code and users can just type: wmux browser open <url>
function wmux { node "$env:WMUX_CLI" @args }

# Named pipe client helper. State updates carry an "auth <token> " prefix —
# wmux injects WMUX_PIPE_TOKEN into every shell it spawns, and the pipe server
# rejects unauthenticated V1 commands (issue #72).
function Send-WmuxMessage {
    param([string]$Message)
    try {
        if ($env:WMUX_PIPE_TOKEN) { $Message = "auth $($env:WMUX_PIPE_TOKEN) $Message" }
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "wmux", [System.IO.Pipes.PipeDirection]::InOut)
        $pipe.Connect(1000)
        $writer = New-Object System.IO.StreamWriter($pipe)
        $writer.AutoFlush = $true
        $writer.WriteLine($Message)
        $pipe.Close()
    } catch {
        # Silently ignore pipe errors
    }
}

# Report CWD
function Report-Cwd {
    $surfaceId = $env:WMUX_SURFACE_ID
    if ($surfaceId) {
        Send-WmuxMessage "report_pwd $surfaceId $PWD"
    }
}

# Publish the live cwd for the PR poller.
# The poller runs in a Start-Job child runspace, which takes the location it was
# created in and keeps it — and an env var set afterwards never reaches a
# process that is already running. The prompt is where the current location is
# known, so it leaves it here for the poller to pick up on its next tick.
$global:_wmux_cwd_file = if ($env:WMUX_SURFACE_ID) {
    Join-Path ([System.IO.Path]::GetTempPath()) "wmux-cwd-$($env:WMUX_SURFACE_ID).txt"
} else { $null }

function Update-WmuxCwdFile {
    if (-not $global:_wmux_cwd_file) { return }
    try {
        Set-Content -LiteralPath $global:_wmux_cwd_file -Value $PWD.ProviderPath -Encoding UTF8 -ErrorAction Stop
    } catch {
        # Nothing to do — the poller just keeps its last known location.
    }
}

# What a poller tick should send, given gh's output. Pure so the decision can be
# tested without a job, a pipe, or a GitHub repo.
function Get-WmuxPrMessage {
    param([string]$SurfaceId, [string]$PrJson, [int]$ExitCode)
    if ($ExitCode -eq 0 -and $PrJson) {
        try {
            $pr = $PrJson | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $pr -and $pr.number) {
                return "report_pr $SurfaceId $($pr.number) $($pr.state) $($pr.title)"
            }
        } catch {
            # Fall through and clear: unreadable output tells us nothing about
            # the PR, and the badge already up may belong to another branch.
        }
    }
    # gh had no PR to report — no PR for this branch, not a repo, not
    # authenticated. Clearing keeps the row honest; staying silent leaves
    # whatever was last reported pinned there for the life of the workspace.
    return "clear_pr $SurfaceId"
}

# Report git branch
function Report-GitBranch {
    $surfaceId = $env:WMUX_SURFACE_ID
    if (-not $surfaceId) { return }

    try {
        $branch = git rev-parse --abbrev-ref HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $branch) {
            $dirty = ""
            $status = git status --porcelain 2>$null
            if ($status) { $dirty = "dirty" }
            Send-WmuxMessage "report_git_branch $surfaceId $branch $dirty"
        } else {
            Send-WmuxMessage "clear_git_branch $surfaceId"
        }
    } catch {
        Send-WmuxMessage "clear_git_branch $surfaceId"
    }
}

# Report shell state
function Report-ShellState {
    param([string]$State)
    $surfaceId = $env:WMUX_SURFACE_ID
    if ($surfaceId) {
        Send-WmuxMessage "report_shell_state $surfaceId $State"
    }
}

# Report "running" when user executes a command (pre-execution hook)
if (Get-Module -Name PSReadLine -ErrorAction SilentlyContinue) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        # Report running state before the command executes
        Report-ShellState "running"
        # Accept the line (execute the command)
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}

# Override prompt (fires AFTER command completes)
$_wmux_original_prompt = $function:prompt
function prompt {
    Report-Cwd
    Update-WmuxCwdFile
    Report-GitBranch
    # Detect if last command was interrupted (Ctrl+C → exit code -1073741510 on Windows)
    if ($LASTEXITCODE -eq -1073741510 -or $LASTEXITCODE -eq 130) {
        Report-ShellState "interrupted"
    } else {
        Report-ShellState "idle"
    }
    Send-WmuxMessage "ports_kick $env:WMUX_SURFACE_ID"

    # Call original prompt or default
    if ($_wmux_original_prompt) {
        & $_wmux_original_prompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }
}

# PR polling background job (every 45 seconds).
# DEFERRED: Start-Job spins up a whole child PowerShell runspace and costs
# several hundred ms — running it during init delayed the FIRST prompt. We
# instead start it on the shell's first idle (after the prompt is already on
# screen), so it never sits on the startup critical path. A global guard makes it
# fire exactly once; PR data isn't needed in the first 45s anyway.
$global:_wmux_pr_started = $false
$null = Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PSEngineEvent]::OnIdle) -Action {
    if ($global:_wmux_pr_started) { return }
    $global:_wmux_pr_started = $true
    # A job runs in its own runspace and sees none of this session's functions,
    # so the tick's decision function is carried across as its initialization.
    $_wmux_pr_init = [scriptblock]::Create("function Get-WmuxPrMessage {`n$(${function:Get-WmuxPrMessage})`n}")
    $global:_wmux_pr_job = Start-Job -InitializationScript $_wmux_pr_init -ScriptBlock {
        param($surfaceId, $pipeName, $pipeToken, $cwdFile)
        while ($true) {
            Start-Sleep -Seconds 45
            try {
                # Follow the pane. This runspace's location is the one it was
                # created in and never moves on its own, so a pane that has
                # since cd'd into another repo would keep being answered for
                # the first one.
                if ($cwdFile -and (Test-Path -LiteralPath $cwdFile)) {
                    $live = (Get-Content -LiteralPath $cwdFile -Raw -ErrorAction SilentlyContinue)
                    if ($live) {
                        $live = $live.Trim()
                        if ($live -and (Test-Path -LiteralPath $live)) { Set-Location -LiteralPath $live }
                    }
                }
                $prJson = (gh pr view --json number,state,title 2>$null) -join "`n"
                $msg = Get-WmuxPrMessage -SurfaceId $surfaceId -PrJson $prJson -ExitCode $LASTEXITCODE
            } catch {
                # gh missing, or the location went away underneath us.
                $msg = "clear_pr $surfaceId"
            }
            try {
                if ($pipeToken) { $msg = "auth $pipeToken $msg" }
                $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
                $pipe.Connect(1000)
                $writer = New-Object System.IO.StreamWriter($pipe)
                $writer.AutoFlush = $true
                $writer.WriteLine($msg)
                $pipe.Close()
            } catch { }
        }
    } -ArgumentList $env:WMUX_SURFACE_ID, "wmux", $env:WMUX_PIPE_TOKEN, $global:_wmux_cwd_file
}

# Quick-launch profile startup commands (issue #32).
# wmux passes these in WMUX_STARTUP_COMMANDS (newline-separated) so they run as
# part of init — before the first interactive prompt — rather than being injected
# as keystrokes afterward. Keystroke injection raced the shell's init-time
# Device Attributes query (ConPTY answers DA1 with "\e[?62;4;9;22c" on stdin);
# when that response landed on the prompt alongside an injected "<cmd>\r" the two
# merged into a bogus executed line (e.g. "62;4;9;22ccls"). Running here avoids
# that entirely. Runs last so the prompt override / PSReadLine handlers exist.
if ($env:WMUX_STARTUP_COMMANDS) {
    foreach ($_wmux_cmd in ($env:WMUX_STARTUP_COMMANDS -split "`n")) {
        $_wmux_cmd = $_wmux_cmd.Trim()
        if ($_wmux_cmd) {
            try { Invoke-Expression $_wmux_cmd } catch { Write-Error $_ }
        }
    }
    # One-shot: don't let it leak into child shells spawned from this session.
    Remove-Item Env:\WMUX_STARTUP_COMMANDS -ErrorAction SilentlyContinue
}
