import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseQuestionScreen as parse } from '../src/core/question-screen';

type Scenario = {width:number; screens: Record<string,string>; viewport?:string; ansiViewport?:string};
const {scenarios} = JSON.parse(readFileSync(new URL('./fixtures/native-contracts/question-2.1.326.json',import.meta.url),'utf8')) as {scenarios:Record<string,Scenario>};
const shot = (scenario:string,name:string) => { const value = scenarios[scenario].screens[name]; assert.ok(value); return value; };

test('all recorded active screens are fully identifiable in plain text and under SGR',()=>{
  for (const [scenario,{screens}] of Object.entries(scenarios)) for (const [name,frame] of Object.entries(screens)) {
    const native = parse(frame);
    if (name==='composer') {assert.equal(native,undefined);continue;}
    assert.ok(native,`${scenario}/${name}`);
    assert.equal(native.options.filter(o=>o.focused).length,1);
    assert.equal(new Set(native.options.map(o=>o.number)).size,native.options.length);
    const styled = frame.split('\n').map(line=>'\x1b[0m'+line.replace('❯','\x1b[31m❯\x1b[39m')+'   ').join('\n');
    assert.deepEqual(parse(styled+'\n\n'),native,`${scenario}/${name} ANSI and tmux padding`);
  }
});
test('single choice and editable Other are structurally separate',()=>{
  const single = parse(shot('single','start'))!;
  assert.equal(single.question,'Which drink should we serve?');
  assert.deepEqual(single.tabs,[{label:'Drink',answered:false}]);
  assert.equal(single.activeTab,0); assert.equal(single.multiSelect,false);
  assert.deepEqual(single.options.map(o=>[o.kind,o.number,o.label,o.description,o.focused]),[
    ['choice',1,'Tea','A warm infusion.',true],['choice',2,'Juice','A cold drink.',false],
    ['other',3,'Type something.',undefined,false],['chat',4,'Chat about this',undefined,false],
  ]);
  assert.equal(single.canAmend,undefined);
  const other = parse(shot('other','text'))!;
  assert.deepEqual(other.input,{kind:'other',number:3,value:'Herbal water',focused:true});
  assert.equal(parse(shot('other','cleared'))!.input?.value,'');
  // A genuine model option can be named exactly like the native placeholder.
  assert.equal(parse(shot('single','start').replace('1. Tea','1. Type something.'))!.options[0].kind,'choice');
});
test('a revisited single answer uses a suffix checkmark, including on Other',()=>{
  const choice=parse(shot('revisit','answered'))!.options[1];
  assert.equal(choice.label,'Juice'); assert.equal(choice.checked,true);
  const page=parse(shot('revisitOther','answered'))!;
  assert.deepEqual(page.input,{kind:'other',number:3,focused:false,value:'茉莉 冷茶'});
  assert.equal(page.options[2].checked,true);
});
test('multi-select keeps marks, navigation order, and unnumbered intermediate actions',()=>{
  const s = parse(shot('multi','submit'))!;
  assert.equal(s.multiSelect,true);assert.deepEqual(s.tabs,[{label:'Snacks',answered:true}]);
  assert.deepEqual(s.options.map(o=>[o.number,o.kind,o.focused,o.checked]),[
    [1,'choice',false,true],[2,'choice',false,true],[3,'other',false,true],[5,'submit',true,undefined],[4,'chat',false,undefined],
  ]);
  assert.deepEqual(s.input,{kind:'other',number:3,value:'Crackers',focused:false});
  assert.equal(parse(shot('multi','afterEnter'))!.options[2].checked,false);
  assert.equal(parse(shot('multiWithPreviews','next'))!.options.find(o=>o.focused)?.kind,'next');
  assert.equal(parse(shot('multiWithPreviews','start'))!.preview,undefined);
});
test('Chinese preview and notes preserve alignment and text; saved notes are not an active editor',()=>{
  const start = parse(shot('preview','start'))!;
  assert.deepEqual(start.tabs,[{label:'会场 布置',answered:false}]);
  assert.equal(start.preview,'木桌\n  [茶具]'); assert.equal(start.canAmend,true);
  assert.deepEqual(start.options.map(o=>o.kind),['choice','choice','chat']);
  assert.deepEqual(parse(shot('preview','edit'))!.input,{kind:'notes',number:2,value:'',focused:true});
  const edited = parse(shot('preview','text'))!;
  assert.equal(edited.preview,'陈列架\n  [点心]');assert.equal(edited.options[1].label,'点心 区');
  assert.deepEqual(edited.input,{kind:'notes',number:2,value:'少糖 不加冰',focused:true});
  assert.deepEqual(parse(shot('partialPreview','saved'))!.input,{kind:'notes',number:1,value:'保留 备注',focused:false});
  assert.equal(parse(shot('partialPreview','without'))!.preview,undefined);
  const chat = parse(shot('partialPreview','chat'))!;
  assert.equal(chat.options.find(o=>o.focused)?.kind,'chat');assert.equal(chat.canAmend,false);
});
test('only review has a verifiable current multi-question tab in text-only captures',()=>{
  assert.equal(parse(shot('mixed','second'))!.activeTab,undefined);
  const s = parse(shot('mixed','review'))!;
  assert.equal(s.kind,'review'); assert.equal(s.activeTab,2); assert.equal(s.footer,'');
  assert.deepEqual(s.tabs,[{label:'Drink',answered:true},{label:'Snacks',answered:true}]);
  assert.deepEqual(s.review,[{question:'Which drink should we serve?',answer:'Tea'},{question:'Which snacks should we pack?',answer:'Fruit'}]);
  assert.deepEqual(parse(shot('mixed','incomplete'))!.review,[]);
  assert.equal(parse(shot('partialPreview','cancel'))!.options.find(o=>o.focused)?.kind,'cancel');
});
test('uncropped native preamble requires corroboration; even then no open fences or stale dialogs',()=>{
  const full=scenarios.preamble.viewport!;
  assert.ok(full.includes('⏺ Let us choose a drink before packing.'));
  assert.equal(parse(full),undefined);
  const expected=parse(shot('preamble','question'));
  assert.deepEqual(parse(full,{pendingToolUse:true}),expected);
  assert.deepEqual(parse(scenarios.preamble.ansiViewport!,{pendingToolUse:true}),expected);
  assert.equal(parse(full.replace('⏺ Let us choose a drink before packing.','⏺ Example\n```text'),{pendingToolUse:true}),undefined);
  assert.equal(parse(full+'\n❯ Returned composer',{pendingToolUse:true}),undefined);
});
test('rejects partial, stale, transcript, generic approval and malformed frames',()=>{
  const s = shot('single','start');
  for(const frame of [s.slice(s.indexOf('Which drink')), s.replace('Enter to select','Enter to confirm'),
    s.replace('4. Chat about this','5. Chat about this'), s.replace('2. Juice','1. Juice'),s.replace('  2. Juice','❯ 2. Juice'),
    s.replace('❯ 1.','  1.'),s.replace('  3. Type something.\n',''),s+'\n❯ New composer',
    '⏺ Example chooser follows\n'+s,'```text\n'+s,s.replace('Esc to cancel',''),
    shot('mixed','review').replace('   → Fruit',''),shot('mixed','review')+'\n❯ ',
    '❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel',
  ]) assert.equal(parse(frame),undefined,frame);
});

