// Sample a mixed AskUserQuestion form with cached binaries and the loopback matrix API.
// node scripts/cc-matrix/probe-question-preview-multi.mjs [--versions a,b] [--widths 80,120,160,200] [--output tests/fixtures] [--clipped]
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeApi } from './fake-api.mjs';
import { cacheRoot } from './install.mjs';
import { previewQuestions } from './question-preview-input.mjs';
import { createSandbox } from './sandbox.mjs';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const versions = (option('--versions') ?? '2.1.300,2.1.310,2.1.321,2.1.326,2.1.329,2.1.331').split(',');
const widths = (option('--widths') ?? '80,120,160,200').split(',').map(Number);
const output = path.resolve(option('--output') ?? 'tests/fixtures');
const clipped = args.includes('--clipped');
const quote = arg => "'" + arg.replaceAll("'", "'\\''") + "'";

async function sample(version, width, named, binary, out) {
  const name = `${named ? 'named' : 'unnamed'}-${width}`;
  const api = await startFakeApi();
  const results = [];
  api.script('mixed', ({ step, toolResults }) => {
    if (step === 0) return { blocks: [{ type: 'text', text: 'Three choices for the sample panel.' },
      { type: 'tool_use', name: 'AskUserQuestion', input: { questions: previewQuestions } }] };
    results.push(...toolResults);
    return { text: 'Sample answers received.' };
  });
  const sandbox = await createSandbox({ version, binary, api });
  const frames = {};
  try {
    const hook = path.join(sandbox.root, 'question.json');
    const settings = { promptSuggestionEnabled: false, hooks: { PreToolUse: [{ matcher: 'AskUserQuestion',
      hooks: [{ type: 'command', command: `cat > ${quote(hook)}` }] }] } };
    const command = 'exec ' + [path.join(sandbox.home, '.local', 'bin', 'claude'), '--settings', JSON.stringify(settings),
      '--session-id', randomUUID(), ...(named ? ['--name', '示例会话'] : [])].map(quote).join(' ');
    sandbox.tmux('new-session', '-d', '-s', 'sample', '-x', String(width), '-y', '40', '-c', sandbox.work, command);
    const capture = (...flags) => sandbox.tmux('capture-pane', '-p', '-J', ...flags, '-t', 'sample').replaceAll(sandbox.root, '/tmp/ccm-sandbox');
    const send = (...keys) => sandbox.tmux('send-keys', '-t', 'sample', ...keys);
    const wait = async (pattern, label) => {
      for (const end = Date.now() + 15_000; Date.now() < end; await delay(100)) if (pattern.test(capture())) return;
      throw new Error(`${label}\n${capture()}`);
    };
    const save = label => {
      const screen = capture().split('\n').map(line => line.trimEnd()).join('\n');
      const tabs = capture('-e').split('\n').find(line => line.includes('✔ Submit') && /[☐☒]/u.test(line))?.trimEnd();
      frames[label] = { screen, ...(tabs && { tabs }) };
    };
    const press = async (label, key) => { send(key); await delay(300); save(label); };
    const crop = async (label, height) => {
      if (!clipped) return;
      const resize = rows => sandbox.tmux('resize-window', '-t', 'sample', '-x', String(width), '-y', String(rows));
      resize(height);
      await delay(550);
      save(label);
      resize(40);
      await delay(550);
    };
    const hasPage = (frame, index) => new RegExp(`\\x1b\\[(?:107|7)m [☐☒] ${previewQuestions[index].header}`, 'u').test(frames[frame].tabs ?? '');
    await wait(/^❯\s*$/m, 'initial composer');
    send('-l', 'Ask the three sample questions ccm:mixed');
    await delay(200);
    send('Enter');
    await wait(/Enter to select/, 'first question');
    await delay(500);
    save('first');
    const { tool_input: input } = JSON.parse(await readFile(hook, 'utf8'));
    assert.deepEqual(input.questions, previewQuestions);
    await press('second', 'Right');
    assert.ok(hasPage('second', 1), 'Right from the first question must open the second question');
    const preview = frames.second.screen.includes('n to add notes');
    await crop('second-clipped', 23);
    await press('second-option-2', 'Down');
    await press('second-option-3', 'Down');
    if (preview) {
      await press('notes', 'n');
      send('-l', 'Sample note');
      await delay(200);
      save('notes-typed');
      await press('notes-escape', 'Escape');
    }
    await press('third', 'Right');
    assert.ok(hasPage('third', 2), 'Right from the preview must open the third question');
    await press('third-tab', 'Tab');
    await press('third-back', 'Left');
    await press('second-back', 'Left');
    await press('second-tab', 'Tab');
    assert.ok(hasPage('second-tab', 2), 'Tab from the second question must open the third question');
    await press('second-back-again', 'Left');
    if (preview) {
      await press('second-numeric', '2');
      assert.ok(hasPage('second-numeric', 1), 'A number does not submit a preview choice');
    }
    await press('first-back', 'Left');
    await press('first-option-2', 'Down');
    await press('first-option-3', 'Down');
    await press('custom', 'Down');
    send('-l', 'Sample custom answer');
    await delay(200);
    save('custom-typed');
    await press('first-restore-3', 'Up');
    await press('first-restore-2', 'Up');
    await press('first-restore-1', 'Up');
    await press('second-after-first-answer', 'Enter');
    await press('first-answered', 'Left');
    await press('second-before-answer', 'Right');
    await press('second-pick-2', 'Down');
    if (preview) await press('second-confirm-notes', 'n');
    await press('third-after-second-answer', 'Enter');
    await press('second-answered', 'Left');
    await press('third-before-answer', 'Right');
    await press('third-pick-2', 'Down');
    await press('review', 'Enter');
    await crop('review-clipped', 17);
    send('Enter');
    await wait(/Sample answers received/, 'submitted answers');
    save('submitted');
    assert.equal(results.length, 1);
    for (const [index, q] of input.questions.entries()) {
      assert.ok(results[0].text.includes(`"${q.question}"="${q.options[index ? 1 : 0].label}"`), results[0].text);
    }
    return { input, preview, frames, results };
  } finally {
    await writeFile(path.join(out, `${name}.json`), JSON.stringify(frames, null, 2) + '\n');
    await sandbox.close();
    await api.close();
  }
}

for (const version of versions) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  // A missing cache entry must fail locally, never invoke the install path.
  const binary = path.join(cacheRoot(), version, 'node_modules', '.bin', 'claude');
  await access(binary);
  const out = path.join(output, `question-preview-multi-${version}`);
  await mkdir(out, { recursive: true });
  for (const width of widths) for (const named of [true, false]) {
    console.log(`${version} ${width} columns ${named ? 'named' : 'unnamed'}`);
    const { input, preview, frames, results } = await sample(version, width, named, binary, out);
    await writeFile(path.join(out, 'tool-input.json'), JSON.stringify(input, null, 2) + '\n');
    console.log(`  ${Object.keys(frames).length} frames, ${preview ? 'preview' : 'standard'} layout, ${results.length} tool result(s)`);
  }
}
