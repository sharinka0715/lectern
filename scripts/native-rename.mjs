// Stock Claude Code and tmux with disposable transcripts, account and model endpoint.
// Run with node --import tsx scripts/native-rename.mjs [--ssh].
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { startLoopback, waitUntil as until } from './fixtures/loopback-ssh.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Backend, projectSlug } from '../src/backend/index.ts';
import { isIdleEmptyComposer } from '../src/core/settings-screen.ts';

const exec = promisify(execFile);
const ssh = process.argv.includes('--ssh');
const root = await realpath(await mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 't-ren-')));
const config = path.join(root, 'config'), work = path.join(root, 'work'), home = path.join(root, 'home');
const sockets = path.join(root, 'sockets'), project = path.join(config, 'projects', projectSlug(work));
for (const d of [project, work, home, sockets]) await mkdir(d, {recursive:true, mode:0o700});
const socket = 'ren-' + randomUUID().slice(0,8);
const foreignSocket = 'external-' + randomUUID().slice(0,8);
const version = (await exec('claude',['--version'])).stdout.trim().split(' ')[0];
let modelRequests = 0, daemon, backend;
const model = createServer((req,res) => {
  if (req.url?.startsWith('/v1/messages')) modelRequests++;
  res.writeHead(503).end();
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const env = {
  PATH:process.env.PATH, HOME:home, SHELL:'/bin/sh', LANG:'en_US.UTF-8', TERM:'xterm-256color', TMUX_TMPDIR:sockets,
  CLAUDE_CONFIG_DIR:config, ANTHROPIC_BASE_URL:'http://127.0.0.1:' + model.address().port,
  ANTHROPIC_API_KEY:'rename-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', DISABLE_AUTOUPDATER:'1',
};
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
delete process.env.TMUX; delete process.env.TMUX_PANE;
const opts = {tmuxSocket:socket, claudeArgs:['--bare','--strict-mcp-config','--model','sonnet']};
const workspace = {id:'rename-test',name:'Rename test',cwd:work,kind:ssh?'ssh':'local',...(ssh?{host:'rename-loopback'}:{})};
const records = async file => (await readFile(file,'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
const foreignServer = createPrivateTmux(sockets, { name: foreignSocket, env });
const tmux = (...args) => exec('tmux', foreignServer.args(...args), { env: foreignServer.env });
async function waitForNativeExit(id) {
  const directory=path.join(config,'sessions');
  await until(async()=>{
    for (const entry of await readdir(directory)) {
      if (!/^[1-9]\d*\.json$/.test(entry)) continue;
      let registration;
      try { registration=JSON.parse(await readFile(path.join(directory,entry),'utf8')); }
      catch (error) { if (error.code==='ENOENT') continue; throw error; }
      if (registration.sessionId!==id) continue;
      try { process.kill(registration.pid,0); return false; }
      catch (error) { if (error.code!=='ESRCH') throw error; }
    }
    return true;
  },'Temporary Claude process still owns the history session');
}
async function seed() {
  const id=randomUUID(), user=randomUUID(), file=path.join(project,id+'.jsonl');
  const common={sessionId:id,cwd:work,version,isSidechain:false,userType:'external',timestamp:new Date().toISOString()};
  const rows=[
    {...common,type:'user',uuid:user,parentUuid:null,message:{role:'user',content:'First question from the rename fixture.'}},
    {...common,type:'assistant',uuid:randomUUID(),parentUuid:user,message:{id:'msg_fixture',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[{type:'text',text:'Stored fixture response.'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:20,output_tokens:5}}},
    {type:'ai-title',sessionId:id,aiTitle:'Native automatic fixture title'},
    {type:'custom-title',sessionId:id,customTitle:'Existing native title'},
  ];
  const original=rows.map(row=>JSON.stringify(row)+'\n').join('');
  await writeFile(file,original);
  return {id,file,original};
}
const report={version,transport:workspace.kind,passed:[]};
try {
  await writeFile(path.join(config,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,lastOnboardingVersion:version,
    theme:'dark',projects:{[work]:{hasTrustDialogAccepted:true}},customApiKeyResponses:{approved:['rename-fixture'],rejected:[]}}));
  if (ssh) {
    daemon = await startLoopback({ root, env, alias: workspace.host });
    opts.sshConfigPath = daemon.configPath;
  }
  backend=new Backend(opts);
  const history=await seed();
  const coldTitle="冷历史 ' 双引号 \" $(fixture)";
  const named=await backend.renameSession(workspace,history.id,coldTitle);
  assert.equal(named.title,coldTitle);assert.equal(named.paneId,undefined);
  assert.equal((await records(history.file)).filter(row=>row.type==='custom-title').at(-1).customTitle,coldTitle);
  assert.equal((await records(history.file)).filter(row=>row.type==='user'||row.type==='assistant').length,2);
  await waitForNativeExit(history.id);
  report.passed.push('inactive existing title replaced without a chat turn or remaining Claude process');
  const live=await backend.resumeSession(workspace,history.id);
  const read=()=>backend.readSession(workspace,history.id,true);
  await until(async()=>{const state=await read();return state.active&&isIdleEmptyComposer(state.viewport??'')&&state.nativeStatus==='idle';},'Native TUI did not become idle');
  const liveTitle='活跃恢复后改名';
  const renamed=await backend.renameSession(workspace,history.id,liveTitle);
  assert.equal(renamed.title,liveTitle);assert.equal(renamed.paneId,live.paneId);
  assert.equal((await records(history.file)).filter(row=>row.type==='custom-title').at(-1).customTitle,liveTitle);
  report.passed.push('running TUI renamed in its original pane');
  const view=await read();
  await backend.closeSession(workspace,history.id,live.paneId,view.panePid);
  const closedTitle='退出后的最终标题';
  await backend.renameSession(workspace,history.id,closedTitle);
  await waitForNativeExit(history.id);
  await backend.dispose();backend=new Backend(opts);
  const restored=(await backend.discover(workspace)).sessions.find(row=>row.id===history.id);
  assert.equal(restored.title,closedTitle);assert.equal(restored.paneId,undefined);
  assert.equal((await readFile(history.file,'utf8')).startsWith(history.original),true);
  assert.equal((await records(history.file)).filter(row=>row.type==='assistant').length,1);
  report.passed.push('new backend saw the final native title, original transcript prefix and UUID');
  const external=await seed();
  const foreign=await tmux('-f','/dev/null','new-session','-d','-P','-F','#{pane_pid}','-s','ordinary','-c',work,'claude',...opts.claudeArgs,'--resume',external.id);
  const pid=Number(foreign.stdout.trim());
  await until(async()=>{try{return JSON.parse(await readFile(path.join(config,'sessions',pid+'.json'),'utf8')).sessionId===external.id;}catch{return false;}},'Other terminal did not register its UUID');
  await assert.rejects(backend.renameSession(workspace,external.id,'Would conflict'),/其他 Claude 终端|原终端/);
  assert.equal((await records(external.file)).filter(row=>row.type==='custom-title').at(-1).customTitle,'Existing native title');
  report.passed.push('ordinary terminal on another tmux server retained its session');
  assert.equal(modelRequests,0);
  console.log(JSON.stringify({...report,modelRequests},null,2));
} finally {
  await backend?.dispose();
  foreignServer.killAll();
  daemon?.stop();
  await new Promise(resolve=>model.close(resolve));
  await rm(root,{recursive:true,force:true});
}
