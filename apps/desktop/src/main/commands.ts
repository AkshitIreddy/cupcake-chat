import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import type { DesktopCommand } from '../shared/desktop-api';

const COMMANDS = new Set<DesktopCommand>([
  'app.about',
  'app.preferences',
  'chat.new',
  'chat.stop',
  'file.attach',
  'navigation.back',
  'navigation.forward',
  'search.open',
  'view.command-palette',
  'view.frosting-thread',
  'view.model-picker',
]);

export const COMMAND_EVENT_CHANNEL = 'cupcake:commands:event';

export function isDesktopCommand(value: unknown): value is DesktopCommand {
  return typeof value === 'string' && COMMANDS.has(value as DesktopCommand);
}

export class CommandRouter {
  dispatch(command: DesktopCommand, target?: BrowserWindow): void {
    const window = target ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window || window.isDestroyed()) return;
    window.webContents.send(COMMAND_EVENT_CHANNEL, command);
  }

  installApplicationMenu(): void {
    const send = (command: DesktopCommand) => (): void => this.dispatch(command);
    const isMac = process.platform === 'darwin';
    const template: MenuItemConstructorOptions[] = [
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { label: 'About CUPCAKEAGI', click: send('app.about') },
                { type: 'separator' as const },
                { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('app.preferences') },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const },
              ],
            },
          ]
        : []),
      {
        label: 'File',
        submenu: [
          { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: send('chat.new') },
          { label: 'Attach file…', accelerator: 'CmdOrCtrl+U', click: send('file.attach') },
          { type: 'separator' },
          ...(isMac ? [{ role: 'close' as const }] : [{ role: 'quit' as const }]),
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'Navigate',
        submenu: [
          { label: 'Back', accelerator: 'Alt+Left', click: send('navigation.back') },
          { label: 'Forward', accelerator: 'Alt+Right', click: send('navigation.forward') },
          { type: 'separator' },
          { label: 'Search', accelerator: 'CmdOrCtrl+Shift+F', click: send('search.open') },
          {
            label: 'Command palette',
            accelerator: 'CmdOrCtrl+K',
            click: send('view.command-palette'),
          },
          { label: 'Model picker', accelerator: 'CmdOrCtrl+M', click: send('view.model-picker') },
          {
            label: 'Frosting Thread',
            accelerator: 'CmdOrCtrl+J',
            click: send('view.frosting-thread'),
          },
          { label: 'Stop current run', accelerator: 'CmdOrCtrl+.', click: send('chat.stop') },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        role: 'help',
        submenu: [{ label: 'About CUPCAKEAGI', click: send('app.about') }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }
}
