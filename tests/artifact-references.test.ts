import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { adjacentFileNames, artifactPath, findPathReferences, parentPath, relativeToFile } from '../src/renderer/artifact-paths';
import { ArtifactMarkdown, LinkedToolText, LinkedUserText } from '../src/renderer/ArtifactLinks';
import { MessageDisplay } from '../src/core/message-display';
import { attachmentPreview, attachmentBytes } from '../src/main/message-attachment';
import { transcriptAttachments } from '../src/core/transcript-attachments';

const noop = () => {};
test('workspace paths support Unicode, literal percent, quoted names, file URLs, native mentions and source locations', () => {
  const text = 'See @assets, /repo/x.ts:4:8, ./src/a.md#L22-L24, "assets/图 100%.png" or https://host/x.png, me@example.org.';
  assert.deepEqual(findPathReferences(text).map(ref => ref.path), ['assets', '/repo/x.ts', './src/a.md', 'assets/图 100%.png']);
  assert.equal(artifactPath('a%2525.md#head', true), 'a%25.md');
  assert.equal(artifactPath('file://localhost/tmp/中文%20a.png'), '/tmp/中文 a.png');
  assert.equal(artifactPath('file:///C:/Project/a.ts'), 'C:/Project/a.ts');
  for (const url of ['https://example.org/a', 'javascript%3Aalert(1)', 'file://another-host/foo', '//host/foo', '%00abc', 'mailto:a@example.org']) {
    assert.equal(artifactPath(url, true), undefined);
  }
  assert.equal(relativeToFile('/srv/reports/note.md', 'files/data.csv'), '/srv/reports/files/data.csv');
  assert.equal(parentPath('/outside'), '/');
  assert.equal(parentPath('.'), undefined);
});

test('plain and code spans require filename evidence, not numeric ratios, property names or word pairs', () => {
  for (const token of ['400/429', '3000/3010', 'usage.current', 'manual/startup']) {
    for (const text of [token, '`' + token + '`', '"' + token + '"']) {
      assert.deepEqual(findPathReferences(text), []);
      assert.deepEqual(findPathReferences(text, true), []);
    }
  }
  assert.deepEqual(findPathReferences('ProxyPanel.tsx index.ts:10', true).map(ref => ref.path), ['ProxyPanel.tsx', 'index.ts']);
  assert.deepEqual(findPathReferences('import "./manual/startup"; // src/x.ts:8').map(ref => ref.path), ['./manual/startup', 'src/x.ts']);
  const prose = '改了ProxyPanel.tsx和index.ts';
  assert.deepEqual(findPathReferences(prose + '。').map(ref => ref.path), [prose], 'Check the literal name before using any prose fallback');
  assert.deepEqual(adjacentFileNames(prose).map(ref => [ref.path, prose.slice(ref.start, ref.end)]), [
    ['ProxyPanel.tsx', 'ProxyPanel.tsx'], ['index.ts', 'index.ts'],
  ]);
  assert.deepEqual(adjacentFileNames('中文目录/中文ProxyPanel.tsx'), []);
  // Media and data outputs Claude reports next to a video or a checkpoint.
  assert.deepEqual(findPathReferences('好了：`build/clip_v10.mp4`，另附 `clip_v10.srt`、`ckpt/step_60000.safetensors` 和 /data/run/out.mkv').map(ref => ref.path),
    ['build/clip_v10.mp4', 'clip_v10.srt', 'ckpt/step_60000.safetensors', '/data/run/out.mkv']);
});

test('unverified Markdown, raw prompts and native JSON remain selectable text without buttons or image requests', () => {
  const md = renderToStaticMarkup(createElement(ArtifactMarkdown, { onOpen: noop,
    text: '[Guide](<pdfs/a b.pdf>) ![proof](local.png) ![tracker](https://evil.invalid/a.png) [![thumbnail](a.png)](b.png) and `src/x.ts:7`\n\n```ts\nconst s = "ignore/me";\n```' }));
  assert.match(md, /Guide/);
  assert.match(md, /proof/);
  assert.match(md, /<code>src\/x.ts:7<\/code>/);
  // A fenced block gets only its own copy button, never a file link.
  assert.match(md, /<div class="code-block"><pre><code class="language-ts">const s = &quot;ignore\/me&quot;;\n<\/code><\/pre><button type="button" class="code-copy" aria-label="复制代码"/);
  assert.doesNotMatch(md.replace(/<button[^>]*class="code-copy"[^>]*>.*?<\/button>/g, ''), /<img|<button|data-file-path=/);
  const user = renderToStaticMarkup(createElement(LinkedUserText, { onOpen: noop, text: '<tag> [doc](<file name.xyz>)' }));
  assert.match(user, /&lt;tag&gt;/);
  assert.match(user, /file name.xyz/);
  assert.doesNotMatch(user, /<button/);
  const input = renderToStaticMarkup(createElement(LinkedToolText, { onOpen: noop, input: true, text: JSON.stringify({ path: 'dir/v"1/NOTICE', file_path: 'README OTHER' }, null, 2) }));
  assert.match(input, /NOTICE/);
  assert.match(input, /README OTHER/);
  assert.doesNotMatch(input, /<button/);
});

