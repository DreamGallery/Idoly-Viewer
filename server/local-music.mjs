/** Vite-only music endpoints; no Worker, R2 or production routes. */
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {parseRange} from './idoly-media.mjs';
const exec=promisify(execFile);
export function localMusicHandler(root,env={}) {
 const pending=new Map();let running=0;const queue=[];
 const python=env.IDOLY_MUSIC_PYTHON||process.env.IDOLY_PYTHON||'python3';
 const run=(args)=>exec(python,['-m','idoly_story_index.music',...args],{cwd:root,env:{...process.env,...env},timeout:180000,maxBuffer:1024*1024});
 const once=(key,job)=>{
  if(!pending.has(key))pending.set(key,(async()=>{if(running>=3)await new Promise(r=>queue.push(r));running++;try{return await job()}finally{running--;queue.shift()?.()}})().finally(()=>pending.delete(key)));
  return pending.get(key);
 };
 return async(req,res,next)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(!path.startsWith('/api/local-music/'))return next();
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
  try {
   const folder=resolve(root,'.local/music');
   try{await stat(resolve(folder,'catalog.json'))}catch(error){if(error.code!=='ENOENT')throw error;await once('catalog',()=>run(['catalog']))}
   let file,type;
   if(path==='/api/local-music/catalog') {file=resolve(folder,'catalog.json');type='application/json; charset=utf-8'}
   else {
    const match=/^\/api\/local-music\/(audio|cover)\/([a-z0-9-]+)\.(flac|webp)$/.exec(path);
    if(!match||match[3] !== (match[1]==='audio'?'flac':'webp'))throw Object.assign(Error('Invalid music URL'),{status:404});
    const [,kind,id]=match;
    const catalog=JSON.parse(await readFile(resolve(folder,'catalog.json'),'utf8'));
    if(!catalog.tracks.some(t=>t.id===id))throw Object.assign(Error('Music not indexed'),{status:404});
    const plan=JSON.parse(await readFile(resolve(folder,'plan.json'),'utf8'));
    const asset=plan.assets[(kind==='audio'?'sud_music_short_':'img_music_jacket_')+id];
    file=resolve(folder,asset.md5,kind==='audio'?'audio.flac':'cover.webp');
    try{await stat(file)}catch(error){if(error.code!=='ENOENT')throw error;await once(kind+':'+id,()=>run([kind,id]))}
    type=kind==='audio'?'audio/flac':'image/webp';
   }
   const info=await stat(file);let range;
   try{range=parseRange(req.headers.range,info.size)}catch{res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return}
   const headers={'Content-Type':type,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache','Content-Length':range?range.end-range.start+1:info.size};
   if(range)headers['Content-Range']=`bytes ${range.start}-${range.end}/${info.size}`;
   res.writeHead(range?206:200,headers);
   if(req.method==='HEAD'){res.end();return}
   createReadStream(file,range||undefined).on('error',()=>res.destroy()).pipe(res);
  }catch(error){console.error('Local music:',error.message?.slice(0,160));if(!res.headersSent)res.writeHead(error.status||502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'音乐暂时无法载入，请重试'}))}
 };
}
