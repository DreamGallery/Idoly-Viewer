/** Local-only game media adapter. Indexed names, bounded decode queue, Range support. */
import {readFile,stat,access} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const exec=promisify(execFile);
export function parseRange(header,size){
 if(!header)return null;
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);
 if(!match||(!match[1]&&!match[2]))throw Error('Invalid range');
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
 const end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;
 if(start>end||start>=size||!Number.isSafeInteger(start)||!Number.isSafeInteger(end))throw Error('Invalid range');
 return {start,end};
}
export async function localMediaHandler(root){
 const plan=JSON.parse(await readFile(resolve(root,'public/data/media-plan.json'),'utf8'));
 const pending=new Map();let running=0;const queue=[];
 const limit=async job=>{if(running>=3)await new Promise(r=>queue.push(r));running++;try{return await job()}finally{running--;queue.shift()?.()}};
 const python=process.env.IDOLY_PYTHON||'python3';
 return async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!pathname.startsWith('/api/media/'))return false;
  try{
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return true}
   const match=/^\/api\/media\/(image|voice|video)\/([A-Za-z0-9_.-]+)\.(webp|wav|mp4)$/.exec(pathname);
   if(!match)throw Object.assign(Error('Invalid media path'),{status:404});
   const [,kind,name,ext]=match;
   const bank=kind==='image'&&ext==='webp'&&plan.images.includes(name)?name:kind==='voice'&&ext==='wav'?plan.voices[name]:kind==='video'&&ext==='mp4'?plan.videos?.[name]:null;
   if(!bank)throw Object.assign(Error('Media not indexed'),{status:404});
   const item=plan.assets[bank],file=resolve(root,'.local/media',item.md5,name+'.'+ext);
   try{await access(file)}catch{
    // All clips in one bank share the same extraction promise.
    if(!pending.has(bank))pending.set(bank,limit(()=>exec(python,['-m','idoly_story_index.media',kind,name],{cwd:root,timeout:180000,maxBuffer:1024*1024})).finally(()=>pending.delete(bank)));
    await pending.get(bank);
   }
   const info=await stat(file);let range;
   try{range=parseRange(req.headers.range,info.size)}catch{res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return true}
   const headers={'Content-Type':kind==='image'?'image/webp':kind==='video'?'video/mp4':'audio/wav','Accept-Ranges':'bytes','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff','Content-Length':range?range.end-range.start+1:info.size};
   if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${info.size}`;
   res.writeHead(range?206:200,headers);
   if(req.method==='HEAD'){res.end();return true}
   createReadStream(file,range||undefined).on('error',()=>res.destroy()).pipe(res);
  }catch(error){
   console.error('Local media:',error.message?.slice(0,180));
   if(!res.headersSent)res.writeHead(error.status||502,{'Content-Type':'application/json'});
   res.end(JSON.stringify({error:error.status===404?'资源未收录':'资源暂时无法读取，请重试'}));
  }
  return true;
 };
}
