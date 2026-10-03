/** Pack a generated NAS snapshot into an offline, content-addressed R2 upload plan.
 * No credentials, network, game extraction, or repository mutation is involved.
 */
import {readFile,writeFile,mkdir,copyFile,readdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,basename,extname,sep} from 'node:path';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string',default:'release/r2'},release:{type:'string'},prefix:{type:'string',default:'idoly-v1'}}});
if(!values.input) throw new Error('Usage: node scripts/package-idoly-resources.mjs --input <snapshot with web/story/adv/media> [--output release/r2] [--release id] [--prefix idoly-v1]');
const sourceManifest=JSON.parse(await readFile(resolve(values.input,'web/catalog/manifest.json'),'utf8'));
const release=values.release || /^\/catalog\/releases\/([A-Za-z0-9_-]+)$/.exec(sourceManifest.base_path || '')?.[1];
if(!release || !/^[A-Za-z0-9_-]+$/.test(release)) throw new Error('Invalid release ID');
const prefix=values.prefix;
if(!prefix || prefix.split('/').some(p=>!p || p==='.' || p==='..') || /[\\\x00-\x1f]/.test(prefix)) throw new Error('Invalid prefix');
const input=resolve(values.input), root=resolve(values.output,release);
if(root===input || root.startsWith(input+sep)) throw new Error('Output must be outside the input snapshot');
const types={'.json':'application/json; charset=utf-8','.csv':'text/csv; charset=utf-8','.txt':'text/plain; charset=utf-8','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.wav':'audio/wav','.flac':'audio/flac','.ogg':'audio/ogg','.mp3':'audio/mpeg','.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'video/webm'};
const files={}, objects=[], seen=new Set();
async function digest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
async function put(key,content){
 const path=resolve(root,key);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,content);
 objects.push({key:prefix+'/'+key,path,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex'),contentType:'application/json; charset=utf-8'});
}
async function walk(dir){
 for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=resolve(dir,entry.name);
  if(entry.isSymbolicLink()) throw new Error('Snapshot must contain materialized files, not symlinks: '+path);
  if(entry.isDirectory()){await walk(path);continue;}
  if(!entry.isFile()) throw new Error('Unsupported snapshot entry: '+path);
  const logical=relative(input,path).split(sep).join('/');
  if(/[\\\x00-\x1f]/.test(logical)) throw new Error('Invalid snapshot path');
  const sha256=await digest(path), type=types[extname(path).toLowerCase()] || 'application/octet-stream';
  const media=logical.startsWith('media/') || logical.startsWith('web/images/');
  const key=(media?'media':'text')+'/'+sha256+'/'+basename(path);
  files[logical]=key;
  if(seen.has(key))continue;
  seen.add(key);const dest=resolve(root,key);await mkdir(resolve(dest,'..'),{recursive:true});await copyFile(path,dest);
  objects.push({key:prefix+'/'+key,path:dest,bytes:(await stat(path)).size,sha256,contentType:type});
 }
}
const catalog=JSON.parse(await readFile(resolve(input,'web/data/catalog.json'),'utf8'));
for(const required of ['web/data/directory.json','web/data/updates.json','web/catalog/manifest.json'])await stat(resolve(input,required));
const manifest=sourceManifest;
// Pin the source metadata to this release, so readers never mix pointer generations.
if(manifest.base_path!==`/catalog/releases/${release}`) throw new Error('web/catalog/manifest.json base_path must be /catalog/releases/'+release);
for(const dir of ['web','story','adv','media']){try{await walk(resolve(input,dir));}catch(e){if(e.code!=='ENOENT' || dir!=='media')throw e;}}
const shards={}, groups={};
for(const [logical,target] of Object.entries(files)) {
 const shard=createHash('sha256').update(logical,'utf8').digest('hex').slice(0,2);
 (groups[shard]??={})[logical]=target;
}
for(const shard of Object.keys(groups).sort()) {
 const key=`releases/${release}/maps/${shard}.json`;shards[shard]=key;
 await put(key,JSON.stringify({files:groups[shard]}));
}
await put(`releases/${release}/file-map.json`,JSON.stringify({schema_version:1,files:{},shards}));
await put('current.json',JSON.stringify({schema_version:1,release,published_at:new Date().toISOString(),versions:{revision:catalog.provenance?.revision ?? null,versions:[]}}));
await writeFile(resolve(root,'upload-manifest.json'),JSON.stringify({schema_version:1,release,prefix,objects,publishLast:prefix+'/current.json'},null,2));
console.log(JSON.stringify({release,objects:objects.length,bytes:objects.reduce((n,o)=>n+o.bytes,0),manifest:resolve(root,'upload-manifest.json')}));
