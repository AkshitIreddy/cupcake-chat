import {
  app,
  session,
  shell,
  type BrowserWindow,
  type Event as ElectronEvent,
  type Session,
} from 'electron';
import { isTrustedRendererUrl as isTrustedUrl, normalizeExternalUrl } from './url-policy';

const APP_ORIGIN = 'cupcake://app';

export function isTrustedRendererUrl(rawUrl: string, developmentServerUrl?: string): boolean {
  return isTrustedUrl(rawUrl, developmentServerUrl, !app.isPackaged);
}

export async function openValidatedExternalUrl(rawUrl: string): Promise<boolean> {
  const safeUrl = normalizeExternalUrl(rawUrl);
  if (!safeUrl) return false;
  try {
    await shell.openExternal(safeUrl, { activate: true });
    return true;
  } catch {
    return false;
  }
}

function contentSecurityPolicy(developmentServerUrl?: string): string {
  const devOrigin = developmentServerUrl ? new URL(developmentServerUrl).origin : undefined;
  const script = app.isPackaged ? "'self'" : "'self' 'unsafe-eval'";
  const connect = devOrigin ? `'self' ${devOrigin} ${devOrigin.replace(/^http/, 'ws')}` : "'self'";

  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "child-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ].join('; ');
}

export function installSessionSecurity(
  targetSession: Session,
  developmentServerUrl?: string,
): void {
  targetSession.setPermissionCheckHandler(() => false);
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  targetSession.on('will-download', (event) => event.preventDefault());

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url, developmentServerUrl)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy(developmentServerUrl)],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Referrer-Policy': ['no-referrer'],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
}

export function hardenWindow(window: BrowserWindow, developmentServerUrl?: string): void {
  const contents = window.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    void openValidatedExternalUrl(url);
    return { action: 'deny' };
  });

  const guardNavigation = (event: ElectronEvent, url: string): void => {
    if (isTrustedRendererUrl(url, developmentServerUrl)) return;
    event.preventDefault();
    void openValidatedExternalUrl(url);
  };
  contents.on('will-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);

  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') {
      console.error(`[desktop] renderer exited: ${details.reason}`);
    }
  });
}

export function assertTrustedIpcSender(senderUrl: string, developmentServerUrl?: string): void {
  if (!isTrustedRendererUrl(senderUrl, developmentServerUrl)) {
    throw new Error(`Rejected IPC from an untrusted renderer origin (expected ${APP_ORIGIN})`);
  }
}

export function getDesktopSession(): Session {
  return session.fromPartition('persist:cupcakeagi', { cache: true });
}
