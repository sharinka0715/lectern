import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkpointPosition } from '../src/backend/native-turn-controls';
import { MessageDisplay } from '../src/core/message-display';
import { readRewind } from '../src/core/turn-controls';

// Captured in the matrix sandbox with the loopback fake API. Times in each
// transcript are relative to its first registration, and IDs are placeholders.
const versions = ['2.1.300', '2.1.321', '2.1.331'];
type Case = { phase: string; startedAt: number; labels: string[] };
const read = (version: string, file: string) => readFileSync(new URL(`./fixtures/rewind-compact-${version}/${file}`, import.meta.url), 'utf8');
const sessionId = '00000000-0000-4000-8000-000000000000';
const offered = (view: MessageDisplay) => view.getMessages().filter(m => m.rewindUuid).map(m => m.text);

for (const version of versions) {
  test(`${version}: projected rewind points and both ends of the native list agree across compactions`, () => {
    for (const {phase, startedAt, labels} of JSON.parse(read(version, 'cases.json')) as Case[]) {
      const view = new MessageDisplay(sessionId);
      view.setRewindProcess(startedAt);
      view.ingestJsonl(read(version, phase + '.jsonl'), true, false);
      const points = view.rewindPoints()!;
      assert.deepEqual(points?.map(point => point.text), labels, phase);
      assert.deepEqual(offered(view), labels.filter(label => !label.startsWith('/')), phase);
      for (const [side, ordinal] of [['first',0], ['latest',labels.length]] as const) {
        const menu = readRewind(read(version, `${phase}-${side}.ansi`))!;
        assert.equal(checkpointPosition(menu, {index:0, prompts:labels}), ordinal, phase + ' ' + side);
      }
    }
  });
}

test('a restore can cut archived rows, and a new process revokes the old shortcuts', () => {
  const version = '2.1.331';
  const [original] = JSON.parse(read(version, 'cases.json')) as Case[];
  assert.equal(original.phase, 'same-once');
  const view = new MessageDisplay(sessionId);
  view.ingestJsonl(read(version, 'same-once.jsonl'), true, false);
  assert.deepEqual(offered(view), ['Fixture question ccm:after-1']);
  view.setRewindProcess(original.startedAt);
  const earlier = view.getMessages().find(m => m.text === 'Fixture question ccm:base-2')!;
  assert.ok(earlier.rewindUuid);
  view.setRewindProcess(original.startedAt + 60_000);
  assert.deepEqual(offered(view), ['Fixture question ccm:after-1']);
  assert.equal(view.confirmNativeRewind(earlier.text, earlier.rewindUuid), undefined);
  view.setRewindProcess(original.startedAt);
  assert.equal(view.confirmNativeRewind(earlier.text, earlier.rewindUuid), earlier.rewindUuid);
  assert.deepEqual(offered(view), ['Fixture question ccm:base-1']);
});
