import { describe, it, expect } from 'vitest';
import { dropCodeContent } from '../../src/renderer/store/split-utils';

const leaf = (surfaces: any[]): any => ({
  type: 'leaf', paneId: 'pane-1', surfaces, activeSurfaceIndex: 0,
});

describe('dropCodeContent', () => {
  it('strips codeContent but keeps the path fields that let it be re-read', () => {
    const tree = leaf([{
      id: 's1', type: 'code',
      codeContent: 'export {}',
      codeFilePath: 'C:\\repo\\index.ts',
      codeRelPath: 'index.ts',
      codeFileName: 'index.ts',
      codeFileMtime: 7,
    }]);
    const out: any = dropCodeContent(tree);
    expect(out.surfaces[0].codeContent).toBeUndefined();
    expect(out.surfaces[0].codeFilePath).toBe('C:\\repo\\index.ts');
    expect(out.surfaces[0].codeRelPath).toBe('index.ts');
    expect(out.surfaces[0].codeFileName).toBe('index.ts');
    expect(out.surfaces[0].codeFileMtime).toBe(7);
  });

  it('never touches a markdown buffer — that one IS persisted on purpose', () => {
    const tree = leaf([{ id: 's1', type: 'markdown', markdownContent: '# hi' }]);
    const out: any = dropCodeContent(tree);
    expect(out.surfaces[0].markdownContent).toBe('# hi');
  });

  it('recurses into both children of a split', () => {
    const tree: any = {
      type: 'split', direction: 'horizontal', ratio: 0.5,
      children: [
        leaf([{ id: 'a', type: 'code', codeContent: 'x' }]),
        leaf([{ id: 'b', type: 'code', codeContent: 'y' }]),
      ],
    };
    const out: any = dropCodeContent(tree);
    expect(out.children[0].surfaces[0].codeContent).toBeUndefined();
    expect(out.children[1].surfaces[0].codeContent).toBeUndefined();
  });
});
