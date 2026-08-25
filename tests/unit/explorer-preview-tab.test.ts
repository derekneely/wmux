import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from '../../src/renderer/store';
import { openInPreviewTab } from '../../src/renderer/components/Explorer/open-preview';

const readFile = vi.fn();
(globalThis as any).window = (globalThis as any).window ?? {};
(window as any).wmux = { markdown: { readFile } };

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
