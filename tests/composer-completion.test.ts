import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkspaceArtifacts } from '../src/backend/artifacts';
import { ComposerCompletions } from '../src/backend/composer-completions';
import { commandInvocation, Transport, type CommandOptions } from '../src/backend/transport';
import type { CompletionItem, Workspace } from '../src/shared/types';
import { applyCompletion, completionAction, completionAt } from '../src/renderer/completion-input';

const posixOnly = { skip: process.platform === 'win32' };
test('endpoint catalog, file boundaries and real local cancellation in an isolated profile', posixOnly, async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'lectern-completion-')));
  const config = join(temp, 'target config'), ws: Workspace = { id: 'local', name: 'Test', kind: 'local', cwd: join(temp, '工程', '子项目') };
  const root = dirname(ws.cwd), marker = join(temp, 'executed'), home = join(temp, 'home');
  const saveEnv = new Map<string,string|undefined>();
  for (const [k,v] of Object.entries({ HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PLUGIN_CACHE_DIR: join(config, 'plugin store') })) { saveEnv.set(k,process.env[k]); process.env[k] = v; }
  const transport = new Transport();
  t.after(async () => { await transport.dispose(); for (const [k,v] of saveEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(temp, { recursive: true, force: true }); });
  const write = async (p: string, s = '') => { await mkdir(dirname(p), { recursive: true }); await writeFile(p,s); };
  const pluginRoot = join(config, 'plugin store');
  const external = join(temp, "installed 'bundle"), cached = join(pluginRoot, 'cache','market','stale','old');
  await write(join(config, 'skills','old-name','SKILL.md'), `---\nname: "个人工具"\n---\n!\`touch ${marker}\`\n`);
  await write(join(config, 'skills','internal','SKILL.md'), '---\nuser-invocable: false\n---\n');
  await write(join(temp, 'linked skill','SKILL.md')); await symlink(join(temp,'linked skill'), join(config,'skills','linked'));
  await write(join(root,'.git','HEAD')); await write(join(root,'.claude','commands','team','发布.md'), `---\nname: does-not-rename-legacy-commands\n---\n!\`touch ${marker}\``);
  await write(join(ws.cwd,'.claude','skills','bundle','.claude-plugin','plugin.json'),JSON.stringify({name:'project-tools'}));
  await write(join(ws.cwd,'.claude','skills','bundle','skills','trace','SKILL.md'));
  await write(join(ws.cwd,'.agents','skills','linked-project','SKILL.md'));
  await symlink('../../.agents/skills/linked-project',join(ws.cwd,'.claude','skills','linked-project'));
  await write(join(ws.cwd,'.claude','skills','local','SKILL.md')); await write(join(ws.cwd,'.claude','settings.local.json'), JSON.stringify({enabledPlugins:{'disabled@market':false}}));
  await write(join(external,'.claude-plugin','plugin.json'), JSON.stringify({ name:'suite', skills:['./more skills'],commands: ['./custom commands'] }));
  await write(join(external,'more skills','reader','SKILL.md')); await write(join(external,'custom commands','qa','check.md'));
  await write(join(external,'commands','not-active.md')); await write(join(cached,'skills','stale','SKILL.md'));
  const disabled = join(pluginRoot,'cache','market','disabled','v1'), other = join(temp,'other');
  await write(join(disabled,'skills','no','SKILL.md')); await write(join(other,'skills','other-project-only','SKILL.md'));
  await write(join(pluginRoot,'installed_plugins.json'), JSON.stringify({version:2,plugins:{
    'suite@market':[{scope:'project',projectPath:root,installPath:external}], 'disabled@market':[{scope:'user',installPath:disabled}],
    'foreign@market':[{scope:'local',projectPath:join(temp,'another'),installPath:other}],
  }}));
  const backend = new ComposerCompletions(transport, new WorkspaceArtifacts(transport));
  const complete = (kind: 'slash'|'mention',prefix: string) => backend.query(ws,'primary','test',{ kind,prefix });
  await t.test('native profile, project ancestors, plugin registry and metadata; no skill execution', async () => {
    for (const expected of ['个人工具','team:发布','local','suite:reader','suite:qa:check','linked','linked-project','project-tools:trace','compact']) assert.ok((await complete('slash',expected)).some(i=>i.value===expected), expected);
    for (const absent of ['internal','not-active','other-project-only','disabled:','stale:']) assert.deepEqual(await complete('slash',absent),[]);
    await assert.rejects(access(marker));
    const override = {...ws,id:'override'};
    const overrideConfig = join(temp,'override'); await write(join(overrideConfig,'commands','override.md'));
    process.env.CLAUDE_CONFIG_DIR = overrideConfig;
    assert.equal((await backend.query(override,'primary','override',{kind:'slash',prefix:'override'}))[0]?.value,'override');
    assert.deepEqual(await backend.query(override,'primary','override-2',{kind:'slash',prefix:'个人工具'}),[]);
    process.env.CLAUDE_CONFIG_DIR = config;
  });
  await t.test('versioned cache and legacy flat installs when no registry exists',async()=>{
    await rm(join(pluginRoot,'installed_plugins.json')); backend.reset();
    await write(join(pluginRoot,'cache','flat','commands','measure.md'));
    assert.equal((await complete('slash','flat:measure'))[0]?.source,'plugin');
    assert.equal((await complete('slash','stale:stale'))[0]?.source,'plugin');
    assert.deepEqual(await complete('slash','disabled:no'),[]);
  });
  await t.test('nested names, Unicode, spaces, literals, private and generated trees, symlink rejection and result cap', async () => {
    const dir = "数据 '集", name = '样例 [一].txt';
    for (const p of [join(dir,name),'.env','node_modules/forbidden','.git/forbidden','sub/.venv/forbidden','sub/deeper/keep.ts','star*.txt']) await write(join(ws.cwd,p));
    for (let i=0;i<70;i++) await write(join(ws.cwd,'many',`item-${i}`));
    await symlink(external,join(ws.cwd,'escape')); await symlink(join(ws.cwd,dir,name),join(ws.cwd,'symlink.txt'));
    assert.deepEqual((await complete('mention','数据')).map(x=>[x.kind,x.value]),[['directory',dir]]);
    assert.equal((await complete('mention',dir+'/样例 ['))[0].value,dir+'/'+name);
    assert.equal((await complete('mention','keep.ts'))[0].value,'sub/deeper/keep.ts');
    assert.deepEqual((await complete('mention','*')).map(i=>i.value),['star*.txt']);
    for (const p of ['/.','../','../../secret','forbidden','escape/','.git/','.env','symlink','~/', '$(touch injected)']) assert.deepEqual(await complete('mention',p),[],p);
    // Dependency trees are listed but only read once the user @s into them; credentials never are.
    assert.deepEqual((await complete('mention','node_modules/')).map(i=>i.value),['node_modules/forbidden']);
    assert.deepEqual((await complete('mention','sub/.venv/')).map(i=>i.value),['sub/.venv/forbidden']);
    assert.equal((await complete('mention','many/item')).length,40); await assert.rejects(access(join(ws.cwd,'injected')));
  });
  await t.test('a canceled transport does not wait for a slow scan', async () => {
    const abort = new AbortController(); const started = Date.now(); const pending = transport.run(ws,'exec sleep 30',{signal:abort.signal});
    setTimeout(()=>abort.abort(),20); await assert.rejects(pending); assert.ok(Date.now()-started < 3000);
  });
});

