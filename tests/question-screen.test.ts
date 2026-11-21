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

// Sampled from Claude Code 2.1.330 with a loopback fake model (synthetic questions).
// 2.1.300 to 2.1.329 draw the same bars (compatibility matrix, question-review-long).
const review330 = (name: string) => readFileSync(new URL(`./fixtures/question-review-2.1.330/${name}.txt`, import.meta.url), 'utf8');
const CLEANUP = '示例相册服务在上午维护时重启了一次，我已经重新提交了缩略图任务。两台测试机（192.0.2.10、192.0.2.11，任务 demo-20260101-abcd）上还在运行的旧版同步脚本 sync_demo.sh（只包括我启动的那些，不包括你自己开的压测进程），能不能由我登录上去停掉？停掉之后我会把没跑完的批次重新排队，等新服务就绪再继续。';
const SPEED = '新版服务比旧版慢了将近一倍，照现在的速度两个批次各要一整天才能处理完全部图片。要不要加机器提速？';
const EXTRAS = '处理完成之后还需要顺手做哪些收尾工作？这些都可以在同一批任务里完成，但每多选一项整体时间大约会增加半小时左右，请按实际需要勾选。';
const LONG_OTHER = '另外把处理日志打包成一个压缩文件发到 ops@example.com，方便以后排查问题时直接下载查看';

test('review page: once a question wraps, every question carries a quote bar (named sessions too)', () => {
  const review = parse(review330('wrapped-named'), { pendingToolUse: true })!;
  assert.equal(review?.kind, 'review');
  assert.deepEqual(review.tabs, [{ label: '旧脚本', answered: true }, { label: '加速', answered: true }]);
  assert.equal(review.activeTab, 2);
  // Wide characters split across lines rejoin without a space; breaks at a space keep one.
  assert.deepEqual(review.review, [{ question: CLEANUP, answer: '可以停 (Recommended)' }, { question: SPEED, answer: '每个批次加一台机器' }]);
  assert.deepEqual(review.options.map(o => [o.number, o.kind, o.label, o.focused]), [[1, 'submit', 'Submit answers', true], [2, 'cancel', 'Cancel', false]]);
  const cancel = parse(review330('wrapped-named-cancel'), { pendingToolUse: true })!;
  assert.deepEqual(cancel.options.map(o => o.focused), [false, true]);
  assert.deepEqual(cancel.review, review.review);
  // 80 columns and a CJK session name: other break points, the same text.
  assert.deepEqual(parse(review330('cjk-name-80'), { pendingToolUse: true })?.review, [{ question: CLEANUP, answer: '可以停 (Recommended)' }, { question: SPEED, answer: '保持现状' }]);
  // A multi-select answer with a long custom entry, on one line and wrapped (no bar, three spaces).
  assert.deepEqual(parse(review330('multi-answer'), { pendingToolUse: true })?.review?.[1], { question: EXTRAS, answer: `生成索引页, 清理临时文件, ${LONG_OTHER}` });
  assert.deepEqual(parse(review330('answer-wrapped'), { pendingToolUse: true })?.review?.[1], { question: EXTRAS, answer: `生成索引页, ${LONG_OTHER}` });
  // Nothing wraps: no bars, as before.
  assert.deepEqual(parse(review330('short-named'), { pendingToolUse: true })?.review, [{ question: 'Which drink should we serve?', answer: 'Tea' }, { question: 'Which snacks should we pack?', answer: 'Fruit' }]);
  // The question page reached with Left from the review rejoins its wrapped title the same way.
  const back = parse(review330('back-to-question'), { pendingToolUse: true })!;
  assert.equal(back.kind, 'question'); assert.equal(back.question, EXTRAS); assert.equal(back.multiSelect, true);
});

