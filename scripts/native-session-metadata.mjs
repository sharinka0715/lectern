// Opt-in real SSH test. Uses one request in an existing test-owned Sonnet/Haiku session.
import assert from 'node:assert/strict';
import { _electron } from 'playwright';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const usage = 'Usage: node scripts/native-session-metadata.mjs <native-manual report.json> <native-ssh-tools report.json> [--recover]';
const paths = process.argv.slice(2).filter(arg => arg !== '--recover');
assert.equal(paths.length, 2, usage);
async function loadReport(file, suite) {
  const absolute = path.resolve(file);
  const relative = path.relative(path.resolve('test-results'), absolute).split(path.sep).join('/');
  assert.match(relative, new RegExp(`^${suite}-\\d+/report\\.json$`), usage);
  const report = JSON.parse(await readFile(absolute, 'utf8'));
  assert.match(report.sessionId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  return report;
}
const source = await loadReport(paths[0], 'native-manual');
const history = await loadReport(paths[1], 'native-ssh-tools');
assert.match(source.host, /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/);
assert.equal(history.host, source.host, 'Use two test reports from the same SSH machine');
assert.match(source.cwd, /^\/tmp\/lectern-manual-[A-Za-z0-9]+$/);
assert.match(history.cwd, /^\/tmp\/lectern-tools-[A-Za-z0-9]+$/);
assert.notEqual(history.sessionId, source.sessionId);
assert.ok(source.transcriptPath?.startsWith('/') && source.transcriptPath.endsWith(`/${source.sessionId}.jsonl`));
const recover = process.argv.includes('--recover');
const root = path.resolve('test-results',`native-session-metadata-${Date.now()}`);
await mkdir(root,{recursive:true});
const report={success:false,root,sessionId:source.sessionId,requests:0,recovery:recover,checks:[]};
const env={...process.env,LECTERN_LOCALE:'zh-CN',LECTERN_USER_DATA:path.join(root,'profile'),LECTERN_LOG_DIR:path.join(root,'diagnostics'),LECTERN_DIAGNOSTIC_CONTENT:'1'};
delete env.ELECTRON_RUN_AS_NODE; delete env.LECTERN_DEV_URL;
const exec=promisify(execFile),q=value=>`'${value.replace(/'/g,`'"'"'`)}'`;
const remote=async cmd=>(await exec('ssh',['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10',source.host,`sh -c ${q(cmd)}`],{timeout:30000,maxBuffer:4*1024*1024})).stdout;
const workspace={id:'native-metadata',name:'SSH · 状态初始化测试',kind:'ssh',host:source.host,cwd:source.cwd};
const other={id:'metadata-history',name:'工具历史（不启动）',kind:'ssh',host:source.host,cwd:history.cwd};
const otherSid=history.sessionId;
let app,page;
try {
  report.originalPanes=await remote("tmux list-panes -a -F '#{pane_id}|#{@lectern_session_id}|#{pane_current_command}'");
  app=await _electron.launch({args:['.'],env}); page=await app.firstWindow();page.setDefaultTimeout(60000);
  await page.waitForFunction(()=>!!window.desktop);
  await page.evaluate(async ({workspace,other})=>{await window.desktop.saveWorkspace(workspace);await window.desktop.saveWorkspace(other);},{workspace,other});
  await page.reload();await page.waitForFunction(()=>!!window.desktop);
  await page.evaluate(()=>{window.__snapshots=[];window.desktop.onSnapshot(s=>{window.__snapshot=s;window.__snapshots.push(s);});});
  await page.waitForFunction(sid=>window.__snapshot?.sessionId===sid&&window.__snapshot.settings?.initialization==='ready'&&!window.__snapshot.settingBusy&&['idle','error'].includes(window.__snapshot.navigationStatus),source.sessionId);
  const initial=await page.evaluate(()=>window.__snapshot);
  assert.ok(initial.paneId,'Only attach an already-live test-owned pane');
  const model=initial.settings.menus.model.options.find(o=>o.current),effort=initial.settings.menus.effort.options.find(o=>o.current);
  assert.ok(model&&(recover?/^(?:Sonnet|Haiku)\b/i:/^Sonnet\b/i).test(model.label),'Do not send a request unless native initialization observed an explicitly allowed model');
  assert.ok(effort);assert.ok(initial.contextUsage?.totalInputTokens>0);assert.ok(initial.executionMode);
  assert.match(await page.locator('[data-setting-kind="model"]').innerText(),new RegExp(model.label));
  assert.equal(await page.locator('[data-context-input-tokens]').getAttribute('data-context-input-tokens'),String(initial.contextUsage.totalInputTokens));
  report.initial={paneId:initial.paneId,model:model.label,effort:effort.label,mode:initial.executionMode,context:initial.contextUsage,messages:initial.messages.length};
  report.checks.push('automatic-native-model-and-effort','footer-mode-observed','historical-last-request-input');
  await page.screenshot({path:path.join(root,'auto-initialized.png')});
  const folder=page.locator(`.workspace-row[data-workspace-id="${other.id}"] .workspace-select`);
  if(await folder.getAttribute('aria-expanded')!=='true')await folder.click();
  await page.locator(`.session-row[data-session-id="${otherSid}"]`).click();
  await page.waitForFunction(id=>window.__snapshot?.sessionId===id&&window.__snapshot.status==='idle'&&!window.__snapshot.paneId,otherSid);
  assert.equal(await page.evaluate(()=>window.__snapshot.settings),undefined,'History-only sessions must not send menu commands');
  await page.locator(`.session-row[data-session-id="${source.sessionId}"]`).click();
  await page.waitForFunction(id=>window.__snapshot?.sessionId===id&&window.__snapshot.settings?.initialization==='ready'&&!window.__snapshot.settingBusy,source.sessionId);
  const cached=await page.evaluate(()=>window.__snapshot.settings);
  assert.equal(cached.menus.model.token,initial.settings.menus.model.token);
  assert.equal(cached.menus.effort.token,initial.settings.menus.effort.token);
  await page.locator('[data-setting-kind="model"]').click();
  await page.locator('[data-setting-menu="model"]').waitFor();
  await page.keyboard.press('Escape');
  report.checks.push('reselect-reuses-cache','inactive-history-no-initialization','fresh-cached-dropdown');
  if(recover&&!/^Haiku\b/i.test(model.label)){
    const haiku=cached.menus.model.options.find(o=>/^Haiku\b/i.test(o.label));assert.ok(haiku,'Recovery may select only the observed Haiku option');
    await page.evaluate(({id,sid,token,option})=>window.desktop.setSessionSetting(id,sid,token,option),{id:workspace.id,sid:source.sessionId,token:cached.menus.model.token,option:haiku.id});
    await page.waitForFunction(()=>window.__snapshot?.settings?.initialization==='ready'&&!window.__snapshot.settingBusy&&window.__snapshot.status==='idle');
    const changed=await page.evaluate(()=>window.__snapshot.settings);
    assert.match(changed.menus.model.options.find(o=>o.current)?.label||'',/^Haiku\b/i);
    assert.notEqual(changed.menus.effort.token,cached.menus.effort.token,'Model changes require a fresh effort observation');
    report.checks.push('observed-haiku-recovery','model-change-refreshes-effort');
  }else if(recover){
    report.checks.push('native-initialization-confirms-previous-haiku-selection');
  }
  const prompt=recover?'周末朋友来家里喝茶，我只有茶杯、一个托盘和纸巾。怎样布置得整洁又方便？请给三条简短建议，不使用工具，也不要读取文件。':'今晚下班后我想花十分钟整理书桌，但很容易越收越乱。请给我一个三步的小流程，每步一句话。不使用工具，不读取或修改文件。';
  await page.getByRole('textbox',{name:'发送给 Claude 的消息'}).fill(prompt);
  await page.getByRole('button',{name:'发送消息',exact:true}).click();report.requests++;
  await page.waitForFunction(({id,count,previousId})=>window.__snapshot?.sessionId===id&&window.__snapshot.messages.length===count&&window.__snapshot.messages.at(-1).source==='jsonl'&&window.__snapshot.messages.at(-1).status==='complete'&&(window.__snapshot.navigationStatus==='error'||(window.__snapshot.status==='idle'&&window.__snapshot.navigationStatus==='idle'&&window.__snapshot.contextUsage?.messageId!==previousId)),{id:source.sessionId,count:initial.messages.length+2,previousId:initial.contextUsage.messageId});
  const final=await page.evaluate(()=>window.__snapshot);
  report.postRequest={status:final.status,navigationStatus:final.navigationStatus,answer:final.messages.at(-1).text,context:final.contextUsage};
  assert.equal(final.navigationStatus,'idle',`Native request failed: ${final.messages.at(-1).text}`);
  assert.ok(final.contextUsage);assert.notEqual(final.contextUsage.messageId,initial.contextUsage.messageId);
  assert.equal(final.messages.at(-1).tools.length,0);
  const snapshots=await page.evaluate(()=>window.__snapshots);
  const turnStates=snapshots.filter(s=>s.sessionId===source.sessionId&&s.messages.length>initial.messages.length);
  assert.ok(turnStates.some(s=>s.status==='working'&&s.contextUsage?.messageId===initial.contextUsage.messageId));
  assert.ok(turnStates.every(s=>s.contextUsage?.messageId===initial.contextUsage.messageId||s.contextUsage?.messageId===final.contextUsage.messageId),'Only completed request usage is published, not an accumulating stream');
  const raw=await remote(`cat ${q(source.transcriptPath)}`);await writeFile(path.join(root,'remote-transcript.jsonl'),raw);
  const records=raw.trim().split('\n').map(JSON.parse),last=records.filter(r=>r.type==='assistant'&&r.message?.id===final.contextUsage.messageId).at(-1);
  assert.ok(last);const usage=last.message.usage;
  assert.equal(final.contextUsage.totalInputTokens,usage.input_tokens+usage.cache_read_input_tokens+usage.cache_creation_input_tokens);
  assert.equal(final.contextUsage.windowTokens,null);assert.equal(final.contextUsage.usedPercent,null);
  assert.match(last.message.model,recover?/haiku/i:/sonnet/i);assert.doesNotMatch(last.message.model,/opus/i);
  assert.equal(final.messages.length,initial.messages.length+2);
  report.final={model:last.message.model,context:final.contextUsage,mode:final.executionMode,messages:final.messages.length,answer:final.messages.at(-1).text};
  report.checks.push(recover?'one-haiku-request':'one-sonnet-request','completed-turn-usage-updated','raw-jsonl-input-categories-match','no-invented-capacity-or-percentage');
  await page.screenshot({path:path.join(root,'completed-turn-context.png')});
  report.success=true;
}catch(error){report.error=error.stack||String(error);process.exitCode=1;await page?.screenshot({path:path.join(root,'failure.png')}).catch(()=>{});}
finally{
  await app?.close();
  report.finalPanes=await remote("tmux list-panes -a -F '#{pane_id}|#{@lectern_session_id}|#{pane_current_command}'");
  const names=(await readdir(path.join(root,'diagnostics'))).filter(n=>/^events\.\d+\.jsonl$/.test(n));
  const events=(await Promise.all(names.map(n=>readFile(path.join(root,'diagnostics',n),'utf8')))).flatMap(t=>t.trim().split('\n').filter(Boolean).map(JSON.parse));
  report.nativeMenuReads=events.filter(e=>e.event==='settings.get.start'&&e.context?.sessionId===source.sessionId).map(e=>e.context.kind??e.data.kind);
  if(report.success){
    try{assert.deepEqual(report.nativeMenuReads,report.checks.includes('model-change-refreshes-effort')?['model','effort','effort']:['model','effort']);assert.equal(report.finalPanes,report.originalPanes);report.checks.push('exactly-two-native-initialization-reads','original-panes-preserved');}
    catch(error){report.success=false;report.error=error.stack;process.exitCode=1;}
  }
  await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
