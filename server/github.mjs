/** Real GitHub collaboration with the local game's catalog and media. */
import {readFile,realpath} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApp} from './app.mjs';
import {localMediaHandler} from './idoly-media.mjs';

const root=resolve(import.meta.dirname,'..');
export async function createSourceServices(env) {
 const web=env.CAMPUS_WEB_DATA||resolve(root,'public');
 const catalog=JSON.parse(await readFile(resolve(web,'data/catalog.json'),'utf8'));
 const byId=new Map(catalog.stories.map(story=>[story.id,story]));
 const original=env.IDOLY_CSV_ROOT||resolve(root,'../Hoshimi-Adv/CSV');
 async function readWithin(directory,path) {
  const base=await realpath(directory),file=await realpath(resolve(base,path));
  if(!file.startsWith(base+sep))throw Object.assign(Error('文件不在配置目录内'),{status:403});
  return readFile(file,'utf8');
 }
 return {
  sourcePath:async id=>byId.get(id)?.path,
  sourceCsv:async id=>{
   const story=byId.get(id);
   if(!story)throw Object.assign(Error('剧情不存在'),{status:404});
   return {csv:await readWithin(original,story.path),label:'原文'};
  },
 };
}

export async function startGitHub({env=process.env,remoteFetch=fetch,port=Number(env.CAMPUS_API_PORT||8787),media=true}={}) {
 if(!env.GITHUB_CLIENT_ID?.trim()||!env.GITHUB_CLIENT_SECRET?.trim())throw Error('请填写 .env.oauth.local 中的 GitHub Client ID 和 Client Secret');
 const server=createApp(env,remoteFetch,await createSourceServices(env));
 if(media){
  const handler=await localMediaHandler(root),original=server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request',async(req,res)=>{if(!await handler(req,res))original(req,res)});
 }
 await new Promise((accept,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);accept()})});
 return server;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 process.loadEnvFile(resolve(root,'.env.oauth.local'));
 const server=await startGitHub();
 console.log(`Idoly GitHub API ready: http://127.0.0.1:${server.address().port}`);
}
