import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Backend, projectSlug } from '../src/backend';
import { HistoryIndexDiskStore } from '../src/backend/history-index-disk-store';
import { type Transport } from '../src/backend/transport';
import { Controller } from '../src/main/controller';
import { WorkspaceStore } from '../src/main/store';
import type { Workspace } from '../src/shared/types';

const posix = {skip:process.platform === 'win32'};
const line = (r:unknown) => JSON.stringify(r)+'\n';
async function fixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(),'lectern 会话 ')));
  const config = join(cwd,'config'), profile = join(cwd,'profile');
  const ws: Workspace = {kind:'ssh',id:'test-history',host:'invalid.example',cwd,claudeDir:config,name:'history'};
  const dirs = [projectSlug(cwd), cwd.replace(/[/.]/g,'-')].map(s=>join(config,'projects',s));
  await Promise.all(dirs.map(d=>mkdir(d,{recursive:true})));
  const backends: Backend[]=[];
  function openBackend() {
    const backend=new Backend({historyIndexStore:new HistoryIndexDiskStore(profile), tmuxSocket:randomUUID(), claudeCommand:'false'});
    backends.push(backend);
    const transport:Transport=(backend as any).transport, run=transport.run.bind(transport), tags:string[]=[];
    // Every command (including poll, discover and proof) runs on the local
    // POSIX fixture. No ssh command or real CLI is invoked.
    transport.run=(w,cmd,opts)=>{ tags.push(opts?.tag??'locate'); return run({...w,kind:'local'},cmd,opts); };
    return {backend,tags};
  }
  const file = (id:string,d=0) => join(dirs[d],id+'.jsonl');
  const record = (sessionId:string,type:string,uuid:string,parentUuid:string|null,content:string) =>
    line({sessionId,cwd,type,uuid,parentUuid,message:{content}});
  const boundary = (sessionId:string,uuid:string,logicalParentUuid:string) => line({sessionId,cwd,type:'system',subtype:'compact_boundary',uuid,parentUuid:null,logicalParentUuid});
  const marker = (sessionId:string,continuedInSessionId:string)=> line({type:'continued-in',sessionId,continuedInSessionId,timestamp:'2026-06-01T00:00:00Z'});
  t.after(async()=>{ await Promise.all(backends.map(b=>b.dispose())); await rm(cwd,{recursive:true,force:true}); });
  return {cwd,ws,profile,file,record,boundary,marker,openBackend};
}

