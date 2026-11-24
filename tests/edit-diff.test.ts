import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageDisplay } from '../src/core/message-display';
import { editPatch } from '../src/shared/edit-patch';
const hunk={oldStart:11,oldLines:2,newStart:11,newLines:2,lines:[' context','- before','+ after']};
const edit={type:'assistant',uuid:'a',sessionId:'s',message:{id:'msg',stop_reason:'tool_use',content:[{type:'tool_use',id:'edit-id',name:'Edit',input:{file_path:'draft.txt',old_string:'before',new_string:'after'}}]}};
const result={type:'user',uuid:'b',parentUuid:'a',sessionId:'s',toolUseResult:{filePath:'draft.txt',originalFile:'PRIVATE ORIGINAL TEXT',structuredPatch:[hunk]},message:{content:[{type:'tool_result',tool_use_id:'edit-id',content:'Updated'}]}};
test('edit tool receives its actual approved patch without exposing the entire original file',()=>{
  const display=new MessageDisplay('s');display.ingestJsonl(JSON.stringify(edit)+'\n');
  assert.equal(display.getMessages()[0].tools[0].editPatch,undefined);
  display.ingestJsonl(JSON.stringify(result)+'\n');const messages=display.getMessages();
  assert.deepEqual(messages[0].tools[0].editPatch,[hunk]);assert.ok(!JSON.stringify(messages).includes('PRIVATE ORIGINAL TEXT'));
});
test('unscoped, ambiguous and failed result patches are not attributed to an edit',()=>{
  assert.equal(editPatch([{...hunk,oldStart:-1}]),undefined);
  for(const blocks of [[{...result.message.content[0],is_error:true}],[...result.message.content,{...result.message.content[0],tool_use_id:'another-id'}]]){
    const display=new MessageDisplay('s');display.ingestJsonl([edit,{...result,message:{content:blocks}}].map(x=>JSON.stringify(x)).join('\n')+'\n');
    assert.equal(display.getMessages()[0].tools[0].editPatch,undefined);
  }
});
test('NotebookEdit projects only the cell texts identified by the result', () => {
  const display = new MessageDisplay('s');
  const notebook = { ...edit, message: { ...edit.message, content: [{ type: 'tool_use', id: 'edit-id', name: 'NotebookEdit', input: { notebook_path: 'notes.ipynb', cell_id: 'summary', new_source: 'new text' } }] } };
  const response = { ...result, toolUseResult: { notebook_path: 'notes.ipynb', old_source: 'old text', new_source: 'new text', original_file: 'other cell private content' } };
  display.ingestJsonl([notebook, response].map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(display.getMessages()[0].tools[0].cellEdit, { before: 'old text', after: 'new text' });
  assert.ok(!JSON.stringify(display.getMessages()).includes('other cell private content'));
});

test('native background completion and tool references stay with the human turn, including an authorization error', () => {
  const display = new MessageDisplay('s');
  const text = '<task-notification>\n<summary>Search completed.</summary>\n<result>Authorization timed out.</result>\n</task-notification>';
  const human = { type: 'user', uuid: 'human', message: { role: 'user', content: 'Find this fixture' } };
  const use = { ...edit, parentUuid: 'human', message: { ...edit.message, content: [{ type: 'tool_use', id: 'search', name: 'ToolSearch', input: {} }] } };
  const toolResult = { ...result, toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: 'search', content: [{ type: 'tool_reference', tool_name: 'fixture__search' }] }] } };
  const notification = { type: 'user', uuid: 'notice', parentUuid: 'b', origin: { kind: 'task-notification' }, message: { role: 'user', content: text } };
  const response = { type: 'assistant', uuid: 'answer', parentUuid: 'notice', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Authorization timed out.' }] } };
  const log = [human, use, toolResult, notification, response].map(row => JSON.stringify(row)).join('\n') + '\n';
  display.ingestJsonl(log);
  display.ingestJsonl(log);
  const messages = display.getMessages();
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant']);
  assert.equal(messages[1].tools[0].result, 'fixture__search');
  assert.deepEqual(messages[1].taskNotifications, [{ id: 'notice', text: 'Search completed.\n\nAuthorization timed out.', textOffset: 0, toolsBefore: 1 }]);
  display.ingestJsonl(JSON.stringify({ ...notification, uuid: 'quoted', parentUuid: 'answer', origin: undefined }) + '\n');
  assert.equal(display.getMessages().filter(m => m.role === 'user').at(-1)?.text, text);
});