test('review page: the partial-answer warning reworded in 2.1.329, styling, and malformed barred reviews', () => {
  const partial = review330('incomplete');
  const incomplete = parse(partial, { pendingToolUse: true })!;
  assert.equal(incomplete?.kind, 'review');
  assert.deepEqual(incomplete.tabs, [{ label: '旧脚本', answered: true }, { label: '加速', answered: false }]);
  assert.deepEqual(incomplete.review, [{ question: CLEANUP, answer: '可以停 (Recommended)' }]);
  // The 2.1.326 wording still parses; an unknown warning does not.
  assert.deepEqual(parse(partial.replace('Some questions are unanswered', 'You have not answered all questions'), { pendingToolUse: true }), incomplete);
  assert.equal(parse(partial.replace('Some questions are unanswered', 'Something else'), { pendingToolUse: true }), undefined);
  for (const name of ['wrapped-named', 'wrapped-named-cancel', 'cjk-name-80', 'multi-answer', 'answer-wrapped', 'incomplete', 'short-named', 'back-to-question']) {
    const frame = review330(name), native = parse(frame, { pendingToolUse: true });
    assert.ok(native, name);
    const styled = frame.split('\n').map(line => '\x1b[0m' + line.replace('❯', '\x1b[31m❯\x1b[39m').replace('│', '\x1b[2m│\x1b[22m') + '   ').join('\n');
    assert.deepEqual(parse(styled + '\n\n', { pendingToolUse: true }), native, `${name} under SGR and tmux padding`);
  }
  const frame = review330('wrapped-named');
  for (const broken of [
    frame.replace(' │ ● 新版服务', ' ● 新版服务'), // bars on some questions only
    frame.replace(' │   我登录上去', '     我登录上去'), // a continuation line lost its bar
    frame.replace('   → 可以停 (Recommended)\n', ''), // a question without an answer
    frame.replace('   → 每个批次加一台机器', ' │ → 每个批次加一台机器'), // a barred answer
    frame.replace('Review your answers\n', 'Review your answers\n\nSome assistant text\n'),
    frame.replace(/\n─+ demo-review ─\n?$/u, '\n❯ Returned composer\n'),
  ]) assert.equal(parse(broken, { pendingToolUse: true }), undefined, broken);
  // Session names wider than ASCII close the dialog too, and nothing else may follow the rule.
  assert.equal(parse(review330('cjk-name-80').trimEnd() + '\nSomething else', { pendingToolUse: true }), undefined);
});

// One question under a reply, sampled from Claude Code 2.1.330 (synthetic text, loopback model).
const single330 = (name: string) => readFileSync(new URL(`./fixtures/question-single-2.1.330/${name}.txt`, import.meta.url), 'utf8');
const ALBUM = '相册页（示例应用用 ImageGrid 组件显示的缩略图墙）在后台补齐元数据时会立刻重新生成缩略图，如果恰好这时滚动就会闪一下、需要等半秒才稳定（不会丢图）。详情页今天已经改成「同一张图还在屏幕上时缩略图不变，只在尺寸变化时重新生成」。相册页要不要也改成这种做法？';
const UNIFY = '改动小：同一张图在屏幕上时缩略图不变，滚动时不会因为补齐元数据而闪烁；尺寸或内容变化时仍然重新生成，画质检查不放松。和 CI 修复一起做，再跑一轮完整 CI。';
const KEEP = '偶尔会闪一下，但逻辑最保守，不再改动。';

