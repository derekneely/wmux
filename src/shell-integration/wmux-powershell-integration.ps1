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
#
# The poller runs in a child runspace, which takes the location it was created
# in and keeps it, so it needs to be told where the pane has got to. An env var
# cannot carry that: the job is already running by the time the pane moves.
#
# Nor can the pipe, which is the obvious candidate and the one to rule out
# explicitly. It runs one direction — shell to wmux — and the consumer here is
# another *shell* process, not wmux. The prompt already sends this exact value
# over as report_pwd; routing the hand-off through the pipe would mean adding
# currentCwd to the surface listing, a V2 method and a CLI verb to read it back,
# then spawning node on every 45s tick, so that the shell can ask wmux for
# something the shell itself just told it. This is a shell-to-shell hand-off, so
# it stays between the shells.
#
# The directory is the one wmux-bash-integration.sh already uses for its own
# hand-off, rather than a second scratch location.
$global:_wmux_cwd_file = if ($env:WMUX_SURFACE_ID) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) "wmux"
    try { $null = New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop } catch {}
    Join-Path $dir "cwd-$($env:WMUX_SURFACE_ID).txt"
} else { $null }

function Update-WmuxCwdFile {
    if (-not $global:_wmux_cwd_file) { return }
    try {
        Set-Content -LiteralPath $global:_wmux_cwd_file -Value $PWD.ProviderPath -Encoding UTF8 -ErrorAction Stop
    } catch {
        # Nothing to do — the poller just keeps its last known location.
    }
}

# Take the hand-off file with us, so a closed pane leaves nothing behind.
$null = Register-EngineEvent -SourceIdentifier ([System.Management.Automation.PSEngineEvent]::Exiting) -Action {
    if ($global:_wmux_cwd_file) {
        Remove-Item -LiteralPath $global:_wmux_cwd_file -Force -ErrorAction SilentlyContinue
    }
}

# What a poller tick should send. Pure so the decision can be tested without a
# job, a pipe, or a GitHub repo. An empty result means "say nothing".
function Get-WmuxPrMessage {
    param(
        [string]$SurfaceId,
        [string]$PrJson,
        [int]$ExitCode,
        [bool]$InRepo,
        [bool]$Reported
    )
    # A pane standing outside a repo knows nothing about the workspace's PR.
    # The badge belongs to the workspace, so wandering into ~ must not take it
    # down with it.
    if (-not $InRepo) { return "" }

    if ($ExitCode -eq 0 -and $PrJson) {
        try {
            $pr = $PrJson | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $pr -and $pr.number) {
                return "report_pr $SurfaceId $($pr.number) $($pr.state) $($pr.title)"
            }
        } catch {
            # Fall through: unreadable output tells us nothing about the PR, and
            # whatever this pane last claimed may no longer hold.
        }
    }

    # We are looking at a branch and gh found no PR on it. Only retract a claim
    # this pane actually made: PR metadata is workspace-scoped and every pwsh
    # pane polls, so a pane clearing unconditionally would speak for panes it
    # knows nothing about — two panes in one workspace would take turns
    # reporting and clearing every 45 seconds.
    if ($Reported) { return "clear_pr $SurfaceId" }
    return ""
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
        # Whether the PR currently on the row is this pane's own claim.
        $reported = $false
        while ($true) {
            Start-Sleep -Seconds 45
            $msg = ""
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
                $null = git rev-parse --git-dir 2>$null
                $inRepo = $LASTEXITCODE -eq 0
                $prJson = ""
                $ghExit = 1
                if ($inRepo) {
                    $prJson = (gh pr view --json number,state,title 2>$null) -join "`n"
                    $ghExit = $LASTEXITCODE
                }
                $msg = Get-WmuxPrMessage -SurfaceId $surfaceId -PrJson $prJson -ExitCode $ghExit `
                    -InRepo $inRepo -Reported $reported
            } catch {
                # git or gh missing, or the location went away underneath us —
                # all of which say nothing about the PR on the row.
                $msg = ""
            }
            if ($msg) {
                $reported = $msg.StartsWith("report_pr")
                try {
                    $line = if ($pipeToken) { "auth $pipeToken $msg" } else { $msg }
                    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
                    $pipe.Connect(1000)
                    $writer = New-Object System.IO.StreamWriter($pipe)
                    $writer.AutoFlush = $true
                    $writer.WriteLine($line)
                    $pipe.Close()
                } catch { }
            }
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
