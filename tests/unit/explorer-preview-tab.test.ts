import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { openInPreviewTab } from '../../src/renderer/components/Explorer/open-preview';

const readFile = vi.fn();
(globalThis as any).window = (globalThis as any).window ?? {};
const readCode = vi.fn();
(window as any).wmux = { markdown: { readFile }, code: { readFile: readCode } };

function setup(): { ws: any; pane: any } {
  const ws = useStore.getState().createWorkspace({ title: 'ws', shell: 'pwsh' });
  const workspace = useStore.getState().workspaces.find((w) => w.id === ws)!;
  const pane = (workspace.splitTree as any).paneId;
  useStore.getState().setFocusedPane?.(pane);
  return { ws, pane };
}

function surfacesOf(ws: any): any[] {
  const workspace = useStore.getState().workspaces.find((w) => w.id === ws)!;
  return (workspace.splitTree as any).surfaces ?? [];
}

beforeEach(() => {
  readFile.mockReset();
  readFile.mockImplementation(async (filePath: string) => ({
    filePath, content: `# ${filePath}`, mtimeMs: 1,
  }));
  readCode.mockReset();
  readCode.mockImplementation(async (_surfaceId: string, relPath: string) => ({
    filePath: `C:\\repo\\${relPath}`, content: 'export {}', mtimeMs: 1,
  }));
});

describe('openInPreviewTab', () => {
  it('creates one ephemeral markdown tab on the first click', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    expect(md[0].ephemeral).toBe(true);
    expect(md[0].markdownFilePath).toBe('C:\\repo\\a.md');
    expect(md[0].markdownFileName).toBe('a.md');
  });

  it('REUSES the preview tab for a second file instead of stacking tabs', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false });
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
    // fileName must be passed through, or the tab keeps the previous label.
    expect(md[0].markdownFileName).toBe('b.md');
  });

  it('focuses an already-open tab for the same path rather than reloading it', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: true });
    readFile.mockClear();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    expect(readFile).not.toHaveBeenCalled();
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(1);
  });

  it('PROMOTES a dirty preview instead of discarding the edit', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    const first = surfacesOf(ws).find((s) => s.type === 'markdown')!;
    useStore.getState().updateSurface(ws, pane, first.id, { markdownDirty: true, markdownContent: 'edited' });

    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false });
    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(2);
    const promoted = md.find((s) => s.id === first.id)!;
    expect(promoted.ephemeral).toBeUndefined();
    expect(promoted.markdownContent).toBe('edited');
    expect(md.find((s) => s.id !== first.id)!.ephemeral).toBe(true);
  });

  it('a keep:true open clears ephemeral so the next click opens a fresh preview', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: true });
    expect(surfacesOf(ws).find((s) => s.type === 'markdown')!.ephemeral).toBeUndefined();
    await openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(2);
  });

  it('does nothing when the read fails, leaving no empty tab behind', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValueOnce({ error: 'File not found', code: 'not_found' });
    await openInPreviewTab(ws, pane, 'C:\\repo\\gone.md', 'gone.md', { keep: false });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(0);
  });

  it('falls back to the first leaf pane when the target pane is gone', async () => {
    const { ws } = setup();
    await openInPreviewTab(ws, 'pane-does-not-exist' as any, 'C:\\repo\\a.md', 'a.md', { keep: false });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(1);
  });

  it('two rapid opens with no existing preview create exactly ONE ephemeral surface', async () => {
    const { ws, pane } = setup();
    // Neither await lands before the second call starts — this is the race:
    // with no preview open yet, both calls could pass the "find a reusable
    // preview" check before either has created one.
    const p1 = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    const p2 = openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false });
    await Promise.all([p1, p2]);

    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    // The later click wins the final label/content.
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
  });

  it('a slow first read does not overwrite a faster/newer second one', async () => {
    const { ws, pane } = setup();
    // Get a preview tab open first so both calls below hit the "reuse the
    // existing preview" path, where the described race is a stale WRITE
    // rather than a duplicate tab.
    await openInPreviewTab(ws, pane, 'C:\\repo\\first.md', 'first.md', { keep: false });

    let resolveA!: (value: { filePath: string; content: string; mtimeMs: number }) => void;
    readFile.mockReset();
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === 'C:\\repo\\a.md') {
        return new Promise((resolve) => { resolveA = resolve; });
      }
      return { filePath, content: `# ${filePath}`, mtimeMs: 1 };
    });

    const p1 = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false }); // slow
    const p2 = openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false }); // fast, clicked after
    // Let the slow first read land only now — after both opens are in flight.
    resolveA({ filePath: 'C:\\repo\\a.md', content: '# a', mtimeMs: 1 });
    await Promise.all([p1, p2]);

    const md = surfacesOf(ws).filter((s) => s.type === 'markdown');
    expect(md).toHaveLength(1);
    // The later-CLICKED file must win, regardless of which read landed first.
    expect(md[0].markdownFilePath).toBe('C:\\repo\\b.md');
  });
});

