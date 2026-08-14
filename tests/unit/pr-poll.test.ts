import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * The PR poller in the PowerShell integration can raise a PR badge but never
 * lower one (issue #4).
 *
 * Two things keep a merged or foreign PR pinned to a workspace row:
 *
 *  1. The tick reports only on success. `gh pr view` failing — no PR for this
 *     branch, not a repo, gh not authed — sends nothing at all, so the last
 *     value stands. `clear_pr` is handled in App.tsx but has no sender, unlike
 *     `clear_git_branch`, whose clearing half is already wired up in both the
 *     PowerShell and bash integrations.
 *
 *  2. `Start-Job` hands the child runspace the location captured at call time
 *     and keeps it there. The poller is started on the shell's first idle (a
 *     deliberate startup-cost fix), so every later `gh pr view` answers for the
 *     directory the pane opened in — `cd` to another repo or worktree and the
 *     row keeps showing the first one's PR.
 *
 * The per-tick decision is a pure function so it can be exercised here against
 * a real PowerShell host rather than pattern-matched; the wiring around it is
 * read back out of the script.
 */

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'shell-integration', 'wmux-powershell-integration.ps1');
// Normalized to LF: the script is CRLF on disk, and every offset below looks
// for a brace on its own line.
const source = fs.readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');

/**
 * Lift a top-level `function Name { … }` out of the integration script.
 * Terminated by a closing brace in column 0, which is how every function in
 * this file is written.
 */
function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name} {`);
  expect(start, `${name} is not defined in ${path.basename(SCRIPT)}`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start);
  expect(end, `${name} has no column-0 closing brace`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

/** The job's script block — everything the poller runs on a tick. */
function pollerJobBlock(): string {
  const start = source.indexOf('Start-Job');
  expect(start, 'no Start-Job in the integration script').toBeGreaterThan(-1);
  return source.slice(start);
}

function findPowerShell(): string | null {
  for (const exe of ['pwsh.exe', 'powershell.exe', 'pwsh']) {
    try {
      execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore' });
      return exe;
    } catch {
      // Not installed, or refused to run — try the next host.
    }
  }
  return null;
}

const host = findPowerShell();

/**
 * Run `Get-WmuxPrMessage` in a real host. Written to a temp .ps1 and invoked
 * with -File: the arguments carry JSON and quotes, and -Command would have them
 * re-parsed by the host's own command-line splitter on the way in.
 */
function prMessage(args: { surfaceId: string; prJson: string; exitCode: number }): string {
  // Single-quoted PowerShell literals: the payload is JSON, and a double-quoted
  // string would have its `"` and `$` re-read by the parser.
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = [
    extractFunction('Get-WmuxPrMessage'),
    '',
    `Get-WmuxPrMessage -SurfaceId ${ps(args.surfaceId)} ` +
      `-PrJson ${ps(args.prJson)} -ExitCode ${args.exitCode}`,
    '',
  ].join('\n');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pr-')), 'probe.ps1');
  fs.writeFileSync(file, script, 'utf8');
  try {
    return execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', file], {
      encoding: 'utf8',
    }).trim();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

describe.skipIf(!host)('Get-WmuxPrMessage — what a poller tick decides to send', () => {
  const surfaceId = 'surf-1111';

  it('reports the PR when gh resolved one', () => {
    const json = JSON.stringify({ number: 450, state: 'MERGED', title: 'Fix the thing' });
    expect(prMessage({ surfaceId, prJson: json, exitCode: 0 })).toBe(
      `report_pr ${surfaceId} 450 MERGED Fix the thing`,
    );
  });

  it('keeps a multi-word title in one piece', () => {
    // pipe-server.ts:139 rejoins everything past the state, so spaces survive
    // the trip — the message just has to carry them.
    const json = JSON.stringify({ number: 7, state: 'OPEN', title: 'a b c d' });
    expect(prMessage({ surfaceId, prJson: json, exitCode: 0 })).toBe(`report_pr ${surfaceId} 7 OPEN a b c d`);
  });

  it('clears the badge when gh exits non-zero', () => {
    // No PR for this branch, or gh is not authenticated. This is the tick that
    // used to send nothing and leave the previous PR up forever.
    expect(prMessage({ surfaceId, prJson: '', exitCode: 1 })).toBe(`clear_pr ${surfaceId}`);
  });

  it('clears the badge when gh exits zero but says nothing', () => {
    expect(prMessage({ surfaceId, prJson: '', exitCode: 0 })).toBe(`clear_pr ${surfaceId}`);
  });

  it('clears the badge rather than reporting unparseable output', () => {
    expect(prMessage({ surfaceId, prJson: 'not json at all', exitCode: 0 })).toBe(`clear_pr ${surfaceId}`);
  });
});