test('Claude Code 2.1.329: a wrapped question carries a quote bar, a named session a closing rule', () => {
  const screen = (name: string) => readFileSync(new URL(`./fixtures/question-2.1.329/${name}.txt`, import.meta.url), 'utf8');
  const wrapped = parse(screen('wrapped-named'), { pendingToolUse: true })!;
  assert.equal(wrapped?.kind, 'question');
  assert.deepEqual(wrapped.tabs, [{ label: '代码与图源', answered: false }]);
  assert.equal(wrapped.question, '示例项目里的实验脚本（scripts/*.py、baselines、analysis 代码）和配图源码 figures/（模板、出图脚本、素材，含上周的数据图草稿）怎么处理？日志、缓存和临时目录已经删了。');
  assert.deepEqual(wrapped.options.map(o => [o.number, o.kind, o.label, o.focused]), [
    [1, 'choice', '留代码，删中间产物 (Recommended)', true], [2, 'choice', '只留结果，代码也删', false],
    [3, 'choice', '代码和 figures 原样保留', false], [4, 'other', 'Type something.', false], [5, 'chat', 'Chat about this', false]]);
  assert.match(wrapped.options[0].description!, /^保留 scripts\/\*\.py.*可重新生成。$/);
  assert.equal(wrapped.multiSelect, false);
  assert.deepEqual(parse(screen('wrapped-named-down'), { pendingToolUse: true })!.options.map(o => o.focused), [false, true, false, false, false]);
  const short = parse(screen('short'), { pendingToolUse: true })!;
  assert.equal(short.question, 'Which drink should we serve?');
  assert.deepEqual(short.options.map(o => o.label), ['Tea', 'Juice', 'Type something.', 'Chat about this']);
  // Only a closing rule with a name goes; any other line below the footer still rejects.
  assert.equal(parse(screen('short').trimEnd() + '\nSomething else', { pendingToolUse: true }), undefined);
});

test('Claude Code 2.1.329: the review page no longer asks "Ready to submit your answers?"', () => {
  // Sampled by the compatibility matrix (scripts/cc-matrix) from a fake-model session.
  const screen = readFileSync(new URL('./fixtures/question-2.1.329/review.txt', import.meta.url), 'utf8');
  const review = parse(screen, { pendingToolUse: true })!;
  assert.equal(review?.kind, 'review');
  assert.deepEqual(review.tabs, [{ label: 'Drink', answered: true }, { label: 'Snacks', answered: true }]);
  assert.deepEqual(review.review, [{ question: 'Which drink should we serve?', answer: 'Tea' }, { question: 'Which snacks should we pack?', answer: 'Fruit, Bread' }]);
  assert.deepEqual(review.options.map(o => [o.number, o.kind, o.focused]), [[1, 'submit', true], [2, 'cancel', false]]);
  // The earlier layout with the question still parses; a missing answer still rejects.
  const older = screen.replace('\n❯ 1. Submit answers', '\nReady to submit your answers?\n\n❯ 1. Submit answers');
  assert.deepEqual(parse(older, { pendingToolUse: true })?.review, review.review);
  assert.equal(parse(screen.replace('   → Tea\n', ''), { pendingToolUse: true }), undefined);
  assert.equal(parse(screen.replace('  2. Cancel', '  2. Cancel\n  3. Something else'), { pendingToolUse: true }), undefined);
});
