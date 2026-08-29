import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppInfo,
  CupcakeDesktopApi,
  DesktopCommand,
  DialogOpenOptions,
  OpaqueFileHandle,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeStatus,
} from '../shared/desktop-api';
import { DESKTOP_API_VERSION } from '../shared/desktop-api';

const channels = {
  appInfo: 'cupcake:app:info',
  windowMinimize: 'cupcake:window:minimize',
  windowToggleMaximize: 'cupcake:window:toggle-maximize',
  windowClose: 'cupcake:window:close',
  windowIsMaximized: 'cupcake:window:is-maximized',
  dialogOpenFiles: 'cupcake:dialog:open-files',
  dialogOpenDirectory: 'cupcake:dialog:open-directory',
  dialogSaveTarget: 'cupcake:dialog:save-target',
  dialogReleaseHandle: 'cupcake:dialog:release-handle',
  commandExecute: 'cupcake:commands:execute',
  commandEvent: 'cupcake:commands:event',
  runtimeStatus: 'cupcake:runtime:status',
  runtimeRequest: 'cupcake:runtime:request',
  runtimeCancel: 'cupcake:runtime:cancel',
  runtimeEvent: 'cupcake:runtime:event',
  runtimeStatusEvent: 'cupcake:runtime:status-event',
} as const;

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: CupcakeDesktopApi = Object.freeze({
  apiVersion: DESKTOP_API_VERSION,
  platform: process.platform,
  app: Object.freeze({
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke(channels.appInfo),
  }),
  window: Object.freeze({
    minimize: (): Promise<void> => ipcRenderer.invoke(channels.windowMinimize),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke(channels.windowToggleMaximize),
    close: (): Promise<void> => ipcRenderer.invoke(channels.windowClose),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke(channels.windowIsMaximized),
  }),
  dialog: Object.freeze({
    openFiles: (options?: DialogOpenOptions): Promise<OpaqueFileHandle[]> =>
      ipcRenderer.invoke(channels.dialogOpenFiles, options),
    openDirectory: (options?: Pick<DialogOpenOptions, 'title'>): Promise<OpaqueFileHandle | null> =>
      ipcRenderer.invoke(channels.dialogOpenDirectory, options),
    chooseSaveTarget: (suggestedName?: string): Promise<OpaqueFileHandle | null> =>
      ipcRenderer.invoke(channels.dialogSaveTarget, suggestedName),
    releaseHandle: (handleId: string): Promise<void> =>
      ipcRenderer.invoke(channels.dialogReleaseHandle, handleId),
  }),
  commands: Object.freeze({
    execute: (command: DesktopCommand): Promise<void> =>
      ipcRenderer.invoke(channels.commandExecute, command),
    onCommand: (listener: (command: DesktopCommand) => void): (() => void) =>
      subscribe(channels.commandEvent, listener),
  }),
  runtime: Object.freeze({
    status: (): Promise<RuntimeStatus> => ipcRenderer.invoke(channels.runtimeStatus),
    request: <T = unknown>(request: RuntimeRequest): Promise<RuntimeResponse<T>> =>
      ipcRenderer.invoke(channels.runtimeRequest, request),
    cancel: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke(channels.runtimeCancel, requestId),
    onEvent: (listener: (event: RuntimeEvent) => void): (() => void) =>
      subscribe(channels.runtimeEvent, listener),
    onStatus: (listener: (status: RuntimeStatus) => void): (() => void) =>
      subscribe(channels.runtimeStatusEvent, listener),
  }),
});

contextBridge.exposeInMainWorld('cupcake', api);
