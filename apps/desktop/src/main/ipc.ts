import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type {
  DialogOpenOptions,
  RuntimeEvent,
  RuntimeRequest,
  RuntimeStatus,
} from '../shared/desktop-api';
import { DESKTOP_API_VERSION } from '../shared/desktop-api';
import { isDesktopCommand } from './commands';
import type { CommandRouter } from './commands';
import type { FileHandleRegistry } from './file-handles';
import { assertTrustedIpcSender } from './security';
import type { SidecarSupervisor } from './sidecar-supervisor';

export const IPC_CHANNELS = {
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

// The renderer gets one ergonomic request method, but it cannot address an
// arbitrary private runtime command. Keep this product-owned allowlist in the
// main process so newly added maintenance/debug handlers remain unreachable
// until they are deliberately reviewed for renderer exposure.
const ALLOWED_RUNTIME_METHODS = new Set([
  'runtime.health',
  'runtime.self_test',
  'system.bootstrap',
  'app.bootstrap',
  'models.list',
  'models.select',
  'models.fallback.preflight',
  'settings.get',
  'settings.list',
  'settings.set',
  'local_models.discover',
  'local_models.hardware',
  'local_models.cupcake.status',
  'local_models.cupcake.catalogs.configure',
  'local_models.cupcake.download',
  'local_models.cupcake.download.status',
  'local_models.cupcake.download.pause',
  'local_models.cupcake.download.resume',
  'local_models.cupcake.download.cancel',
  'local_models.cupcake.download.reset',
  'local_models.cupcake.load',
  'local_models.cupcake.unload',
  'local_models.cupcake.remove_model',
  'local_models.cupcake.runtime_version',
  'local_models.cupcake.devices',
  'local_models.performance.record',
  'local_models.performance.get',
  'local_models.ollama.load',
  'local_models.ollama.unload',
  'local_models.ollama.remove',
  'local_models.lm_studio.list',
  'local_models.lm_studio.load',
  'providers.configure',
  'providers.compatible.configure',
  'providers.connectInteractive',
  'providers.disconnect',
  'providers.status',
  'providers.catalog.refresh',
  'projects.list',
  'projects.get',
  'projects.create',
  'projects.update',
  'projects.archive',
  'projects.files.list',
  'ingestion.ingest',
  'ingestion.ingest.private',
  'conversations.list',
  'conversations.get',
  'conversations.create',
  'conversations.rename',
  'conversations.archive',
  'conversations.branches',
  'conversations.branch',
  'chat.history',
  'chat.preflight',
  'chat.disclosure.preflight',
  'chat.send',
  'chat.edit',
  'chat.regenerate',
  'search.query',
  'search.project',
  'memory.list',
  'memory.get',
  'memory.remember',
  'memory.confirmation.preflight',
  'memory.propose',
  'memory.activate',
  'memory.forget',
  'memory.history',
  'memory.usage.record',
  'memory.suggestions.enable',
  'memory.suggestions.list',
  'memory.suggestions.dismiss',
  'tools.list',
  'tools.preflight',
  'tools.cancel',
  'mcp.connect',
  'mcp.tools.list',
  'mcp.tool.call',
  'mcp.disconnect',
  'tasks.list',
  'tasks.get',
  'tasks.create',
  'tasks.execute',
  'tasks.resume',
  'tasks.cancel',
  'tasks.steer',
  'tasks.followup',
  'tasks.approval.resolve',
  'tasks.events',
  'artifacts.list',
  'artifacts.create',
  'artifacts.get',
  'artifacts.content.read',
  'artifacts.revise',
  'artifacts.history',
  'artifacts.export.intent',
  'backup.create.intent',
  'backup.restore.intent',
  'developer.events',
  'developer.traces',
  'developer.purge',
  'developer.run_tree',
  'agents.roles',
  'agents.delegate',
  'migration.detect',
  'migration.preview',
  'migration.execute',
  'migration.decline',
  'migration.recovered_tasks',
  'proactive.enabled',
]);

interface IpcDependencies {
  handles: FileHandleRegistry;
  runtime: SidecarSupervisor;
  commands: CommandRouter;
  developmentServerUrl?: string;
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const { handles, runtime, commands, developmentServerUrl } = dependencies;
  const registrations: string[] = [];

  const register = <T extends unknown[], R>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: T) => R | Promise<R>,
  ): void => {
    ipcMain.handle(channel, (event, ...args: T) => {
      const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
      assertTrustedIpcSender(senderUrl, developmentServerUrl);
      return handler(event, ...args);
    });
    registrations.push(channel);
  };

  register(IPC_CHANNELS.appInfo, () => ({
    apiVersion: DESKTOP_API_VERSION,
    appVersion: app.getVersion(),
    platform: process.platform,
    packaged: app.isPackaged,
    runtime: runtime.status().state,
  }));

  register(IPC_CHANNELS.windowMinimize, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  register(IPC_CHANNELS.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });
  register(IPC_CHANNELS.windowClose, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.close(),
  );
  register(
    IPC_CHANNELS.windowIsMaximized,
    (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false,
  );

  register(IPC_CHANNELS.dialogOpenFiles, async (event, rawOptions?: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = validateOpenOptions(rawOptions);
    const result = await dialog.showOpenDialog(window!, {
      title: options.title,
      properties: options.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: options.filters,
    });
    if (result.canceled) return [];
    const publicHandles = [];
    for (const selectedPath of result.filePaths) {
      const publicHandle = await handles.registerExisting(selectedPath, false);
      const grant = handles.resolve(publicHandle.id);
      if (grant) runtime.registerFileGrant(grant);
      publicHandles.push(publicHandle);
    }
    return publicHandles;
  });

  register(IPC_CHANNELS.dialogOpenDirectory, async (event, rawOptions?: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const title = validTitle((rawOptions as { title?: unknown } | undefined)?.title);
    const result = await dialog.showOpenDialog(window!, { title, properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const publicHandle = await handles.registerExisting(result.filePaths[0], false);
    const grant = handles.resolve(publicHandle.id);
    if (grant) runtime.registerFileGrant(grant);
    return publicHandle;
  });

  register(IPC_CHANNELS.dialogSaveTarget, async (event, rawSuggestedName?: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const suggestedName = validSuggestedName(rawSuggestedName);
    const result = await dialog.showSaveDialog(window!, { defaultPath: suggestedName });
    if (result.canceled || !result.filePath) return null;
    const publicHandle = await handles.registerSaveTarget(result.filePath);
    const grant = handles.resolve(publicHandle.id);
    if (grant) runtime.registerFileGrant(grant);
    return publicHandle;
  });

  register(IPC_CHANNELS.dialogReleaseHandle, (_event, handleId: unknown) => {
    const id = validId(handleId);
    if (!id) return;
    handles.release(id);
    runtime.releaseFileGrant(id);
  });

  register(IPC_CHANNELS.commandExecute, (event, command: unknown) => {
    if (!isDesktopCommand(command)) throw new TypeError('Unknown desktop command');
    const window = BrowserWindow.fromWebContents(event.sender);
    commands.dispatch(command, window ?? undefined);
  });

  register(IPC_CHANNELS.runtimeStatus, () => runtime.status());
  register(IPC_CHANNELS.runtimeRequest, (_event, request: unknown) =>
    runtime.request(validateRuntimeRequest(request)),
  );
  register(IPC_CHANNELS.runtimeCancel, (_event, targetId: unknown) => {
    const id = validId(targetId);
    return id ? runtime.cancel(id) : false;
  });

  const broadcastEvent = (event: RuntimeEvent): void => broadcast(IPC_CHANNELS.runtimeEvent, event);
  const broadcastStatus = (status: RuntimeStatus): void =>
    broadcast(IPC_CHANNELS.runtimeStatusEvent, status);
  runtime.on('event', broadcastEvent);
  runtime.on('status', broadcastStatus);

  return () => {
    for (const channel of registrations) ipcMain.removeHandler(channel);
    runtime.off('event', broadcastEvent);
    runtime.off('status', broadcastStatus);
  };
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(channel, payload);
  }
}

function validateOpenOptions(raw: unknown): DialogOpenOptions {
  if (!raw || typeof raw !== 'object') return {};
  const candidate = raw as Record<string, unknown>;
  const filters = Array.isArray(candidate.filters)
    ? candidate.filters.slice(0, 16).flatMap((filter) => {
        if (!filter || typeof filter !== 'object') return [];
        const value = filter as Record<string, unknown>;
        if (typeof value.name !== 'string' || !Array.isArray(value.extensions)) return [];
        const extensions = value.extensions
          .filter(
            (extension): extension is string =>
              typeof extension === 'string' && /^[a-z0-9*]+$/i.test(extension),
          )
          .slice(0, 32);
        return extensions.length ? [{ name: value.name.slice(0, 80), extensions }] : [];
      })
    : undefined;
  return {
    title: validTitle(candidate.title),
    multiple: candidate.multiple === true,
    filters,
  };
}

function validTitle(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 160) : undefined;
}

function validSuggestedName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return [...value]
    .map((character) =>
      character.charCodeAt(0) < 32 || /[\\/:*?"<>|]/.test(character) ? '-' : character,
    )
    .join('')
    .slice(0, 180);
}

function validId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9-]{1,128}$/i.test(value) ? value : null;
}

function validateRuntimeRequest(value: unknown): RuntimeRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Runtime request must be an object');
  const request = value as Record<string, unknown>;
  if (typeof request.method !== 'string') throw new TypeError('Runtime request method is required');
  if (!ALLOWED_RUNTIME_METHODS.has(request.method)) {
    throw new TypeError('Runtime request method is not exposed to the renderer');
  }
  if (request.timeoutMs !== undefined && typeof request.timeoutMs !== 'number') {
    throw new TypeError('Runtime timeout must be a number');
  }
  return {
    method: request.method,
    params: request.params,
    timeoutMs: typeof request.timeoutMs === 'number' ? request.timeoutMs : undefined,
  };
}
