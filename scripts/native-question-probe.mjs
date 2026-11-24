// node scripts/native-question-probe.mjs [--write-fixtures]
// Stock Claude Code and tmux. No model service, saved user account, or existing project.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile), version = '2.1.326', followUp = 'Question probe follow-up.';
const introduction = 'Let us choose a drink before packing.';
function stream(res, model, block, seq, preamble) {
  const tool = block.type === 'tool_use';
  res.writeHead(200, {'content-type':'text/event-stream'});
  function send(type, fields = {}) { res.write(`event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`); }
  send('message_start',{message:{id:`msg_fixture_${seq}`,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:0}}});
  let index = 0;
  if (tool && preamble) {
    send('content_block_start',{index,content_block:{type:'text',text:''}});
    send('content_block_delta',{index,delta:{type:'text_delta',text:preamble}});
    send('content_block_stop',{index}); index++;
  }
  send('content_block_start',{index,content_block:tool ? {...block,input:{}} : {type:'text',text:''}});
  send('content_block_delta',{index,delta:tool ? {type:'input_json_delta',partial_json:JSON.stringify(block.input)} : {type:'text_delta',text:block.text}});
  send('content_block_stop',{index});
  send('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5}});
  send('message_stop'); res.end();
}

/** Does not launch Electron, CLI, or tmux. Pass only the returned env to their processes.
 * Queue a fixed question immediately before sending the associated user turn. */
export async function createQuestionProbe() {
  const root = await realpath(await mkdtemp('/tmp/t-q-'));
  const home = path.join(root, 'home'), config = path.join(root, 'config'), cwd = path.join(root, 'work');
  const env = { PATH:process.env.PATH, HOME:home, SHELL:'/bin/sh', LANG:'en_US.UTF-8', TERM:'xterm-256color',
    CLAUDE_CONFIG_DIR:config, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', DISABLE_AUTOUPDATER:'1',
    ANTHROPIC_API_KEY:'question-fixture', NO_PROXY:'127.0.0.1,localhost', HTTP_PROXY:'http://127.0.0.1:1', HTTPS_PROXY:'http://127.0.0.1:1' };
  let nextBlock, nextPreamble, seq = 0;
  const server = createServer(async (req,res) => {
    if (req.method !== 'POST' || new URL(req.url,'http://localhost').pathname !== '/v1/messages') return res.writeHead(404).end();
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const tool = body.tools?.some(t=>t.name==='AskUserQuestion' || t.tools?.some(x=>x.name==='AskUserQuestion'));
      const block = tool && nextBlock ? nextBlock : {type:'text',text:followUp};
      const preamble = block===nextBlock ? nextPreamble : undefined;
      if (block===nextBlock) { nextBlock=undefined; nextPreamble=undefined; }
      stream(res,body.model,block,++seq,preamble);
    } catch { res.writeHead(400).end(); }
  });
  let privateServer;
  async function close() {
    privateServer?.kill();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
  try {
    for (const d of [home,config,cwd]) await mkdir(d,{mode:0o700});
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    privateServer = createPrivateTmux(root, { env });
    assert.match((await run('claude',['--version'],{env,cwd})).stdout.trim(),/^2\.1\.326\b/);
    await writeFile(path.join(config,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,lastOnboardingVersion:version,theme:'dark',projects:{[cwd]:{hasTrustDialogAccepted:true}},customApiKeyResponses:{approved:[env.ANTHROPIC_API_KEY]}}));
    const tmux = (...args) => run('tmux', privateServer.args('-f', '/dev/null', ...args), { env: privateServer.env, cwd });
    return {root,home,config,cwd,env:privateServer.env,close,tmux,queueQuestion(questions,id='toolu_question_'+randomUUID(),preamble) {
      assert.ok(!nextBlock,'another fixture question is already queued');
      nextPreamble = preamble;
      nextBlock = {type:'tool_use',id,name:'AskUserQuestion',input:{questions}};
      return id;
    }};
  } catch (error) { await close(); throw error; }
}