test('embedded bytes stay out of snapshots and revisions; native image-only prompts and file attachment rows are visible', async () => {
  const display = new MessageDisplay('s');
  const raw = Buffer.from('GIF89aExample').toString('base64');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: raw } };
  const ingest = (...rows: unknown[]) => display.ingestJsonl(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  ingest({ type: 'user', uuid: 'u', sessionId: 's', message: { content: [image] } },
    { type: 'attachment', uuid: 'file', parentUuid: 'u', attachment: { type: 'file', filename: '/project/a b.py' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'file', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });
  const messages = display.getMessages();
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].text, '');
  assert.equal(messages[0].attachments?.[1].path, '/project/a b.py');
  assert.ok(!JSON.stringify(messages).includes(raw));
  const id = messages[0].attachments![0].id;
  const attachment = display.getAttachment(id);
  assert.equal((await attachmentPreview(attachment)).kind, 'image');
  assert.deepEqual(attachmentBytes(attachment), Buffer.from(raw, 'base64'));
  display.ingestJsonl(JSON.stringify({ type: 'user', uuid: 'new', message: { content: 'new thread' } }) + '\n', true);
  assert.throws(() => display.getAttachment(id));
});

test('images keep their native positions across user text, tool calls, results and later assistant text', () => {
  const display = new MessageDisplay('s');
  const text = (text: string) => ({ type: 'text', text });
  const image = (body: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(body).toString('base64') } });
  const message = (type: string, uuid: string, parentUuid: string | null, content: unknown[]) => ({ type, uuid, parentUuid, message: { content } });
  const encode = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const input = message('user', 'q', null, [text('左🧭'), image('input'), text('右')]);
  const call = { type: 'tool_use', name: 'Read', id: 'read', input: { file_path: 'plot.png' } };
  const start = message('assistant', 'a', 'q', [image('first'), text('之前'), call, image('second')]);
  const result = message('user', 'r', 'a', [{ type: 'tool_result', tool_use_id: 'read', content: [image('result')] }]);
  const finish = message('assistant', 'b', 'r', [text('读完'), image('last'), text('解释')]);
  display.ingestJsonl(encode(result, finish), true, true);
  assert.equal(display.getMessages()[0].attachments![0].toolsBefore, 1);
  display.prependJsonl(encode(input, start), false);
  const [prompt, reply] = display.getMessages();
  assert.equal(prompt.text, '左🧭\n\n右');
  assert.equal(prompt.attachments![0].textOffset, '左🧭'.length);
  assert.equal(reply.text, '之前\n\n读完\n\n解释');
  assert.deepEqual(reply.attachments!.map(ref => [ref.image, ref.textOffset, ref.toolsBefore]), [[true,0,0], [true,2,1], [true,2,1], [true,6,1]]);
  const old = reply.attachments!.at(-1)!;
  display.ingestJsonl(encode(message('assistant', 'b', 'r', [text('读完'), image('revised'), text('解释')])));
  const revised = display.getMessages()[1].attachments!.at(-1)!;
  assert.equal(revised.id, old.id);
  assert.notEqual(revised.revision, old.revision);
  assert.deepEqual(attachmentBytes(display.getAttachment(old.id)), Buffer.from('revised'));
});

test('nested tool results expose local MCP resource paths and inspect MIME from bytes', async () => {
  const [file, invalidPdf] = transcriptAttachments('record', [{ type: 'tool_result', content: [
    { type: 'resource_link', uri: 'file:///root/data%20set.csv' }, { type: 'resource_link', uri: 'https://remote.invalid/a' },
    { type: 'document', title: 'fake.pdf', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('<html>').toString('base64') } },
  ] }]);
  assert.equal(file.ref.path, '/root/data set.csv');
  assert.equal((await attachmentPreview(invalidPdf)).kind, 'binary');
});

test('a folder Claude Code attached for an @-mention is marked as one', () => {
  const [folder, file] = transcriptAttachments('record', [{ type: 'directory', path: '/project/src' }, { type: 'file', filename: '/project/notes.md' }]);
  assert.deepEqual(folder.ref, { id: 'record:attachment:0', name: 'src', path: '/project/src', directory: true });
  assert.deepEqual(file.ref, { id: 'record:attachment:1', name: 'notes.md', path: '/project/notes.md' });
});