describe.skipIf(!host)('the integration script itself', () => {
  it('parses in a real PowerShell host', () => {
    // Nothing else here would notice a syntax error: the tests above lift one
    // function out of the file, and the ones below read it as text. A shell
    // integration that fails to parse takes the whole pane's prompt, git
    // branch and shell state down with it, silently.
    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-parse-')), 'parse.ps1');
    fs.writeFileSync(
      probe,
      [
        '$errors = $null',
        `$null = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$null, [ref]$errors)`,
        'if ($errors) { $errors | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" } }',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const out = execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', probe], {
        encoding: 'utf8',
      }).trim();
      expect(out, `parse errors in ${path.basename(SCRIPT)}`).toBe('');
    } finally {
      fs.rmSync(path.dirname(probe), { recursive: true, force: true });
    }
  });
});

describe.skipIf(!host)('the poller job', () => {
  it('can call Get-WmuxPrMessage inside the job runspace', () => {
    // A job is a separate runspace and inherits none of the session's
    // functions, so the tick's decision function is handed over as the job's
    // initialization script. If that hand-off ever stopped working the tick
    // would throw on every pass and clear the badge forever — the same symptom
    // as the bug, from the other direction.
    const initLine = source.split('\n').find((l) => l.includes('[scriptblock]::Create('));
    expect(initLine, 'no initialization script built for the job').toBeTruthy();

    const probe = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-job-')), 'job.ps1');
    fs.writeFileSync(
      probe,
      [
        extractFunction('Get-WmuxPrMessage'),
        '',
        (initLine as string).trim(),
        '$j = Start-Job -InitializationScript $_wmux_pr_init -ScriptBlock {',
        "  Get-WmuxPrMessage -SurfaceId 'surf-1' -PrJson '{\"number\":450,\"state\":\"MERGED\",\"title\":\"t\"}' -ExitCode 0",
        '}',
        '$null = Wait-Job $j -Timeout 30',
        'Receive-Job $j',
        'Remove-Job $j -Force',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      const out = execFileSync(host as string, ['-NoProfile', '-NonInteractive', '-File', probe], {
        encoding: 'utf8',
      }).trim();
      expect(out).toBe('report_pr surf-1 450 MERGED t');
    } finally {
      fs.rmSync(path.dirname(probe), { recursive: true, force: true });
    }
  });
});

describe('PR poller wiring', () => {
  it('sends whatever the tick decided, not only the success case', () => {
    const job = pollerJobBlock();
    expect(job).toContain('Get-WmuxPrMessage');
    // The old shape: a lone `if` around the send, with no else.
    expect(job).not.toMatch(/if\s*\(\s*\$LASTEXITCODE\s*-eq\s*0\s*-and\s*\$prJson\s*\)/);
  });

  it('re-reads the pane cwd on every tick instead of trusting Start-Job', () => {
    const job = pollerJobBlock();
    expect(job).toContain('Set-Location');
  });

  it('publishes the pane cwd from the prompt, which is where it is known', () => {
    // The job is a separate process: an env var set after it started is
    // invisible to it, so the live location has to be handed over out-of-band.
    expect(source).toContain('Update-WmuxCwdFile');
    const prompt = source.slice(source.indexOf('function prompt {'));
    expect(prompt.slice(0, prompt.indexOf('\n}\n'))).toContain('Update-WmuxCwdFile');
  });
});