test('SSH machines receive the POSIX discovery script, using target config rather than desktop home', posixOnly, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'lectern-completion-wire-')));
  const config = join(root, 'config'), cwd = join(root, 'repo'); await mkdir(cwd); await mkdir(join(config,'commands'),{recursive:true}); await writeFile(join(config,'commands','from-target.md'),'');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const privateValue = 'never-send-private-setting';
  await writeFile(join(config,'settings.json'),JSON.stringify({env:{SAMPLE:privateValue}, enabledPlugins:{'active@market':true}}));
  // Execute the actual OpenSSH stdin envelope without contacting a real machine.
  class Endpoint extends Transport {
    override async run(ws: Workspace, script: string, options: CommandOptions = {}) {
      // The second machine exercises the core-Perl JSON fallback for systems without jq.
      const cmd = commandInvocation(ws,ws.host==='no-jq' ? script.replace('if command -v jq', 'if false && command -v jq') : script); assert.equal(cmd.file,'ssh');
      const body = String(cmd.input);
      const { stdout,stderr } = await promisify(execFile)('/bin/sh',['-c',body],{env:{PATH:'/usr/bin:/bin',HOME:root,CLAUDE_CONFIG_DIR:config},signal:options.signal});
      if (script.includes('record_json settings')) {
        const fields = stdout.split('\0'); const i=fields.indexOf('settings'); assert.notEqual(i,-1);
        assert.deepEqual(JSON.parse(Buffer.from(fields[i+2],'base64').toString()),{enabledPlugins:{'active@market':true}});
      }
      return { stdout:Buffer.from(stdout),stderr };
    }
  }
  const wire = new Endpoint(), service = new ComposerCompletions(wire,new WorkspaceArtifacts(wire));
  for (const host of ['isolated','no-jq']) assert.equal((await service.query({id:host,name:host,kind:'ssh',cwd,host},'primary','wire',{kind:'slash',prefix:'from-target'}))[0].value,'from-target');
});

