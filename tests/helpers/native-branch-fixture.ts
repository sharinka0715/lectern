import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectSlug } from '../../src/backend';
import type { Workspace } from '../../src/shared/types';

export async function nativeBranchFixture(count = 15) {
  // Short path also fits macOS's tmux UNIX socket limit.
  const root = await realpath(await mkdtemp('/tmp/lectern-br-'));
  const cwd = join(root,'work'), home = join(root,'home'), config = join(root,'config');
  const dir = join(config,'projects',projectSlug(cwd));
  await Promise.all([mkdir(cwd),mkdir(home),mkdir(dir,{recursive:true})]);
  const fakeKey = 'test-only';
  const env = {PATH:process.env.PATH!,HOME:home,TERM:'xterm-256color',CLAUDE_CONFIG_DIR:config,TMUX_TMPDIR:root,
    ANTHROPIC_API_KEY:fakeKey,ANTHROPIC_BASE_URL:'http://127.0.0.1:1',DISABLE_AUTOUPDATER:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'};
  const ws: Workspace = {id:'native-branch',name:'分叉测试',kind:'local',cwd,claudeDir:config};
  const originalId = randomUUID(), prompts: string[] = [], ids: string[] = [], rows = [];
  let parent: string | null = null;
  for (let i=0; i<count; i++) {
    const text = i === 1 || i === count-2 ? 'Repeated prompt' : `Prompt ${i}`;
    prompts.push(text);
    for(const role of ['user','assistant']) {
      const uuid=randomUUID(); if (role==='user') ids.push(uuid);
      const message=role==='user' ? {role,content:text} : {id:'msg_'+uuid,type:'message',model:'claude-opus-4-7',role,
        content:[{type:'text',text:`Fixture answer ${i}`}],stop_reason:'end_turn',usage:{input_tokens:4,output_tokens:3}};
      rows.push(JSON.stringify({uuid,parentUuid:parent,isSidechain:false,cwd,sessionId:originalId,version:'2.1.326',userType:'external',type:role,timestamp:'2026-11-17T08:00:00.000Z',message}));
      parent=uuid;
    }
  }
  await writeFile(join(dir,originalId+'.jsonl'),rows.join('\n')+'\n');
  await writeFile(join(config,'.claude.json'),JSON.stringify({hasCompletedOnboarding:true,lastOnboardingVersion:'2.1.326',projects:{[cwd]:{hasTrustDialogAccepted:true}},customApiKeyResponses:{approved:[fakeKey]}}));
  return {root,cwd,home,config,dir,env,ws,originalId,prompts,ids};
}