test('continued-in uses the unique matching compact boundary: real paging, projected old turns, tip-only appends and stat-only restart',posix,async t=>{
  const f=await fixture(t), ids=[randomUUID(),randomUUID(),randomUUID()];
  let parent:string|null=null;
  const pre=ids.map((id,i)=>{
    const q=randomUUID(),a=randomUUID();
    const text=f.record(id,'user',q,parent,`提问 ${i}`)+f.record(id,'assistant',a,q,`答复 ${i}`);
    parent=a; return {text,answer:a};
  });
  const cuts=[randomUUID(),randomUUID()];
  const shared=(id:string,i:number)=>f.boundary(id,cuts[i],pre[i].answer);
  function later(i:number) {
    const a=JSON.parse(pre[i].text.split('\n')[0]);
    return pre[i].text.replace(JSON.stringify(a),JSON.stringify({...a,parentUuid:cuts[i-1]}));
  }
  const old=pre[0].text, middle=shared(ids[1],0)+later(1), final=shared(ids[2],1)+later(2);
  const neverCopied=f.record(ids[0],'user',randomUUID(),cuts[0],'仅交接前原始分支含有的提问');
  await writeFile(f.file(ids[0]),old+shared(ids[0],0)+later(1).replaceAll(ids[1],ids[0])+neverCopied+f.marker(ids[0],ids[1]));
  await writeFile(f.file(ids[1]),middle+shared(ids[1],1)+later(2).replaceAll(ids[2],ids[1])+f.marker(ids[1],ids[2]));
  await writeFile(f.file(ids[2]),final);
  const cold=f.openBackend(), d=await cold.backend.discover(f.ws);
  assert.deepEqual(d.sessions.map(s=>s.id),[ids[2]],d.diagnostic);
  assert.equal(d.sessions[0].path,f.file(ids[2]));
  assert.deepEqual(d.sessions[0].historySourceIds,ids.slice(0,2));
  assert.equal(d.sessions[0].historySegmentCount,3);
  const handoff=await cold.backend.readHandoffHistory(f.ws,ids[2],ids[0]);
  assert.ok(handoff.jsonl.toString().includes(neverCopied));
  await assert.rejects(cold.backend.readHandoffHistory(f.ws,ids[2],randomUUID()),/不属于/);
  assert.equal(cold.tags.filter(tag=>tag==='history.physical_proof').length,2);
  const warm=f.openBackend(); await warm.backend.discover(f.ws);
  assert.deepEqual(warm.tags.filter(t=>t.startsWith('history.')),['history.file_stamps']);
  const poll=()=>warm.backend.readSession(f.ws,ids[2],false,[],true);
  const recent=await poll(); assert.equal(recent.jsonl.toString(),final);
  assert.equal(recent.transcriptPosition?.offset,Buffer.byteLength(final));
  const before=await warm.backend.readOlderHistory(f.ws,ids[2],recent.olderCursor!);
  assert.equal(before.jsonl.toString(),middle); assert.equal(before.sourceSessionId,ids[1]);
  const first=await warm.backend.readOlderHistory(f.ws,ids[2],before.olderCursor!);
  assert.equal(first.jsonl.toString(),old); assert.equal(first.sourceSessionId,ids[0]); assert.ok(!first.olderCursor);
  const store=new WorkspaceStore(f.profile); await store.save(f.ws);
  const controller=new Controller(store,warm.backend);
  try {
    let snapshot=await controller.watchSession(f.ws.id,ids[2]);
    while (snapshot.historyPage?.hasOlder) snapshot=await controller.loadEarlierMessages(f.ws.id,ids[2],snapshot.historyPage.cursor);
    assert.deepEqual(snapshot.messages.map(m=>m.text),['提问 0','答复 0','提问 1','答复 1','提问 2','答复 2']);
    assert.deepEqual(snapshot.messages.filter(m=>m.rewindUuid).map(m=>m.text),['提问 2'],'rewind indexes only the actual tip prompt');
    assert.equal(snapshot.sessionId,ids[2]);
  } finally { await controller.detach(); }
  const extra=f.record(ids[2],'user',randomUUID(),pre[2].answer,'新消息'); await appendFile(f.file(ids[2]),extra);
  const appended=await poll(); assert.equal(appended.reset,false); assert.equal(appended.jsonl.toString(),extra);
  // Old source resumed on its own: stale older cursor refuses its changed
  // bytes, rediscovery keeps the source independent of its former successor.
  await appendFile(f.file(ids[0]),f.record(ids[0],'user',randomUUID(),pre[0].answer,'独立恢复'));
  await assert.rejects(warm.backend.readOlderHistory(f.ws,ids[2],before.olderCursor!),/变化/);
  assert.deepEqual((await warm.backend.discover(f.ws)).sessions.map(s=>s.id).sort(),[ids[0],ids[2]].sort());
});

test('aliases choose the complete physical file, including proven differently named copies, but never shared titles, forks or mixed owners',posix,async t=>{
  const f=await fixture(t), id=randomUUID(), copy=randomUUID(), other=randomUUID(), fork=randomUUID();
  const prompt=randomUUID(),answer=randomUUID();
  const short=f.record(id,'user',prompt,null,'同名'), full=short+f.record(id,'assistant',answer,prompt,'较全的副本');
  await writeFile(f.file(id,1),short); await writeFile(f.file(id),full);
  await writeFile(f.file(copy),full); await writeFile(f.file(other),f.record(other,'user',randomUUID(),null,'同名'));
  await writeFile(f.file(fork),short+line({type:'user',cwd:f.cwd,sessionId:fork,uuid:randomUUID(),message:{content:'fork'}}));
  const {backend}=f.openBackend(), result=await backend.discover(f.ws);
  assert.deepEqual(result.sessions.map(s=>s.id).sort(),[id,other,fork].sort(),result.diagnostic);
  assert.equal(result.sessions.find(s=>s.id===id)?.path,f.file(id));
  assert.equal((await backend.readSession(f.ws,id,false,[],true)).jsonl.toString(),full);
  const warm=f.openBackend(); await warm.backend.discover(f.ws); assert.ok(!warm.tags.includes('history.physical_proof'));
  // A longer foreign filename is only adopted if its ENTIRE file has the same
  // native owner; metadata under the filename's own UUID disproves a copy.
  await appendFile(f.file(copy),line({type:'last-prompt',sessionId:copy}));
  assert.ok((await backend.discover(f.ws)).sessions.some(s=>s.id===copy));
  await rm(f.file(copy)); await rm(f.file(id,1)); await link(f.file(id),f.file(id,1));
  assert.equal((await backend.discover(f.ws)).sessions.find(s=>s.id===id)?.path,f.file(id));
});

