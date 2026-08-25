import { describe, it, expect } from 'vitest';
import {
  joinRel, sortEntries, toggleExpanded, pruneExpanded, flattenVisible, responseKey,
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
