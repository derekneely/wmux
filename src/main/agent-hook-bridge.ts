/**
 * Claude Code hooks → declared agent state (issue #128).
 *
 * The protocol in agent-state.ts is agent-agnostic: anything that can write a
 * line of JSON to the wmux pipe can drive it. But Claude Code is what most wmux
 * panes actually run, and wmux ALREADY configures four of its hooks in
 * ~/.claude/settings.json (see ensureClaudeHooks in claude-context.ts):
 *
 *   PostToolUse   — a tool just finished running
 *   Notification  — Claude Code wants the user's attention
 *   Stop          — the turn is over
 *   SubagentStop  — one parallel subagent finished
 *
 * Translating those into report_agent calls means the "which pane needs me?"
 * signal works for Claude Code with zero install: no plugin, no wrapper, no
 * opt-in. Other agents (OpenCode, custom harnesses) call the pipe directly.
 *
 * These hooks are lifecycle truth from the agent process itself, which is the
 * same reasoning that made hooks — not output parsing — authoritative for the
 * sidebar's agent lines (issue #81 class).
 */

import { SurfaceId } from '../shared/types';
import { reportAgent, ReportAgentParams } from './agent-state';

/** The hook events wmux registers. */
export type ClaudeHookEvent =
  | 'UserPromptSubmit'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SubagentStop';

const KNOWN_HOOK_EVENTS: ClaudeHookEvent[] = [
  'UserPromptSubmit', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop',
];

/**
 * Which event a `hook.event` wire payload denotes, or null for one outside the model.
 *
 * This exists because the payload does not always say. `wmux-hook.js` is invoked
 * two ways (see its usage block): `--event <Event>` for the lifecycle hooks, and
 * a bare `<tool-name>` for PostToolUse — and the bare form sends `{ tool }` with
 * NO `event` field. Reading `params.event` directly therefore admitted
 * Notification, Stop and SubagentStop while silently dropping every PostToolUse.
 *
 * That one omission disabled the only signal that ever declares `working`. A
 * pane never reported a run, so the sidebar fell back to the scraping heuristic
 * this module exists to replace — showing a busy pane as idle, and a finished
 * one as still running. Worse, PostToolUse is also what clears `blocked` the
 * moment the agent resumes work, so answering a permission prompt left "needs
 * you" stuck on the pane until the turn ended.
 *
 * Resolved here rather than by teaching the hook helper to send `event`: hooks
 * are written into settings.json once at install, so the bare-tool form is
 * already out in every existing config and will keep arriving from helper
 * vintages this build does not control. The main process is the single place
 * that sees every payload regardless of who produced it.
 */
export function hookEventName(
  params: { event?: unknown; tool?: unknown } | null | undefined,
): ClaudeHookEvent | null {
  const explicit = typeof params?.event === 'string' ? params.event.trim() : '';
  if (explicit) {
    return KNOWN_HOOK_EVENTS.includes(explicit as ClaudeHookEvent) ? (explicit as ClaudeHookEvent) : null;
  }
  // No event named, but a tool did run — that is PostToolUse by construction,
  // since it is the only hook wmux registers that reports a tool.
  const tool = typeof params?.tool === 'string' ? params.tool.trim() : '';
  return tool ? 'PostToolUse' : null;
}

/**
 * Map one Claude Code hook event to a report_agent payload, or null to ignore it.
 */
export function hookToAgentReport(
  event: ClaudeHookEvent,
  message: string | null,
): ReportAgentParams | null {
  switch (event) {
    // The user pressed Enter: a turn has STARTED.
    //
    // Without this wmux had no turn-start signal at all — the earliest thing it
    // ever heard was PostToolUse, which fires when a tool FINISHES. So the
    // stretch between submitting a prompt and the first completed tool declared
    // nothing, and a pane that was very much thinking read `idle`. For a turn
    // that answers in prose and calls no tool, NOTHING was ever declared and the
    // pane stayed idle from start to end.
    //
    // Absolute runDepth, matching PostToolUse: this is "a turn is in flight",
    // an idempotent statement, not an increment. Submitting a prompt also means
    // the user is plainly not parked on a prompt any more, so it clears
    // `blocked` — they just answered it, by typing.
    case 'UserPromptSubmit':
      return { awaitingHuman: false, runDepth: 1 };

    // Claude Code wants the user. This fires both for permission/question
    // prompts and for the ~60s "still waiting on you" idle nudge, and we park
    // the pane for both: in either case the agent genuinely is waiting on a
    // human, which is exactly what `blocked` claims. Sniffing the message text
    // to tell the two apart was considered and rejected — it would silently
    // stop working the day Claude Code rewords a prompt, and the failure would
    // be the dangerous direction (a real prompt read as "not blocked").
    case 'Notification':
      return { awaitingHuman: true, reason: message };

    // A tool finished, so a turn is in flight — and nobody is parked on a
    // prompt, because a pending permission dialog would have stopped the tool
    // from running at all.
    //
    // Absolute runDepth rather than a delta: this fires on EVERY tool call and
    // nothing decrements per-call, so `runDelta: +1` would climb forever. An
    // absolute value is idempotent — five hundred tool calls still leave the
    // depth at 1.
    case 'PostToolUse':
      return { awaitingHuman: false, runDepth: 1 };

    // One parallel subagent finished. The outer turn normally continues, so
    // this decrements rather than clearing — that is the whole reason runDepth
    // is a refcount. reportAgent clamps at zero, so an unbalanced decrement
    // (a subagent whose start we never saw) cannot go negative.
    case 'SubagentStop':
      return { runDelta: -1 };

    // The turn is over: nothing can still be running and nothing can still be
    // waiting on the user. Decisive on purpose — this is the backstop that
    // guarantees no ghost state survives a turn even if an earlier event was
    // dropped, the same role Stop already plays for the sidebar's agent lines
    // (issue #81 class).
    case 'Stop':
      return { awaitingHuman: false, runDepth: 0 };

    default:
      return null;
  }
}

/**
 * Apply a Claude Code hook event to the declared agent state for `surfaceId`.
 * Called from the hook.event pipe handler in index.ts.
 */
export function applyHookToAgentState(
  surfaceId: SurfaceId,
  event: string,
  message: string | null,
): void {
  if (!KNOWN_HOOK_EVENTS.includes(event as ClaudeHookEvent)) return;

  const params = hookToAgentReport(event as ClaudeHookEvent, message);
  if (!params) return;
  reportAgent(surfaceId, params);
}
