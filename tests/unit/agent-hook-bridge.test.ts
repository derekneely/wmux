import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  hookToAgentReport,
  applyHookToAgentState,
  hookEventName,
  resetHookBridge,
  HookTurnContext,
} from '../../src/main/agent-hook-bridge';
import { getAgentState, resetAgentState } from '../../src/main/agent-state';
import { SurfaceId } from '../../src/shared/types';

const surf = 'surf-hook-1' as SurfaceId;

/** A turn in flight — the context every event but Notification ignores. */
const IN_TURN: HookTurnContext = { runDepth: 1, turnStartTracked: true };

beforeEach(() => {
  resetAgentState();
  resetHookBridge();
});

describe('hookToAgentReport', () => {
  it('Notification parks the pane on the user and keeps the message as the reason', () => {
    expect(hookToAgentReport('Notification', 'Claude needs your permission to use Bash', IN_TURN))
      .toEqual({ awaitingHuman: true, reason: 'Claude needs your permission to use Bash' });
  });

  it('PostToolUse asserts a run and clears any block, idempotently', () => {
    expect(hookToAgentReport('PostToolUse', null, IN_TURN)).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('SubagentStop decrements rather than clearing the run', () => {
    expect(hookToAgentReport('SubagentStop', null, IN_TURN)).toEqual({ runDelta: -1 });
  });

  it('Stop is decisive: nothing running, nothing waiting', () => {
    expect(hookToAgentReport('Stop', null, IN_TURN)).toEqual({ awaitingHuman: false, runDepth: 0 });
  });
});

describe('hookEventName', () => {
  // The regression this exists to stop: `wmux-hook.js` is invoked two ways, and
  // only one of them sends an `event` field. Gating on `params.event` therefore
  // admitted three of the four hooks and dropped every PostToolUse — the ONLY
  // event that ever declares `working`, and the one that clears `blocked` when
  // the agent resumes after an answer.
  it('reads PostToolUse off a bare tool payload, which carries no event field', () => {
    expect(hookEventName({ tool: 'Bash' })).toBe('PostToolUse');
    expect(hookEventName({ tool: 'Edit', file: 'a.ts' })).toBe('PostToolUse');
    // `wmux-hook.js` defaults an unnamed tool to this rather than sending none.
    expect(hookEventName({ tool: 'unknown' })).toBe('PostToolUse');
  });

  it('an explicit event wins over any tool name riding along with it', () => {
    expect(hookEventName({ event: 'Stop', tool: 'Bash' })).toBe('Stop');
    expect(hookEventName({ event: 'Notification' })).toBe('Notification');
    expect(hookEventName({ event: 'SubagentStop' })).toBe('SubagentStop');
  });

  it('names nothing for payloads outside the model', () => {
    expect(hookEventName({ event: 'SessionStart' })).toBeNull();
    expect(hookEventName({})).toBeNull();
    expect(hookEventName(null)).toBeNull();
    // Whitespace is not a tool name; treating it as one would assert a run for
    // a payload that named nothing.
    expect(hookEventName({ tool: '   ' })).toBeNull();
  });
});

describe('applyHookToAgentState', () => {
  it('ignores hook events that are not part of the model', () => {
    applyHookToAgentState(surf, 'SessionStart', null);
    expect(getAgentState(surf)).toBeUndefined();
  });

  it('drives a full turn: tool use → permission prompt → answered → done', () => {
    applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)?.state).toBe('working');

    applyHookToAgentState(surf, 'Notification', 'permission to use Bash');
    expect(getAgentState(surf)).toMatchObject({ state: 'blocked', blockedReason: 'permission to use Bash' });

    // The user approved: the next tool ran, which can only happen once the
    // prompt is gone.
    applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'working', blockedReason: null });

    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('hundreds of tool calls do not inflate the run depth', () => {
    for (let i = 0; i < 300; i++) applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)?.runDepth).toBe(1);
  });

  it('Stop clears a pane that was left blocked', () => {
    // The backstop property: even if the un-block event is missed, ending the
    // turn must not leave a ghost "needs you" behind.
    applyHookToAgentState(surf, 'Notification', 'waiting');
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('a subagent finishing does not end the outer turn', () => {
    applyHookToAgentState(surf, 'PostToolUse', null);
    applyHookToAgentState(surf, 'SubagentStop', null);
    // PostToolUse set depth to exactly 1, so one SubagentStop drains it; the
    // clamp is what keeps a second one from going negative.
    applyHookToAgentState(surf, 'SubagentStop', null);
    expect(getAgentState(surf)?.runDepth).toBe(0);
  });
});

