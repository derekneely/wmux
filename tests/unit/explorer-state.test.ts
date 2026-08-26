import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  joinRel, sortEntries, toggleExpanded, pruneExpanded, flattenVisible, responseKey,
  pathRoot, toAbsolutePath,
} from '../../src/renderer/components/Explorer/explorer-state';

const dir = (name: string): any => ({ name, kind: 'dir', size: 0, mtimeMs: 0, viewable: false });
const file = (name: string, viewable = true): any => ({ name, kind: 'file', size: 1, mtimeMs: 0, viewable });

describe('joinRel', () => {
  it('joins with POSIX separators and treats the root as empty', () => {
    expect(joinRel('', 'docs')).toBe('docs');
    expect(joinRel('docs', 'nested')).toBe('docs/nested');
  });
  it('normalizes a backslash parent so keys never disagree', () => {
    expect(joinRel('docs\\nested', 'x')).toBe('docs/nested/x');
  });
});

describe('sortEntries', () => {
  it('puts directories before files, then locale-aware by name', () => {
    const out = sortEntries([file('b.md'), dir('zeta'), file('a.md'), dir('Alpha')]);
    expect(out.map((e: any) => e.name)).toEqual(['Alpha', 'zeta', 'a.md', 'b.md']);
  });
  it('groups symlinks with directories rather than with files', () => {
    const out = sortEntries([file('a.md'), { ...dir('link'), kind: 'symlink' }]);
    expect(out[0].name).toBe('link');
  });
  it('does not mutate its input', () => {
    const input = [file('b.md'), file('a.md')];
    sortEntries(input);
    expect(input.map((e) => e.name)).toEqual(['b.md', 'a.md']);
  });
});

describe('toggleExpanded', () => {
  it('adds and removes', () => {
    expect(toggleExpanded([], 'docs')).toEqual(['docs']);
    expect(toggleExpanded(['docs'], 'docs')).toEqual([]);
  });
  it('collapsing a parent also collapses its descendants', () => {
    expect(toggleExpanded(['docs', 'docs/nested', 'src'], 'docs')).toEqual(['src']);
  });
  it('does not collapse a sibling with a shared name prefix', () => {
    expect(toggleExpanded(['docs', 'docs-old'], 'docs')).toEqual(['docs-old']);
  });
});

describe('pruneExpanded', () => {
  it('keeps the newest maxRoots entries with the touched root last', () => {
    const out = pruneExpanded({ a: [], b: [], c: [] }, 'd', 3);
    expect(Object.keys(out)).toEqual(['b', 'c', 'd']);
  });
  it('re-touching an existing root moves it to the end without dropping it', () => {
    const out = pruneExpanded({ a: ['x'], b: [], c: [] }, 'a', 3);
    expect(Object.keys(out)).toEqual(['b', 'c', 'a']);
    expect(out.a).toEqual(['x']);
  });
});

describe('flattenVisible', () => {
  const tree = {
    '': [dir('docs'), file('README.md')],
    docs: [dir('nested'), file('guide.md')],
    'docs/nested': [file('deep.md')],
  };

  it('yields only the root when nothing is expanded', () => {
    expect(flattenVisible(tree as any, []).map((r) => r.relPath)).toEqual(['docs', 'README.md']);
  });

  it('yields rows in visual order with depth', () => {
    expect(flattenVisible(tree as any, ['docs']).map((r) => [r.relPath, r.depth])).toEqual([
      ['docs', 0], ['docs/nested', 1], ['docs/guide.md', 1], ['README.md', 0],
    ]);
  });

  it('descends into a second expanded level', () => {
    expect(flattenVisible(tree as any, ['docs', 'docs/nested']).map((r) => r.relPath)).toEqual([
      'docs', 'docs/nested', 'docs/nested/deep.md', 'docs/guide.md', 'README.md',
    ]);
  });

  it('yields no children for an expanded directory whose fetch is still in flight', () => {
    const partial = { '': [dir('docs')] };
    expect(flattenVisible(partial as any, ['docs']).map((r) => r.relPath)).toEqual(['docs']);
  });
});

describe('responseKey', () => {
  it('changes when any of surfaceId, root or relPath changes', () => {
    const base = responseKey('surf-1', 'C:\\repo', 'docs');
    expect(responseKey('surf-2', 'C:\\repo', 'docs')).not.toBe(base);
    expect(responseKey('surf-1', 'C:\\other', 'docs')).not.toBe(base);
    expect(responseKey('surf-1', 'C:\\repo', 'src')).not.toBe(base);
    expect(responseKey('surf-1', 'C:\\repo', 'docs')).toBe(base);
  });
});

// ─── Absolute path construction (the Git Bash / junction seam) ───────────────
// The renderer sends main a surfaceId and a rel-path, and main answers with the
// entries PLUS the absolute root it resolved. Building paths from the REPORTED
// cwd instead fails silently: enumeration still works (main normalizes on the
// way in), and only the clicks — open, reveal, open-in-default-app, copy path —
// die. String.raw throughout, so what is written is what is compared.

