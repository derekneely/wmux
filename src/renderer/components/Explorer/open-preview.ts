// ─── Explorer: opening a file into the markdown preview tab ──────────────────
// Browsing ten files makes ONE tab, not ten. The reuse rules live here rather
// than in the panel because they are store logic and that is what the tests
// point at.

import { useStore } from '../../store';
import { findLeaf, getAllPaneIds } from '../../store/split-utils';
import type { PaneId, WorkspaceId } from '../../../shared/types';

export async function openInPreviewTab(
  workspaceId: WorkspaceId,
  paneId: PaneId,
  filePath: string,
  fileName: string,
  opts: { keep: boolean },
): Promise<void> {
  const store = useStore.getState();
  const workspace = store.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return;

  // The pane may have closed between the render and the click. Falling back to
  // the first leaf beats dropping the click on the floor.
  let targetPane = paneId;
  let leaf = findLeaf(workspace.splitTree, paneId);
  if (!leaf) {
    const first = getAllPaneIds(workspace.splitTree)[0];
    if (!first) return;
    targetPane = first;
    leaf = findLeaf(workspace.splitTree, first);
    if (!leaf) return;
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
    return;
  }

  // 2. Find the pane's preview tab. A DIRTY one is promoted, never recycled —
  //    an unsaved edit is not discarded by a click in a tree.
  const preview = leaf.surfaces.find((s) => s.type === 'markdown' && s.ephemeral);
  let targetSurfaceId = preview && !preview.markdownDirty ? preview.id : null;
  if (preview && preview.markdownDirty) {
    store.updateSurface(workspaceId, targetPane, preview.id, { ephemeral: undefined });
  }

  const read = await window.wmux.markdown.readFile(filePath);
  if (!read || 'error' in read) return; // No empty tab left behind on failure.

  // 3. No reusable preview → make one.
  if (!targetSurfaceId) {
    targetSurfaceId = useStore.getState().addSurface(workspaceId, targetPane, 'markdown', {
      ephemeral: !opts.keep,
    });
    if (!targetSurfaceId) return;
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
}