test('a missing, mismatched, forked or contested continuation keeps native sessions independently addressable',posix,async t=>{
  const f=await fixture(t), from=randomUUID(), other=randomUUID(), to=randomUUID(), parent=randomUUID(), cut=randomUUID();
  const source=(id:string)=>f.record(id,'user',parent,null,'源')+f.boundary(id,cut,parent)+f.marker(id,to);
  // Each successor also has a turn of its own; a file with no conversation at all is not history.
  const own=(id:string,after:string)=>f.record(id,'user',randomUUID(),after,'续写');
  const wrongCut=randomUUID();
  await writeFile(f.file(from),source(from)); await writeFile(f.file(to),f.boundary(to,wrongCut,parent)+own(to,wrongCut));
  const {backend}=f.openBackend(), discover=()=>backend.discover(f.ws);
  assert.equal((await discover()).sessions.length,2);
  await writeFile(f.file(to),f.boundary(to,cut,parent)+own(to,cut)); await writeFile(f.file(other),source(other));
  const disputed=await discover(); assert.equal(disputed.sessions.length,3); assert.match(disputed.diagnostic!,/唯一后继/);
  await rm(f.file(other)); const uuid=randomUUID();
  await appendFile(f.file(to),line({type:'user',sessionId:to,cwd:f.cwd,uuid,forkedFrom:{sessionId:other,messageUuid:uuid},message:{content:'独立分支'}}));
  assert.equal((await discover()).sessions.length,2);
});

test('a resumed copy joins its source: root copies with a marker, markerless boundary copies, and not a source that kept going',posix,async t=>{
  const f=await fixture(t), sub=join(f.cwd,'sub');
  const at=(minute:number)=>new Date(Date.UTC(2026,0,1,0,minute)).toISOString();
  const rec=(sessionId:string,type:string,uuid:string,parentUuid:string|null,content:string,minute:number,cwd=f.cwd)=>
    line({sessionId,cwd,type,uuid,parentUuid,timestamp:at(minute),message:{content,...(type==='assistant' && {stop_reason:'end_turn'})}});
  const cutAt=(sessionId:string,uuid:string,logicalParentUuid:string,cwd=f.cwd)=>
    line({sessionId,cwd,type:'system',subtype:'compact_boundary',uuid,parentUuid:null,logicalParentUuid,timestamp:at(3)});
  // Newer CLIs: the resumed copy repeats everything from the root, and the source names it.
  const [a,b,q,r]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  await writeFile(f.file(a),rec(a,'user',q,null,'根问题',1)+rec(a,'assistant',r,q,'根回答',2)+f.marker(a,b));
  await writeFile(f.file(b),rec(b,'user',q,null,'根问题',1)+rec(b,'assistant',r,q,'根回答',2)+rec(b,'user',randomUUID(),r,'续接后的新问题',10));
  // Older clients: no marker. The source moved into a subdirectory, and its
  // unanswered last prompt was not carried into the copy.
  const [c,d,p1,p2,cut,s1,s2]=Array.from({length:7},()=>randomUUID());
  await writeFile(f.file(c),rec(c,'user',p1,null,'压缩前',1)+rec(c,'assistant',p2,p1,'压缩前回答',2,sub)+cutAt(c,cut,p2,sub)+
    rec(c,'user',s1,cut,'压缩后',4,sub)+rec(c,'assistant',s2,s1,'压缩后回答',5,sub)+rec(c,'user',randomUUID(),s2,'未完成的提问',6,sub));
  await writeFile(f.file(d),cutAt(d,cut,p2)+rec(d,'user',s1,cut,'压缩后',4)+rec(d,'assistant',s2,s1,'压缩后回答',5)+rec(d,'user',randomUUID(),s2,'新的提问',20));
  // Two branches of one prefix, each with its own finished turn: neither hides the other.
  const [e,g,q3,r3,q4,q5]=Array.from({length:6},()=>randomUUID());
  await writeFile(f.file(e),rec(e,'user',q3,null,'分支问题',1)+rec(e,'assistant',r3,q3,'分支回答',2)+rec(e,'user',q4,r3,'源会话继续',15)+rec(e,'assistant',randomUUID(),q4,'源会话的回答',16));
  await writeFile(f.file(g),rec(g,'user',q3,null,'分支问题',1)+rec(g,'assistant',r3,q3,'分支回答',2)+rec(g,'user',q5,r3,'副本自己的问题',10)+rec(g,'assistant',randomUUID(),q5,'副本的回答',11));
  const {backend,tags}=f.openBackend(), found=await backend.discover(f.ws);
  assert.deepEqual(found.sessions.map(s=>s.id).sort(),[b,d,e,g].sort(),String(found.diagnostic));
  assert.deepEqual(found.sessions.find(s=>s.id===b)?.historySourceIds,[a]);
  assert.deepEqual(found.sessions.find(s=>s.id===d)?.historySourceIds,[c]);
  assert.equal(found.diagnostic,undefined);
  const store=new WorkspaceStore(f.profile); await store.save(f.ws);
  const controller=new Controller(store,backend);
  try {
    const all=async(id:string)=>{ let s=await controller.watchSession(f.ws.id,id); while (s.historyPage?.hasOlder) s=await controller.loadEarlierMessages(f.ws.id,id,s.historyPage.cursor); return s.messages.map(m=>m.text); };
    assert.deepEqual(await all(b),['根问题','根回答','续接后的新问题'],'a root copy is shown once');
    assert.deepEqual(await all(d),['压缩前','压缩前回答','压缩后','压缩后回答','新的提问'],'the unfinished prompt stays in the source only');
  } finally { await controller.detach(); }
  // The proofs persist: a restart reuses them without reading transcripts again.
  const proofs=tags.filter(tag=>tag==='history.physical_proof').length; assert.ok(proofs>=3);
  const warm=f.openBackend(); await warm.backend.discover(f.ws);
  assert.ok(!warm.tags.includes('history.physical_proof'));
});

