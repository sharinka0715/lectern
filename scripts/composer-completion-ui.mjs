// Standalone renderer regression, no app build, real CLI, SSH, user profile or network.
// Run: node scripts/composer-completion-ui.mjs
import { build } from 'esbuild';
import { _electron as electron } from './fixtures/electron.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = dirname(dirname(fileURLToPath(import.meta.url))), dir = await mkdtemp(join(tmpdir(),'lectern-completion-ui-'));
let app;
try {
  const harness = `import {useRef,useState} from 'react'; import {createRoot} from 'react-dom/client';
import {useComposerCompletion} from './src/renderer/useComposerCompletion';
window.submitted=[];window.pending=new Map();window.canceled=[];
window.desktop={ completeComposer(ws,view,id,query){return new Promise(resolve=>{window.pending.set(query.prefix,{id,resolve});})},
 cancelComposerCompletion(view,id){window.canceled.push(id);return Promise.resolve()} };
function Composer(){ const [value,onValue]=useState(''),inputRef=useRef(null); const c=useComposerCompletion({workspaceId:'fixture',sessionId:'one',view:'primary',enabled:true,value,onValue,inputRef});
return <main><textarea ref={inputRef} value={value} {...c.inputProps} onKeyDown={e=>{if(c.onKeyDown(e))return; if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();window.submitted.push(value)}}}/>{c.popup}</main>}
createRoot(document.querySelector('main')).render(<Composer/>);`;
  const {outputFiles} = await build({stdin:{contents:harness,resolveDir:root,loader:'tsx'}, bundle:true,write:false,outdir:dir,entryNames:'fixture',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
  await Promise.all(outputFiles.map(f=>writeFile(f.path,f.contents)));
  await writeFile(join(dir,'page.html'),'<meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>body>main {position:absolute;bottom:20px;left:20px;width:500px}</style><main></main><script src="fixture.js"></script>');
  await writeFile(join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');let w;app.whenReady().then(()=>{w=new BrowserWindow({show:false,webPreferences:{sandbox:true}});w.loadFile(${JSON.stringify(join(dir,'page.html'))})});`);
  app=await electron.launch({args:[`--user-data-dir=${join(dir,'profile')}`,join(dir,'main.cjs')]});
  const page=await app.firstWindow(); page.setDefaultTimeout(5000);
  const input=page.locator('textarea'), list=page.getByRole('listbox'), active=page.locator('[role=option][aria-selected=true]');
  const resolve = (prefix, names, kind='file') => page.evaluate(({prefix,names,kind})=>window.pending.get(prefix).resolve(names.map(value=>({value,kind,source:'workspace'}))),{prefix,names,kind});
  const pending = prefix=>page.waitForFunction(p=>window.pending.has(p),prefix);
  // Only allow-listed built-ins are offered; interactive ones such as /help or /config are not.
  await input.fill('/'); await list.waitFor(); assert.match(await active.textContent(),/\/compact/);
  assert.equal(await list.getByText('/help', { exact: true }).count(), 0);
  await input.press('ArrowDown'); assert.match(await active.textContent(),/\/context/); await input.press('ArrowUp'); await input.press('Tab'); assert.equal(await input.inputValue(),'/compact ');
  await input.fill('/res'); await input.press('Escape'); await list.waitFor({state:'hidden'}); assert.equal(await input.inputValue(),'/res');
  await input.fill('@old'); await input.press('Enter'); assert.deepEqual(await page.evaluate(()=>window.submitted),[]); await pending('old'); await input.fill('@new'); await pending('new');
  assert.equal(await page.evaluate(()=>window.canceled.includes(window.pending.get('old').id)),true);
  await resolve('new',['文 档/a.txt','文 档/b.txt']); await list.waitFor(); await resolve('old',['stale.txt']);
  await input.press('ArrowUp'); assert.match(await active.textContent(),/b.txt/); await input.press('Enter');
  assert.equal(await input.inputValue(),'@"文 档/b.txt" '); assert.deepEqual(await page.evaluate(()=>window.submitted),[]);
  await input.fill('读取 @fo.txt 然后检查'); await input.press('Home'); for(let i=0;i<6;i++) await input.press('ArrowRight');
  await pending('fo'); await resolve('fo',['folder.txt']); await list.waitFor(); await active.click();
  assert.equal(await input.inputValue(),'读取 @folder.txt 然后检查'); assert.equal(await input.evaluate(el=>el.selectionStart),'读取 @folder.txt '.length);
  await input.fill('@d'); await pending('d'); await resolve('d',['文 档'],'directory'); await list.waitFor(); await input.press('Tab');
  await pending('文 档/'); assert.equal(await input.inputValue(),'@"文 档/"'); assert.equal(await input.evaluate(el=>el.selectionStart),'@"文 档/'.length);
  await input.fill('/mo'); await list.waitFor();
  await input.dispatchEvent('compositionstart'); await input.press('Enter'); assert.deepEqual(await page.evaluate(()=>window.submitted),[]);
  assert.equal((await input.inputValue()).includes('/model'),false); await input.dispatchEvent('compositionend');
  console.log('Composer popup: allow-listed commands, keyboard and pointer insertion, IME, caret and stale IPC verified.');
} finally { await app?.close(); await rm(dir,{recursive:true,force:true}); }
