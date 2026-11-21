import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedSettingOption, settingAvailability, validateSettingMenu } from '../src/renderer/session-settings-state';
import { settingMenuNeedsRefresh } from '../src/shared/session-setting-ticket';
import type { SessionSettingSnapshot } from '../src/shared/types';

const menu: SessionSettingSnapshot = {
  kind: 'model', token: 'opaque-token', sessionId: 'session-a', paneId: '%3', observedAt: '2026-01-01T00:00:00Z', command: '/model', complete: true,
  options: [{ id: 'custom-model-id', label: 'Tenant supplied model α', current: true }, { id: 'another-model-id', label: 'Private model β', current: false }],
  currentOptionId: 'custom-model-id',
};

test('current settings require a confirmed ID and one matching native current item', () => {
  assert.equal(confirmedSettingOption(menu)?.label, 'Tenant supplied model α');
  assert.equal(confirmedSettingOption({ ...menu, currentOptionId: undefined }), undefined);
  assert.equal(confirmedSettingOption({ ...menu, currentOptionId: 'not-returned' }), undefined);
  assert.equal(confirmedSettingOption({ ...menu, options: menu.options.map(option => ({ ...option, current: true })) }), undefined);
  assert.equal(confirmedSettingOption({ ...menu, options: menu.options.map(option => ({ ...option, current: false })) }), undefined);
});

test('cached menu labels survive but expired or invalid tickets require an explicit refresh', () => {
  const observed = Date.parse(menu.observedAt);
  assert.equal(settingMenuNeedsRefresh(menu, observed + 4 * 60 * 1000), false);
  assert.equal(settingMenuNeedsRefresh(menu, observed + 5 * 60 * 1000), true);
  assert.equal(settingMenuNeedsRefresh({ ...menu, complete: false }, observed), true);
  assert.equal(settingMenuNeedsRefresh({ ...menu, refreshRequired: true }, observed), true);
  assert.equal(settingMenuNeedsRefresh({ ...menu, observedAt: 'unknown' }, observed), true);
  assert.equal(settingMenuNeedsRefresh(menu, observed - 1), true);
  assert.equal(settingMenuNeedsRefresh(undefined, observed), true);
  assert.equal(confirmedSettingOption(menu)?.label, 'Tenant supplied model α');
});

test('a bound machine catalog can be used later without borrowing a current choice', () => {
  const catalog: SessionSettingSnapshot = { ...menu, source: 'catalog', currentOptionId: undefined,
    options: menu.options.map(option => ({ ...option, current: false })) };
  assert.equal(settingMenuNeedsRefresh(catalog, Date.parse(menu.observedAt) + 24 * 3600_000), false);
  assert.equal(validateSettingMenu(catalog, 'model', 'session-a', '%3'), catalog);
  assert.equal(confirmedSettingOption(catalog), undefined);
  assert.equal(settingMenuNeedsRefresh({ ...catalog, complete: false }), true);
});

test('menus accept actual arbitrary choices without imposing built-in model or effort names', () => {
  assert.equal(validateSettingMenu(menu, 'model', 'session-a', '%3'), menu);
  const effort = { ...menu, kind: 'effort' as const, command: '/effort', options: [{ id: 'native-custom-focus', label: 'Custom focus level', current: true }], currentOptionId: 'native-custom-focus' };
  assert.equal(validateSettingMenu(effort, 'effort', 'session-a', '%3'), effort);
  assert.equal(confirmedSettingOption(effort)?.label, 'Custom focus level');
});

test('late or malformed menus cannot be applied to another session or pane', () => {
  assert.throws(() => validateSettingMenu(menu, 'effort', 'session-a', '%3'), /会话或终端已变化/);
  assert.throws(() => validateSettingMenu(menu, 'model', 'session-b', '%3'), /会话或终端已变化/);
  assert.throws(() => validateSettingMenu(menu, 'model', 'session-a', '%9'), /会话或终端已变化/);
  assert.throws(() => validateSettingMenu({ ...menu, options: [menu.options[0], menu.options[0]] }, 'model', 'session-a', '%3'), /重复选项/);
  assert.throws(() => validateSettingMenu({ ...menu, token: '' }, 'model', 'session-a', '%3'), /信息不完整/);
});

test('native menu controls require a ready live pane or a confirmed native error', () => {
  assert.equal(settingAvailability({ paneId: '%3', status: 'idle', nativeInputReady: false }).allowed, false);
  assert.equal(settingAvailability({ paneId: '%3', status: 'idle', navigationStatus: 'idle' }).allowed, true);
  for (const status of ['connecting', 'working', 'waiting', 'offline', 'error'] as const) assert.equal(settingAvailability({ paneId: '%3', status }).allowed, false);
  assert.equal(settingAvailability({ status: 'idle' }).allowed, false);
  assert.equal(settingAvailability({ paneId: '%3', status: 'idle', busy: true }).allowed, false);
  assert.equal(settingAvailability({ paneId: '%3', status: 'idle', navigationStatus: 'unknown' }).allowed, false);
  assert.equal(settingAvailability({ paneId: '%3', status: 'idle', navigationStatus: 'waiting' }).allowed, false);
});

test('native API errors allow recovery settings while disconnected or busy panes remain blocked', () => {
  assert.equal(settingAvailability({ paneId: '%3', status: 'error', navigationStatus: 'error' }).allowed, true);
  assert.equal(settingAvailability({ status: 'error', navigationStatus: 'error' }).allowed, false);
  assert.equal(settingAvailability({ paneId: '%3', status: 'error', navigationStatus: 'error', busy: true }).allowed, false);
  for (const navigationStatus of ['unknown', 'waiting', 'working', 'idle'] as const) assert.equal(settingAvailability({ paneId: '%3', status: 'error', navigationStatus }).allowed, false);
  for (const status of ['offline', 'connecting', 'working', 'waiting'] as const) assert.equal(settingAvailability({ paneId: '%3', status, navigationStatus: 'error' }).allowed, false);
});
