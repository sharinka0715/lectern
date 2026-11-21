import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFileWindow, liveTranscriptScript, transcriptVersionGuard } from '../src/backend/transcript-pages';

const line = (record: object) => JSON.stringify(record) + '\n';
// The one-time note Claude Code (sampled with 2.1.328) appends when the first command
// is submitted in auto mode, e.g. right after /rewind opened its menu.
const notice = line({ parentUuid: 'e7e5b018-a843-44fc-88b7-7178db5d2229', isSidechain: false, type: 'system', subtype: 'informational',
  content: 'Auto mode lets Claude handle permission prompts automatically — Claude checks each tool call for risky actions and prompt injection before executing.' });

test('the rewind guard keeps its revision across appended auto mode notices only', { skip: process.platform === 'win32' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-guard-')));
  const file = join(root, 'session.jsonl');
  try {
    await writeFile(file, line({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Prompt 0' } }).repeat(20));
    const window = decodeFileWindow(execFileSync('sh', ['-c', liveTranscriptScript([file], undefined, true)]));
    const cursor = { inode: window.inode, offset: window.end, stamp: window.stamp, guard: window.guard };
    const passes = () => { try { execFileSync('sh', ['-c', transcriptVersionGuard([file], cursor)], { stdio: 'pipe' }); return true; } catch { return false; } };
    assert.equal(passes(), true, 'unchanged');
    await appendFile(file, notice);
    assert.equal(passes(), true, 'an informational notice was appended');
    await appendFile(file, notice.slice(0, 40));
    assert.equal(passes(), false, 'a partial line could be anything');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the rewind guard still fails on new conversation records or a changed prefix', { skip: process.platform === 'win32' }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lectern-guard-')));
  const file = join(root, 'session.jsonl');
  try {
    const prompt = line({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'Prompt 0' } });
    await writeFile(file, prompt.repeat(20));
    const window = decodeFileWindow(execFileSync('sh', ['-c', liveTranscriptScript([file], undefined, true)]));
    const cursor = { inode: window.inode, offset: window.end, stamp: window.stamp, guard: window.guard };
    const passes = () => { try { execFileSync('sh', ['-c', transcriptVersionGuard([file], cursor)], { stdio: 'pipe' }); return true; } catch { return false; } };
    await appendFile(file, notice + line({ parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content: 'Prompt 1' } }));
    assert.equal(passes(), false, 'a new prompt changes the branch');
    // The same length again, but the bytes before the cursor were rewritten.
    await writeFile(file, prompt.repeat(19) + prompt.replace('Prompt 0', 'Prompt 9') + notice);
    assert.equal(passes(), false, 'a rewritten prefix');
    // Without a guard sample only the exact revision passes.
    await writeFile(file, prompt.repeat(20) + notice);
    assert.throws(() => execFileSync('sh', ['-c', transcriptVersionGuard([file], { ...cursor, guard: undefined })], { stdio: 'pipe' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
