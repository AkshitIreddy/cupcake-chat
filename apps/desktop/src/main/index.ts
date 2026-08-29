import { app, BrowserWindow } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import { isAbsolute, join } from 'node:path';
import { CommandRouter } from './commands';
import { FileHandleRegistry } from './file-handles';
import { registerIpcHandlers } from './ipc';
import { getDesktopSession, installSessionSecurity } from './security';
import { SidecarSupervisor } from './sidecar-supervisor';
import { TrayController } from './tray';
import { createMainWindow, developmentServerUrl, installApplicationProtocol } from './windows';

app.setName('CUPCAKEAGI');
app.setAppUserModelId('com.cupcakeagi.desktop');
app.enableSandbox();

// A disposable profile is useful for owner acceptance testing without touching
// the normal `%APPDATA%\\CUPCAKEAGI` data directory. It is intentionally
// opt-in, Windows-only, and requires both a marker and an absolute path so a
// copied launcher cannot silently redirect an ordinary installation.
const testDataDir = process.env.CUPCAKE_TEST_DATA_DIR;
if (
  process.platform === 'win32' &&
  process.env.CUPCAKE_TEST_PROFILE === '1' &&
  testDataDir &&
  isAbsolute(testDataDir)
) {
  app.setPath('userData', testDataDir);
}

// Squirrel invokes the executable during install/update/uninstall. Handle
// those lifecycle events without starting sidecars or opening the workbench.
if (squirrelStartup) app.quit();

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

const handles = new FileHandleRegistry();
const commands = new CommandRouter();
const tray = new TrayController();
let mainWindow: BrowserWindow | undefined;
let unregisterIpc: (() => void) | undefined;
let quittingAfterCleanup = false;

const sidecarDirectory = app.isPackaged ? join(process.resourcesPath, 'sidecars') : undefined;
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const runtime = new SidecarSupervisor({
  executablePath:
    (!app.isPackaged ? process.env.CUPCAKE_BROKER_PATH : undefined) ??
    (sidecarDirectory
      ? join(sidecarDirectory, `cupcake-tool-broker${executableSuffix}`)
      : undefined),
  runtimeExecutablePath:
    (!app.isPackaged ? process.env.CUPCAKE_RUNTIME_PATH : undefined) ??
    (sidecarDirectory ? join(sidecarDirectory, `cupcake-runtime${executableSuffix}`) : undefined),
  localBaselinePath:
    (!app.isPackaged ? process.env.CUPCAKE_LOCAL_BASELINE_DIR : undefined) ??
    (sidecarDirectory ? join(sidecarDirectory, 'cupcake-local') : undefined),
  manifestPath: sidecarDirectory ? join(sidecarDirectory, 'sidecars.manifest.json') : undefined,
  requireManifest: app.isPackaged,
  userDataPath: app.getPath('userData'),
  // Packaged builds must fail closed if either signed sidecar is absent,
  // corrupt, or cannot complete the authenticated handshake. Deterministic
  // fixtures are a development-only convenience and must never masquerade as
  // live state in a release-candidate package.
  allowMockFallback: !app.isPackaged && process.env.CUPCAKE_REQUIRE_SIDECARS !== '1',
});

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

void app
  .whenReady()
  .then(async () => {
    const desktopSession = getDesktopSession();
    installSessionSecurity(desktopSession, developmentServerUrl());
    installApplicationProtocol(desktopSession);
    unregisterIpc = registerIpcHandlers({
      handles,
      runtime,
      commands,
      developmentServerUrl: developmentServerUrl(),
    });
    commands.installApplicationMenu();
    await runtime.start();
    mainWindow = await createMainWindow(desktopSession);
    tray.create(() => mainWindow);

    mainWindow.on('close', (event) => {
      // Closing the workbench keeps durable work alive in the tray. The tray
      // menu's explicit Quit path runs the checkpoint/shutdown sequence below.
      if (!quittingAfterCleanup) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
    mainWindow.on('closed', () => {
      mainWindow = undefined;
    });
  })
  .catch((error: unknown) => {
    console.error('[desktop] failed to start', error);
    app.quit();
  });

app.on('activate', () => {
  void activateApplication();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (quittingAfterCleanup) return;
  event.preventDefault();
  quittingAfterCleanup = true;
  unregisterIpc?.();
  handles.clear();
  tray.destroy();
  void runtime.stop().finally(() => app.quit());
});

async function activateApplication(): Promise<void> {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = await createMainWindow(getDesktopSession());
  } else {
    mainWindow?.show();
  }
}
