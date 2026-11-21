import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '../shared/types';
import { t } from '../shared/i18n';

/** Builds the menu in the current language; call again after switching language. */
export function installApplicationMenu(onAction: (action: MenuAction) => void) {
  const mac = process.platform === 'darwin';
  const preferences = {
    label: t('menu.preferences'), accelerator: 'CmdOrCtrl+,', click: () => onAction('preferences'),
  };
  const checkForUpdates = { label: t('update.menuCheck'), click: () => onAction('checkForUpdates') };
  const template: MenuItemConstructorOptions[] = [];
  if (mac) template.push({
    label: app.name,
    submenu: [
      { role: 'about', label: t('menu.about') }, checkForUpdates,
      { type: 'separator' }, preferences,
      { type: 'separator' }, { role: 'services', label: t('menu.services'), submenu: [] },
      { type: 'separator' },
      { role: 'hide', label: t('menu.hide') },
      { role: 'hideOthers', label: t('menu.hideOthers') },
      { role: 'unhide', label: t('menu.unhide') },
      { type: 'separator' }, { role: 'quit', label: t('menu.quitApp') },
    ],
  });
  template.push({
    label: t('menu.file'),
    submenu: [
      ...(mac ? [] : [preferences, { type: 'separator' as const }]),
      { role: 'close', label: t('menu.closeWindow') },
      ...(mac ? [] : [{ role: 'quit' as const, label: t('menu.quit') }]),
    ],
  }, {
    label: t('menu.edit'),
    submenu: [
      { role: 'undo', label: t('menu.undo') }, { role: 'redo', label: t('menu.redo') },
      { type: 'separator' },
      { role: 'cut', label: t('menu.cut') }, { role: 'copy', label: t('menu.copy') },
      { role: 'paste', label: t('menu.paste') }, { role: 'pasteAndMatchStyle', label: t('menu.pastePlain') },
      { role: 'selectAll', label: t('menu.selectAll') },
    ],
  }, {
    label: t('menu.view'),
    submenu: [
      { role: 'resetZoom', label: t('menu.actualSize') }, { role: 'zoomIn', label: t('menu.zoomIn') },
      { role: 'zoomOut', label: t('menu.zoomOut') }, { type: 'separator' },
      { role: 'togglefullscreen', label: t('menu.fullScreen') },
      { type: 'separator' }, { role: 'reload', label: t('menu.reload') },
      { role: 'toggleDevTools', label: t('menu.devTools') },
    ],
  }, {
    label: t('menu.window'),
    submenu: [
      { role: 'minimize', label: t('menu.minimize') },
      ...(mac ? [{ role: 'zoom' as const, label: t('menu.zoomWindow') }, { type: 'separator' as const },
        { role: 'front' as const, label: t('menu.front') }] : []),
    ],
  }, {
    role: 'help', label: t('menu.help'),
    submenu: [
      { label: t('menu.guide'), click: () => onAction('help') },
      ...(mac ? [] : [checkForUpdates, { role: 'about' as const, label: t('menu.about') }]),
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