test('history without a conversation is ignored: cost records, a model switch, an unused chat',posix,async t=>{
  const f=await fixture(t), [cost,model,blank,real]=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  await writeFile(f.file(cost),line({type:'cost-state',sessionId:cost,totalCostUSD:0.01}));
  await writeFile(f.file(model),line({type:'user',sessionId:model,cwd:f.cwd,uuid:randomUUID(),parentUuid:null,message:{content:'<command-name>/model</command-name>'}})+
    line({type:'assistant',sessionId:model,cwd:f.cwd,uuid:randomUUID(),parentUuid:null,message:{model:'<synthetic>',content:[{type:'text',text:'Set model to haiku'}]}}));
  await writeFile(f.file(blank),line({type:'custom-title',sessionId:blank,customTitle:'新对话'})+line({type:'permission-mode',sessionId:blank,cwd:f.cwd,permissionMode:'default'}));
  await writeFile(f.file(real),f.record(real,'user',randomUUID(),null,'真正的问题'));
  const {backend}=f.openBackend(), found=await backend.discover(f.ws);
  assert.deepEqual(found.sessions.map(s=>s.id),[real]);
  assert.equal(found.diagnostic,undefined,'no notice about the ignored files');
  const warm=f.openBackend(); assert.deepEqual((await warm.backend.discover(f.ws)).sessions.map(s=>s.id),[real],'the decision survives a restart');
});

test('a local folder keeps its resumed-copy proofs across a restart too',posix,async t=>{
  const f=await fixture(t), ids=[randomUUID(),randomUUID()], ws:Workspace={...f.ws,kind:'local',host:undefined};
  const q=randomUUID(), a=randomUUID(), cut=randomUUID();
  const old=f.record(ids[0],'user',q,null,'提问')+f.record(ids[0],'assistant',a,q,'答复');
  const copy=(id:string)=>f.boundary(id,cut,a)+f.record(id,'user',randomUUID(),cut,'续接后的提问');
  await writeFile(f.file(ids[0]),old+copy(ids[0]).split('\n')[0]+'\n'+f.marker(ids[0],ids[1]));
  await writeFile(f.file(ids[1]),copy(ids[1]));
  const cold=f.openBackend(), d=await cold.backend.discover(ws);
  assert.deepEqual(d.sessions.map(s=>s.id),[ids[1]],d.diagnostic);
  assert.ok(cold.tags.includes('history.physical_proof'));
  // A launch with nothing changed proves nothing again. Titles are read again
  // (the snapshot keeps no prompt text), so they do not turn into placeholders.
  const warm=f.openBackend(), again=await warm.backend.discover(ws);
  assert.deepEqual(again.sessions.map(s=>s.id),[ids[1]]);
  assert.equal(warm.tags.includes('history.physical_proof'),false);
  assert.ok(warm.tags.includes('history.changed_metadata'));
  assert.equal(again.sessions[0].title,d.sessions[0].title);
  assert.doesNotMatch(again.sessions[0].title,/^历史会话/);
});
