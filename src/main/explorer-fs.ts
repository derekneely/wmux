// ─── File explorer: directory enumeration and its jail ───────────────────────
// This module is the ENTIRE security surface of the explorer panel. `relPath`
// arrives from the renderer and is treated as attacker-controlled; `root`
// arrives from explorer-roots.ts, which has already resolved it through
// fs.realpath.native, and IS trusted.
//
// Reads are deliberately NOT governed here. markdown.readFile accepts any
// absolute path and is gated only on the extension whitelist, by existing
// design — the explorer widens nothing, and adding a second read guard is the
// duplication markdown-file.ts was extracted to prevent.
//
// TOCTOU is accepted, not solved. Between the segment walk and the readdir a
// segment could be swapped for a link. Closing that needs handle-based
// traversal (openat-style), which Node does not expose portably. The residual
// capability is "enumerate a directory outside the root", by an attacker who
// already has local write access to the project root — and who could just put
// a .md file there instead.

import * as fs from 'fs';
import * as path from 'path';
import type {
  ExplorerEntry,
  ExplorerListError,
  ExplorerListResult,
} from '../shared/types';
import { isAllowedMarkdownPath } from './markdown-file';
import { canonical } from './markdown-grants';

/** Per-directory cap. Exceeding it sets `truncated` rather than shipping a
 *  50k-element array through IPC. */
export const MAX_ENTRIES = 2000;

/** Static skip list. Deliberately not .gitignore parsing — a tree that needs a
 *  parser to decide what to show is a different feature. */
export const FILTERED_NAMES = new Set(['.git', 'node_modules', 'dist', 'build']);

const RESERVED_STEM = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

function fail(message: string, code: ExplorerListError['code']): ExplorerListError {
  return { error: message, code };
}

/**
 * Windows path policy. Runs BEFORE any path.resolve — several of these forms
 * resolve to somewhere surprising rather than throwing, so rejecting after
 * resolution would be reasoning about an already-lost path.
 */
