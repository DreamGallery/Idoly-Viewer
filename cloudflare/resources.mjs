const contentType = key => ({json:'application/json; charset=utf-8',csv:'text/csv; charset=utf-8',txt:'text/plain; charset=utf-8',webp:'image/webp',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml',wav:'audio/wav',flac:'audio/flac',ogg:'audio/ogg',mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'video/mp4',webm:'video/webm',gz:'application/gzip'}[key.split('.').pop().toLowerCase()] || 'application/octet-stream');
const jsonResponse = (request, value, release) => new Response(request.method==='HEAD'?null:JSON.stringify(value), {headers:{'Content-Type':'application/json; charset=utf-8','X-Idoly-Release':release,'Cache-Control':'public, max-age=31536000, immutable'}});
const error = status => Object.assign(new Error('Resource unavailable'), {status});
const safe = value => {
  if (typeof value !== 'string' || !value || value.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f]/.test(value)) throw error(400);
  return value;
};
export function resources(env) {
  const prefix = safe(env.IDOLY_R2_PREFIX || env.CAMPUS_R2_PREFIX || 'idoly-v1');
  const bucket = env.RESOURCES;
  async function text(key) {
    const obj = await bucket.get(prefix + '/' + safe(key));
    if (!obj) throw error(404);
    return obj.text();
  }
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
  async function loadMap(key,cache,maxSize,root=false) {
    const cached=cache.get(key);if(cached)return cached;
    const obj=await bucket.get(prefix+'/'+key);if(!obj)return null;
    if(obj.size>maxSize)throw error(503);
    const raw=await obj.text();if(new TextEncoder().encode(raw).byteLength>maxSize)throw error(503);
    const map=JSON.parse(raw);
    if(!dictionary(map.files) || (root && map.schema_version!==1) || (map.shards!==undefined && !dictionary(map.shards)))throw error(503);
    cache.set(key,map,raw.length*2);return map;
  }
  async function resolveFile(key) {
    safe(key);
    const match=/^releases\/([^/]+)\/(web\/.*|story\/.*|adv\/.*|media\/.*)$/.exec(key);
    if(!match)return key;
    const release=match[1], logical=match[2];
    const map=await loadMap('releases/'+release+'/file-map.json',maps,8*1024*1024,true);
    // Legacy direct-object releases have no map. Never cache a missing object.
    if(!map)return key;
    let target=map.files[logical];
    if(!target && map.shards){
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(logical)));
      const shard=hash[0].toString(16).padStart(2,'0'), shardKey=map.shards[shard];
      if(shardKey){
        // A map can select only this release's deterministic shard path.
        if(shardKey!=='releases/'+release+'/maps/'+shard+'.json')throw error(503);
        const fragment=await loadMap(shardKey,shards,2*1024*1024);
        if(!fragment)throw error(503);
        target=fragment.files[logical];
      }
    }
    if(!target)throw error(404);
    if(typeof target!=='string' || (!/^(text|media)\/[a-f0-9]{64}\/[^/]+$/.test(target) && !/^releases\/[^/]+\/(web|story|adv|media)\/.+/.test(target)))throw error(503);
    return safe(target);
  }
  async function current() {
    try { const info = JSON.parse(await text('current.json')); if (!info || typeof info.release !== 'string' || !/^[A-Za-z0-9_-]+$/.test(info.release)) throw error(503); return info; }
    catch(e) { if(e.status === 404) return null; throw e; }
  }
  function versionList(info) { return Array.isArray(info?.versions?.versions) ? info.versions.versions.slice(0,5) : []; }
  async function sourceRoots() {
    const info = await current(); if (!info) throw error(503);
    const root = 'releases/' + safe(info.release);
    return {web:root+'/web',story:root+'/story',adv:root+'/adv'};
  }
  async function readFile(root, relative) {
    // Catalog base_path is a public versioned URL; map it back to this release.
    const catalog = /^catalog\/releases\/([^/]+)\/(.+)$/.exec(relative);
    if(catalog) {
      if(root !== 'releases/'+catalog[1]+'/web') throw error(400);
      relative = 'catalog/'+catalog[2];
    }
    return text(await resolveFile(safe(root)+'/'+safe(relative)));
  }
  async function stream(request, key, download=false, immutable=false) {
    const headers = new Headers({'X-Content-Type-Options':'nosniff','Cache-Control':immutable?'public, max-age=31536000, immutable':'no-store','Accept-Ranges':'bytes'});
    const resolved = await resolveFile(safe(key));
    const fullKey = prefix+'/'+resolved;
    const release=/^releases\/([^/]+)\//.exec(key)?.[1];
    if(release) headers.set('X-Idoly-Release',release);
    const head = await bucket.head(fullKey);
    if(!head) throw error(404);
    head.writeHttpMetadata(headers); headers.set('ETag',head.httpEtag);
    if (!headers.has('Content-Type')) headers.set('Content-Type', contentType(resolved));
    headers.set('Cache-Control',immutable?'public, max-age=31536000, immutable':'no-store');
    if(download) {headers.set('Content-Disposition', 'attachment; filename="'+key.split('/').pop()+'"');headers.set('Content-Type','application/gzip');}
    if(request.headers.get('If-None-Match') === head.httpEtag) return new Response(null,{status:304,headers});
    let start=0,end=head.size-1,status=200;
    const raw=request.headers.get('Range');
    if(raw && (!request.headers.get('If-Range') || request.headers.get('If-Range')===head.httpEtag)) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(raw);
      if(match) {start=match[1]?Number(match[1]):Math.max(0,head.size-Number(match[2]));end=match[1]&&match[2]?Math.min(Number(match[2]),end):end;}
      if(!match || (!match[1]&&!match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start>end || start>=head.size) {
        headers.set('Content-Range',`bytes */${head.size}`);return new Response(null,{status:416,headers});
      }
      status=206;headers.set('Content-Range',`bytes ${start}-${end}/${head.size}`);
    }
    headers.set('Content-Length', String(head.size ? end-start+1 : 0));
    if(request.method==='HEAD') return new Response(null,{status,headers});
    const obj=await bucket.get(fullKey,status===206?{range:{offset:start,length:end-start+1}}:{});
    if(!obj) throw error(404);
    return new Response(obj.body,{status,headers});
  }
  async function route(request) {
    const url=new URL(request.url);
    let path;
    try { path=decodeURIComponent(url.pathname); } catch { throw error(400); }
    const pinned=url.searchParams.get('release');
    if(pinned!==null && !/^[A-Za-z0-9_-]+$/.test(pinned)) throw error(400);
    const pinnedSource=pinned && /^\/api\/(source|script)\//.test(path);
    async function snapshot(){const info=pinned?{release:pinned}:await current();if(!info)throw error(503);return info;}
    const handled=pinnedSource || path.startsWith('/data/') || path.startsWith('/catalog/') || path.startsWith('/media/') || path.startsWith('/images/') || path.startsWith('/api/media/') || path.startsWith('/api/resources/download/') || path==='/api/resources/versions';
    if(!handled) return null;
    if(!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{Allow:'GET, HEAD'}});
    if(pinnedSource) {
      const match=/^\/api\/(source|script)\/([\w-]+)$/.exec(path);if(!match)throw error(400);
      const root='releases/'+pinned;
      if(match[1]==='script') return jsonResponse(request,{txt:await readFile(root+'/adv',match[2]+'.txt')},pinned);
      const manifest=JSON.parse(await readFile(root+'/web','catalog/manifest.json'));
      const chapter=JSON.parse(await readFile(root+'/web',manifest.base_path.replace(/^\//,'')+'/chapters/'+match[2]+'.json'));
      if(!chapter.csv_path)throw error(404);
      const csv=await readFile(root+'/story',chapter.csv_path);
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(csv));
      const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
      return jsonResponse(request,{csv,label:chapter.label || '仓库稿件',sha256,scriptId:match[2]},pinned);
    }
    if(path==='/api/resources/versions') {
      const info=await current();
      return new Response(request.method==='HEAD'?null:JSON.stringify({revision:info?.versions?.revision ?? null,versions:versionList(info),release:info?.release ?? null}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    }
    if(path.startsWith('/api/resources/download/')) {
      const name=path.slice('/api/resources/download/'.length), info=await current();
      if(!/^(idoly|campus)-resources-r[0-9]+-[a-f0-9]{12}\.tar\.gz$/.test(name) || !versionList(info).some(v=>v.filename===name)) throw error(404);
      if(env.IDOLY_R2_PUBLIC_BASE_URL || env.CAMPUS_R2_PUBLIC_BASE_URL) {
        const base=new URL(env.IDOLY_R2_PUBLIC_BASE_URL || env.CAMPUS_R2_PUBLIC_BASE_URL);if(base.protocol!=='https:') throw error(503);
        return new Response(null,{status:302,headers:{Location:base.href.replace(/\/$/,'')+'/'+prefix+'/downloads/'+name,'Cache-Control':'no-store'}});
      }
      return stream(request,'downloads/'+name,true);
    }
    if(path.startsWith('/media/')) {
      if(!/^\/media\/[a-f0-9]{64}\/[^/]+$/.test(path)) throw error(404);
      return stream(request,path.slice(1),false,true);
    }
    if(path.startsWith('/api/media/')) {
      const match=/^\/api\/media\/(image|voice|video)\/(.+)$/.exec(path);
      if(!match) throw error(404);
      const info=await snapshot();
      return stream(request,'releases/'+info.release+'/media/'+match[1]+'/'+safe(match[2]),false,Boolean(pinned));
    }
    if(path.startsWith('/images/')) {
      const info=await snapshot();
      return stream(request,'releases/'+info.release+'/web/'+safe(path.slice(1)),false,Boolean(pinned));
    }
    if(path==='/catalog/manifest.json') {
      const info=await snapshot();
      return stream(request,'releases/'+safe(info.release)+'/web/catalog/manifest.json',false,Boolean(pinned));
    }
    if(path.startsWith('/data/') || (path.startsWith('/catalog/') && !path.startsWith('/catalog/releases/'))) {
      const info=await snapshot();
      return stream(request,'releases/'+safe(info.release)+'/web/'+safe(path.slice(1)),false,Boolean(pinned));
    }
    const match=/^\/catalog\/releases\/([^/]+)\/(.+)$/.exec(path);
    if(!match) throw error(404);
    return stream(request,'releases/'+safe(match[1])+'/web/catalog/'+safe(match[2]),false,true);
  }
  return {route,sourceRoots,readFile,status:async()=>{
    const info=await current();return info?{state:'ready',revision:info.versions?.revision,release:info.release,last_success:info.published_at}:{state:'initializing',phase:'等待导入剧情资源'};
  }};
}
