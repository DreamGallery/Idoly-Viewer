/** Campus Viewer's API with an entirely local GitHub transport for acceptance testing. */
import {localMediaHandler} from './idoly-media.mjs';
import {createApp} from './app.mjs';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'..');
const hash=s=>createHash('sha256').update(s).digest('hex');
export async function createLocalRepo({directory=resolve(root,'.local'),catalogPath=resolve(root,'public/data/catalog.json'),translations=resolve(root,'../Idoly-localify-translations')}={}){
 const catalog=JSON.parse(await readFile(catalogPath,'utf8')),byId=new Map(catalog.stories.map((s,i)=>[s.id,{...s,number:i+1}]));
 const file=resolve(directory,'repository.json');await mkdir(directory,{recursive:true});
 let saved;try{saved=JSON.parse(await readFile(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw e;saved={head:'local-initial',files:{},issues:{}}}
 const objects=new Map();let serial=Promise.resolve();
 const persist=async()=>{const temp=file+'.tmp';await writeFile(temp,JSON.stringify(saved));await rename(temp,file)};
 const issue=s=>saved.issues[s.number]||{number:s.number,title:s.id,body:`<!-- ai_path: story/ai/${s.path} -->\n<!-- translated_path: story/human/${s.path} -->\n<!-- proofread_path: story/reviewed/${s.path} -->\n<!-- tr::待认领 -->\n<!-- pr::待认领 -->`,updated_at:'2026-09-30T00:00:00.000Z',state:'open',labels:[],assignees:[]};
 async function content(path){
  if(Object.hasOwn(saved.files,path))return saved.files[path];
  if(path==='users.json')return JSON.stringify({});
  if(path==='glossary/names.json')return readFile(resolve(translations,path),'utf8');
  if(/^story\/(ai|human|reviewed)\//.test(path)&&catalog.stories.some(s=>path.endsWith('/'+s.path))){try{return await readFile(resolve(translations,path),'utf8')}catch(e){if(e.code!=='ENOENT')throw e}}
  return null;
 }
 const response=(x,status=200)=>Response.json(x,{status});
 async function run(url,opts={}){
  const u=new URL(url),method=opts.method||'GET',body=opts.body?JSON.parse(opts.body):null;
  if(u.hostname!=='api.github.com')throw Error('本地模式禁止访问外部服务');
  if(u.pathname==='/search/issues'){const id=u.searchParams.get('q')?.split(' ').at(-1);const s=byId.get(id);return response({items:s?[issue(s)]:[]})}
  const prefix='/repos/DreamGallery/Idoly-localify-translations';
  if(!u.pathname.startsWith(prefix))return response({error:'Unknown local repository'},404);
  const p=decodeURIComponent(u.pathname.slice(prefix.length).replace(/^\//,''));
  if(!p)return response({permissions:{push:true},archived:false});
  if(p.startsWith('contents/')){const path=p.slice(9);if(path.split('/').some(x=>x==='..'||x==='.'))return response({},400);const value=await content(path);return value===null?response({},404):response({sha:hash(value),content:Buffer.from(value).toString('base64')})}
  if(p==='issues'){const page=Number(u.searchParams.get('page')||1);return response(catalog.stories.slice((page-1)*100,page*100).map(s=>issue(byId.get(s.id))))}
  if(/^issues\/\d+$/.test(p)){const n=Number(p.split('/')[1]),s=catalog.stories[n-1];if(!s)return response({},404);const previous=issue(byId.get(s.id));if(method==='PATCH'){saved.issues[n]={...previous,...body,updated_at:new Date(Math.max(Date.now(),Date.parse(previous.updated_at)+1)).toISOString()};await persist();return response(saved.issues[n])}return response(previous)}
  if(p==='git/ref/heads/main')return response({object:{sha:saved.head}});
  if(p.startsWith('git/commits/')&&method==='GET')return response({sha:saved.head,tree:{sha:saved.head}});
  if(p==='git/blobs'){const value=Buffer.from(body.content,'base64').toString('utf8'),sha=hash(value);objects.set(sha,{value});return response({sha})}
  if(p==='git/trees'){const sha=randomUUID();objects.set(sha,{tree:body.tree});return response({sha})}
  if(p==='git/commits'){const sha=randomUUID();objects.set(sha,{...body});return response({sha})}
  if(p==='git/refs/heads/main'&&method==='PATCH'){
   const commit=objects.get(body.sha);if(!commit||commit.parents[0]!==saved.head||body.force)return response({},409);
   const tree=objects.get(commit.tree)?.tree;if(!tree)return response({},400);
   for(const item of tree){saved.files[item.path]=item.sha===null?null:objects.get(item.sha).value}
   saved.head=body.sha;await persist();return response({object:{sha:saved.head}});
  }
  return response({error:'Unsupported local GitHub request'},404);
 }
 const remoteFetch=(url,opts)=>{const job=serial.then(()=>run(url,opts));serial=job.catch(()=>{});return job};
 return {remoteFetch,byId,content};
}
export async function startLocal({port=8787,directory}={}){
 const repo=await createLocalRepo({directory});
 const server=createApp({CAMPUS_PUBLIC_ORIGIN:'http://127.0.0.1:5173',CAMPUS_WORK_OWNER:'DreamGallery',CAMPUS_WORK_REPO:'Idoly-localify-translations',CAMPUS_WORK_BRANCH:'main',CAMPUS_WEB_DATA:resolve(root,'public'),CAMPUS_ADV_ROOT:resolve(root,'../Hoshimi-Adv/Resource')},repo.remoteFetch,{localAuth:true,sourcePath:async id=>repo.byId.get(id)?.path,sourceCsv:async id=>{const s=repo.byId.get(id);if(!s)throw Object.assign(Error('剧情不存在'),{status:404});for(const prefix of ['story/reviewed/','story/human/','story/ai/']){const csv=await repo.content(prefix+s.path);if(csv!==null)return {csv,label:({'story/reviewed/':'人工校对稿','story/human/':'人工翻译稿','story/ai/':'AI 初译 · 待校对'})[prefix]}}return readFile(resolve(root,'../Hoshimi-Adv/CSV',s.path),'utf8')}});
 const media=await localMediaHandler(root);
 const original=server.listeners('request')[0];server.removeAllListeners('request');server.on('request',async(req,res)=>{if(!await media(req,res))original(req,res)});
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const server=await startLocal();console.log('Idoly local API ready: http://127.0.0.1:8787 (no GitHub writes)')}