export function validateRelPath(relPath: string): 'invalid_path' | null {
  if (typeof relPath !== 'string') return 'invalid_path';
  if (relPath === '' || relPath === '.') return null;

  // UNC (\\server\share) and the namespace prefixes \\?\ and \\.\ .
  if (/^[\\/]{2}/.test(relPath)) return 'invalid_path';
  // Absolute, and drive-relative 'C:foo' — the latter is NOT absolute by
  // path.isAbsolute, and path.resolve would resolve it against THAT drive's
  // own current directory, which is not the root.
  if (path.isAbsolute(relPath)) return 'invalid_path';
  if (/^[A-Za-z]:/.test(relPath)) return 'invalid_path';
  if (/^[\\/]/.test(relPath)) return 'invalid_path';

  for (const segment of relPath.split(/[\\/]+/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    // Alternate data streams: 'notes.md:hidden' opens a different byte stream
    // than the name displayed.
    if (segment.includes(':')) return 'invalid_path';
    // Stem-wise, so CON.md is rejected too — Windows resolves it to the device.
    if (RESERVED_STEM.test(segment.split('.')[0])) return 'invalid_path';
    // Windows silently strips a trailing dot or space, so the path displayed
    // and the path opened would differ.
    if (/[ .]$/.test(segment)) return 'invalid_path';
  }
  return null;
}

function mapErrno(err: any): ExplorerListError {
  const code = err?.code;
  if (code === 'ENOENT') return fail('Directory not found', 'not_found');
  if (code === 'ENOTDIR') return fail('Not a directory', 'not_a_directory');
  if (code === 'EACCES' || code === 'EPERM') return fail('Permission denied', 'denied');
  // Node fs errors embed the full absolute path, which on Windows carries the
  // user's account name — never put that on the wire to the renderer (the
  // same reason wmux crash-report avoids the path-bearing Win32_Process
  // properties). Log the real message main-side only; the renderer gets a
  // fixed, English, path-free string.
  console.error('[explorer-fs] read failed:', err?.message ?? err);
  return fail('Failed to read directory', 'read_failed');
}

/** POSIX separators on the wire, so the renderer's rel-path keys are stable
 *  regardless of which side built them. */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * The jail, shared by every caller that turns a renderer-supplied `relPath`
 * into an absolute path under a trusted root.
 *
 * Extracted out of listDir so directory enumeration and file reading cannot
 * drift apart — a second copy of a segment walk is exactly the duplication
 * this module's header refuses. `leaf` is the ONLY difference between the two
 * callers: listDir needs the final segment to be a directory, a code read
 * needs it to be a regular file. Every INTERMEDIATE segment is a directory
 * either way, and no segment may be a symlink.
 */
export async function resolveInRoot(
  root: string,
  relPath: string,
  leaf: 'dir' | 'file',
): Promise<{ abs: string } | ExplorerListError> {
  const invalid = validateRelPath(relPath);
  if (invalid) return fail('Invalid path', invalid);

  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, relPath);
  const rel = path.relative(rootAbs, abs);

  // The root itself is a directory by construction, so asking for a file at
  // the empty path is a caller bug, not a filesystem outcome. Answering
  // invalid_path here keeps the segment loop below from silently accepting it
  // by iterating zero times.
  if (rel === '' && leaf === 'file') return fail('Invalid path', 'invalid_path');

  // isAbsolute(rel) would be the cross-drive case: path.relative returns an
  // absolute path rather than a '..' chain when the two live on different
  // drives. In practice validateRelPath already rejects any drive-qualified
  // relPath (^[A-Za-z]:) before this point, so a drive-qualified `abs` can
  // never reach here and this clause is unreachable given the current
  // policy. Kept anyway as deliberate defensive code — it is one line, and
  // it is what stops this function from being cross-drive-unsafe should the
  // policy layer above it ever change.
  // `rel === '..' || startsWith('..' + sep)` — NOT startsWith('..'), which also
  // rejects a legitimately-named child like `..foo` or `...`. The user sees
  // that as a folder in the tree that refuses to open, with no way to tell why.
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`);
  if (escapes || path.isAbsolute(rel)) {
    return fail('Path is outside the root', 'outside_root');
  }
  // Belt and braces for Windows spellings (8.3 short names are already gone —
  // the root was realpath'd on the way in). The explicit + path.sep is what
  // stops a SIBLING sharing a name prefix from passing as a child.
  const cRoot = canonical(rootAbs);
  const cAbs = canonical(abs);
  if (cAbs !== cRoot && !cAbs.startsWith(cRoot + path.sep)) {
    return fail('Path is outside the root', 'outside_root');
  }

  // Segment walk. lstat'ing only the final path is insufficient: root\link\sub
  // follows `link` before the final lstat ever runs. libuv maps Windows
  // reparse points onto symlinks, so `mklink /J` junctions report
  // isSymbolicLink() === true and this one check covers both.
  const segments = rel === '' ? [] : rel.split(path.sep);
  let cursor = rootAbs;
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(cursor);
    } catch (err) {
      return mapErrno(err);
    }
    if (st.isSymbolicLink()) return fail('Path is outside the root', 'outside_root');
    const isLast = i === segments.length - 1;
    if (!isLast || leaf === 'dir') {
      if (!st.isDirectory()) return fail('Not a directory', 'not_a_directory');
    } else if (!st.isFile()) {
      // A directory where a file was expected. Reusing invalid_path rather
      // than inventing a third code: the user clicked something the tree
      // rendered as a file, so the tree and the disk disagree — which is the
      // same class of answer invalid_path already carries.
      return fail('Not a regular file', 'invalid_path');
    }
  }

  return { abs };
}

/**
 * List one directory under `root`.
 *
 * Pure w.r.t. wmux state: resolving WHICH root belongs to a surface is the IPC
 * handler's job (explorer-roots.ts), which is what keeps this testable without
 * faking surface state.
 */
export async function listDir(
  root: string,
  relPath: string,
  opts: { showHidden?: boolean } = {},
): Promise<ExplorerListResult> {
  const resolved = await resolveInRoot(root, relPath, 'dir');
  if ('error' in resolved) return resolved;
  const abs = resolved.abs;
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, abs);

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch (err) {
    return mapErrno(err);
  }

  const entries: ExplorerEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    // Windows hidden/system ATTRIBUTES are deliberately not consulted: the
    // dotfile convention is the rule, so this tree shows what the same tree
    // shows in WSL.
    if (!opts.showHidden && (dirent.name.startsWith('.') || FILTERED_NAMES.has(dirent.name))) {
      continue;
    }
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const kind: ExplorerEntry['kind'] = dirent.isSymbolicLink()
      ? 'symlink'
      : dirent.isDirectory()
        ? 'dir'
        : 'file';
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = await fs.promises.lstat(path.join(abs, dirent.name));
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // Raced away between readdir and lstat — list it with zeroes rather than
      // failing the whole directory over one entry.
    }
    entries.push({
      name: dirent.name,
      kind,
      size,
      mtimeMs,
      // A link is never viewable: markdown.readFile refuses symlinks outright,
      // so offering one would be offering a click guaranteed to fail.
      viewable: kind === 'file' && isAllowedMarkdownPath(dirent.name),
    });
  }

  return { root: rootAbs, relPath: toPosix(rel), entries, truncated };
}
