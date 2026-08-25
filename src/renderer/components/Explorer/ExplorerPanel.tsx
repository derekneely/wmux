import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { findLeaf } from '../../store/split-utils';
import { useT } from '../../i18n';
import type { ExplorerErrorCode, ExplorerListResult } from '../../../shared/types';
import {
  flattenVisible, pruneExpanded, responseKey, toggleExpanded,
  type ExplorerRow, type ExplorerTreeState,
} from './explorer-state';
import { ExplorerTree } from './ExplorerTree';
import '../../styles/explorer.css';
import type { PaneId } from '../../../shared/types';

const MAX_ROOTS = 8;

interface ExplorerPanelProps {
  onClose: () => void;
  /** Focused pane id, lifted from App.tsx local state — not store state. */
  focusedPaneId: PaneId | null;
}

export function ExplorerPanel({ onClose, focusedPaneId }: ExplorerPanelProps): React.JSX.Element {
  const t = useT();
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const updateWorkspaceMetadata = useStore((s) => s.updateWorkspaceMetadata);

  // The root follows the FOCUSED PANE's active surface, not the workspace: the
  // workspace cwd is last-reporter-wins across every pane and would thrash.
  const focusedSurface = useMemo(() => {
    if (!workspace || !focusedPaneId) return null;
    const leaf = findLeaf(workspace.splitTree, focusedPaneId);
    return leaf?.surfaces[leaf.activeSurfaceIndex] ?? null;
  }, [workspace, focusedPaneId]);

  const surfaceId = focusedSurface?.id ?? null;
  const root = focusedSurface?.currentCwd ?? focusedSurface?.cwd ?? workspace?.cwd ?? '';

  const [tree, setTree] = useState<ExplorerTreeState>({});
  const [error, setError] = useState<ExplorerErrorCode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const expandedByRoot = workspace?.explorerExpanded ?? {};
  const expanded = expandedByRoot[root] ?? [];

  // The current identity of this tree. A reply that no longer matches when it
  // lands is dropped — rapid pane switching would otherwise paint one pane's
  // children under another pane's tree.
  const currentKeyRef = useRef('');
  currentKeyRef.current = responseKey(surfaceId ?? '', root, String(showHidden));

  const fetchDir = useCallback(async (relPath: string) => {
    if (!surfaceId || !root) return;
    const key = currentKeyRef.current;
    setLoading(true);
    try {
      const result: ExplorerListResult =
        await window.wmux.explorer.listDir(surfaceId, relPath, { showHidden });
      // Clear loading for THIS call unconditionally, even if stale. A stale
      // reply that skipped this would strand the spinner/empty-state forever
      // if the newer fetch then bailed at the guard above (no surfaceId/root)
      // and never started its own — nothing else would ever clear it.
      setLoading(false);
      if (currentKeyRef.current !== key) return; // stale — a different pane/root now
      if ('error' in result) {
        // Only a ROOT failure blanks the panel; a failure expanding one child
        // leaves the rest of the tree on screen.
        if (relPath === '') { setError(result.code); setTree({}); }
        return;
      }
      setError(null);
      if (relPath === '') setTruncated(result.truncated);
      setTree((prev) => ({ ...prev, [result.relPath]: result.entries }));
    } catch {
      // ipcRenderer.invoke rejected — main threw rather than returning a
      // structured ExplorerListError, so there is no `code` to branch on.
      // Fall back to the generic read_failed message rather than leaving an
      // unhandled rejection and a stuck spinner.
      setLoading(false);
      if (currentKeyRef.current !== key) return;
      if (relPath === '') { setError('read_failed'); setTree({}); }
    }
  }, [surfaceId, root, showHidden]);

  // Re-root whenever the focused pane, its cwd, or the hidden filter changes.
  useEffect(() => {
    setTree({});
    setError(null);
    setSelected(null);
    if (surfaceId && root) void fetchDir('');
  }, [surfaceId, root, showHidden, fetchDir]);

  const handleToggleDir = useCallback((relPath: string) => {
    if (!activeWorkspaceId) return;
    const next = toggleExpanded(expanded, relPath);
    const map = pruneExpanded({ ...expandedByRoot, [root]: next }, root, MAX_ROOTS);
    updateWorkspaceMetadata(activeWorkspaceId, { explorerExpanded: map });
    if (next.includes(relPath) && !tree[relPath]) void fetchDir(relPath);
  }, [activeWorkspaceId, expanded, expandedByRoot, root, tree, fetchDir, updateWorkspaceMetadata]);

  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  const handleActivate = useCallback((_row: ExplorerRow, _opts: { keep: boolean }) => {
    // Task 7 wires the preview-tab open flow here.
  }, []);

  const rootLabel = root ? (root.split(/[\\/]/).filter(Boolean).pop() ?? root) : '';

  return (
    <div className="explorer-panel">
      <div className="explorer-panel__header">
        <span className="explorer-panel__root" title={root}>
          {rootLabel || t('explorer.title', 'Explorer')}
        </span>
        <button
          className="explorer-panel__action"
          title={t('explorer.refresh', 'Refresh')}
          onClick={() => { setTree({}); void fetchDir(''); }}
        >{'↻'}</button>
        <button
          className="explorer-panel__action"
          title={showHidden
            ? t('explorer.hideHidden', 'Hide hidden files')
            : t('explorer.showHidden', 'Show hidden files')}
          onClick={() => setShowHidden((v) => !v)}
        >{showHidden ? '◉' : '○'}</button>
        <button
          className="explorer-panel__action"
          title={t('explorer.close', 'Close explorer')}
          onClick={onClose}
        >{'×'}</button>
      </div>
      <div className="explorer-panel__body">
        {error && (
          <div className="explorer-panel__message">{t(`explorer.error.${error}` as any, error)}</div>
        )}
        {!error && rows.length === 0 && !loading && (
          <div className="explorer-panel__message">{t('explorer.empty', 'This folder is empty')}</div>
        )}
        {!error && (
          <ExplorerTree
            rows={rows}
            selectedRelPath={selected}
            onToggleDir={handleToggleDir}
            onSelect={(row) => setSelected(row.relPath)}
            onActivate={handleActivate}
            onContextMenu={() => { /* Task 7 */ }}
          />
        )}
        {truncated && (
          <div className="explorer-panel__message">
            {t('explorer.truncated', 'Showing the first {count} entries').replace('{count}', '2000')}
          </div>
        )}
      </div>
    </div>
  );
}
