import { describe, it, expect } from 'vitest';
import { applyWmuxHooks } from '../../src/main/claude-context';

const HOOK = '/res/cli/wmux-hook.js';

const wmuxCmds = (entries: any[]): string[] =>
  entries.flatMap((e) => (e.hooks || []).map((h: any) => h.command as string));

describe('applyWmuxHooks (issue #53)', () => {
  it('installs PostToolUse, Notification and Stop wmux hooks', () => {
    const out = applyWmuxHooks({}, HOOK);

    // PostToolUse: one entry per tracked tool.
    const postCmds = wmuxCmds(out.hooks.PostToolUse);
    expect(postCmds.some((c) => c.includes('wmux-hook.js') && c.includes('Bash'))).toBe(true);
    expect(postCmds.some((c) => c.includes('Edit'))).toBe(true);

    // Notification + Stop: pass an --event flag.
    expect(wmuxCmds(out.hooks.Notification)).toEqual([
      `node "${HOOK}" --event Notification 2>/dev/null || true`,
    ]);
    expect(wmuxCmds(out.hooks.Stop)).toEqual([
      `node "${HOOK}" --event Stop 2>/dev/null || true`,
    ]);
  });

  it('preserves existing user hooks in every array', () => {
    const userPost = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-script.sh' }] };
    const userStop = { hooks: [{ type: 'command', command: 'notify-send done' }] };
    const out = applyWmuxHooks(
      { hooks: { PostToolUse: [userPost], Stop: [userStop] } },
      HOOK,
    );

    expect(wmuxCmds(out.hooks.PostToolUse)).toContain('my-own-script.sh');
    expect(wmuxCmds(out.hooks.Stop)).toContain('notify-send done');
    // ...and the wmux entries are still added alongside them.
    expect(wmuxCmds(out.hooks.Stop).some((c) => c.includes('--event Stop'))).toBe(true);
  });

  it('is idempotent — re-running replaces wmux entries, never duplicates them', () => {
    const once = applyWmuxHooks({}, HOOK);
    const twice = applyWmuxHooks(once, HOOK);

    expect(twice.hooks.Notification).toHaveLength(1);
    expect(twice.hooks.Stop).toHaveLength(1);
    // Same number of PostToolUse entries on the second pass (no accumulation).
    expect(twice.hooks.PostToolUse).toHaveLength(once.hooks.PostToolUse.length);
  });

  it('does not mutate the input settings object', () => {
    const input: any = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user' }] }] } };
    const snapshot = JSON.stringify(input);
    applyWmuxHooks(input, HOOK);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('adds a SubagentStop hook entry alongside Notification and Stop', () => {
    const result = applyWmuxHooks({}, '/abs/wmux-hook.js');
    const entries = result.hooks.SubagentStop;
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toContain('--event SubagentStop');
  });

  it('replaces a prior wmux SubagentStop entry instead of duplicating it', () => {
    const once = applyWmuxHooks({}, '/abs/wmux-hook.js');
    const twice = applyWmuxHooks(once, '/abs/wmux-hook.js');
    expect(twice.hooks.SubagentStop).toHaveLength(1);
  });
});

describe('PostToolUse catch-all — state must not ride on the label allowlist', () => {
  const catchAll = (out: any) =>
    out.hooks.PostToolUse.find((e: any) =>
      (e.hooks || []).some((h: any) => h.command.includes('--event PostToolUse')));

  it('installs an entry covering every tool, not just the tracked ten', () => {
    expect(catchAll(applyWmuxHooks({}, HOOK))).toBeDefined();
  });

  it('carries NO matcher key — matchers are regex, so "*" would never match', () => {
    // The subtle one. A matcher of "*" reads as a wildcard and is in fact an
    // invalid pattern (nothing to repeat); the hook would silently never fire
    // and the pane would sit on "Needs you" exactly as before. Omitting the
    // matcher is the documented way to apply a hook to every tool.
    const entry = catchAll(applyWmuxHooks({}, HOOK));
    expect('matcher' in entry).toBe(false);
  });

  it('AskUserQuestion is covered by it, and is NOT in the labelled list', () => {
    const out = applyWmuxHooks({}, HOOK);
    const labelled = out.hooks.PostToolUse.filter((e: any) => e.matcher).map((e: any) => e.matcher);
    // The gap that stranded "Needs you": answering a question is exactly when
    // the block should lift, and this tool never had an entry of its own.
    expect(labelled).not.toContain('AskUserQuestion');
    expect(catchAll(out)).toBeDefined();
  });

  it('re-applying does not accumulate duplicates', () => {
    const once = applyWmuxHooks({}, HOOK);
    const twice = applyWmuxHooks(once, HOOK);
    expect(twice.hooks.PostToolUse.length).toBe(once.hooks.PostToolUse.length);
  });

  it('removeWmuxHooks takes it back out again', async () => {
    const { removeWmuxHooks } = await import('../../src/main/claude-context');
    const stripped = removeWmuxHooks(applyWmuxHooks({ hooks: {} }, HOOK));
    expect(stripped.hooks?.PostToolUse).toBeUndefined();
  });
});
