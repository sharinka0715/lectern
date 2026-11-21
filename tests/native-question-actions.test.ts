import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { performQuestionAction, QuestionInputUnconfirmed, type QuestionDriver, type QuestionKey } from '../src/backend/native-question-actions';
import { parseQuestionScreen } from '../src/core/question-screen';
import { NavigationKeyNotSent } from '../src/backend/native-settings';
import type { QuestionAction } from '../src/shared/question-action';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/question-2.1.326.json', import.meta.url), 'utf8')).scenarios as Record<string, {screens: Record<string,string>; ansiViewport?: string}>;
const s = (name: string, screen: string) => fixtures[name].screens[screen];
const single = s('single','start'), other = s('other','focus'), custom = s('other','text');
const juice = single.replace('❯ 1. Tea', '  1. Tea').replace('  2. Juice', '❯ 2. Juice');
const chat = s('chat','composer');
const parsed = (view: string) => { const screen = parseQuestionScreen(view); assert.ok(screen, view); return screen; };
type Write = QuestionKey | {paste: string};
function drive(initial: string, script: [Write, string][]) {
  const state = { viewport: initial, paneId: '%4', panePid: 81, nativeStatus: 'waiting', nativeWaitingFor: 'input needed' };
  const sent: Write[] = [];
  const send = async (input: Write) => {
    sent.push(input);
    const step = script[sent.length - 1];
    assert.ok(step, `unexpected input ${JSON.stringify(input)}`); assert.deepEqual(input, step[0]); state.viewport = step[1];
  };
  const driver: QuestionDriver = { frame: async () => ({ ...state }), questionKey: send, pasteQuestion: text => send({paste:text}) };
  const act = (action: QuestionAction, expected = parsed(initial), check = () => {}) => performQuestionAction(driver, '%4', 81, expected, action, check);
  return { sent, driver, act, state };
}

test('single-select walks exact adjacent rows, ignores stale repaints, and submits only once', async () => {
  const d = drive(single, [['Down',juice],['Enter',chat]]);
  let stale = 2;
  d.driver.frame = async () => ({...d.state, viewport: d.sent.length === 1 && stale-- > 0 ? single : d.state.viewport});
  await d.act({ kind:'activate', number:2 });
  await assert.rejects(d.act({kind:'activate',number:2}), /已变化/);
  assert.deepEqual(d.sent, ['Down','Enter']);
});

test('Other can be focused, edited/read back, replaced and cleared without Enter; activation is separate', async () => {
  let d = drive(single, [['Down',juice],['Down',other]]);
  await d.act({kind:'focus',number:3}); assert.deepEqual(d.sent, ['Down','Down']);
  d = drive(other, [[{paste:'Herbal water'},custom]]);
  await d.act({kind:'text',text:'Herbal water'});
  d = drive(custom, [['End',custom],['C-u',other],[{paste:'梅子水'},custom.replace('Herbal water','梅子水')]]);
  await d.act({kind:'text',text:'梅子水'}); assert.deepEqual(d.sent,['End','C-u',{paste:'梅子水'}]);
  d = drive(custom, [['End',custom],['C-u',other]]); await d.act({kind:'text',text:''});
  d = drive(custom, [['Enter',chat]]); await d.act({kind:'activate',number:3});
});

test('preview/Notes uses n only on the requested choice; Escape leaves editing and retains notes', async () => {
  const start = s('preview','start'), edit = s('preview','edit'), draft = s('preview','draft'), saved = s('preview','text');
  const resting = edit.replace('Add notes on this design…','press n to add notes').replace(' · ctrl+g to edit in VS Code ·\nEsc',' · Esc');
  let d = drive(start, [['Down',resting],['n',edit]]);
  await d.act({kind:'amend',number:2}); assert.deepEqual(d.sent,['Down','n']);
  d = drive(draft, [['End',draft],['C-u',edit],[{paste:'少糖 不加冰'},saved]]);
  await d.act({kind:'text',text:'少糖 不加冰'});
  const ended = saved.replace(' · ctrl+g to edit in VS Code ·\nEsc',' · Esc');
  d = drive(saved, [['Escape',ended]]); await d.act({kind:'cancel'});
  d = drive(saved, [['Enter',chat]]); await d.act({kind:'activate',number:2});
  d = drive(saved, []); await assert.rejects(d.act({kind:'focus',number:1}),/不支持/);
  await assert.rejects(d.act({kind:'next'}), /不支持/); assert.deepEqual(d.sent,[]);
});

test('focus can change preview (including absent preview) but cannot change per-question notes', async () => {
  const before = s('partialPreview','saved'), after = s('partialPreview','without'), chatFocus = s('partialPreview','chat');
  let d = drive(before,[['Down',after],['Down',chatFocus],['Enter',chat]]);
  await d.act({kind:'activate',number:3}); assert.deepEqual(d.sent,['Down','Down','Enter']);
  d = drive(before,[['Down',after.replace('保留 备注','unrelated notes')]]);
  await assert.rejects(d.act({kind:'activate',number:2}),QuestionInputUnconfirmed); assert.deepEqual(d.sent,['Down']);
});

