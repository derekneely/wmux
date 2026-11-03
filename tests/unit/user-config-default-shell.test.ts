import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadUserConfig } from '../../src/main/user-config';

function writeTmp(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-cfg-shell-'));
  const p = path.join(dir, 'config.toml');
  fs.writeFileSync(p, contents, 'utf-8');
  return p;
}

describe('user-config [workspace] default-shell', () => {
  let tmpPath: string | null = null;

  afterEach(() => {
    if (tmpPath) {
      try { fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true }); } catch { /* noop */ }
      tmpPath = null;
    }
  });

  it('reads an absolute path verbatim', () => {
    tmpPath = writeTmp(`
      [workspace]
      default-shell = 'C:\\Users\\me\\AppData\\Local\\Programs\\nu\\bin\\nu.exe'
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toEqual([]);
    expect(out.workspace?.defaultShell).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\nu\\bin\\nu.exe');
  });

  it('accepts the camelCase spelling and a command line with arguments', () => {
    tmpPath = writeTmp(`
      [workspace]
      defaultShell = '"C:\\Tools\\my shell.exe" --login'
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toEqual([]);
    expect(out.workspace?.defaultShell).toBe('"C:\\Tools\\my shell.exe" --login');
  });

  it('keeps an empty string, which means System default', () => {
    tmpPath = writeTmp(`
      [workspace]
      default-shell = ""
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toEqual([]);
    expect(out.workspace?.defaultShell).toBe('');
  });

  it('trims surrounding whitespace', () => {
    tmpPath = writeTmp(`
      [workspace]
      default-shell = "  pwsh.exe  "
    `);
    expect(loadUserConfig(tmpPath).workspace?.defaultShell).toBe('pwsh.exe');
  });

  it('reports a non-string value and ignores it', () => {
    tmpPath = writeTmp(`
      [workspace]
      default-shell = 3
    `);
    const out = loadUserConfig(tmpPath);
    expect(out.errors).toContain('workspace.default-shell: expected a string');
    expect(out.workspace?.defaultShell).toBeUndefined();
  });
});