describe('pathRoot', () => {
  // The whole bug in one assertion. The bash integration reports `$(pwd)`.
  it('prefers the RESOLVED root over a Git Bash reported cwd', () => {
    const reported = '/c/Users/x/repo';
    const resolved = String.raw`C:\Users\x\repo`;
    expect(pathRoot(resolved, reported)).toBe(resolved);
    expect(toAbsolutePath(pathRoot(resolved, reported), 'docs/README.md'))
      .toBe(String.raw`C:\Users\x\repo\docs\README.md`);
  });

  it('does not produce the mixed-separator path the reported cwd would', () => {
    const fromReported = toAbsolutePath('/c/Users/x/repo', 'README.md');
    const fromResolved = toAbsolutePath(
      pathRoot(String.raw`C:\Users\x\repo`, '/c/Users/x/repo'), 'README.md',
    );
    // What shipped: a string no Windows API accepts.
    expect(fromReported).toBe(String.raw`/c/Users/x/repo\README.md`);
    expect(fromResolved).not.toBe(fromReported);
    expect(fromResolved.startsWith('C:')).toBe(true);
  });

  // The subtler PowerShell half: a junction, an 8.3 short name, or different
  // casing. Main returns the realpath; keeping the alias means the path saved
  // and revealed is not the path listed.
  it('prefers the realpath over an aliased Windows cwd', () => {
    expect(pathRoot(String.raw`C:\Users\x\repo`, String.raw`C:\junction\repo`))
      .toBe(String.raw`C:\Users\x\repo`);
    expect(pathRoot(String.raw`C:\Users\Derek Neely\repo`, String.raw`C:\Users\DEREKN~1\repo`))
      .toBe(String.raw`C:\Users\Derek Neely\repo`);
  });

  // Only until the first root reply lands — in that window it is the reported
  // cwd or nothing at all.
  it('falls back to the reported cwd before any root reply has arrived', () => {
    const reported = String.raw`C:\Users\x\repo`;
    expect(pathRoot(null, reported)).toBe(reported);
    expect(pathRoot(undefined, reported)).toBe(reported);
    // An empty resolved root is not a root either.
    expect(pathRoot('', reported)).toBe(reported);
  });
});

describe('toAbsolutePath', () => {
  it('converts POSIX rel-paths to backslashes and strips a trailing root separator', () => {
    expect(toAbsolutePath(String.raw`C:\repo`, 'a/b/c.md')).toBe(String.raw`C:\repo\a\b\c.md`);
    // Not String.raw here: a raw template may not END in a backslash.
    expect(toAbsolutePath('C:\\repo\\', 'a.md')).toBe(String.raw`C:\repo\a.md`);
    expect(toAbsolutePath(String.raw`C:\repo//`, 'a.md')).toBe(String.raw`C:\repo\a.md`);
  });

  it('returns the root itself for an empty rel-path, with no dangling separator', () => {
    expect(toAbsolutePath(String.raw`C:\repo`, '')).toBe(String.raw`C:\repo`);
  });
});

// ─── Wiring pin ──────────────────────────────────────────────────────────────
// The helpers above are only worth anything if the panel actually uses them.
// The failure mode is invisible at runtime (the tree paints; only the clicks
// die) and this project has no DOM test harness, so pin it at the source —
// the same tactic the opencode-plugin export-count test uses.
describe('ExplorerPanel wiring', () => {
  const src = readFileSync(
    resolve(__dirname, '../../src/renderer/components/Explorer/ExplorerPanel.tsx'),
    'utf-8',
  );

  it('stores the resolved root from the root reply', () => {
    expect(src).toContain('setResolvedRoot(result.root)');
  });

  it('builds absolute paths from the resolved root, never the reported cwd', () => {
    expect(src).toContain('pathRoot(resolvedRoot, root)');
    expect(src).toContain('toAbsolutePath(absRoot, relPath)');
    // No hand-rolled concatenation onto the reported cwd left anywhere.
    expect(src).not.toMatch(/\$\{root\.replace/);
  });

  it('keys the expansion map off the resolved root', () => {
    expect(src).toContain('[absRoot]: next');
    expect(src).toContain('expandedByRoot[absRoot]');
  });
});

// ─── Wiring pin: the code viewer ─────────────────────────────────────────────
// Same tactic, same reason as the block above — a click that routes to the
// wrong surface type, or a MARKDOWN_EXT list that has drifted from main's
// ALLOWED_MD_EXT, fails silently at runtime.
describe('code viewer wiring', () => {
  it('open-preview routes non-markdown files to a code surface', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/renderer/components/Explorer/open-preview.ts'), 'utf-8',
    );
    expect(src).toContain('targetTypeFor');
    expect(src).toContain('window.wmux.code.readFile');
  });

  it('the renderer MARKDOWN_EXT list matches main ALLOWED_MD_EXT exactly', () => {
    // Two lists that must agree across a boundary the renderer may not import
    // across. Drift here silently sends .md files to the code viewer.
    const renderer = readFileSync(
      resolve(__dirname, '../../src/renderer/components/Explorer/open-preview.ts'), 'utf-8',
    );
    const main = readFileSync(resolve(__dirname, '../../src/main/markdown-file.ts'), 'utf-8');
    const exts = (s: string, marker: string): string[] => {
      const at = s.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      const body = s.slice(at, s.indexOf(']', at));
      return [...body.matchAll(/'(\.[a-z]+)'/g)].map((m) => m[1]).sort();
    };
    const rendererExts = exts(renderer, 'MARKDOWN_EXT = new Set');
    expect(rendererExts.length).toBeGreaterThan(0);
    expect(rendererExts).toEqual(exts(main, 'ALLOWED_MD_EXT = new Set'));
  });

  it('the panel passes surfaceId and relPath to openInPreviewTab', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/renderer/components/Explorer/ExplorerPanel.tsx'), 'utf-8',
    );
    expect(src).toContain('relPath: row.relPath');
  });
});