test('the only multi-select answer may be replaced, clearing and restoring its checked row and answered tab', async () => {
  const first = s('multiOtherOnly','first'), cleared = s('multiOtherOnly','cleared'), replaced = s('multiOtherOnly','replaced');
  const d = drive(first,[['End',first],['C-u',cleared],[{paste:'薄荷 糖'},replaced]]);
  await d.act({kind:'text',text:'薄荷 糖'}); assert.deepEqual(d.sent,['End','C-u',{paste:'薄荷 糖'}]);
});

test('plain multi-select toggles, handles Other differently, and separates opening Review from final approval', async () => {
  const start = s('multi','start');
  const checked = start.replace('☐ Snacks','☒ Snacks').replace('[ ] Fruit','[✔] Fruit');
  let d = drive(start,[['Space',checked]]); await d.act({kind:'activate',number:1});
  d = drive(s('multi','other'),[[{paste:'Crackers'},s('multi','custom')]]); await d.act({kind:'text',text:'Crackers'});
  d = drive(s('multi','custom'),[['Enter',s('multi','afterEnter')]]); await d.act({kind:'activate',number:3});
  // Unnumbered Submit is above Chat (native row 4) in navigation order.
  d = drive(s('multi','chat'),[['Up',s('multi','submit')],['Enter',s('multi','review')]]);
  await d.act({kind:'activate',number:5}); assert.deepEqual(d.sent,['Up','Enter']);
  d = drive(s('multi','review'),[['Enter',chat]]); await d.act({kind:'activate',number:1});
});

test('question navigation, skipping an empty Next, partial review, cancel and clarification are explicit', async () => {
  let d = drive(s('mixed','start'),[['Enter',s('mixed','second')]]); await d.act({kind:'activate',number:1});
  d = drive(s('emptyNext','emptyNext'),[['Enter',s('emptyNext','after')]]); await d.act({kind:'activate',number:5});
  d = drive(s('multi','start'),[['Right',s('mixed','incomplete').replace('☐ Drink  ☐ Snacks','☐ Snacks')]]); await d.act({kind:'next'});
  d = drive(s('mixed','incomplete'),[['Left',s('mixed','second').replace('☒ Drink','☐ Drink')]]); await d.act({kind:'previous'});
  d = drive(s('previewTabs','first'),[['Right',s('previewTabs','right')]]); await d.act({kind:'next'});
  d = drive(s('previewTabs','right'),[['Left',s('previewTabs','left')]]); await d.act({kind:'previous'});
  d = drive(s('incompleteSubmit','partial'),[['Enter',chat]]); await d.act({kind:'activate',number:1});
  d = drive(s('skipAll','empty'),[['Enter',chat]]); await d.act({kind:'activate',number:1});
  d = drive(s('cancelOther','editing'),[['Escape',chat]]); await d.act({kind:'cancel'});
  d = drive(s('partialPreview','review'),[['Down',s('partialPreview','cancel')],['Enter',chat]]); await d.act({kind:'activate',number:2});
  d = drive(single,[['Escape',chat]]); await d.act({kind:'cancel'});
  d = drive(s('chat','focus'),[['Enter',chat]]); await d.act({kind:'activate',number:4});
});

test('a captured assistant preamble is actionable only with corroborated pending tool and native wait state', async () => {
  const viewport = fixtures.preamble.ansiViewport!;
  const d = drive(viewport,[['Escape',chat]]);
  const expected = parsed(s('preamble','question'));
  assert.equal(parseQuestionScreen(viewport), undefined);
  await d.act({kind:'cancel'},expected);
  d.state.viewport = viewport; d.state.nativeStatus = 'idle';
  await assert.rejects(d.act({kind:'cancel'},expected),/已变化/); assert.deepEqual(d.sent,['Escape']);
});

test('rejects stale snapshots, unknown rows/actions, mismatched process, wait status or ownership before sending', async () => {
  const d = drive(single,[]);
  for (const expected of [juice, single.replace('A warm infusion.','Another description.'), single.replace('Which drink','Which food')]) {
    await assert.rejects(d.act({kind:'activate',number:1},parsed(expected)),/已变化/);
  }
  for (const action of [{kind:'activate',number:0},{kind:'activate',number:'1'},{kind:'focus',number:NaN},
    {kind:'amend',number:1},{kind:'activate',number:3},{kind:'bogus'},null] as unknown as QuestionAction[]) {
    await assert.rejects(d.act(action));
  }
  await assert.rejects(d.act({kind:'text',text:'do not send'}),/已变化/);
  await assert.rejects(d.act({kind:'focus',number:1},parsed(single),() => {throw Error('token expired');}),/token expired/);
  for (const overrides of [{panePid:92},{paneId:'%8'},{nativeStatus:'busy'},{nativeStatus:'idle'},{nativeStatus:'shell'},{nativeWaitingFor:'permission'}]) {
    const altered = drive(single,[]); Object.assign(altered.state,overrides); await assert.rejects(altered.act({kind:'cancel'}),/已变化/);
  }
  assert.deepEqual(d.sent,[]);
});

