import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveInRoot } from '../../src/main/explorer-fs';

let base: string;
let root: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-code-jail-'));
  root = path.join(base, 'root');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'nope');
  // A sibling whose name merely BEGINS with the root's name. The
  // `canonical(root) + path.sep` check is what stops it passing as a child.
  fs.mkdirSync(path.join(base, 'rootsibling'), { recursive: true });
});

afterAll(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
});

const code = (r: any): string | undefined => r.code;

describe('resolveInRoot', () => {
  it('resolves a real file inside the root under leaf=file', async () => {
    const r: any = await resolveInRoot(root, 'src/index.ts', 'file');
    expect(r.abs).toBe(path.join(root, 'src', 'index.ts'));
  });

  it('resolves a directory inside the root under leaf=dir', async () => {
    const r: any = await resolveInRoot(root, 'src', 'dir');
    expect(r.abs).toBe(path.join(root, 'src'));
  });

  it('resolves the root itself under leaf=dir', async () => {
    const r: any = await resolveInRoot(root, '', 'dir');
    expect(r.abs).toBe(path.resolve(root));
  });

  it('rejects the empty relPath under leaf=file — the root is not a file', async () => {
    expect(code(await resolveInRoot(root, '', 'file'))).toBe('invalid_path');
  });

  it('rejects a traversal out of the root', async () => {
    const r = await resolveInRoot(root, '../outside/secret.txt', 'file');
    expect(code(r)).toBe('outside_root');
  });

  it('rejects an absolute path supplied as relPath', async () => {
    const r = await resolveInRoot(root, 'C:\\Windows\\System32\\drivers\\etc\\hosts', 'file');
    expect(code(r)).toBe('invalid_path');
  });

  it('rejects a sibling sharing a name prefix with the root', async () => {
    const r = await resolveInRoot(root, '../rootsibling', 'dir');
    expect(code(r)).toBe('outside_root');
  });

  it('rejects a directory when a file was asked for', async () => {
    expect(code(await resolveInRoot(root, 'src', 'file'))).toBe('invalid_path');
  });

  it('rejects a file when a directory was asked for', async () => {
    expect(code(await resolveInRoot(root, 'src/index.ts', 'dir'))).toBe('not_a_directory');
  });

  it('reports a missing path as not_found', async () => {
    expect(code(await resolveInRoot(root, 'src/nope.ts', 'file'))).toBe('not_found');
  });
});
