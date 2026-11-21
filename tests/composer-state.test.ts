import assert from 'node:assert/strict';
import test from 'node:test';
import { composerPlaceholder, isMessageInputReady } from '../src/renderer/composer-state';
import type { NavigationSessionStatus, SessionStatus } from '../src/shared/types';

test('ordinary idle input retains its existing navigation requirements', () => {
  assert.equal(isMessageInputReady({ status: 'idle' }), true);
  assert.equal(isMessageInputReady({ status: 'idle', navigationStatus: 'idle', nativeInputReady: false }), true);
  for (const navigationStatus of ['history', 'working', 'waiting', 'error', 'unknown'] as const)
    assert.equal(isMessageInputReady({ status: 'idle', navigationStatus, nativeInputReady: true }), false);
});

test('a retained API error permits a new message only with explicit native readiness', () => {
  assert.equal(isMessageInputReady({ status: 'error', navigationStatus: 'error', nativeInputReady: true }), true);
  for (const nativeInputReady of [undefined, false])
    assert.equal(isMessageInputReady({ status: 'error', navigationStatus: 'error', nativeInputReady }), false);
  for (const navigationStatus of [undefined, 'idle', 'history', 'working', 'waiting', 'unknown'] as const)
    assert.equal(isMessageInputReady({ status: 'error', navigationStatus, nativeInputReady: true }), false);
});

test('native readiness never relaxes disconnected, loading, working or waiting states', () => {
  const blocked: SessionStatus[] = ['offline', 'connecting', 'working', 'waiting'];
  const navigation: (NavigationSessionStatus | undefined)[] = [undefined, 'history', 'idle', 'working', 'waiting', 'error', 'unknown'];
  for (const status of blocked) for (const navigationStatus of navigation)
    assert.equal(isMessageInputReady({ status, navigationStatus, nativeInputReady: true }), false, `${status}/${navigationStatus}`);
});

const placeholderBase = {
  workspace: true, sessionId: true, snapshot: true, paneId: true, canSend: false, inTurn: false, terminalLocked: false,
  draftOccupied: false, settingBusy: false, trustBusy: false, questionBusy: false, rewind: false, busy: false, permission: false, status: 'working' as SessionStatus,
};

test('an enabled composer invites a message or in-turn guidance', () => {
  assert.equal(composerPlaceholder({ ...placeholderBase, canSend: true, status: 'idle' }), '和 Claude 聊聊你的想法…');
  assert.equal(composerPlaceholder({ ...placeholderBase, canSend: true, inTurn: true }), '给当前回复补充指引，或加入队列…');
  assert.equal(composerPlaceholder({ ...placeholderBase, canSend: true, inTurn: true, compacting: true }), '正在压缩对话，新消息会排队，压缩完成后发送…');
});

test('a disabled composer always states why', () => {
  const generic = new Set(['和 Claude 聊聊你的想法…', '给当前回复补充指引，或加入队列…']);
  const cases: [Partial<typeof placeholderBase> & { navigationStatus?: NavigationSessionStatus }, RegExp][] = [
    [{ settingBusy: true }, /切换模型或 effort/],
    [{ trustBusy: true }, /目录信任/],
    [{ questionBusy: true }, /回答/],
    [{ rewind: true }, /回退/],
    [{ permission: true, status: 'waiting' }, /工具授权/],
    [{ busy: true }, /上一项操作/],
    [{ status: 'connecting' }, /同步/],
    [{ status: 'waiting' }, /确认/],
    [{ status: 'idle', navigationStatus: 'waiting' }, /确认/],
    [{ status: 'error' }, /出错/],
    [{ status: 'offline' }, /续接/],
    [{ status: 'working' }, /正在处理.*查看终端/],
    [{ status: 'idle', navigationStatus: 'unknown' }, /查看终端/],
  ];
  for (const [input, reason] of cases) {
    const text = composerPlaceholder({ ...placeholderBase, ...input });
    assert.ok(!generic.has(text), JSON.stringify(input));
    assert.match(text, reason, JSON.stringify(input));
  }
  assert.match(composerPlaceholder({ ...placeholderBase, terminalLocked: true, settingBusy: true }), /终端接管中/);
  assert.match(composerPlaceholder({ ...placeholderBase, draftOccupied: true }), /草稿/);
});

test('a new chat says nothing starts until its first message, then follows the launch', () => {
  const base = { workspace: true, sessionId: false, snapshot: false, paneId: false, canSend: false, inTurn: false, terminalLocked: false, draftOccupied: false,
    settingBusy: false, trustBusy: false, questionBusy: false, rewind: false, busy: false, status: 'offline' as const };
  assert.match(composerPlaceholder({ ...base, draft: true }), /发送后才启动 Claude Code/);
  // A machine without tmux or Claude Code says so instead of inviting a first message.
  assert.equal(composerPlaceholder({ ...base, draft: true, hostBlocked: '本机缺少 tmux，装好之前不能在这里开始对话' }), '本机缺少 tmux，装好之前不能在这里开始对话');
  assert.equal(composerPlaceholder({ ...base, folderResolving: true }), '正在读取目录…');
  assert.equal(composerPlaceholder({ ...base, draft: true, launching: true, busy: true }), '正在启动 Claude Code…');
  assert.match(composerPlaceholder({ ...base, sessionId: true, snapshot: true, paneId: true, pendingFirst: true, status: 'connecting' }), /就绪后自动发送/);
  assert.match(composerPlaceholder({ ...base, sessionId: true, snapshot: true, paneId: true, pendingFirst: true, status: 'waiting' }), /确认终端里的提示后/);
});
