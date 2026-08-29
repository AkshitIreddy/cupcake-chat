import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalFileGrant } from './file-handles';
import type { FileHandleRegistry } from './file-handles';
import type { SidecarSupervisor } from './sidecar-supervisor';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      electron.handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '2.0.0-test', isPackaged: true },
  BrowserWindow: {
    fromWebContents: vi.fn(() => undefined),
    getAllWindows: vi.fn(() => []),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: electron.ipcMain,
}));

vi.mock('./security', () => ({ assertTrustedIpcSender: vi.fn() }));

import {
  IPC_CHANNELS,
  registerIpcHandlers,
  validateAttachmentGrants,
  validateRuntimeRequest,
} from './ipc';

const handleId = '0198f1e2-d3c4-7a69-8def-0123456789ab';
const grant: InternalFileGrant = {
  id: handleId,
  kind: 'file',
  name: 'notes.txt',
  writable: false,
  absolutePath: 'C:\\selected\\notes.txt',
  createdAt: 1,
};

function fakeHandles(): FileHandleRegistry {
  return {
    resolveActiveAttachments: vi.fn((ids: readonly string[]) => {
      if (ids.length !== 1 || ids[0] !== handleId) throw new TypeError('unavailable');
      return [grant];
    }),
  } as unknown as FileHandleRegistry;
}

describe('renderer attachment IPC validation', () => {
  it('accepts matching bounded opaque handle lists and resolves active grants', () => {
    const request = validateRuntimeRequest({
      method: 'chat.send',
      params: {
        attachments: [{ handleId }],
        attachmentHandles: [handleId],
      },
    });

    expect(validateAttachmentGrants(request, fakeHandles())).toEqual([grant]);
  });

  it.each([
    [{ attachments: [{ handleId, absolutePath: 'C:\\secret.txt' }] }, 'only an opaque handleId'],
    [
      { attachments: [{ handleId }], attachmentHandles: ['0198f1e2-d3c4-7a69-8def-deadbeef0000'] },
      'do not match',
    ],
    [{ attachments: [{ handleId }, { handleId }] }, 'must be unique'],
  ])('rejects malformed or replay-prone attachment payloads', (params, message) => {
    const request = validateRuntimeRequest({ method: 'chat.send', params });
    expect(() => validateAttachmentGrants(request, fakeHandles())).toThrow(message);
  });

  it('rejects more than 32 attachment capabilities before registry resolution', () => {
    const request = validateRuntimeRequest({
      method: 'chat.send',
      params: {
        attachments: Array.from({ length: 33 }, (_, index) => ({
          handleId: `attachment-${index}`,
        })),
      },
    });
    expect(() => validateAttachmentGrants(request, fakeHandles())).toThrow('at most 32');
  });
});

describe('durable attachment send lifecycle', () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.ipcMain.handle.mockClear();
  });

  it('re-registers the exact grant and releases only after renderer confirmation', async () => {
    let finishSend!: (value: { ok: boolean; result?: unknown }) => void;
    const response = new Promise<{ ok: boolean; result?: unknown }>((resolve) => {
      finishSend = resolve;
    });
    const handles = fakeHandles();
    const releaseHandle = vi.fn(() => true);
    Object.assign(handles, {
      release: releaseHandle,
    });
    const registerFileGrant = vi.fn();
    const releaseFileGrant = vi.fn();
    const runtime = Object.assign(new EventEmitter(), {
      status: vi.fn(() => ({ state: 'ready', mode: 'broker', restartCount: 0 })),
      request: vi.fn(() => response),
      cancel: vi.fn(),
      registerFileGrant,
      releaseFileGrant,
    }) as unknown as SidecarSupervisor;
    const unregister = registerIpcHandlers({
      handles,
      runtime,
      commands: { dispatch: vi.fn() } as never,
    });
    const event = { senderFrame: { url: 'cupcake://app/index.html' }, sender: {} };
    const invokeRequest = electron.handlers.get(IPC_CHANNELS.runtimeRequest)!;
    const invokeRelease = electron.handlers.get(IPC_CHANNELS.dialogReleaseHandle)!;
    const pending = invokeRequest(event, {
      method: 'chat.send',
      params: { attachments: [{ handleId }], attachmentHandles: [handleId] },
    }) as Promise<unknown>;

    expect(registerFileGrant).toHaveBeenCalledWith(grant);
    expect(() => invokeRelease(event, handleId)).toThrow('durable send is pending');
    expect(releaseHandle).not.toHaveBeenCalled();

    finishSend({ ok: true, result: { messageId: 'durable-message' } });
    await expect(pending).resolves.toMatchObject({ ok: true });
    invokeRelease(event, handleId);

    expect(releaseHandle).toHaveBeenCalledWith(handleId);
    expect(releaseFileGrant).toHaveBeenCalledWith(handleId);
    unregister();
  });
});