// ─── Failure reporting ───────────────────────────────────────────────────────
// A bare `if (!read || 'error' in read) return;` is what made the Git Bash
// absolute-path bug invisible: every click was a no-op with no message. It also
// hides the ordinary case of clicking a file that was deleted out from under
// the tree. The failure is now returned as an explorer error CODE — never the
// sibling `error` string, which stays English for main-process callers.
describe('openInPreviewTab failure reporting', () => {
  it('returns null on success', async () => {
    const { ws, pane } = setup();
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false }))
      .resolves.toBeNull();
  });

  it('maps a not_found read onto the explorer code of the same name', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValue({ error: 'File not found', code: 'not_found' });
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\gone.md', 'gone.md', { keep: false }))
      .resolves.toBe('not_found');
  });

  it('maps the markdown-only codes onto invalid_path', async () => {
    const { ws, pane } = setup();
    for (const code of ['no_path', 'unsupported_type', 'symlink', 'not_regular_file']) {
      readFile.mockResolvedValue({ error: 'nope', code });
      await expect(openInPreviewTab(ws, pane, 'C:\\repo\\x.md', 'x.md', { keep: false }))
        .resolves.toBe('invalid_path');
    }
  });

  it('falls back to read_failed for an unknown or absent code', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValue({ error: 'boom', code: 'something_new' });
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\x.md', 'x.md', { keep: false }))
      .resolves.toBe('read_failed');
    readFile.mockResolvedValue(undefined);
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\y.md', 'y.md', { keep: false }))
      .resolves.toBe('read_failed');
  });

  it('leaves no empty tab behind when the read fails', async () => {
    const { ws, pane } = setup();
    readFile.mockResolvedValue({ error: 'File not found', code: 'not_found' });
    await openInPreviewTab(ws, pane, 'C:\\repo\\gone.md', 'gone.md', { keep: false });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(0);
  });

  it('reports NOTHING for an open a newer click superseded', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\first.md', 'first.md', { keep: false });

    let resolveA!: (value: any) => void;
    readFile.mockReset();
    readFile.mockImplementation(async (filePath: string) => {
      if (filePath === 'C:\\repo\\a.md') return new Promise((r) => { resolveA = r; });
      return { filePath, content: '# b', mtimeMs: 1 };
    });
    const p1 = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    const p2 = openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false });
    resolveA({ filePath: 'C:\\repo\\a.md', content: '# a', mtimeMs: 1 });
    // Superseded is not a failure — flashing an error for a file the user has
    // already navigated away from would be noise.
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
  });

  it('does not wedge later opens behind a rejected one', async () => {
    const { ws, pane } = setup();
    readFile.mockRejectedValueOnce(new Error('ipc blew up'));
    const bad = openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    await expect(bad).rejects.toThrow('ipc blew up');
    // The next open must still run rather than inheriting the rejection.
    readFile.mockImplementation(async (filePath: string) => ({
      filePath, content: '# ok', mtimeMs: 1,
    }));
    await expect(openInPreviewTab(ws, pane, 'C:\\repo\\b.md', 'b.md', { keep: false }))
      .resolves.toBeNull();
    expect(surfacesOf(ws).some((s) => s.markdownFilePath === 'C:\\repo\\b.md')).toBe(true);
  });
});

describe('openInPreviewTab — code files', () => {
  const codeOpts = { keep: false, surfaceId: 'surf-1' as any, relPath: 'index.ts' };

  it('creates a code surface for a non-markdown file', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    const code = surfacesOf(ws).filter((s) => s.type === 'code');
    expect(code).toHaveLength(1);
    expect(code[0].ephemeral).toBe(true);
    expect(code[0].codeFilePath).toBe('C:\\repo\\index.ts');
    expect(code[0].codeFileName).toBe('index.ts');
    expect(code[0].codeRelPath).toBe('index.ts');
    expect(code[0].codeContent).toBe('export {}');
  });

  it('still creates a markdown surface for a .md file', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    expect(surfacesOf(ws).filter((s) => s.type === 'markdown')).toHaveLength(1);
    expect(surfacesOf(ws).filter((s) => s.type === 'code')).toHaveLength(0);
  });

  it('RECYCLES a markdown preview into a code preview — one tab, not two', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('code');
  });

  it('RECYCLES a code preview back into a markdown preview', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('markdown');
  });

  it('promotes a DIRTY markdown preview rather than recycling it for a code file', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    const md = surfacesOf(ws).find((s) => s.type === 'markdown')!;
    const wsObj = useStore.getState().workspaces.find((w) => w.id === ws)!;
    const paneId = (wsObj.splitTree as any).paneId;
    useStore.getState().updateSurface(ws, paneId, md.id, { markdownDirty: true });
    await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts);
    const kept = surfacesOf(ws).find((s) => s.type === 'markdown')!;
    expect(kept.ephemeral).toBeUndefined();      // promoted, buffer intact
    expect(surfacesOf(ws).filter((s) => s.type === 'code')).toHaveLength(1);
  });

  it('does NOT destroy the existing preview when the code read fails', async () => {
    const { ws, pane } = setup();
    await openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false });
    readCode.mockResolvedValueOnce({ error: 'Not a text file', code: 'binary' });
    const failure = await openInPreviewTab(ws, pane, 'C:\\repo\\logo.png', 'logo.png', {
      keep: false, surfaceId: 'surf-1' as any, relPath: 'logo.png',
    });
    expect(failure).toBe('binary');
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
    expect(previews[0].type).toBe('markdown');   // untouched
  });

  it('returns invalid_path when a code file is opened with no relPath', async () => {
    const { ws, pane } = setup();
    const failure = await openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', { keep: false });
    expect(failure).toBe('invalid_path');
  });

  it('still makes ONE tab from two clicks in the same tick, across a type change', async () => {
    const { ws, pane } = setup();
    await Promise.all([
      openInPreviewTab(ws, pane, 'C:\\repo\\a.md', 'a.md', { keep: false }),
      openInPreviewTab(ws, pane, 'C:\\repo\\index.ts', 'index.ts', codeOpts),
    ]);
    const previews = surfacesOf(ws).filter((s) => s.type === 'markdown' || s.type === 'code');
    expect(previews).toHaveLength(1);
  });
});
