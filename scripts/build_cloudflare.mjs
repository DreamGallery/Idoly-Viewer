import { mkdir, rm, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const publicDir = '.wrangler/ui-public';
await rm(publicDir,{recursive:true,force:true});
await mkdir(publicDir,{recursive:true});
for(const name of ['favicon.ico','favicon.svg','theme-init.js','fonts']) {
  await cp('public/'+name,publicDir+'/'+name,{recursive:true});
}
const result=spawnSync('npm',['run','build'],{stdio:'inherit',env:{...process.env,CAMPUS_CLOUDFLARE_BUILD:'1'}});
process.exitCode=result.status ?? 1;
