import { app, Menu, nativeImage, Tray, type BrowserWindow } from 'electron';
import { join } from 'node:path';

// A tiny packaged-safe neutral icon. Product artwork can replace it without changing tray behavior.
const TRAY_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAFUlEQVR42mNkYPj/n4ECwESJ5lEDANV4AhKqWjNQAAAAAElFTkSuQmCC';

export class TrayController {
  #tray?: Tray;

  create(getMainWindow: () => BrowserWindow | undefined): void {
    if (this.#tray) return;
    const packagedIcon = join(
      app.getAppPath(),
      ...(app.isPackaged
        ? ['.vite', 'renderer', 'main_window', 'brand', 'cupcake-tray.png']
        : ['public', 'brand', 'cupcake-tray.png']),
    );
    const productIcon = nativeImage.createFromPath(packagedIcon);
    const icon = productIcon.isEmpty() ? nativeImage.createFromDataURL(TRAY_ICON) : productIcon;
    if (icon.isEmpty()) return;
    this.#tray = new Tray(icon.resize({ width: 16, height: 16 }));
    this.#tray.setToolTip('CUPCAKEAGI');
    this.#tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open CUPCAKEAGI',
          click: () => showWindow(getMainWindow()),
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    );
    this.#tray.on('double-click', () => showWindow(getMainWindow()));
  }

  destroy(): void {
    this.#tray?.destroy();
    this.#tray = undefined;
  }
}

function showWindow(window?: BrowserWindow): void {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