test('usable built-ins remain available on a failing endpoint; common commands come first', async () => {
  class Offline extends Transport { override async run(): Promise<never> {throw new Error('offline');} }
  const wire = new Offline(), service = new ComposerCompletions(wire,new WorkspaceArtifacts(wire));
  const ws: Workspace={id:'ws',name:'ws',kind:'local',cwd:'/unused'};
  const results=await service.query(ws,'primary','fail',{kind:'slash',prefix:''});
  assert.deepEqual(results.slice(0,3).map(i=>i.value),['compact','context','model']);
  assert.equal(results.some(i=>i.value==='help'||i.value==='clear'),false,'interactive built-ins are not offered');
});

test('supersession and explicit cancel are scoped to a split and request ID', async () => {
  const calls: { signal: AbortSignal; done: (v:CompletionItem[])=>void }[] = [];
  const backend = new ComposerCompletions(new Transport(),{ complete: (_w,_q,signal)=>new Promise(resolve=>calls.push({signal,done:resolve})) });
  const workspace: Workspace = {id:'ws',name:'ws',kind:'local',cwd:'/unused'};
  const query = (r: string, view: 'primary'|'secondary'='primary')=>backend.query(workspace,view,r,{kind:'mention',prefix:'x'});
  const first=query('first'), split=query('split','secondary'), second=query('second');
  assert.ok(calls[0].signal.aborted); backend.cancel('primary','first'); assert.ok(!calls[1].signal.aborted && !calls[2].signal.aborted);
  backend.cancel('secondary','split'); assert.ok(calls[1].signal.aborted);
  const item: CompletionItem = {kind:'file',source:'workspace',value:'x'};
  calls.forEach(c=>c.done([item])); assert.deepEqual(await Promise.all([first,split,second]),[[],[],[item]]);
  await assert.rejects(backend.query(workspace,'primary','bad!',{kind:'mention',prefix:'x'}));
});

test('cursor-local tokens, literal paths, quoted directories, remainder and keyboard/IME', () => {
  const file: CompletionItem={value:'文 档/a.txt',kind:'file',source:'workspace'};
  const text='😀 看 @old.txt 然后继续\nnext';
  const at=completionAt(text,text.indexOf('ld'))!;
  assert.equal(at.prefix,'o'); const next=applyCompletion(text,at,file); assert.equal(next.text,'😀 看 @"文 档/a.txt" 然后继续\nnext');
  const quoted='请看 @"文 档/a.txt" later'; assert.equal(completionAt(quoted,quoted.indexOf('a.txt'))?.prefix,'文 档/');
  const dir=applyCompletion('@a',completionAt('@a',2)!,{...file,kind:'directory',value:'文 档'});
  assert.equal(completionAt(dir.text,dir.caret)?.prefix,'文 档/');
  assert.equal(applyCompletion('/co，继续',completionAt('/co，继续',3)!,{kind:'command',source:'builtin',value:'compact'}).text,'/compact ，继续');
  assert.equal(completionAt('输入。@读',5)?.prefix,'读');
  assert.equal(completionAt('hello /foo',10),undefined); assert.equal(completionAt('a@example.com',13),undefined); assert.equal(completionAt('@foo',2,3),undefined);
  assert.equal(applyCompletion('/co check',completionAt('/co check',3)!,{kind:'command',source:'builtin',value:'compact'}).text,'/compact check');
  assert.deepEqual(completionAction({key:'ArrowUp'},3,0,false,true),{type:'move',index:2});
  assert.deepEqual(completionAction({key:'ArrowDown'},3,2,false,true),{type:'move',index:0});
  for(const key of ['Enter','Tab']) assert.deepEqual(completionAction({key},3,1,false,true),{type:'accept',index:1});
  assert.deepEqual(completionAction({key:'Process',code:'NumpadEnter'},3,1,false,true),{type:'accept',index:1});
  assert.deepEqual(completionAction({key:'Escape'},0,0,false,true),{type:'close'});
  assert.deepEqual(completionAction({key:'Enter'},3,0,true,true),{type:'ime'});
  assert.equal(completionAction({key:'Enter',shiftKey:true},3,0,false,true),undefined);
});
