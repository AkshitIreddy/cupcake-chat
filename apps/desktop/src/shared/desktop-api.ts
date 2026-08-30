export const DESKTOP_API_VERSION = 1 as const;
export type DesktopPlatform = 'win32';

export type DesktopCommand =
  | 'app.about'
  | 'app.preferences'
  | 'chat.new'
  | 'chat.stop'
  | 'file.attach'
  | 'navigation.back'
  | 'navigation.forward'
  | 'search.open'
  | 'view.command-palette'
  | 'view.frosting-thread'
  | 'view.model-picker';

export type RuntimeState = 'disabled' | 'starting' | 'ready' | 'degraded' | 'stopped' | 'crashed';

export interface AppInfo {
  apiVersion: typeof DESKTOP_API_VERSION;
  appVersion: string;
  platform: DesktopPlatform;
  packaged: boolean;
  runtime: RuntimeState;
}

export interface OpaqueFileHandle {
  id: string;
  kind: 'file' | 'directory' | 'save-target';
  name: string;
  extension?: string;
  size?: number;
  writable: boolean;
}

export interface DialogOpenOptions {
  title?: string;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface RuntimeRequest {
  method: string;
  params?: unknown;
  timeoutMs?: number;
}

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; retryable: boolean };
}

export interface RuntimeEvent {
  sequence: number;
  type: string;
  payload: unknown;
  timestamp: string;
}

export interface RuntimeStatus {
  state: RuntimeState;
  mode: 'broker' | 'mock' | 'disabled';
  pid?: number;
  restartCount: number;
  detail?: string;
}

export interface ProviderSetupInput {
  provider: string;
  secret: string;
  baseUrl?: string;
  organization?: string;
  modelId?: string;
  displayName?: string;
}

export interface ProviderSetupResult {
  provider: string;
  state?: 'ready' | 'degraded' | 'failed' | 'cancelled';
  discovery?: 'supported' | 'unsupported' | 'failed';
  models?: Array<{
    id: string;
    model: string;
    display_name: string;
    capabilities: string[];
    compatibility_verified: boolean;
  }>;
  tested_at_ms?: number;
  latency_ms?: number;
  diagnostic?: { code: string; message: string; retryable: boolean } | null;
  tested?: boolean;
  configured?: boolean;
  endpointId?: string;
  persistent: boolean;
  runtimeDisconnected?: boolean;
  removed?: boolean;
}

export interface Unsubscribe {
  (): void;
}

export interface CupcakeDesktopApi {
  readonly apiVersion: typeof DESKTOP_API_VERSION;
  readonly platform: DesktopPlatform;
  app: {
    getInfo(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
  };
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
  };
  dialog: {
    openFiles(options?: DialogOpenOptions): Promise<OpaqueFileHandle[]>;
    openDirectory(options?: Pick<DialogOpenOptions, 'title'>): Promise<OpaqueFileHandle | null>;
    chooseSaveTarget(suggestedName?: string): Promise<OpaqueFileHandle | null>;
    releaseHandle(handleId: string): Promise<void>;
  };
  commands: {
    execute(command: DesktopCommand): Promise<void>;
    onCommand(listener: (command: DesktopCommand) => void): Unsubscribe;
  };
  runtime: {
    status(): Promise<RuntimeStatus>;
    request<T = unknown>(request: RuntimeRequest): Promise<RuntimeResponse<T>>;
    cancel(requestId: string): Promise<boolean>;
    onEvent(listener: (event: RuntimeEvent) => void): Unsubscribe;
    onStatus(listener: (status: RuntimeStatus) => void): Unsubscribe;
  };
  provider: {
    test(input: ProviderSetupInput): Promise<RuntimeResponse<ProviderSetupResult>>;
    connect(input: ProviderSetupInput): Promise<RuntimeResponse<ProviderSetupResult>>;
    disconnect(provider: string): Promise<RuntimeResponse<ProviderSetupResult>>;
  };
}

declare global {
  interface Window {
    cupcake?: CupcakeDesktopApi;
  }
}
