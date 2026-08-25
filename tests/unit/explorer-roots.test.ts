import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  reportExplorerCwd, getExplorerRoot, forgetExplorerRoot, resetExplorerRoots,
} from '../../src/main/explorer-roots';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-roots-'));
const real = path.join(base, 'project');
fs.mkdirSync(real, { recursive: true });

beforeEach(() => resetExplorerRoots());
afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('explorer roots', () => {
  it('returns null for a surface that has reported nothing', () => {
    expect(getExplorerRoot('surf-1')).toBeNull();
  });

  it('records a reported cwd and resolves it through realpath', () => {
    reportExplorerCwd('surf-1', real);
    const root = getExplorerRoot('surf-1')!;
    expect(root.cwd).toBe(real);
    expect(root.realRoot).toBe(fs.realpathSync.native(real));
  });

  it('ignores an empty or whitespace cwd rather than storing a bogus root', () => {
    reportExplorerCwd('surf-1', '   ');
    expect(getExplorerRoot('surf-1')).toBeNull();
  });

  it('falls back to path.resolve when the directory does not exist locally', () => {
    const missing = path.join(base, 'deleted');
    reportExplorerCwd('surf-2', missing);
    expect(getExplorerRoot('surf-2')!.realRoot).toBe(path.resolve(missing));
  });

  it('does not re-realpath when the reported cwd is unchanged', () => {
    reportExplorerCwd('surf-3', real);
    const first = getExplorerRoot('surf-3');
    const originalRealpath = fs.realpathSync.native;
    let calls = 0;
    (fs.realpathSync as any).native = (p: string) => { calls++; return originalRealpath(p); };
    try {
      reportExplorerCwd('surf-3', real);
      expect(calls).toBe(0);
      expect(getExplorerRoot('surf-3')).toEqual(first);
    } finally {
      (fs.realpathSync as any).native = originalRealpath;
    }
  });

  it('forgets a surface', () => {
    reportExplorerCwd('surf-4', real);
    forgetExplorerRoot('surf-4');
    expect(getExplorerRoot('surf-4')).toBeNull();
  });
});
