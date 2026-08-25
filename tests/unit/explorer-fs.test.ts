import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listDir, validateRelPath, MAX_ENTRIES } from '../../src/main/explorer-fs';

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-explorer-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'index.ts'), 'export {}');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, 'docs', 'guide.markdown'), 'g');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'nope');
});

afterAll(() => {
  try { fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* best effort */ }
});

function err(result: any): string | undefined { return result.code; }

describe('validateRelPath', () => {
  it('accepts an empty path and ordinary relative paths', () => {
    expect(validateRelPath('')).toBeNull();
    expect(validateRelPath('docs')).toBeNull();
    expect(validateRelPath('docs/nested')).toBeNull();
    expect(validateRelPath('docs\\nested')).toBeNull();
  });

  it('rejects absolute, drive-relative, UNC and namespace-prefixed paths', () => {
    expect(validateRelPath('C:\\Windows')).toBe('invalid_path');
    expect(validateRelPath('/etc/passwd')).toBe('invalid_path');
    expect(validateRelPath('C:foo')).toBe('invalid_path');
    expect(validateRelPath('\\\\server\\share')).toBe('invalid_path');
    expect(validateRelPath('\\\\?\\C:\\Windows')).toBe('invalid_path');
    expect(validateRelPath('\\\\.\\PhysicalDrive0')).toBe('invalid_path');
  });

  it('rejects alternate data streams', () => {
    expect(validateRelPath('notes.md:hidden')).toBe('invalid_path');
    expect(validateRelPath('docs/notes.md:$DATA')).toBe('invalid_path');
  });

  it('rejects reserved DOS device names stem-wise', () => {
    for (const name of ['NUL', 'CON', 'PRN', 'AUX', 'COM1', 'LPT9', 'con', 'CON.md']) {
      expect(validateRelPath(name)).toBe('invalid_path');
    }
    expect(validateRelPath('CONSOLE.md')).toBeNull();
    expect(validateRelPath('docs/CON/x')).toBe('invalid_path');
  });

  it('rejects segments with a trailing dot or space', () => {
    expect(validateRelPath('docs ')).toBe('invalid_path');
    expect(validateRelPath('docs.')).toBe('invalid_path');
    expect(validateRelPath('docs./nested')).toBe('invalid_path');
  });
});

describe('listDir jail', () => {
  it('lists the root', async () => {
    const r: any = await listDir(root, '');
    expect(r.code).toBeUndefined();
    expect(r.relPath).toBe('');
    expect(r.entries.map((e: any) => e.name).sort()).toEqual(['README.md', 'docs', 'index.ts']);
  });

  it('rejects a .. escape, including a deep chain', async () => {
    expect(err(await listDir(root, '..'))).toBe('outside_root');
    expect(err(await listDir(root, 'docs/../../..'))).toBe('outside_root');
    expect(err(await listDir(root, 'docs/nested/../../../outside'))).toBe('outside_root');
  });

  it('rejects an absolute relPath before resolving it', async () => {
    expect(err(await listDir(root, outside))).toBe('invalid_path');
  });

  it('rejects a cross-drive target via the isAbsolute(rel) clause', async () => {
    // path.relative() returns an ABSOLUTE path across drives rather than a
    // '..' chain, which is the case the startsWith('..') check alone misses.
    const otherDrive = root.startsWith('C:') ? 'D:\\data' : 'C:\\data';
    expect(err(await listDir(root, otherDrive))).toBe('invalid_path');
  });

  it('rejects a symlink as the FINAL segment', async () => {
    const link = path.join(root, 'leaf-link');
    fs.symlinkSync(outside, link, 'junction');
    expect(err(await listDir(root, 'leaf-link'))).toBe('outside_root');
  });

  it('rejects a junction as an INTERMEDIATE segment', async () => {
    // root\mid-link\ is a junction to `outside`; asking for mid-link/sub must
    // fail even though the FINAL lstat would resolve inside `outside`.
    fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'mid-link'), 'junction');
    expect(err(await listDir(root, 'mid-link/sub'))).toBe('outside_root');
  });

  it('reports a junction entry as kind=symlink and never viewable', async () => {
    const r: any = await listDir(root, '');
    const link = r.entries.find((e: any) => e.name === 'leaf-link');
    expect(link.kind).toBe('symlink');
    expect(link.viewable).toBe(false);
  });

  it('treats Windows case variance as the same jail', async () => {
    if (process.platform !== 'win32') return;
    const shouted = root.toUpperCase();
    const r: any = await listDir(shouted, 'docs');
    expect(r.code).toBeUndefined();
    expect(r.relPath).toBe('docs');
  });
});

describe('listDir filtering, limits and errors', () => {
  it('hides dotfiles, .git, node_modules, dist and build by default', async () => {
    const r: any = await listDir(root, '');
    const names = r.entries.map((e: any) => e.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('.env');
    expect(names).not.toContain('node_modules');
  });

  it('shows them with showHidden', async () => {
    const r: any = await listDir(root, '', { showHidden: true });
    const names = r.entries.map((e: any) => e.name);
    expect(names).toContain('.git');
    expect(names).toContain('.env');
    expect(names).toContain('node_modules');
  });

  it('marks viewable from ALLOWED_MD_EXT', async () => {
    const r: any = await listDir(root, '');
    const byName = Object.fromEntries(r.entries.map((e: any) => [e.name, e]));
    expect(byName['README.md'].viewable).toBe(true);
    expect(byName['index.ts'].viewable).toBe(false);
    expect(byName['docs'].viewable).toBe(false);
    const docs: any = await listDir(root, 'docs');
    expect(docs.entries.find((e: any) => e.name === 'guide.markdown').viewable).toBe(true);
  });

  it('truncates at MAX_ENTRIES', async () => {
    const big = path.join(root, 'big');
    fs.mkdirSync(big, { recursive: true });
    for (let i = 0; i < MAX_ENTRIES + 5; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), '');
    const r: any = await listDir(root, 'big');
    expect(r.truncated).toBe(true);
    expect(r.entries.length).toBe(MAX_ENTRIES);
  });

  it('returns not_found and not_a_directory distinctly', async () => {
    expect(err(await listDir(root, 'nope'))).toBe('not_found');
    expect(err(await listDir(root, 'README.md'))).toBe('not_a_directory');
  });

  it('maps EACCES to denied rather than read_failed', async () => {
    fs.mkdirSync(path.join(root, 'denied-probe'), { recursive: true });
    const realReaddir = fs.promises.readdir;
    (fs.promises as any).readdir = async () => {
      const e: any = new Error('permission denied'); e.code = 'EACCES'; throw e;
    };
    try {
      expect(err(await listDir(root, 'denied-probe'))).toBe('denied');
    } finally {
      (fs.promises as any).readdir = realReaddir;
    }
  });
});
