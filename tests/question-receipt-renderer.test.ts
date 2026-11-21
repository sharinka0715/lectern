import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { summarizeActivities, toolActivity, toolDisplayState } from '../src/renderer/reply-activities';
import type { ToolBlock } from '../src/shared/types';

const { scenarios } = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/question-2.1.326.json', import.meta.url), 'utf8'));
function tool(key: string): ToolBlock {
  const r = scenarios[key].outcome[0];
  return {id:r.tool_use_id, name:'AskUserQuestion', input:'{}', result:r.content, isError:r.is_error === true};
}

test('display native discussion and stop receipts as user choices without rewriting stored results', () => {
  const chat = tool('chat'), cancel = tool('cancel'), success = tool('preview');
  assert.equal(toolDisplayState(chat), 'discussion');
  assert.equal(toolDisplayState(cancel), 'cancelled');
  assert.equal(toolDisplayState(success), 'completed');
  assert.match(success.result!, /notes: 少糖 不加冰/);
  const genuine = {...chat,result:'Something went wrong'};
  const rows = [chat, cancel, success, genuine, {...genuine, isError:false,result:undefined}].map(toolActivity);
  assert.equal(summarizeActivities(rows).failed, 1);
  assert.equal(summarizeActivities(rows).pending, 1);
  assert.equal(chat.isError, true);
  assert.equal(cancel.isError, true);
  assert.equal(chat.result, scenarios.chat.outcome[0].content);
});

test('do not treat lookalike tool names, quoted answers, or arbitrary rejections as these decisions', () => {
  const chat = tool('chat'), cancel = tool('cancel');
  assert.equal(toolDisplayState({...chat, name:'mcp__custom__AskUserQuestion'}), 'error');
  assert.equal(toolDisplayState({...chat, result:`Other answer: ${chat.result}`}), 'error');
  assert.equal(toolDisplayState({...cancel, result:cancel.result + ' Unexpected error.'}), 'error');
  assert.equal(toolDisplayState({...chat,isError:false}), 'completed');
});
