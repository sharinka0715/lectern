import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { t } from '../shared/i18n';

/** Native edit menu for text fields and selected text; empty elsewhere. */
export function editMenuItems(params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  if (params.isEditable) return [
    { role: 'undo', label: t('menu.undo'), enabled: flags.canUndo }, { role: 'redo', label: t('menu.redo'), enabled: flags.canRedo }, { type: 'separator' },
    { role: 'cut', label: t('menu.cut'), enabled: flags.canCut }, { role: 'copy', label: t('menu.copy'), enabled: flags.canCopy },
    { role: 'paste', label: t('menu.paste'), enabled: flags.canPaste }, { type: 'separator' }, { role: 'selectAll', label: t('menu.selectAll'), enabled: flags.canSelectAll },
  ];
  if (params.selectionText.trim()) return [{ role: 'copy', label: t('menu.copy'), enabled: flags.canCopy }, { type: 'separator' }, { role: 'selectAll', label: t('menu.selectAll') }];
  return [];
}
