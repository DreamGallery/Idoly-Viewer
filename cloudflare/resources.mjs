import {originalCsv, originalStory} from '../server/public-story.mjs';
import {resourceCache, resourceError as error, safe, IMMUTABLE_TTL, POINTER_TTL} from './resource-cache.mjs';

const jsonResponse = (request, value, release, immutable=true) => {
  const body=JSON.stringify(value);
  return new Response(request.method==='HEAD'?null:body, {headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':String(new TextEncoder().encode(body).byteLength),'X-Content-Type-Options':'nosniff','X-Idoly-Release':release,'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-store'}});
};
const validRelease = value => /^[A-Za-z0-9_-]{1,80}$/.test(value);
const validCatalog = path => /^(?:manifest\.json|chapters\/[\w-]{1,200}\.json|builds\/[\w-]{1,80}\/(?:updates\.json|lists\/[\w-]{1,80}\.json|chapters\/[\w-]{1,200}\.json))$/.test(path);
export function resources(env, options={}) {
  const prefix = safe(env.IDOLY_R2_PREFIX || env.CAMPUS_R2_PREFIX || 'idoly-v1');
  const objects = resourceCache(env, prefix, options);
  // Keep only a small working set; a full game index exceeds Worker memory.
  function boundedCache(maxCount,maxBytes) {
    const entries=new Map();let bytes=0;
    return {
      get(key){const entry=entries.get(key);if(!entry)return;entries.delete(key);entries.set(key,entry);return entry.value;},
      set(key,value,size){
        if(size>maxBytes)return;
        if(entries.has(key)){bytes-=entries.get(key).size;entries.delete(key);}
        entries.set(key,{value,size});bytes+=size;
        while(entries.size>maxCount || bytes>maxBytes){const oldest=entries.keys().next().value;bytes-=entries.get(oldest).size;entries.delete(oldest);}
      },
    };
  }
  const maps=boundedCache(2,4*1024*1024), shards=boundedCache(16,4*1024*1024);
  const dictionary=value=>value && typeof value==='object' && !Array.isArray(value);
  async function loadMap(key,cache,maxSize,root=false,scope) {
    const cached=cache.get(key);if(cached)return cached;
    let raw;
    try {raw=await objects.text(key,{maxBytes:maxSize,missingTtl:root?IMMUTABLE_TTL:0},scope);}
    catch(e){if(e.status===404)return null;throw e;}
    const map=JSON.parse(raw);
    if(!dictionary(map.files) || (root && map.schema_version!==1) || (map.shards!==undefined && !dictionary(map.shards)))throw error(503);
    cache.set(key,map,raw.length*2);return map;
  }
  async function resolveFile(key,scope) {
    safe(key);
    const match=/^releases\/([^/]+)\/(web\/.*|story\/.*|adv\/.*|media\/.*)$/.exec(key);
    if(!match)return key;
    const release=match[1], logical=match[2];
    if(!validRelease(release))throw error(400);
    const map=await loadMap('releases/'+release+'/file-map.json',maps,8*1024*1024,true,scope);
    if(!map){
      // Legacy releases have no map. A real catalog (or the current pointer)
      // must confirm the release before falling back to direct object paths.
      if((await current(scope))?.release!==release){
        const manifest=JSON.parse(await objects.text('releases/'+release+'/web/catalog/manifest.json',{},scope));
        if(!manifest || typeof manifest.base_path!=='string')throw error(404);
      }
      return key;
    }
    let target=Object.hasOwn(map.files,logical)?map.files[logical]:null;
    if(!target && map.shards){
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(logical)));
      const shard=hash[0].toString(16).padStart(2,'0'), shardKey=Object.hasOwn(map.shards,shard)?map.shards[shard]:null;
      if(shardKey){
        // A map can select only this release's deterministic shard path.
        if(shardKey!=='releases/'+release+'/maps/'+shard+'.json')throw error(503);
        const fragment=await loadMap(shardKey,shards,2*1024*1024,false,scope);
        if(!fragment)throw error(503);
        target=Object.hasOwn(fragment.files,logical)?fragment.files[logical]:null;
      }
    }
    if(!target)throw error(404);
    if(typeof target!=='string' || (!/^(text|media)\/[a-f0-9]{64}\/[^/]+$/.test(target) && !/^releases\/[^/]+\/(web|story|adv|media)\/.+/.test(target)))throw error(503);
    return safe(target);
  }
  async function current(scope) {
    try { const info = JSON.parse(await objects.text('current.json',{ttl:POINTER_TTL,maxBytes:1024*1024},scope)); if (!info || typeof info.release !== 'string' || !validRelease(info.release)) throw error(503); return info; }
    catch(e) { if(e.status === 404) return null; throw e; }
  }
  function versionList(info) { return Array.isArray(info?.versions?.versions) ? info.versions.versions.slice(0,5) : []; }
  async function status(scope) {
    const info=await current(scope);
    return info?{state:'ready',revision:info.versions?.revision,release:info.release,last_success:info.published_at}:{state:'initializing',phase:'等待导入剧情资源'};
  }
  async function sourceRoots(scope) {
    const info = await current(scope); if (!info) throw error(503);
    const root = 'releases/' + safe(info.release);
    return {web:root+'/web',story:root+'/story',adv:root+'/adv'};
  }
  async function readFile(root, relative, scope, original=false) {
    // Catalog base_path is a public versioned URL; map it back to this release.
    const catalog = /^catalog\/releases\/([^/]+)\/(.+)$/.exec(relative);
    if(catalog) {
      if(root !== 'releases/'+catalog[1]+'/web') throw error(400);
      relative = 'catalog/'+catalog[2];
    }
    const logical=safe(root)+'/'+safe(relative), key=await resolveFile(logical,scope);
    if(original)return objects.publicText(key,'csv',originalCsv,scope);
    const privateText=/^releases\/[^/]+\/(?:story\/|web\/data\/stories\/)/.test(logical);
    return objects.text(key,{ttl:privateText?0:IMMUTABLE_TTL},scope);
  }
  async function sourceCsv(id, release, scope) {
    if (!/^[\w-]{1,200}$/.test(id) || (release != null && !validRelease(release))) throw error(400);
    const roots = release ? {web:'releases/'+release+'/web',story:'releases/'+release+'/story'} : await sourceRoots(scope);
    const manifest = JSON.parse(await readFile(roots.web,'catalog/manifest.json',scope));
    const chapter = JSON.parse(await readFile(roots.web,manifest.base_path.replace(/^\//,'')+'/chapters/'+id+'.json',scope));
    if (!chapter.csv_path) throw error(404);
    return {csv:await readFile(roots.story,chapter.csv_path,scope,true),label:'原文'};
  }
  async function stream(request, key, download=false, immutable=false,scope) {
    return objects.stream(request,await resolveFile(safe(key),scope),{download,immutable,release:/^releases\/([^/]+)\//.exec(key)?.[1]},scope);
  }
  async function route(request,ctx) {
    const url=new URL(request.url);
    let path;
    try { path=decodeURIComponent(url.pathname); } catch { throw error(400); }
    const pinned=url.searchParams.get('release');
    if(pinned!==null && !validRelease(pinned)) throw error(400);
    // Collaboration scripts and the legacy source alias pass through API authorization.
    if (path.startsWith('/api/source/') || (path.startsWith('/api/script/') && url.searchParams.get('work')==='1')) return null;
    const publicSource=path.startsWith('/api/original/') || path.startsWith('/api/script/');
    const scope={request,ctx,checked:false};
    async function snapshot(){const info=pinned?{release:pinned}:await current(scope);if(!info)throw error(503);return info;}
    const handled=publicSource || path.startsWith('/data/') || path.startsWith('/catalog/') || path.startsWith('/media/') || path.startsWith('/images/') || path.startsWith('/api/media/') || path.startsWith('/api/resources/download/') || path==='/api/resources/versions' || path==='/api/resources/status';
    if(!handled) return null;
    if(!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
    safe(path.slice(1));
    if(publicSource) {
      const match=/^\/api\/(original|script)\/([\w-]{1,200})$/.exec(path);if(!match)throw error(400);
      const info=await snapshot(), root='releases/'+info.release;
      if(match[1]==='script') return jsonResponse(request,{txt:await readFile(root+'/adv',match[2]+'.txt',scope)},info.release,Boolean(pinned));
      const csv=(await sourceCsv(match[2],info.release,scope)).csv;
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(csv));
      const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
      return jsonResponse(request,{csv,label:'原文',sha256,scriptId:match[2]},info.release,Boolean(pinned));
    }
    if(path==='/api/resources/versions') {
      const info=await current(scope);
      return new Response(request.method==='HEAD'?null:JSON.stringify({revision:info?.versions?.revision ?? null,versions:versionList(info),release:info?.release ?? null}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    }
    if(path==='/api/resources/status') {
      const value=await status(scope);
      return new Response(request.method==='HEAD'?null:JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }
    if(path.startsWith('/api/resources/download/')) {
      const name=path.slice('/api/resources/download/'.length);
      if(!/^(idoly|campus)-resources-r[0-9]+-[a-f0-9]{12}\.tar\.gz$/.test(name))throw error(404);
      const info=await current(scope);
      if(!versionList(info).some(v=>v.filename===name)) throw error(404);
      if(env.IDOLY_R2_PUBLIC_BASE_URL || env.CAMPUS_R2_PUBLIC_BASE_URL) {
        const base=new URL(env.IDOLY_R2_PUBLIC_BASE_URL || env.CAMPUS_R2_PUBLIC_BASE_URL);if(base.protocol!=='https:') throw error(503);
        return new Response(null,{status:302,headers:{Location:base.href.replace(/\/$/,'')+'/'+prefix+'/downloads/'+name,'Cache-Control':'no-store'}});
      }
      return stream(request,'downloads/'+name,true,false,scope);
    }
    if(path.startsWith('/media/')) {
      if(!/^\/media\/[a-f0-9]{64}\/[^/]{1,240}\.(?:webp|png|jpe?g|svg|wav|flac|ogg|mp3|m4a|mp4|webm)$/.test(path)) throw error(404);
      return stream(request,path.slice(1),false,true,scope);
    }
    if(path.startsWith('/api/media/')) {
      const match=/^\/api\/media\/(image|voice|video)\/(.+)$/.exec(path);
      if(!match) throw error(404);
      if(!({image:/\.(?:webp|png|jpe?g|svg)$/,voice:/\.(?:wav|flac|ogg|mp3|m4a)$/,video:/\.(?:mp4|webm)$/}[match[1]].test(match[2])))throw error(404);
      const info=await snapshot();
      return stream(request,'releases/'+info.release+'/media/'+match[1]+'/'+safe(match[2]),false,Boolean(pinned),scope);
    }
    if(path.startsWith('/images/')) {
      if(!/\.(?:webp|png|jpe?g|svg)$/.test(path))throw error(404);
      const info=await snapshot();
      return stream(request,'releases/'+info.release+'/web/'+safe(path.slice(1)),false,Boolean(pinned),scope);
    }
    if(path==='/catalog/manifest.json') {
      const info=await snapshot();
      return stream(request,'releases/'+safe(info.release)+'/web/catalog/manifest.json',false,Boolean(pinned),scope);
    }
    if(path.startsWith('/data/stories/')) {
      if(!/^\/data\/stories\/[\w-]{1,200}\.json$/.test(path)) throw error(404);
      const info=await snapshot();
      const key=await resolveFile('releases/'+info.release+'/web/'+path.slice(1),scope);
      const story=await objects.publicText(key,'story',raw=>JSON.stringify(originalStory(JSON.parse(raw))),scope);
      return jsonResponse(request,JSON.parse(story),info.release,Boolean(pinned));
    }
    if(path.startsWith('/data/') || (path.startsWith('/catalog/') && !path.startsWith('/catalog/releases/'))) {
      if(path.startsWith('/data/')?!/^\/data\/(?:(?:catalog|directory|updates|music|glossary)\.json|media\/[\w-]{1,200}\.json)$/.test(path):!validCatalog(path.slice('/catalog/'.length)))throw error(404);
      const info=await snapshot();
      return stream(request,'releases/'+safe(info.release)+'/web/'+safe(path.slice(1)),false,Boolean(pinned),scope);
    }
    const match=/^\/catalog\/releases\/([^/]+)\/(.+)$/.exec(path);
    if(!match || !validRelease(match[1]) || !validCatalog(match[2])) throw error(404);
    return stream(request,'releases/'+safe(match[1])+'/web/catalog/'+safe(match[2]),false,true,scope);
  }
  return {route,sourceRoots,sourceCsv,readFile,status};
}
