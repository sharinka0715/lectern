import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScenarioIds, selectNativeScenario, validateNativeAnswer } from '../scripts/native-dialogue.mjs';

const answer = (text: string) => ({ role: 'assistant', source: 'jsonl', status: 'complete', text, tools: [] });
const examples = [
  '做一碗番茄鸡蛋盖饭吧。先打散鸡蛋炒熟盛出，再炒软番茄，把鸡蛋倒回去拌匀。将剩米饭充分加热后盖上番茄炒蛋，就能吃了。',
  '不好意思，周六下午我临时有事，咖啡能改到周日上午十点吗？你那时方便吗，我们再一起慢慢聊。',
  '第一步，先把几个杯子送去厨房洗好。第二步，把纸张分类放成两摞。第三步，整理充电线，把常用的留在桌边。',
  '先花半小时听一点轻音乐，顺手做几次轻柔的伸展。然后用剩下的半小时读几页喜欢的书，安静享受雨声。',
];

test('native scripts default to distinct daily conversations and trust rounds rotate deterministically', () => {
  assert.notEqual(selectNativeScenario('native', 0, '').id, selectNativeScenario('settings', 0, '').id);
  assert.notEqual(selectNativeScenario('trust', 0, '').id, selectNativeScenario('trust', 1, '').id);
  assert.equal(selectNativeScenario('native', 0, 'rainy-hour').id, 'rainy-hour');
  assert.throws(() => selectNativeScenario('native', 0, 'unknown'), /Unknown LECTERN_TEST_SCENARIO/);
  assert.throws(() => selectNativeScenario('trust', -1, ''), /nonnegative/);
});

test('each scenario accepts a relevant natural canonical response without tools', () => {
  nativeScenarioIds.forEach((id, index) => {
    const scenario = selectNativeScenario('native', 0, id);
    const validation = validateNativeAnswer(scenario, answer(examples[index]), { status: 'idle' });
    assert.equal(validation.scenarioId, id);
    assert.equal(validation.noToolCalls, true);
    assert.ok(validation.checks.length >= 3);
  });
});

test('length, canned echoes and API errors cannot masquerade as successful native dialogues', () => {
  const scenario = selectNativeScenario('native', 0, 'quick-dinner');
  for (const text of ['', 'LECTERN_NATIVE_OK_中文🧭', scenario.prompt, '这是一段很长但是和所问晚饭完全无关的句子。', 'API Error: 400 Unsupported model\n' + examples[0]]) {
    assert.throws(() => validateNativeAnswer(scenario, answer(text), { status: 'idle' }));
  }
  assert.throws(() => validateNativeAnswer(scenario, { ...answer(examples[0]), tools: [{ name: 'Read' }] }, { status: 'idle' }), /forbids tool/);
  assert.throws(() => validateNativeAnswer(scenario, { ...answer(examples[0]), source: 'preview' }, { status: 'idle' }), /JSONL/);
  assert.throws(() => validateNativeAnswer(scenario, { ...answer(examples[0]), status: 'streaming' }, { status: 'working' }), /completed/);
  assert.throws(() => validateNativeAnswer(scenario, answer(examples[0]), { status: 'error' }), /failed/);
  assert.throws(() => validateNativeAnswer(scenario, answer(examples[0]), { status: 'idle', error: 'SSH failed' }), /No transport/);
});

test('rainy-hour accepts real before/after time blocks without requiring canned transition words', () => {
  const scenario = selectNativeScenario('native', 0, 'rainy-hour');
  const text = '下雨天在家安静待一小时，可以这样安排：\n\n- **前 30 分钟：泡一杯热饮，坐在窗边听雨声**，什么都不用做，让节奏慢下来。\n- **后 30 分钟：选一本书或一段轻音乐，安静地读或听**，手机调成静音放在一旁。\n\n这样既有安静的开头，也有一点点专注的投入，时间刚好过去，不会觉得无聊。';
  assert.equal(validateNativeAnswer(scenario, answer(text), { status: 'idle' }).scenarioId, 'rainy-hour');
  assert.throws(() => validateNativeAnswer(scenario, answer('可以读书或听音乐，前面放着一杯茶。用30分钟做其中一件事就可以。'), { status: 'idle' }), /活动安排顺序/);
});
