// Real stock TUI and Electron. Mode startup and consent require no model turns.
import { createPrivateTmux } from './fixtures/private-tmux.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from './fixtures/electron.mjs';
import { openConversation } from './fixtures/sidebar-folders.mjs';
import { Backend } from '../src/backend/index.ts';

const root = await realpath(await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 't-mode-')));
const config = path.join(root,'config'), work = path.join(root,'workspace'), profile = path.join(root,'profile');
const logs = path.resolve('test-results','native-mode-matrix-' + Date.now());
const ws = {id:'mode-proof',kind:'local',cwd:work,name:'本机模式测试'};
// A full model ID the operator's Claude Code can use (LECTERN_NATIVE_MODEL); the report checks replies came from it.
const model = process.env.LECTERN_NATIVE_MODEL || 'claude-sonnet-5-5', modeMap = {manual:'default',plan:'plan',auto:'auto',acceptEdits:'acceptEdits',bypassPermissions:'bypassPermissions',dontAsk:'dontAsk'};
const env = {PATH:process.env.PATH, HOME:root, LANG:'en_US.UTF-8', LECTERN_LOCALE:'zh-CN', SHELL:'/bin/sh', TERM:'xterm-256color', CLAUDE_CONFIG_DIR:config,
  TMUX_TMPDIR:path.join(root,'sockets'), ANTHROPIC_BASE_URL:'http://127.0.0.1:9', ANTHROPIC_API_KEY:'lectern-mode-fixture',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',LECTERN_USER_DATA:profile,LECTERN_LOG_DIR:path.join(logs,'diagnostics'),LECTERN_DIAGNOSTIC_CONTENT:'1'};
for(const dir of [work,config,profile,env.TMUX_TMPDIR,logs]) await mkdir(dir,{recursive:true,mode:0o700});
const privateServer = createPrivateTmux(env.TMUX_TMPDIR, { env });
Object.assign(process.env,privateServer.env);
delete process.env.TMUX; delete process.env.TMUX_PANE;
await writeFile(path.join(config,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,lastOnboardingVersion:'2.1.326',theme:'dark',projects:{[work]:{hasTrustDialogAccepted:true}},customApiKeyResponses:{approved:['lectern-mode-fixture'],rejected:[]}}));
await writeFile(path.join(config,'settings.json'),JSON.stringify({model}));
await writeFile(path.join(profile,'workspaces.json'),JSON.stringify([ws]));
const tmux = (...args) => privateServer.tmux(...args).trimEnd();
const sessions=[],report={success:false,modes:[]};let app;
try {
  for(const [mode,expected] of Object.entries(modeMap)){
    const backend=new Backend({claudeArgs:['--model',model,'--strict-mcp-config','--permission-mode',mode]});
    try { sessions.push({mode,expected,...await backend.createSession(ws)}); } finally {await backend.dispose();}
  }
  const exe=process.argv[2]; app=await _electron.launch({args:exe?[]:['.'],env,...(exe?{executablePath:path.resolve(exe)}:{})});
  const page=await app.firstWindow();page.setDefaultTimeout(35000);
  await page.evaluate(()=>{window.desktop.onSnapshot(s=>{window.__mode=s;});});
  for(const s of sessions) {
    // Six new conversations: the folder lists five until 展开更多 (openConversation clicks it).
    await openConversation(page,ws.id,s.id);
    // The test user accepts the one warning solely in the disposable bypass pane.
    if(s.mode==='bypassPermissions') {
      await page.waitForFunction(id=>window.__mode?.sessionId===id && window.__mode.navigationStatus==='waiting' && window.__mode.viewport?.includes('WARNING: Claude Code running in Bypass Permissions mode'),s.id);
      await page.locator('[title="查看终端原屏"]').click();
      await page.locator('[data-terminal-action="take"]').click();
      const before=await tmux('capture-pane','-p','-t',s.paneId);
      assert.match(before,/❯\s*No, exit/);
      const terminal = page.getByRole('textbox', { name: '原生终端输入' });
      await terminal.press('ArrowDown');
      await page.waitForFunction(()=>/❯\s*Yes, I accept/.test(window.__mode?.viewport));
      await terminal.press('Enter');
      await page.waitForFunction(()=>window.__mode?.executionMode?.mode==='bypassPermissions');
      // Claude can register its final foreground process only after this startup
      // notice. The controller then correctly revokes the earlier control token.
      if (await page.evaluate(()=>!!window.__mode?.terminalControl)) await page.locator('[data-terminal-action="release"]').click();
      await page.getByRole('button',{name:'关闭终端原屏'}).click();
      report.bypassWarningHandled=true;
    }
    await page.waitForFunction(({id,mode})=>window.__mode?.sessionId===id &&
      document.querySelector('[data-execution-mode]')?.getAttribute('data-execution-mode')===mode,{id:s.id,mode:s.expected});
    const observation=await page.evaluate(()=>window.__mode.executionMode);
    const screen=await tmux('capture-pane','-p','-t',s.paneId);
    assert.ok(screen.includes(observation.evidence));assert.ok(screen.includes(model));
    report.modes.push({launch:s.mode,displayed:s.expected,evidence:observation.evidence});
    await writeFile(path.join(logs,s.mode+'.txt'),screen);
  }
  report.success=true;
} catch(e) {report.error=String(e.stack||e);process.exitCode=1;}
finally {
  await app?.close();
  privateServer.kill();
  await rm(root,{recursive:true,force:true});
  await writeFile(path.join(logs,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({logs,...report}));
}