describe('UserPromptSubmit — the turn-start signal', () => {
  // The gap this closes: wmux registered four hooks and none of them fired when
  // a turn BEGAN. PostToolUse fires when a tool FINISHES, so everything before
  // the first completed tool declared nothing and the pane read `idle` while it
  // was thinking. A prose-only turn declared nothing at all, start to end.
  it('declares a run the moment the user submits', () => {
    expect(hookToAgentReport('UserPromptSubmit', null, IN_TURN)).toEqual({ awaitingHuman: false, runDepth: 1 });
  });

  it('a turn that never calls a tool is still working from Enter to Stop', () => {
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    expect(getAgentState(surf)?.state).toBe('working');
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');
  });

  it('submitting a prompt clears a block — the user just answered it by typing', () => {
    applyHookToAgentState(surf, 'Notification', 'permission to use Bash');
    expect(getAgentState(surf)?.state).toBe('blocked');
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    expect(getAgentState(surf)).toMatchObject({ state: 'working', blockedReason: null });
  });

  it('is idempotent with the PostToolUse that follows it', () => {
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'PostToolUse', null);
    applyHookToAgentState(surf, 'PostToolUse', null);
    expect(getAgentState(surf)?.runDepth).toBe(1);
  });

  it('is resolved from the wire payload like any other named event', () => {
    expect(hookEventName({ event: 'UserPromptSubmit' })).toBe('UserPromptSubmit');
  });
});

describe('Notification — the idle nudge is not a block', () => {
  // The bug: Claude Code arms a ~60s "waiting for your input" nudge when a turn
  // ends, and it fires whether or not anything is actually being asked. A pane
  // that had just been /clear'd and left alone therefore lit up "Needs you" 60s
  // after its last Stop, with an empty conversation and nothing to answer.
  const nudge = 'Claude is waiting for your input';
  const prompt = 'Claude needs your permission to use Bash';

  it('ignores a Notification that arrives with the turn already over', () => {
    expect(hookToAgentReport('Notification', nudge, { runDepth: 0, turnStartTracked: true })).toBeNull();
  });

  it('still blocks a Notification that arrives mid-turn — that is a real prompt', () => {
    expect(hookToAgentReport('Notification', prompt, { runDepth: 1, turnStartTracked: true }))
      .toEqual({ awaitingHuman: true, reason: prompt });
  });

  it('draws no distinction until UserPromptSubmit is known to fire', () => {
    // A settings.json predating the UserPromptSubmit hook sits at runDepth 0
    // through an entire turn. Concluding "idle nudge" from that would swallow
    // real permission prompts — so the gate stays shut and both block.
    expect(hookToAgentReport('Notification', prompt, { runDepth: 0, turnStartTracked: false })?.awaitingHuman)
      .toBe(true);
  });

  it('a /clear\'d pane sitting idle does not start asking for attention', () => {
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'Stop', null);
    expect(getAgentState(surf)?.state).toBe('idle');

    applyHookToAgentState(surf, 'Notification', nudge);
    expect(getAgentState(surf)).toMatchObject({ state: 'idle', blockedReason: null });
  });

  it('a permission prompt inside a live turn still parks the pane', () => {
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'Notification', prompt);
    expect(getAgentState(surf)).toMatchObject({ state: 'blocked', blockedReason: prompt });
  });

  it('a prompt on the very first turn of a pane is not mistaken for a nudge', () => {
    // What made the flag global rather than per-surface: this pane has never
    // submitted a prompt, but another one has, so the hook is known to fire and
    // this pane's own runDepth 1 is trustworthy.
    const other = 'surf-hook-2' as SurfaceId;
    applyHookToAgentState(other, 'UserPromptSubmit', null);

    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'Notification', prompt);
    expect(getAgentState(surf)?.state).toBe('blocked');
  });

  it('a nudge repeating while genuinely blocked leaves the block standing', () => {
    // The prompt kept runDepth at 1, so the repeat is indistinguishable from
    // the original — and must be, since the pane really is still waiting.
    applyHookToAgentState(surf, 'UserPromptSubmit', null);
    applyHookToAgentState(surf, 'Notification', prompt);
    applyHookToAgentState(surf, 'Notification', nudge);
    expect(getAgentState(surf)?.state).toBe('blocked');
  });
});