test('invalid text and control sequences never reach the native editor; losing the editor never falls through to chat', async () => {
  const d = drive(other,[]);
  for (const text of ['x\ny','\r','x\t','x\x1b[201~','\x7f','\u0085',' ',' x','x ','x'.repeat(4097),42]) {
    await assert.rejects(d.act({kind:'text',text} as QuestionAction),/4096/);
  }
  d.state.viewport = chat; await assert.rejects(d.act({kind:'text',text:'/model'}),/已变化/); assert.deepEqual(d.sent,[]);
  const replaced = drive(custom,[['End',custom],['C-u',chat]]);
  await assert.rejects(replaced.act({kind:'text',text:'never paste here'}),QuestionInputUnconfirmed);
  assert.deepEqual(replaced.sent,['End','C-u']);
});

test('rejects unproven intermediate, including skipped row, changed answer, timeout or switching panes mid-action', async () => {
  for (const view of [other,juice.replace('Juice','Milk'),chat,s('multi','start')]) {
    const d = drive(single,[['Down',view]]);
    await assert.rejects(d.act({kind:'activate',number:2}),QuestionInputUnconfirmed); assert.deepEqual(d.sent,['Down']);
  }
  const d = drive(single,[['Down',juice]]); d.driver.frame = async () => ({...d.state,panePid:d.sent.length ? 82 : 81});
  await assert.rejects(d.act({kind:'activate',number:2}),QuestionInputUnconfirmed); assert.deepEqual(d.sent,['Down']);
  const expired = drive(single,[['Down',juice]]);
  await assert.rejects(expired.act({kind:'activate',number:2},parsed(single),()=>{if(expired.sent.length) throw Error('superseded');}),QuestionInputUnconfirmed);
  assert.deepEqual(expired.sent,['Down']);
  const stuck = drive(single,[['Enter',single]]);
  await assert.rejects(stuck.act({kind:'activate',number:1}),QuestionInputUnconfirmed); assert.deepEqual(stuck.sent,['Enter']);
});

test('after a submit, transport failure or an unknown non-composer is not reported as successful, nor retried', async () => {
  const d = drive(single,[]); let count = 0;
  d.driver.questionKey = async () => { ++count; throw Error('transport closed after dispatch'); };
  await assert.rejects(d.act({kind:'activate',number:1}),QuestionInputUnconfirmed); assert.equal(count,1);
  const refused = drive(single,[]);
  refused.driver.questionKey = async () => { throw new NavigationKeyNotSent(); };
  await assert.rejects(refused.act({kind:'activate',number:1}), NavigationKeyNotSent);
  const redraw = drive(single,[['Enter',chat]]);
  let attempts = 0;
  const send = redraw.driver.questionKey;
  redraw.driver.questionKey = async key => {
    if (++attempts === 1) throw new NavigationKeyNotSent();
    await send(key);
  };
  await redraw.act({kind:'activate',number:1}); assert.deepEqual(redraw.sent,['Enter']);
  const moved = drive(single,[]);
  moved.driver.questionKey = async () => { moved.state.viewport = other; throw new NavigationKeyNotSent(); };
  await assert.rejects(moved.act({kind:'activate',number:1}), /已变化/);
  const replaced = drive(single,[['Enter','Do you trust this directory?\n❯ 1. Yes']]);
  await assert.rejects(replaced.act({kind:'activate',number:1}),QuestionInputUnconfirmed); assert.deepEqual(replaced.sent,['Enter']);
});

test('the barred review of long questions submits, cancels, and goes back to change answers', async () => {
  const f = (name: string) => readFileSync(new URL(`./fixtures/question-review-2.1.330/${name}.txt`, import.meta.url), 'utf8');
  const review = f('wrapped-named'), composer = f('after-submit');
  let d = drive(review, [['Enter', composer]]);
  await d.act({kind:'activate', number:1}); assert.deepEqual(d.sent, ['Enter']);
  d = drive(review, [['Down', f('wrapped-named-cancel')], ['Enter', composer]]);
  await d.act({kind:'activate', number:2}); assert.deepEqual(d.sent, ['Down', 'Enter']);
  d = drive(review, [['Escape', composer]]); await d.act({kind:'cancel'});
  // Left returns to the last question page (multi-select, wrapped title) without changing any answer.
  d = drive(f('multi-answer'), [['Left', f('back-to-question')]]); await d.act({kind:'previous'});
  d = drive(f('multi-answer'), []); await assert.rejects(d.act({kind:'next'}), /不支持/);
  // A page whose answered marker changed is not accepted as the result of Left.
  d = drive(f('multi-answer'), [['Left', f('back-to-question').replace('☒ 附加项', '☐ 附加项')]]);
  await assert.rejects(d.act({kind:'previous'}));
});
