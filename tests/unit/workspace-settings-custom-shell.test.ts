// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceSettings from '../../src/renderer/components/Settings/WorkspaceSettings';
import { useStore } from '../../src/renderer/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NU = 'C:\\Users\\me\\AppData\\Local\\Programs\\nu\\bin\\nu.exe';

let root: Root;
let host: HTMLDivElement;
let pickShell: ReturnType<typeof vi.fn>;
let originalShell: string;

async function render(): Promise<void> {
  await act(async () => root.render(createElement(WorkspaceSettings)));
}

function setShell(value: string): void {
  useStore.getState().setWorkspacePrefs({ defaultShell: value });
}

function shellSelect(): HTMLSelectElement {
  const opt = [...host.querySelectorAll('option')].find((o) => o.value === 'cmd.exe');
  return opt!.parentElement as HTMLSelectElement;
}

function customInput(): HTMLInputElement | null {
  return host.querySelector('input[data-testid="custom-shell-input"]');
}

function browseButton(): HTMLButtonElement {
  return host.querySelector('button[data-testid="custom-shell-browse"]') as HTMLButtonElement;
}

// React tracks the last value it rendered, so a plain `el.value = x` is
// invisible to it; going through the prototype setter is what a user's input
// looks like to React.
async function change(el: HTMLSelectElement | HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

beforeEach(() => {
  useStore.setState({ language: 'en' });
  originalShell = useStore.getState().workspacePrefs.defaultShell;
  pickShell = vi.fn(() => Promise.resolve({ path: NU }));
  (window as any).wmux = {
    system: { pickShell },
    awake: {
      getState: vi.fn(() => new Promise(() => {})),
      setMode: vi.fn(),
      setPreventDisplaySleep: vi.fn(),
      onStateChange: vi.fn(() => () => {}),
    },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as any).wmux;
  setShell(originalShell);
});

describe('WorkspaceSettings custom default shell', () => {
  it('offers a Custom option and hides the path field for a preset', async () => {
    setShell('pwsh.exe');
    await render();
    expect([...shellSelect().options].map((o) => o.value)).toContain('custom');
    expect(shellSelect().value).toBe('pwsh.exe');
    expect(customInput()).toBeNull();
  });

  it('shows a stored non-preset value as Custom with the value in the field', async () => {
    setShell(NU);
    await render();
    expect(shellSelect().value).toBe('custom');
    expect(customInput()?.value).toBe(NU);
  });

  it('treats a preset typed in another case as that preset', async () => {
    setShell('PWSH.EXE');
    await render();
    expect(shellSelect().value).toBe('pwsh.exe');
  });

  it('picking Custom opens an empty field without changing the stored shell', async () => {
    setShell('cmd.exe');
    await render();
    await change(shellSelect(), 'custom');
    expect(shellSelect().value).toBe('custom');
    expect(customInput()?.value).toBe('');
    expect(useStore.getState().workspacePrefs.defaultShell).toBe('cmd.exe');
  });

  it('typing in the field stores the custom shell', async () => {
    setShell('');
    await render();
    await change(shellSelect(), 'custom');
    await change(customInput()!, NU);
    expect(useStore.getState().workspacePrefs.defaultShell).toBe(NU);
    expect(shellSelect().value).toBe('custom');
  });

  it('Browse stores the picked executable', async () => {
    setShell('');
    await render();
    await change(shellSelect(), 'custom');
    await act(async () => { browseButton().click(); });
    expect(pickShell).toHaveBeenCalled();
    expect(useStore.getState().workspacePrefs.defaultShell).toBe(NU);
    expect(customInput()?.value).toBe(NU);
  });

  it('a cancelled Browse leaves the shell alone', async () => {
    pickShell.mockResolvedValueOnce({ canceled: true });
    setShell(NU);
    await render();
    await act(async () => { browseButton().click(); });
    expect(useStore.getState().workspacePrefs.defaultShell).toBe(NU);
  });

  it('choosing a preset from Custom stores it and hides the field', async () => {
    setShell(NU);
    await render();
    await change(shellSelect(), 'wsl.exe');
    expect(useStore.getState().workspacePrefs.defaultShell).toBe('wsl.exe');
    expect(customInput()).toBeNull();
  });
});