const base = { header: 'Drink', question: 'Which drink should we serve?', multiSelect: false, options: [
  { label: 'Tea', description: 'A warm infusion.' }, { label: 'Juice', description: 'A cold drink.' },
] };
const extra = { header: 'Snacks', question: 'Which snacks should we pack?', multiSelect: true, options: [
  { label: 'Fruit', description: 'Fresh fruit.' }, { label: 'Bread', description: 'Fresh bread.' },
] };
const preview = { header:'会场 布置', question:'接待区的设计方案，你更喜欢哪一种？', multiSelect:false, options:[
  {label:'茶歇 区',description:'第一种方案。',preview:'木桌\n  [茶具]'}, {label:'点心 区',description:'第二种方案。',preview:'陈列架\n  [点心]'},
]};
async function probe(write) {
  const fixture = await createQuestionProbe();
  const {cwd,config} = fixture;
  const tmux = async (...args) => (await fixture.tmux(...args)).stdout;
  const recorded = {}; let pane, current;
  const screen = () => tmux('capture-pane','-p','-J','-t',pane);
  async function wait(predicate,label) {
    let value;
    for (let i=0;i<100;i++) { value=await screen(); if(predicate(value)) return value; await delay(100); }
    throw new Error(`Timed out: ${label}\n${value}`);
  }
  async function capture(name) {
    const full = await screen();
    const lines = full.trimEnd().split('\n').map(line=>line.trimEnd());
    // Only the active widget (or the successor composer), never the welcome banner or a path.
    const start = lines.findIndex(line=>/^─{20,}$/.test(line));
    assert.ok(start>=0);
    const result = lines.slice(start).join('\n'); current.screens[name] = result;
    if (process.env.PRINT_QUESTION_FRAMES) console.log(`FRAME ${name}\n${result}`);
    return result;
  }
  async function key(...keys) {
    for (const k of keys) { current.keys.push(k); await tmux('send-keys','-t',pane,k); await delay(180); }
  }
  async function text(value) {
    current.keys.push({text:value}); await tmux('send-keys','-t',pane,'-l','--',value); await delay(180);
  }
  async function scenario(name, questions, width, drive, check, preamble) {
    const id = randomUUID(), toolId = fixture.queueQuestion(questions,`toolu_question_${name}`,preamble);
    current = recorded[name] = {width,keys:[],screens:{}};
    pane = (await tmux('new-session','-d','-P','-F','#{pane_id}','-x',String(width),'-y','42','-s','probe_'+name,'-c',cwd,
      'claude','--strict-mcp-config','--permission-mode','default','--model','claude-opus-5-5','--session-id',id,'Run the question probe.')).trim();
    await wait(s=>s.includes(questions[0].question) && s.includes('Esc'),name);
    const file = path.join(config,'projects',cwd.replace(/[^a-zA-Z0-9]/g,'-'),`${id}.jsonl`);
    const pid = (await tmux('display-message','-p','-t',pane,'#{pane_pid}')).trim();
    const rows = async () => (await readFile(file,'utf8')).trimEnd().split('\n').map(x=>JSON.parse(x));
    await delay(400);
    const registration = JSON.parse(await readFile(path.join(config,'sessions',pid+'.json'),'utf8'));
    const before = await rows(); current.pending = {toolUse:before.some(r=>Array.isArray(r.message?.content)&&r.message.content.some(b=>b.id===toolId)),status:registration.status,waitingFor:registration.waitingFor??null};
    assert.deepEqual(current.pending,{toolUse:true,status:'waiting',waitingFor:'input needed'});
    await drive();
    await wait(s=>!s.includes('Enter to select') && !s.includes('Ready to submit your answers?'),name+' closed');
    let outcome;
    for(let i=0;i<60;i++) {
      outcome = (await rows()).flatMap(row => { const content=row.message?.content;
        if (content==='Could you compare the drinks?') return [{role:'user',text:content}];
        return !Array.isArray(content) ? [] : content.flatMap(b=>b.type==='tool_result' && b.tool_use_id===toolId
          ? [{...b,nativeResult:row.toolUseResult}] : b.type==='text' && b.text===followUp ? [{role:'assistant',text:followUp}] : []); });
      if (outcome.length && (outcome[0].nativeResult==='User rejected tool use' || outcome.filter(x=>x.role==='assistant').length >= (name==='chat'?2:1))) break;
      await delay(100);
    }
    current.outcome = outcome;
    check(outcome[0],outcome);
    console.log(`PASS ${name}: ${Object.keys(current.screens).length} frames, ${outcome.length} outcome records`);
    await tmux('kill-session','-t','probe_'+name);
  }
  const answers = (q,value) => result=>assert.equal(result.nativeResult.answers[q.question],value);
  const cancelled = result=>{assert.equal(result.is_error,true); assert.equal(result.nativeResult,'User rejected tool use');};
  try {
    await scenario('single',[base],120,async()=>{await capture('start'); await key('Tab'); assert.equal(await capture('afterTab'),current.screens.start); await key('Down','Enter');},answers(base,'Juice'));
    await scenario('other',[base],80,async()=>{await key('Down','Down'); await capture('focus'); await text('Herbal water'); await capture('text'); await key('End','C-u'); await capture('cleared'); await text('Lemon water'); await key('Enter');},answers(base,'Lemon water'));
    await scenario('preview',[preview],80,async()=>{await capture('start'); await key('Down','n'); await capture('edit'); await text('中文 初稿'); await capture('draft'); await key('End','C-u'); await capture('cleared'); await text('少糖 不加冰'); await capture('text'); await key('Enter');},result=>{
      answers(preview,'点心 区')(result);assert.deepEqual(result.nativeResult.annotations[preview.question],{preview:preview.options[1].preview,notes:'少糖 不加冰'});
    });
    await scenario('multi',[extra],120,async()=>{await capture('start'); await key('Space','Down','Space','Down'); await capture('other'); await text('Crackers'); await capture('custom'); await key('Enter'); await capture('afterEnter'); await key('Enter','Down'); await capture('submit'); await key('Down'); await capture('chat'); await key('Up','Enter'); await capture('review'); await key('Enter');},answers(extra,'Fruit, Bread, Crackers'));
    await scenario('mixed',[base,extra],80,async()=>{await capture('start'); await key('Right','Right'); await capture('incomplete'); await key('Left','Left','Enter'); await capture('second'); await key('Space','Right'); await capture('review'); await key('Enter');},result=>{answers(base,'Tea')(result);answers(extra,'Fruit')(result);});
    await scenario('chat',[base],120,async()=>{await key('Down','Down','Down'); await capture('focus'); await key('Enter'); await wait(s=>s.includes(followUp),'clarification successor'); await capture('composer'); await text('Could you compare the drinks?'); await key('Enter');},(result,outcome)=>{
      assert.equal(result.is_error,true); assert.match(result.content,/The user wants to clarify these questions/);assert.deepEqual(outcome.slice(1).map(x=>x.role),['assistant','user','assistant']);
    });
    await scenario('cancel',[base],80,async()=>{await capture('start'); await key('Escape');},cancelled);
    const partial = {...preview,options:[preview.options[0],{label:'室外',description:'无预览。'}]};
    await scenario('partialPreview',[partial,base],80,async()=>{await capture('first'); await key('n'); await text('保留 备注'); await key('Left','Escape'); await capture('saved'); await key('Down'); await capture('without'); await key('Up'); await capture('back'); await key('Down','Down'); await capture('chat'); await key('Up','Enter'); await capture('second'); await key('Enter'); await capture('review'); await key('Down'); await capture('cancel'); await key('Enter');},cancelled);
    await scenario('multiWithPreviews',[{...extra,options:extra.options.map((option,i)=>({...option,preview:'Example '+i}))},base],120,async()=>{await capture('start'); await key('Space','Down','Down','Down'); await capture('next'); await key('Enter'); await capture('second'); await key('Enter','Enter');},result=>{answers(base,'Tea')(result);answers(extra,'Fruit')(result);});
    await scenario('incompleteSubmit',[base,extra],80,async()=>{await key('Enter','Right'); await capture('partial'); await key('Enter');},result=>{assert.equal(result.nativeResult.answers[base.question],'Tea');assert.ok(!(extra.question in result.nativeResult.answers));});
    await scenario('emptyNext',[extra,base],120,async()=>{await key('Down','Down','Down'); await capture('emptyNext'); await key('Enter'); await capture('after'); await key('Escape');},cancelled);
    await scenario('skipAll',[base,extra],80,async()=>{await key('Right','Right'); await capture('empty'); await key('Enter');},result=>assert.deepEqual(result.nativeResult.answers,{}));
    await scenario('cancelOther',[base],80,async()=>{await key('Down','Down');await text('With lemon');await capture('editing');await key('Escape');},cancelled);
    await scenario('previewTabs',[partial,base],80,async()=>{await capture('first');await key('Right');await capture('right');await key('Left');await capture('left');await key('Tab');await capture('tab');await key('BTab');await capture('backtab');await key('Escape');},cancelled);
    await scenario('preamble',[base],120,async()=>{
      const full = (await screen()).replaceAll(cwd,'/tmp/question-probe/work').split('\n').map(l=>l.trimEnd()).join('\n');
      assert.ok(full.includes(introduction));current.viewport = full;
      current.ansiViewport = (await tmux('capture-pane','-p','-J','-e','-t',pane)).replaceAll(cwd,'/tmp/question-probe/work');
      await capture('question');await key('Enter');
    },answers(base,'Tea'),introduction);
    await scenario('revisit',[base,extra],80,async()=>{await key('Down','Enter','Left');await capture('answered');await key('Down','Down');await capture('chat');await key('Escape');},cancelled);
    await scenario('revisitOther',[base,extra],80,async()=>{await key('Down','Down');await text('茉莉 冷茶');await key('Enter','Left');await capture('answered');await key('Escape');},cancelled);
    await scenario('notesWithoutPreview',[partial],80,async()=>{await key('Down','n');await text('靠窗');await capture('editing');await key('Enter');},result=>{answers(partial,'室外')(result);assert.equal(result.nativeResult.annotations[partial.question]?.notes,'靠窗');});
    await scenario('multiOtherOnly',[extra],80,async()=>{
      await key('Down','Down'); await text('饼干'); await capture('first');
      await key('End','C-u'); await capture('cleared'); await text('薄荷 糖'); await capture('replaced');
      await key('Down','Enter'); await capture('review'); await key('Enter');
    },answers(extra,'薄荷 糖'));
    if(write) await writeFile(new URL('../tests/fixtures/native-contracts/question-2.1.326.json',import.meta.url),JSON.stringify({version,scenarios:recorded},null,2)+'\n');
  } finally { await fixture.close(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) await probe(process.argv.includes('--write-fixtures'));
