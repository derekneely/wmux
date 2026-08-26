import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store';
import { findLeaf } from '../../store/split-utils';
import { useT } from '../../i18n';
import type { ExplorerErrorCode, ExplorerListResult } from '../../../shared/types';
import {
  flattenVisible, pathRoot, pruneExpanded, responseKey, toAbsolutePath, toggleExpanded,
  type ExplorerRow, type ExplorerTreeState,
} from './explorer-state';
import { ExplorerTree } from './ExplorerTree';
import { openInPreviewTab } from './open-preview';
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
  // The cwd as REPORTED by the shell. Good enough to identify a fetch, and it
  // is what main resolves a root from — but never good enough to build a path
  // out of, which is what `absRoot` below is for.
  const root = focusedSurface?.currentCwd ?? focusedSurface?.cwd ?? workspace?.cwd ?? '';

  const [tree, setTree] = useState<ExplorerTreeState>({});
  const [error, setError] = useState<ExplorerErrorCode | null>(null);
  const [openError, setOpenError] = useState<ExplorerErrorCode | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // The absolute, realpath'd root main actually listed, taken from the root
  // reply. Main already knows it; before this landed the renderer threw it away
  // and concatenated paths onto the reported cwd instead, which under Git Bash
  // produced `/c/Users/x/repo\README.md` — a string no Windows API accepts, so
  // opening, revealing and copying a path all failed silently.
  const [resolvedRoot, setResolvedRoot] = useState<string | null>(null);

  const absRoot = pathRoot(resolvedRoot, root);

  // Expansion is keyed off the RESOLVED root, so the two spellings of one
  // directory (a junction and its target, `/c/...` and `C:\...`) share a single
  // entry instead of fragmenting into two.
  const expandedByRoot = workspace?.explorerExpanded ?? {};
  const expanded = expandedByRoot[absRoot] ?? [];

  // Everything derived from a SUCCESSFUL root listing, cleared together. The
  // banner and the resolved root are both statements about one specific folder
  // — leaving either behind puts a stale "Showing the first 2000 entries" under
  // a different folder, or lets a click build a path from a root that is no
  // longer the one on screen.
  const resetRootState = useCallback(() => {
    setResolvedRoot(null);
    setTruncated(false);
    setOpenError(null);
  }, []);

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
        if (relPath === '') { setError(result.code); setTree({}); resetRootState(); }
        return;
      }
      setError(null);
      if (relPath === '') {
        setTruncated(result.truncated);
        setResolvedRoot(result.root);
      }
      setTree((prev) => ({ ...prev, [result.relPath]: result.entries }));
    } catch {
      // ipcRenderer.invoke rejected — main threw rather than returning a
      // structured ExplorerListError, so there is no `code` to branch on.
      // Fall back to the generic read_failed message rather than leaving an
      // unhandled rejection and a stuck spinner.
      setLoading(false);
      if (currentKeyRef.current !== key) return;
      if (relPath === '') { setError('read_failed'); setTree({}); resetRootState(); }
    }
  }, [surfaceId, root, showHidden, resetRootState]);

  // Re-root whenever the focused pane, its cwd, or the hidden filter changes.
  useEffect(() => {
    setTree({});
    setError(null);
    setSelected(null);
    resetRootState();
    if (surfaceId && root) void fetchDir('');
  }, [surfaceId, root, showHidden, fetchDir, resetRootState]);

  const handleToggleDir = useCallback((relPath: string) => {
    if (!activeWorkspaceId) return;
    const next = toggleExpanded(expanded, relPath);
    const map = pruneExpanded({ ...expandedByRoot, [absRoot]: next }, absRoot, MAX_ROOTS);
    updateWorkspaceMetadata(activeWorkspaceId, { explorerExpanded: map });
    if (next.includes(relPath) && !tree[relPath]) void fetchDir(relPath);
  }, [activeWorkspaceId, expanded, expandedByRoot, absRoot, tree, fetchDir, updateWorkspaceMetadata]);

  const rows = useMemo(() => flattenVisible(tree, expanded), [tree, expanded]);

  // The tree's relPath is POSIX; the backing path the markdown surface saves
  // and reveals with must be a real Windows path — built from `absRoot`, never
  // from the reported cwd.
  const absolutePathOf = useCallback(
    (relPath: string) => toAbsolutePath(absRoot, relPath),
    [absRoot],
  );

  const handleActivate = useCallback((row: ExplorerRow, opts: { keep: boolean }) => {
    // No `focusedPaneId` bail: openInPreviewTab falls back to the workspace's
    // first pane when the id does not resolve, and dropping the click here
    // meant that recovery path could never run.
    if (!activeWorkspaceId || !absRoot) return;
    const absolute = absolutePathOf(row.relPath);
    setOpenError(null);
    void openInPreviewTab(
      activeWorkspaceId, focusedPaneId ?? ('' as PaneId), absolute, row.entry.name, opts,
    ).then(setOpenError, () => setOpenError('read_failed'));
  }, [activeWorkspaceId, focusedPaneId, absRoot, absolutePathOf]);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; row: ExplorerRow } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback((row: ExplorerRow, event: React.MouseEvent) => {
    setContextMenu({ x: event.clientX, y: event.clientY, row });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu(); };
    const handleMouseDown = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) closeContextMenu();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [contextMenu, closeContextMenu]);

  const copyPath = useCallback((relPath: string) => {
    void window.wmux?.clipboard?.writeText?.(absolutePathOf(relPath));
  }, [absolutePathOf]);

  const rootLabel = absRoot ? (absRoot.split(/[\\/]/).filter(Boolean).pop() ?? absRoot) : '';

  return (
    <div className="explorer-panel">
      <div className="explorer-panel__header">
        <span className="explorer-panel__root" title={absRoot}>
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
            onContextMenu={handleContextMenu}
          />
        )}
        {truncated && (
          <div className="explorer-panel__message">
            {t('explorer.truncated', 'Showing the first {count} entries').replace('{count}', '2000')}
          </div>
        )}
        {/* A FAILED OPEN, not a failed listing: it sits under the tree and
            leaves the rows on screen, because the folder is still readable —
            it is one file that could not be shown. Blanking the panel the way
            `error` does would throw away the tree the user is browsing. */}
        {openError && (
          <div className="explorer-panel__message">
            {t(`explorer.error.${openError}` as any, openError)}
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="ctx-menu"
          role="menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="ctx-menu__item"
            role="menuitem"
            onClick={() => { copyPath(contextMenu.row.relPath); closeContextMenu(); }}
          >
            {t('explorer.copyPath', 'Copy path')}
          </div>
          <div
            className={`ctx-menu__item${contextMenu.row.entry.viewable ? '' : ' ctx-menu__item--disabled'}`}
            role="menuitem"
            aria-disabled={!contextMenu.row.entry.viewable}
            onClick={() => {
              if (!contextMenu.row.entry.viewable) return;
              void window.wmux.markdown.reveal(absolutePathOf(contextMenu.row.relPath));
              closeContextMenu();
            }}
          >
            {t('explorer.reveal', 'Reveal in File Explorer')}
          </div>
          <div
            className={`ctx-menu__item${contextMenu.row.entry.viewable ? '' : ' ctx-menu__item--disabled'}`}
            role="menuitem"
            aria-disabled={!contextMenu.row.entry.viewable}
            onClick={() => {
              if (!contextMenu.row.entry.viewable) return;
              void window.wmux.markdown.openInApp(absolutePathOf(contextMenu.row.relPath));
              closeContextMenu();
            }}
          >
            {t('explorer.openInApp', 'Open in default app')}
          </div>
          {!contextMenu.row.entry.viewable && (
            <div className="explorer-panel__ctx-hint">
              {t('explorer.notViewable', 'wmux can only open text files')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