test('one wrapped CJK question under a reply: full title and descriptions at 80, 120 and 160 columns', () => {
  for (const name of ['wrapped-named-120', 'wrapped-named-80', 'wrapped-named-160', 'wrapped-unnamed-120', 'no-preamble']) {
    const s = parse(single330(name), { pendingToolUse: true });
    assert.equal(s?.kind, 'question', name);
    assert.deepEqual(s.tabs, [{ label: '方案', answered: false }]);
    assert.equal(s.activeTab, 0); assert.equal(s.multiSelect, false);
    // Breaks between wide characters, beside fullwidth punctuation or at a space rejoin to the original.
    assert.equal(s.question, ALBUM, name);
    assert.deepEqual(s.options.map(o => [o.number, o.kind, o.label, o.description, o.focused]), [
      [1, 'choice', '统一成详情页做法 (Recommended)', UNIFY, true], [2, 'choice', '保持现状', KEEP, false],
      [3, 'other', 'Type something.', undefined, false], [4, 'chat', 'Chat about this', undefined, false]], name);
    assert.deepEqual(s.input, { kind: 'other', number: 3, value: '', focused: false });
    assert.equal(s.footer, 'Enter to select · ↑/↓ to navigate · Esc to cancel');
    const styled = single330(name).split('\n').map(line => '\x1b[0m' + line.replace('❯', '\x1b[36m❯\x1b[39m').replace(/^│/u, '\x1b[2m│\x1b[22m') + '   ').join('\n');
    assert.deepEqual(parse(styled + '\n\n', { pendingToolUse: true }), s, `${name} under SGR and tmux padding`);
  }
  assert.deepEqual(parse(single330('wrapped-named-120-down'), { pendingToolUse: true })?.options.map(o => o.focused), [false, true, false, false]);
  // Reply text above the dialog: only a pending AskUserQuestion on the active branch vouches for it.
  for (const name of ['wrapped-named-120', 'wrapped-named-80', 'wrapped-named-160', 'wrapped-unnamed-120']) assert.equal(parse(single330(name)), undefined, name);
  assert.equal(parse(single330('no-preamble'))?.question, ALBUM);
});

test('one question, other shapes: unwrapped title, single multi-select with wrapped descriptions, previews', () => {
  const short = parse(single330('short-named'), { pendingToolUse: true })!;
  assert.equal(short.question, '相册页要不要也改成详情页的做法？');
  assert.deepEqual(short.options.map(o => o.description), [UNIFY, KEEP, undefined, undefined]);
  const multi = parse(single330('multi-named'), { pendingToolUse: true })!;
  assert.equal(multi.question, '改完之后还需要顺手做哪些收尾工作？这些都可以放在同一批改动里完成，但每多选一项整体时间大约会增加半小时左右，请按实际需要勾选（ImageGrid 和 DetailView 都会受影响）。');
  assert.equal(multi.multiSelect, true);
  assert.deepEqual(multi.tabs, [{ label: '收尾', answered: false }]);
  assert.deepEqual(multi.options.map(o => [o.number, o.kind, o.description ?? null, o.checked ?? null]), [
    [1, 'choice', '为相册页和详情页各加一组截图比对，覆盖滚动、缩放和切换深色模式三种情况，失败时把差异图上传到 CI 产物里方便排查。', false],
    [2, 'choice', '在开发说明里写清楚缩略图何时重新生成。', false], [3, 'other', null, false], [5, 'submit', null, null], [4, 'chat', null, null]]);
  const preview = parse(single330('preview-named'), { pendingToolUse: true })!;
  // "对比（" ends a full row and "ImageGrid" starts the next: no space beside fullwidth punctuation.
  assert.equal(preview.question, '首页相册墙的版式你更喜欢哪一种？左边是按时间排列的瀑布流，右边是按地点分组的网格，两种都已经做好了示例，可以直接对比（ImageGrid 组件同时支持两种布局）。');
  assert.deepEqual(preview.options.map(o => [o.kind, o.label]), [['choice', '瀑布流'], ['choice', '分组网格'], ['chat', 'Chat about this']]);
  assert.equal(preview.preview, '┌──┐┌────┐\n│  ││    │\n└──┘└────┘');
  // Malformed variants still reject.
  const frame = single330('wrapped-named-120');
  for (const broken of [
    frame.replace('│ 组件显示的缩略图墙', '  组件显示的缩略图墙'), // a title line lost its bar
    frame.replace('     。和 CI 修复', '。和 CI 修复'), // a description lost its indent
    frame.replace('  3. Type something.\n', ''),
    frame.replace(/\n─+ Demo 示例开发 ─\n?$/u, '\n❯ Returned composer\n'),
  ]) assert.equal(parse(broken, { pendingToolUse: true }), undefined, broken);
});
