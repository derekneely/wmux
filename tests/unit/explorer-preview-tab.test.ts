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
