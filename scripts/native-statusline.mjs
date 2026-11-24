// Run the real GUI and CLI on a private tmux server with disposable settings.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron } from './fixtures/electron.mjs';
import { startConversation } from './fixtures/sidebar-folders.mjs';

const exec = promisify(execFile);
const root = await realpath(await mkdtemp('/tmp/lectern-line-'));
const config = path.join(root, 'config'), profile = path.join(root, 'profile');
const work = path.join(root, 'managed'), ordinaryWork = path.join(root, 'ordinary');
const reportDir = path.resolve('test-results', 'native-statusline-' + Date.now());
const logs = path.join(reportDir, 'diagnostics');
const account = path.join(root, 'account'), socketDir = path.join(root, 'sockets');
const workspaceId = 'statusline-integration', history = randomUUID();
for (const dir of [work, ordinaryWork, account, config, profile, socketDir, logs]) await mkdir(dir, {recursive:true, mode:0o700});
const original = 'ORDINARY STATUS LINE';
const settings = JSON.stringify({ model: 'sonnet', statusLine: { type: 'command', command: 'cat >/dev/null; printf "ORDINARY STATUS LINE"' } });
const env = {
  PATH: process.env.PATH, HOME: account, CLAUDE_CONFIG_DIR: config, LECTERN_LOCALE: 'zh-CN',
  SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMUX_TMPDIR: socketDir,
  ANTHROPIC_API_KEY: 'local-status-test',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1', DISABLE_AUTOUPDATER:'1',
  LECTERN_USER_DATA: profile, LECTERN_LOG_DIR: logs, LECTERN_DIAGNOSTIC_CONTENT: '1',
};
const tmux = (...args) => exec('tmux', args, { env }).then(result => result.stdout.trimEnd());
async function ordinaryVisible(pane) {
  return (await tmux('capture-pane','-p','-t',pane)).includes(original);
}
async function startOrdinary(name) {
  const pane = await tmux('-f','/dev/null','new-session','-d','-P','-F','#{pane_id}',
    '-x','120','-y','40','-s',name,'-c',ordinaryWork,
    'claude','--strict-mcp-config','--model','sonnet','--session-id',randomUUID());
  for (let i=0; i<55 && !await ordinaryVisible(pane); i++) await delay(300);
  assert.ok(await ordinaryVisible(pane),'ordinary CLI renders the configured marker');
  return pane;
}
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
// Pass --baseline <saved app directory> to measure the old always-read behavior.
// A positional executable still selects a packaged app for the regression test.
const baseline = process.argv[2] === '--baseline';
// --autocomplete [executable] adds a wrapped native suggestion and an explicit
// retry to a separate run, keeping the standard latency measurements comparable.
const autocomplete = process.argv[2] === '--autocomplete';
const report = { success:false, baseline, autocompleteFixture:autocomplete, modelRequests:0, chooser:[] };
const localApi = createServer((req, res) => {
  if (new URL(req.url, 'http://localhost').pathname === '/v1/messages') report.modelRequests++;
  res.writeHead(503).end();
});
let app;
try {
  await new Promise((resolve,reject) => localApi.once('error',reject).listen(0,'127.0.0.1',resolve));
  env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + localApi.address().port;
  await writeFile(path.join(config,'.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true, lastOnboardingVersion:'2.1.326', theme:'dark',
    projects: { [work]:{hasTrustDialogAccepted:true}, [ordinaryWork]:{hasTrustDialogAccepted:true} },
    customApiKeyResponses: {approved:['local-status-test'],rejected:[]},
  }));
  await writeFile(path.join(config,'settings.json'),settings);
  if (autocomplete) {
    const skill = path.join(config, 'skills', 'model-alignment-fixture');
    await mkdir(skill, {recursive:true});
    const description = Array(6).fill('Fixture description wraps across suggestion rows.').join(' ');
    await writeFile(path.join(skill, 'SKILL.md'), [
      '---', 'name: model-alignment-fixture', 'description: ' + description, '---', 'Disposable native chooser fixture.', '',
    ].join('\n'));
  }
  const project = path.join(config,'projects', work.replace(/[^A-Za-z0-9]/g,'-'));
  await mkdir(project,{recursive:true});
  const userId = randomUUID(), common = {sessionId:history,cwd:work,version:'2.1.326',isSidechain:false,userType:'external',timestamp:new Date().toISOString()};
  const records = [
    {...common,type:'user',uuid:userId,parentUuid:null,message:{role:'user',content:'An offline history fixture.'}},
    {...common,type:'assistant',uuid:randomUUID(),parentUuid:userId,message:{id:'msg_fixture',type:'message',role:'assistant',model:'claude-sonnet-5-5',content:[{type:'text',text:'Stored fixture response.'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:25000,cache_read_input_tokens:3000,cache_creation_input_tokens:2000,output_tokens:10}}},
  ];
  await writeFile(path.join(project,history+'.jsonl'),records.map(x=>JSON.stringify(x)).join('\n')+'\n');
  await writeFile(path.join(profile,'workspaces.json'),JSON.stringify([{id:workspaceId,kind:'local',cwd:work,name:'Status line fixture',claudeDir:config}]));
  const regularPane = await startOrdinary('ordinary');
  report.ordinaryPane = regularPane;

  const executablePath = !baseline && process.argv[autocomplete ? 3 : 2];
  const appPath = baseline ? path.resolve(process.argv[3]) : '.';
  app = await _electron.launch({ env, args:executablePath?[]:[appPath], ...(executablePath ? {executablePath:path.resolve(executablePath)} : {}) });
  const page = await app.firstWindow(); page.setDefaultTimeout(40000);
  await page.evaluate(() => window.desktop.onSnapshot(s => { window.__statusLineSnapshot=s; }));
  const closeButton = page.getByRole('button',{name:'关闭当前对话',exact:true});
  // Closing asks for confirmation first.
  const close = { click: async () => { await closeButton.click(); await page.locator('dialog.confirm-action[open]').getByRole('button',{name:'关闭对话',exact:true}).click(); } };
  const resume = page.getByRole('button',{name:'续接会话',exact:true});
  async function waitForLine(id) {
    await page.waitForFunction(id => {
      const s=window.__statusLineSnapshot;
      return s?.statusLineManaged && s.statusLine?.sessionId===s.sessionId && (!id || s.sessionId===id)
        && s.statusLine.effort && s.status==='idle' && !s.settingBusy;
    }, id, {timeout:50000});
    return page.evaluate(()=>window.__statusLineSnapshot);
  }
  async function assertScoped(snap) {
    assert.match(snap.statusLine.modelId,/sonnet/i);
    assert.ok(snap.statusLine.contextWindowSize>0);
    if (!baseline) for (const menu of Object.values(snap.settings?.menus ?? {})) assert.equal(menu.source,'catalog');
    assert.ok((await page.locator('[data-setting-kind="model"]').innerText()).includes(snap.statusLine.modelName));
    assert.ok((await page.locator('[data-setting-kind="effort"]').innerText()).includes(snap.statusLine.effort));
    const telemetry = page.locator('.session-context-usage');
    assert.match(await telemetry.getAttribute('title'),/Claude Code 状态栏/);
    assert.equal(await telemetry.getAttribute('data-context-input-tokens'),String(snap.statusLine.inputTokens ?? ''));
    const terminal=await tmux('capture-pane','-p','-t',snap.paneId);
    assert.equal(terminal.includes(original),false,'managed CLI uses its own statusLine');
    assert.ok(await ordinaryVisible(regularPane),'the ordinary CLI running beside it keeps its own statusLine');
  }

  async function openChooser(sessionId, kind, action) {
    const menu = page.locator('[data-setting-menu="' + kind + '"]');
    const refresh = action === 'refresh' || action === 'retry';
    const trigger = refresh ? menu.getByRole('button',{name:/^重新读取/})
      : page.locator('button[data-setting-kind="' + kind + '"]');
    // Time the real click in the renderer through the first animation frame
    // with an enabled alternative that a pointer can actually hit.
    await trigger.evaluate((button, { kind, refresh }) => {
      const selector = '[data-setting-menu="' + kind + '"]';
      const optionSelector = 'button[role="option"][aria-selected="false"]:enabled';
      const oldId = refresh && document.querySelector(selector)?.querySelector(optionSelector)?.dataset.optionId;
      window.__chooserMeasurement = undefined;
      button.addEventListener('click', () => {
        const start = performance.now(), clickedAtMs = Date.now();
        function frame() {
          const options = [...(document.querySelector(selector)?.querySelectorAll(optionSelector) ?? [])];
          const ready = options.some(option => {
            const rect = option.getBoundingClientRect();
            return option.contains(document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2));
          });
          const firstId = options[0]?.dataset.optionId;
          if (ready && (!oldId || firstId !== oldId)) {
            window.__chooserMeasurement = { clickedAtMs, readyAtMs:Date.now(),
              durationMs:Math.round(performance.now()-start), enabledAlternatives:options.length,
              labels:options.map(option=>option.querySelector('strong')?.textContent.trim()) };
          } else requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }, { capture:true, once:true });
    }, {kind,refresh});
    await trigger.click();
    const result = await page.waitForFunction(() =>
      window.__chooserMeasurement || document.querySelector('.setting-menu-error')?.textContent);
    const measurement = await result.jsonValue();
    assert.equal(typeof measurement,'object',kind+' '+action+': '+measurement);
    report.chooser.push({sessionId,kind,action,...measurement});
    return menu;
  }
  async function dismiss(menu) {
    await page.keyboard.press('Escape');
    await menu.waitFor({state:'hidden'});
  }

  // 新建对话 only opens a draft; start the pane without a message and open it from the sidebar.
  await startConversation(page,workspaceId);
  const fresh=await waitForLine();
  assert.notEqual(fresh.sessionId,history);
  await assertScoped(fresh);
  assert.equal(fresh.statusLine.usedPercentage,undefined);
  assert.equal(fresh.statusLine.inputTokens,undefined);
  report.newSession = fresh.statusLine;
  report.ordinaryPaneStartedWhileManaged = await startOrdinary('ordinary-after-lectern');
  assert.equal(await readFile(path.join(config,'settings.json'),'utf8'),settings);
  for (const kind of ['model','effort']) {
    await dismiss(await openChooser(fresh.sessionId,kind,'first'));
    const repeated = await openChooser(fresh.sessionId,kind,'repeat');
    if (kind === 'model') await dismiss(repeated);
  }
  const effortMenu = baseline ? await openChooser(fresh.sessionId,'effort','refresh') : page.locator('[data-setting-menu="effort"]');
  const options = await effortMenu.getByRole('option').all();
  for (const option of options) {
    if (!await option.isEnabled() || await option.getAttribute('aria-selected') === 'true') continue;
    const label = (await option.locator('strong').innerText()).trim();
    if (/auto|default/i.test(label) || label.toLowerCase() === fresh.statusLine.effort.toLowerCase()) continue;
    await option.click();
    await page.waitForFunction(level => window.__statusLineSnapshot?.statusLine?.effort?.toLowerCase() === level.toLowerCase(), label);
    report.userSelectedEffort=label;
    break;
  }
  assert.ok(report.userSelectedEffort,'change to a level actually offered in the Sonnet test picker');
  await close.click();
  await page.locator('.session-row[data-session-id="'+history+'"]').click();
  await resume.click();
  const resumed=await waitForLine(history);
  await assertScoped(resumed);
  assert.equal(resumed.statusLine.inputTokens,30000);
  assert.ok(Number.isFinite(resumed.statusLine.usedPercentage));
  report.resumedSession=resumed.statusLine;
  const pasteCount = async () => (await tmux('show-options', '-gqv', '@lectern_test_pastes')).length;
  if (autocomplete) {
    // The hook runs on the disposable server after each actual tmux paste.
    // The first GUI click from an empty input also checks the counter works.
    await tmux('set-hook', '-g', 'after-paste-buffer', 'set-option -ga @lectern_test_pastes p');
    assert.equal(await pasteCount(), 0);
  }
  const resumedMenu = await openChooser(history,'model','first');
  if (autocomplete) {
    const firstPastes = await pasteCount();
    assert.equal(firstPastes, 0, 'a cache hit never pastes into the business pane');
    await dismiss(resumedMenu);

    // Recreate the exact draft left behind when the older guard withheld Enter.
    await tmux('send-keys', '-t', resumed.paneId, '-l', '/model');
    let descriptionColumn = -1;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rows = (await tmux('capture-pane', '-p', '-J', '-t', resumed.paneId)).split('\n');
      const index = rows.findIndex(row => /^\s+\/model-alignment-fixture\s+Fixture description/.test(row));
      if (index >= 0 && rows.some(row => /^\s*❯\s+\/model\s+\S/.test(row))
        && rows.some(row => /^❯\s+\/model\s*$/.test(row))) {
        const column = rows[index].indexOf('Fixture description');
        const continuation = rows[index + 1] ?? '';
        if (continuation.search(/\S/) === column && /suggestion rows/.test(continuation)) {
          descriptionColumn = column;
          break;
        }
      }
      await delay(50);
    }
    assert.ok(descriptionColumn > 0, 'real CLI has the exact /model draft, focused suggestion and wrapped skill description');
    await page.locator('[data-setting-kind="model"]').click();
    await resumedMenu.getByRole('option').first().waitFor();
    const retryPastes = (await pasteCount()) - firstPastes;
    assert.equal(retryPastes, 0, 'browsing preserves an existing slash draft');
    assert.match(await tmux('capture-pane','-p','-J','-t',resumed.paneId), /^❯\s+\/model\s*$/m);
    await tmux('send-keys','-t',resumed.paneId,'C-u');
    report.autocomplete = { descriptionColumn, firstPastes, retryPastes };
  }
  await dismiss(resumedMenu);
  await close.click(); await resume.waitFor();
  assert.ok(await ordinaryVisible(regularPane));
  assert.ok(await ordinaryVisible(report.ordinaryPaneStartedWhileManaged));
  assert.equal(await readFile(path.join(config,'settings.json'),'utf8'),settings);
  report.userSettingsUnchanged=true;
  await app.close(); app=undefined;
  const events=[];
  for (const name of await readdir(logs)) {
    if (/^events\.\d+\.jsonl$/.test(name)) events.push(...(await readFile(path.join(logs,name),'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)));
  }
  events.sort((a,b)=>a.seq-b.seq);
  const reads = events.filter(e=>e.event==='settings.get.start');
  const opens = events.filter(e=>e.event==='capture.settings.input' && e.data.phase==='open');
  const resumedCommands = events.filter(e=>e.event==='settings.resume_pending_command');
  report.menuReads = reads.map(e=>[e.context.sessionId,e.context.kind]);
  report.nativeMenuOpens = opens.map(e=>[e.context.sessionId,e.data.content]);
  for (const measurement of report.chooser) {
    const withinClick = e => e.context.sessionId === measurement.sessionId && e.context.kind === measurement.kind
      && Date.parse(e.timestamp) >= measurement.clickedAtMs && Date.parse(e.timestamp) <= measurement.readyAtMs;
    measurement.nativeReads = reads.filter(withinClick).length;
    measurement.nativeOpens = opens.filter(withinClick).length;
    if (autocomplete) measurement.resumedCommands = resumedCommands.filter(withinClick).length;
    const read = events.find(e=>e.event==='settings.get.complete' && withinClick(e));
    if (read) {
      const start = reads.find(e=>e.context.operationId===read.context.operationId);
      measurement.nativeReadMs = read.data.durationMs;
      measurement.transportCommands = events.filter(e=>e.event==='transport.command.complete' &&
        e.context.traceId===read.context.traceId && start.seq <= e.seq && e.seq <= read.seq).length;
      measurement.afterReadMs = measurement.readyAtMs - Date.parse(read.timestamp);
    }
  }
  report.readsWhileViewing = reads.length - report.chooser.reduce((count,m)=>count+m.nativeReads,0);
  if (!baseline) {
    // The menus come from the machine's model list (Claude Code's SDK initialize, model-catalogs.ts):
    // no native /model or /effort menu is read in any pane any more (it used to be once per kind).
    assert.deepEqual(reads, [], 'no native menu reads');
    assert.ok(events.some(e => e.event === 'backend.model_probe.start'), 'the choices come from the machine model list');
  }
  for (const m of report.chooser) {
    const expected = baseline ? 1 : 0;
    assert.equal(m.nativeReads,expected,m.kind+' '+m.action+' reads');
    assert.equal(m.nativeOpens,m.action === 'retry' ? 0 : expected,m.kind+' '+m.action+' command pastes requested');
    if (autocomplete) assert.equal(m.resumedCommands,m.action === 'retry' ? 1 : 0,m.kind+' '+m.action+' existing commands');
    if (m.action === 'repeat') {
      const first = report.chooser.find(other=>other.sessionId===m.sessionId && other.kind===m.kind && other.action==='first');
      assert.deepEqual(m.labels,first.labels,'reopening preserves all selectable native alternatives');
    }
  }
  // The default switch is one typed `/effort <level>` (settings.set_inline); the menu way
  // (settings.set, opened with `/effort`) remains for choices without an inline name.
  const applications = events.filter(e=>e.event==='settings.set.start' || e.event==='settings.set_inline.start');
  assert.equal(applications.length,1,'one explicit effort change');
  if (baseline) {
    const applyOpens = opens.filter(e=>e.context.operationId===applications[0].context.operationId);
    assert.deepEqual(applyOpens.map(e=>e.data.content),['/effort','/effort'],'the baseline verifies from a second menu');
    assert.equal(opens.length+resumedCommands.length,reads.length+applyOpens.length,'each native open belongs to a requested read or application');
  } else {
    const inputs = events.filter(e=>e.event==='capture.settings.input');
    const applyInputs = inputs.filter(e=>e.context.operationId===applications[0].context.operationId);
    assert.equal(applyInputs.length,1,'the change types one native command');
    assert.match(applyInputs[0].data.content,applications[0].event==='settings.set_inline.start'
      ? new RegExp('^/effort '+report.userSelectedEffort+'$','i') : /^\/effort$/);
    assert.equal(inputs.length+resumedCommands.length,applyInputs.length,'each native command belongs to the application');
  }
  assert.equal(events.filter(e=>e.event==='controller.send.start').length,0);
  assert.equal(report.modelRequests,0,'chooser and status line send no model requests');
  report.success=true;
} catch (e) {
  report.error=String(e?.stack??e); process.exitCode=1;
} finally {
  await app?.close();
  await tmux('kill-server').catch(()=>{}); // TMUX_TMPDIR belongs exclusively to this test.
  await new Promise(resolve=>localApi.close(resolve));
  await rm(root,{recursive:true,force:true});
  await writeFile(path.join(reportDir,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({reportDir,...report}));
}
