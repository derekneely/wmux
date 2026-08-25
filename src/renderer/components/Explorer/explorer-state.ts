// ─── Explorer: pure state helpers ────────────────────────────────────────────
// Kept apart from the components because this is where the unit tests point —
// same split as split-utils.ts and markdown-utils.ts. Nothing here touches
// React, the store or IPC.

import type { ExplorerEntry } from '../../../shared/types';

/** Loaded children, keyed by POSIX rel-path; '' is the root. */
export type ExplorerTreeState = Record<string, ExplorerEntry[]>;

export interface ExplorerRow {
  entry: ExplorerEntry;
  /** POSIX rel-path of this entry from the root. */
  relPath: string;
  /** Indent level; the root's own children are 0. */
  depth: number;
  expanded: boolean;
}

/** POSIX separators everywhere on the renderer side, so a key built from a
 *  main-process reply and one built locally can never disagree. */
export function joinRel(parent: string, name: string): string {
  const base = parent.replace(/\\/g, '/').replace(/\/+$/, '');
  return base ? `${base}/${name}` : name;
}

function isDirLike(entry: ExplorerEntry): boolean {
  return entry.kind !== 'file';
}

/** Directories first, then locale-aware by name. Returns a new array. */
export function sortEntries(entries: ExplorerEntry[]): ExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (isDirLike(a) !== isDirLike(b)) return isDirLike(a) ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });
}

/**
 * Expand or collapse one directory.
 *
 * Collapsing takes its descendants with it — otherwise re-expanding a parent
 * would explode back to whatever was open three levels down, which is not what
 * a collapse looked like it did. The `+ '/'` guard is what keeps a sibling
 * sharing a name prefix ('docs-old' under 'docs') from being swept up.
 */
export function toggleExpanded(expanded: string[], relPath: string): string[] {
  if (expanded.includes(relPath)) {
    const prefix = `${relPath}/`;
    return expanded.filter((p) => p !== relPath && !p.startsWith(prefix));
  }
  return [...expanded, relPath];
}

/**
 * LRU-cap the per-root expansion map. Insertion order IS the recency order —
 * the touched root is deleted and re-inserted so it lands at the end.
 */
export function pruneExpanded(
  map: Record<string, string[]>,
  root: string,
  maxRoots: number,
): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(map)) {
    if (key !== root) next[key] = value;
  }
  next[root] = map[root] ?? [];
  const keys = Object.keys(next);
  if (keys.length <= maxRoots) return next;
  const pruned: Record<string, string[]> = {};
  for (const key of keys.slice(keys.length - maxRoots)) pruned[key] = next[key];
  return pruned;
}

/**
 * Depth-first walk of what is currently on screen, in visual order. Backs
 * arrow-key navigation, which needs "the row below this one" and cannot get it
 * from a recursive component tree.
 *
 * An expanded directory with no loaded children simply yields no children —
 * the fetch is in flight, and the rows re-render when it lands.
 */
export function flattenVisible(
  tree: ExplorerTreeState,
  expanded: string[],
): ExplorerRow[] {
  const open = new Set(expanded);
  const rows: ExplorerRow[] = [];

  const walk = (relPath: string, depth: number): void => {
    for (const entry of sortEntries(tree[relPath] ?? [])) {
      const childPath = joinRel(relPath, entry.name);
      // A symlink is never expandable — the jail refuses to traverse it, so an
      // expander arrow would be an affordance for a guaranteed error.
      const canExpand = entry.kind === 'dir';
      const isOpen = canExpand && open.has(childPath);
      rows.push({ entry, relPath: childPath, depth, expanded: isOpen });
      if (isOpen) walk(childPath, depth + 1);
    }
  };

  walk('', 0);
  return rows;
}

/**
 * Identity of an in-flight listDir. Rapid pane switching would otherwise paint
 * one pane's children under another pane's tree, so a reply whose key no longer
 * matches the current one is dropped rather than applied.
 *
 * `|` is the separator (not the NUL a prior version used, which made the file
 * register as binary to git). `|` is safe: `surfaceId` is a branded
 * `surf-{uuid}` and cannot contain it; the `variant` values are POSIX
 * rel-paths (normalized by joinRel, never carrying one) or a boolean's
 * spelling; `root` is an absolute Windows path, and `|` is a reserved
 * character Windows paths can never contain.
 *
 * `variant` is deliberately untyped beyond `string`: the key only has to be an
 * identity, and call sites pass whatever else distinguishes one in-flight
 * request from another (a rel-path, or `String(showHidden)`).
 */
export function responseKey(surfaceId: string, root: string, variant: string): string {
  return `${surfaceId}|${root}|${variant}`;
}

// ─── Absolute paths ──────────────────────────────────────────────────────────
// Enumeration only ever needs a surfaceId and a rel-path — main owns the root.
// But every ACTION on a listed entry (open, reveal, open-in-default-app, copy
// path) needs a real absolute Windows path, and the renderer is what builds it.
// These two helpers are the whole of that construction, kept pure and here
// rather than inline in the panel because getting the root wrong is silent:
// the tree still paints, and only the clicks fail.

/**
 * Which root absolute paths are built from.
 *
 * `resolvedRoot` is `ExplorerListOk.root` — the absolute, realpath'd Windows
 * path main itself listed. `reportedCwd` is the verbatim `report_pwd`
 * argument, which is a Windows path only by luck: the bash integration reports
 * `$(pwd)`, i.e. `/c/Users/...`, and a pwsh cwd can be a junction, an 8.3
 * short name, or cased differently from the real directory. Main normalizes
 * all of those for ENUMERATION, so a tree built on the reported cwd looks
 * perfectly healthy while every path built from it is unopenable.
 *
 * So the resolved root always wins. The reported cwd is a fallback for exactly
 * one window — before the first root reply has landed — where it is that or
 * nothing.
 */
export function pathRoot(resolvedRoot: string | null | undefined, reportedCwd: string): string {
  return resolvedRoot || reportedCwd;
}

/** Join a POSIX rel-path onto an absolute Windows root. */
export function toAbsolutePath(root: string, relPath: string): string {
  const base = root.replace(/[\\/]+$/, '');
  const tail = relPath.replace(/\//g, '\\');
  return tail ? `${base}\\${tail}` : base;
}
