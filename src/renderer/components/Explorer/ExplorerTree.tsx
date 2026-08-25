import React from 'react';
import type { ExplorerRow } from './explorer-state';

interface ExplorerTreeProps {
  rows: ExplorerRow[];
  selectedRelPath: string | null;
  onToggleDir: (relPath: string) => void;
  onSelect: (row: ExplorerRow) => void;
  /** Task 7 wires the open flow here; Task 6 passes a no-op. */
  onActivate: (row: ExplorerRow, opts: { keep: boolean }) => void;
  onContextMenu: (row: ExplorerRow, event: React.MouseEvent) => void;
}

export function ExplorerTree({
  rows, selectedRelPath, onToggleDir, onSelect, onActivate, onContextMenu,
}: ExplorerTreeProps): React.JSX.Element {
  return (
    <div className="explorer-tree" role="tree">
      {rows.map((row) => {
        const isDir = row.entry.kind === 'dir';
        // A symlink is inert: the jail refuses to traverse it and
        // markdown.readFile refuses to read one, so neither affordance applies.
        const isLink = row.entry.kind === 'symlink';
        const dimmed = !isDir && !row.entry.viewable;
        return (
          <div
            key={row.relPath}
            role="treeitem"
            aria-expanded={isDir ? row.expanded : undefined}
            aria-selected={row.relPath === selectedRelPath}
            className={[
              'explorer-row',
              row.relPath === selectedRelPath ? 'explorer-row--selected' : '',
              dimmed ? 'explorer-row--dimmed' : '',
              isLink ? 'explorer-row--link' : '',
            ].filter(Boolean).join(' ')}
            style={{ paddingLeft: 8 + row.depth * 14 }}
            title={row.entry.name}
            onClick={(e) => {
              onSelect(row);
              if (isDir) onToggleDir(row.relPath);
              // Ctrl+click promotes, same as a double-click.
              else if (row.entry.viewable) onActivate(row, { keep: e.ctrlKey });
            }}
            onDoubleClick={() => {
              if (!isDir && row.entry.viewable) onActivate(row, { keep: true });
            }}
            onContextMenu={(e) => { e.preventDefault(); onContextMenu(row, e); }}
          >
            <span className="explorer-row__chevron">
              {isDir ? (row.expanded ? '▾' : '▸') : ''}
            </span>
            <span className="explorer-row__name">{row.entry.name}</span>
          </div>
        );
      })}
    </div>
  );
}
