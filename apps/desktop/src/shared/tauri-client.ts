import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  DESKTOP_API_VERSION,
  type AppInfo,
  type CupcakeDesktopApi,
  type DesktopCommand,
  type DialogOpenOptions,
  type OpaqueFileHandle,
  type ProviderSetupInput,
  type ProviderSetupResult,
  type RuntimeEvent,
  type RuntimeRequest,
  type RuntimeResponse,
  type RuntimeStatus,
  type Unsubscribe,
} from './desktop-api';

function subscribe<T>(event: string, listener: (payload: T) => void): Unsubscribe {
  let active = true;
  let unlisten: UnlistenFn | undefined;
  void listen<T>(event, ({ payload }) => {
    if (active) listener(payload);
  }).then((release) => {
    if (active) unlisten = release;
    else release();
  });
  return () => {
    active = false;
    unlisten?.();
  };
}

function providerCall(
  command: 'provider_test' | 'provider_connect',
  input: ProviderSetupInput,
): Promise<RuntimeResponse<ProviderSetupResult>> {
  return invoke(command, { input });
}

export function installTauriDesktopApi(): boolean {
  if (!isTauri()) return false;
  const api: CupcakeDesktopApi = {
    apiVersion: DESKTOP_API_VERSION,
    platform: 'win32',
    app: {
      getInfo: () => invoke<AppInfo>('app_info'),
      openExternal: (url) => invoke<void>('open_external_url', { url }),
    },
    window: {
      minimize: () => invoke<void>('window_minimize'),
      toggleMaximize: () => invoke<boolean>('window_toggle_maximize'),
      close: () => invoke<void>('window_close'),
      isMaximized: () => invoke<boolean>('window_is_maximized'),
    },
    dialog: {
      openFiles: (options?: DialogOpenOptions) =>
        invoke<OpaqueFileHandle[]>('dialog_open_files', { options }),
      openDirectory: (options?: Pick<DialogOpenOptions, 'title'>) =>
        invoke<OpaqueFileHandle | null>('dialog_open_directory', { options }),
      chooseSaveTarget: (suggestedName?: string) =>
        invoke<OpaqueFileHandle | null>('dialog_choose_save_target', { suggestedName }),
      releaseHandle: (handleId: string) => invoke<void>('dialog_release_handle', { handleId }),
    },
    commands: {
      execute: (command: DesktopCommand) => invoke<void>('command_execute', { command }),
      onCommand: (listener) => subscribe<DesktopCommand>('cupcake://command', listener),
    },
    runtime: {
      status: () => invoke<RuntimeStatus>('runtime_status'),
      request: <T>(request: RuntimeRequest) =>
        invoke<RuntimeResponse<T>>('runtime_request', { request }),
      cancel: (requestId: string) => invoke<boolean>('runtime_cancel', { requestId }),
      onEvent: (listener) => subscribe<RuntimeEvent>('cupcake://runtime-event', listener),
      onStatus: (listener) => subscribe<RuntimeStatus>('cupcake://runtime-status', listener),
    },
    provider: {
      test: (input) => providerCall('provider_test', input),
      connect: (input) => providerCall('provider_connect', input),
      disconnect: (provider) =>
        invoke<RuntimeResponse<ProviderSetupResult>>('provider_disconnect', { provider }),
    },
  };
  Object.defineProperty(window, 'cupcake', { configurable: false, value: api });
  return true;
}
