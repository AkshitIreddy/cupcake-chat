import { app, BrowserWindow, net, nativeTheme, protocol, type Session } from 'electron';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import { hardenWindow } from './security';

declare const MAIN_WINDOW_VITE_DEV_SERVER: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cupcake',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true,
    },
  },
]);

export function developmentServerUrl(): string | undefined {
  return typeof MAIN_WINDOW_VITE_DEV_SERVER === 'string' ? MAIN_WINDOW_VITE_DEV_SERVER : undefined;
}

export function installApplicationProtocol(targetSession: Session): void {
  if (!app.isPackaged || targetSession.protocol.isProtocolHandled('cupcake')) return;
  const rendererRoot = resolve(
    app.getAppPath(),
    '.vite',
    'renderer',
    MAIN_WINDOW_VITE_NAME || 'main_window',
  );

  targetSession.protocol.handle('cupcake', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      const requestedPath = decodeURIComponent(url.pathname);
      const relativePath =
        requestedPath === '/' ? 'index.html' : normalize(requestedPath).replace(/^[/\\]+/, '');
      let filePath = resolve(rendererRoot, relativePath);
      if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
        return new Response('Not found', { status: 404 });
      }
      try {
        await access(filePath);
      } catch {
        if (extname(relativePath)) return new Response('Not found', { status: 404 });
        filePath = join(rendererRoot, 'index.html');
      }
      const response = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(response.headers);
      headers.set(
        'Content-Type',
        MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      );
      headers.set(
        'Cache-Control',
        extname(filePath) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
      );
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

export async function createMainWindow(targetSession: Session): Promise<BrowserWindow> {
  const isMac = process.platform === 'darwin';
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 360,
    minHeight: 560,
    show: false,
    title: 'CUPCAKEAGI',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#181515' : '#F6F2EB',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#181515' : '#F6F2EB',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#F7F1E8' : '#2A2322',
            height: 40,
          },
        }),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      session: targetSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      spellcheck: true,
      devTools: !app.isPackaged,
      navigateOnDragDrop: false,
    },
  });

  hardenWindow(window, developmentServerUrl());
  window.once('ready-to-show', () => window.show());
  window.webContents.setVisualZoomLevelLimits(1, 4).catch(() => undefined);

  if (developmentServerUrl()) {
    await window.loadURL(developmentServerUrl()!);
  } else {
    await window.loadURL('cupcake://app/');
  }
  return window;
}
