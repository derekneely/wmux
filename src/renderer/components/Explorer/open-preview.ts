// ─── Explorer: opening a file into the markdown preview tab ──────────────────
// Browsing ten files makes ONE tab, not ten. The reuse rules live here rather
// than in the panel because they are store logic and that is what the tests
// point at.

import { useStore } from '../../store';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { ExplorerErrorCode, PaneId, WorkspaceId } from '../../../shared/types';

/**
 * `markdown.readFile`'s failure codes, mapped onto the explorer's own — which
 * are the ones with `explorer.error.*` translations in every locale.
 *
 * Only `code` is ever mapped. The sibling `error` field stays English on
 * purpose (it is for main-process callers and the log), so rendering it would
 * put an untranslated string in front of a French user — the same split
 * commit 82a779f drew for MarkdownReadError.
 *
 * Anything unlisted falls back to `read_failed`: "could not read it" is true of
 * every failure here, and a wrong-but-specific message is worse than a vague
 * correct one.
 */
const READ_ERROR_CODES: Record<string, ExplorerErrorCode> = {
  not_found: 'not_found',
  no_path: 'invalid_path',
  unsupported_type: 'invalid_path',
  symlink: 'invalid_path',
  not_regular_file: 'invalid_path',
  too_large: 'read_failed',
  read_failed: 'read_failed',
};

/**
 * Null on success, or when a newer open superseded this one — a superseded open
 * is not a failure, and reporting one would flash an error for a file the user
 * has already navigated away from.
 */
export type PreviewOpenFailure = ExplorerErrorCode | null;

// Fast browsing is exactly what this feature exists for, and two clicks in
// quick succession race across the `readFile` await below. Two distinct
// failures, two distinct guards:
//
// - With NO preview open yet, both calls could pass the "find a reusable
//   preview" check (step 2) before either has created one, producing TWO
//   ephemeral tabs — permanently defeating the reuse rule. `paneQueues`
//   serializes every open onto the SAME target pane so the second call's
//   step-2 check only ever runs after the first call has fully finished
//   creating/updating a surface.
// - With a preview ALREADY open, both calls resolve onto the same
//   `targetSurfaceId`, and without ordering the later-LANDING read would win
//   over the later-CLICKED one. Serializing already prevents the two reads
//   from overlapping, but `seq` is kept as an independent second guard —
//   cheap insurance against a future caller that reaches `openOnce` outside
//   the queue (a keyboard handler, a test) reintroducing the race.
let seq = 0;
const paneQueues = new Map<string, Promise<PreviewOpenFailure>>();

export function openInPreviewTab(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  filePath: string,
  fileName: string,
  opts: { keep: boolean },
): Promise<PreviewOpenFailure> {
  const key = `${workspaceId}:${paneId}`;
  const prev = paneQueues.get(key);
  // When the queue is idle, start openOnce SYNCHRONOUSLY (not via .then()) —
  // it must run up through its own `readFile` call in the same tick as the
  // caller's click, or the very first open in a burst would already be a
  // microtask behind the second one and the ordering this exists to fix
  // would be lost before either open even reaches its await.
  //
  // The chain continues on rejection as well as fulfilment (both `then` arms
  // run the same callback): a previous open that threw must not swallow every
  // later open behind it, which is the same wedge the `clear` below guards
  // against on the map side.
  const next = (): Promise<PreviewOpenFailure> =>
    openOnce(workspaceId, paneId, filePath, fileName, opts);
  const run = prev ? prev.then(next, next) : next();
  paneQueues.set(key, run);
  // Clear the entry once THIS call settles, but only if nothing newer has
  // already replaced it — otherwise a slow call's cleanup could evict a
  // fresher call's still-in-flight entry out from under it. This also keeps
  // one rejected/failed open from wedging every later open behind a
  // permanently-settled queue entry: the map simply goes back to idle.
  const clear = () => { if (paneQueues.get(key) === run) paneQueues.delete(key); };
  run.then(clear, clear);
  return run;
}

async function openOnce(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  filePath: string,
  fileName: string,
  opts: { keep: boolean },
): Promise<PreviewOpenFailure> {
  const store = useStore.getState();
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;

  // The pane may have closed between the render and the click. Falling back to
  // the first leaf beats dropping the click on the floor.
  let targetPane = paneId;
  let leaf = findLeaf(workspace.splitTree, paneId);
  if (!leaf) {
    const first = getAllPaneIds(workspace.splitTree)[0];
    if (!first) return null;
    targetPane = first;
    leaf = findLeaf(workspace.splitTree, first);
    if (!leaf) return null;
  }

  // 1. Already open in this pane → focus it. Same "check before adding" rule as
  //    maybeAutoOpenDiffTab (App.tsx:215).
  const existingIndex = leaf.surfaces.findIndex((s) => s.markdownFilePath === filePath);
  if (existingIndex >= 0) {
    const existing = leaf.surfaces[existingIndex];
    store.selectSurface(workspaceId, targetPane, existingIndex);
    if (opts.keep && existing.ephemeral) {
      store.updateSurface(workspaceId, targetPane, existing.id, { ephemeral: undefined });
    }
    return null;
  }

  // 2. Find the pane's preview tab. A DIRTY one is promoted, never recycled —
  //    an unsaved edit is not discarded by a click in a tree.
  const preview = leaf.surfaces.find((s) => s.type === 'markdown' && s.ephemeral);
  let targetSurfaceId = preview && !preview.markdownDirty ? preview.id : null;
  if (preview && preview.markdownDirty) {
    store.updateSurface(workspaceId, targetPane, preview.id, { ephemeral: undefined });
  }

  const mine = ++seq;
  const read = await window.wmux.markdown.readFile(filePath);
  if (mine !== seq) return null; // a newer open landed while this one was in flight
  // No empty tab is left behind on failure — but the failure is REPORTED, not
  // swallowed. Silence here is what made a wrong absolute path look like a
  // dead click with no explanation, and it hides every click on a file that
  // was deleted out from under the tree.
  if (!read) return 'read_failed';
  if ('error' in read) return READ_ERROR_CODES[read.code] ?? 'read_failed';

  // 3. No reusable preview → make one.
  if (!targetSurfaceId) {
    targetSurfaceId = useStore.getState().addSurface(workspaceId, targetPane, 'markdown', {
      ephemeral: !opts.keep,
    });
    if (!targetSurfaceId) return 'read_failed';
  } else if (opts.keep) {
    store.updateSurface(workspaceId, targetPane, targetSurfaceId, { ephemeral: undefined });
  }

  // fileName is REQUIRED: without it markdownFileName is not updated and the
  // tab keeps the previous file's label.
  useStore.getState().setMarkdownContent(targetSurfaceId, read.content, {
    filePath: read.filePath,
    fileName,
    mtimeMs: read.mtimeMs,
  });
  return null;
}
