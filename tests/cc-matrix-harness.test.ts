import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error The compatibility matrix scripts are plain ES modules.
import { selectVersions } from '../scripts/cc-matrix/versions.mjs';
// @ts-expect-error The compatibility matrix scripts are plain ES modules.
import { startFakeApi } from '../scripts/cc-matrix/fake-api.mjs';

test('compatibility matrix: one release per block of ten, plus latest and stable', () => {
  const published = ['2.1.299', '2.1.300', '2.1.301', '2.1.310', '2.1.311', '2.1.319', '2.1.321', '2.1.322', '2.1.329', '2.1.330-beta.1'];
  assert.deepEqual(selectVersions(published, { latest: '2.1.329', stable: '2.1.311' }), ['2.1.300', '2.1.310', '2.1.311', '2.1.321', '2.1.329']);
  assert.deepEqual(selectVersions(published, { latest: '2.1.322' }, { from: '2.1.315' }), ['2.1.319', '2.1.321', '2.1.322']);
});

test('compatibility matrix fake API: the marker picks the script, the step follows the tool loop', async () => {
  const api = await startFakeApi();
  try {
    api.script('loop', ({ step }: { step: number }) => step === 0 ? { blocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'true' } }] } : { text: 'finished' });
    const ask = async (messages: unknown[]) => {
      const response = await fetch(`${api.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm', stream: true, tools: [{ name: 'Agent' }, { name: 'Bash' }], messages }) });
      return response.text();
    };
    const first = await ask([{ role: 'user', content: 'go ccm:loop' }]);
    assert.match(first, /"name":"Bash"/);
    assert.match(first, /"stop_reason":"tool_use"/);
    const second = await ask([{ role: 'user', content: 'go ccm:loop' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]);
    assert.match(second, /finished/);
    assert.deepEqual(api.requests.map((r: { script: string; step: number }) => [r.script, r.step]), [['loop', 0], ['loop', 1]]);
    // A task notification's <summary> tag is not the compaction prompt.
    const note = await ask([{ role: 'user', content: '<task-notification><summary>done</summary></task-notification>' }]);
    assert.doesNotMatch(note, /Primary Request/);
    const models = await fetch(`${api.url}/v1/models`).then(r => r.json());
    assert.ok(models.data.length > 1);
    assert.equal(api.external.length, 0);
  } finally { await api.close(); }
});
