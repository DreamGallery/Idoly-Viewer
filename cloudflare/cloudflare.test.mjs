import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {getPlatformProxy, createTestHarness} from 'wrangler';
import {sessionStore} from './session.mjs';
import {resources} from './resources.mjs';

async function fixture(fn) {
  const proxy=await getPlatformProxy({configPath:'wrangler.jsonc',persist:false});
  try {await fn(proxy.env.RESOURCES,proxy.env.DB);} finally {await proxy.dispose();}
}
test('D1 encrypted sessions survive new store instances; OAuth consumption is atomic',()=>fixture(async (_bucket,db)=>{
  await db.exec((await readFile(new URL('./migrations/0001_sessions.sql',import.meta.url),'utf8')).replace(/\n/g,' '));
  const secret='test-secret-'.repeat(4);
  const a=sessionStore(db,secret,'session'), b=sessionStore(db,secret,'session');
  await a.set('cookie-id',{token:'private-github-token',expires:Date.now()+60000});
  const raw=await db.prepare('SELECT * FROM auth_state').first();
  assert.notEqual(raw.id,'cookie-id');assert.ok(!raw.value.includes('private-github-token'));
  assert.equal((await b.get('cookie-id')).token,'private-github-token');
  const rotated=sessionStore(db,'new-secret-'.repeat(4),'session');
  assert.equal(await rotated.get('cookie-id'),undefined);
  await assert.rejects(()=>sessionStore(db,'short','session').get('cookie-id'),/SESSION_SECRET/);
  await db.prepare('UPDATE auth_state SET value=? WHERE namespace=?').bind('invalid-base64!', 'session').run();
  assert.equal(await a.get('cookie-id'),undefined);
  await b.delete('cookie-id');assert.equal(await a.get('cookie-id'),undefined);
  await a.set('expired',{expires:1});assert.equal(await b.get('expired'),undefined);
  const oauth=sessionStore(db,secret,'oauth');await oauth.set('state',{expires:Date.now()+60000});
  const taken=await Promise.all([oauth.take('state'),oauth.take('state')]);assert.equal(taken.filter(Boolean).length,1);
}));
test('R2 routes cold start, immutable catalog, source reads, range and download allowlist',()=>fixture(async bucket=>{
  const data=resources({RESOURCES:bucket,CAMPUS_R2_PREFIX:'test'});
  assert.equal((await data.status()).state,'initializing');
  await assert.rejects(()=>data.sourceRoots(),{status:503});
  const name='campus-resources-r63-abcdef123456.tar.gz';
  await bucket.put('test/current.json',JSON.stringify({release:'r1',versions:{revision:63,versions:[{filename:name}]}}));
  await bucket.put('test/releases/r1/web/catalog/manifest.json',JSON.stringify({base_path:'/catalog/releases/r1/builds/x'}));
  await bucket.put('test/releases/r1/web/catalog/builds/x/chapters/adv_a.json','{"csv_path":"CSV/a.csv"}');
  await bucket.put('test/releases/r1/story/CSV/a.csv','name,text');
  await bucket.put('test/downloads/'+name,'0123456789');
  const req=(path,opts)=>new Request('https://site.test'+path,opts);
  assert.equal((await data.status()).revision,63);
  const roots=await data.sourceRoots();assert.equal(await data.readFile(roots.story,'CSV/a.csv'),'name,text');
  assert.ok(await data.readFile(roots.web,'catalog/releases/r1/builds/x/chapters/adv_a.json'));
  await assert.rejects(()=>data.readFile(roots.story,'../secret'),{status:400});
  await assert.rejects(()=>data.readFile(roots.web,'catalog/releases/r2/manifest.json'),{status:400});
  assert.equal((await data.route(req('/catalog/manifest.json'))).status,200);
  const response=await data.route(req('/api/resources/download/'+name,{headers:{Range:'bytes=2-5'}}));
  assert.equal(response.status,206);assert.equal(await response.text(),'2345');
  assert.equal((await data.route(req('/api/resources/download/'+name,{headers:{Range:'bytes=30-'}}))).status,416);
  assert.equal((await data.route(req('/api/resources/download/'+name,{method:'HEAD'}))).headers.get('Content-Length'),'10');
  await assert.rejects(()=>data.route(req('/api/resources/download/campus-resources-r1-111111111111.tar.gz')),{status:404});
  const direct=resources({RESOURCES:bucket,CAMPUS_R2_PREFIX:'test',CAMPUS_R2_PUBLIC_BASE_URL:'https://assets.test'});
  assert.equal((await direct.route(req('/api/resources/download/'+name))).headers.get('Location'),'https://assets.test/test/downloads/'+name);
}));

test('actual Workers runtime serves SPA, Node API, R2 text, OAuth state and logout',async()=>{
  const secret='integration-secret-'.repeat(4);
  const harness=createTestHarness({workers:[{configPath:'wrangler.jsonc',secrets:{SESSION_SECRET:secret,GITHUB_CLIENT_ID:'test-id',GITHUB_CLIENT_SECRET:'test-secret'}}]});
  try {
    await harness.listen();
    const worker=harness.getWorker();const env=await worker.getEnv();
    await env.DB.exec((await readFile(new URL('./migrations/0001_sessions.sql',import.meta.url),'utf8')).replace(/\n/g,' '));
    const get=(path,init)=>harness.fetch('http://127.0.0.1:8788'+path,init);
    assert.equal((await (await get('/api/health')).json()).ok,true);
    assert.equal((await get('/workbench')).headers.get('Content-Type').includes('text/html'),true);
    assert.equal((await get('/api/source/adv_demo')).status,503);
    await env.RESOURCES.put('idoly-v1/current.json',JSON.stringify({release:'r1',versions:{revision:62,versions:[]}}));
    await env.RESOURCES.put('idoly-v1/releases/r1/web/catalog/manifest.json',JSON.stringify({base_path:'/catalog/releases/r1/builds/x'}));
    await env.RESOURCES.put('idoly-v1/releases/r1/web/catalog/builds/x/chapters/adv_demo.json',JSON.stringify({csv_path:'CSV/demo.csv'}));
    await env.RESOURCES.put('idoly-v1/releases/r1/story/CSV/demo.csv','name,text\n咲季,你好');
    await env.RESOURCES.put('idoly-v1/releases/r1/adv/adv_demo.txt','original script');
    assert.equal((await (await get('/api/source/adv_demo')).json()).csv,'name,text\n咲季,你好');
    assert.equal((await (await get('/api/script/adv_demo')).json()).txt,'original script');
    await env.RESOURCES.put('idoly-v1/releases/r1/web/data/catalog.json','{"stories":[]}');
    assert.deepEqual(await (await get('/data/catalog.json')).json(),{stories:[]});
    for(const path of ['/images/missing.png','/api/media/voice/missing.wav','/data/missing.json','/catalog/missing.json']) {
      const missing=await get(path);assert.equal(missing.status,404);assert.match(missing.headers.get('Content-Type'),/application\/json/);
    }
    await env.RESOURCES.put('idoly-v1/releases/r1/media/voice/demo.wav','0123456789');
    const audio=await get('/api/media/voice/demo.wav',{headers:{Range:'bytes=3-6'}});
    assert.equal(audio.status,206);assert.equal(audio.headers.get('Content-Type'),'audio/wav');assert.equal(await audio.text(),'3456');
    await env.RESOURCES.put('idoly-v1/current.json',JSON.stringify({release:'r2'}));
    const pinnedCsv=await (await get('/api/source/adv_demo?release=r1')).json();
    assert.equal(pinnedCsv.csv,'name,text\n咲季,你好');assert.match(pinnedCsv.sha256,/^[a-f0-9]{64}$/);
    assert.equal((await (await get('/api/script/adv_demo?release=r1')).json()).txt,'original script');
    const login=await get('/api/auth/login?returnTo=/workbench',{redirect:'manual'});
    assert.equal(login.status,302);const location=new URL(login.headers.get('Location'));const state=location.searchParams.get('state');
    const flow=await sessionStore(env.DB,secret,'oauth').get(state);assert.equal(flow.returnTo,'/workbench');
    const callback='/api/auth/callback?state='+state;
    assert.equal((await get(callback,{headers:{Cookie:'campus_oauth='+state}})).status,400);
    assert.equal(await sessionStore(env.DB,secret,'oauth').get(state),undefined);
    const sessions=sessionStore(env.DB,secret,'session');await sessions.set('test-cookie',{token:'fake',csrf:'csrf-test',expires:Date.now()+60000});
    const logout=await get('/api/auth/logout',{method:'POST',headers:{Origin:'http://127.0.0.1:8788',Cookie:'idoly_session=test-cookie','X-CSRF-Token':'csrf-test'},body:'{}'});
    assert.equal(logout.status,200);assert.equal(await sessions.get('test-cookie'),undefined);
  } finally {await harness.close();}
});


test('content-addressed release maps serve CSV, TXT and catalog; older releases still work',()=>fixture(async bucket=>{
  const data=resources({RESOURCES:bucket,CAMPUS_R2_PREFIX:'mapped'});
  const csv='text/'+'a'.repeat(64)+'/demo.csv', txt='text/'+'b'.repeat(64)+'/demo.txt', catalog='text/'+'c'.repeat(64)+'/manifest.json';
  await bucket.put('mapped/'+csv,'name,text\n咲季,你好');
  await bucket.put('mapped/'+txt,'original script');
  await bucket.put('mapped/'+catalog,'{"base_path":"/catalog/releases/new/builds/x"}');
  await bucket.put('mapped/releases/new/file-map.json',JSON.stringify({schema_version:1,files:{'story/CSV/demo.csv':csv,'adv/demo.txt':txt,'web/catalog/manifest.json':catalog,'story/CSV/legacy.csv':'releases/old/story/CSV/demo.csv','story/CSV/bad.csv':'../secret'}}));
  await bucket.put('mapped/current.json',JSON.stringify({release:'new',versions:{revision:62,versions:[]}}));
  const roots=await data.sourceRoots();
  assert.equal(await data.readFile(roots.story,'CSV/demo.csv'),'name,text\n咲季,你好');
  assert.equal(await data.readFile(roots.adv,'demo.txt'),'original script');
  const res=await data.route(new Request('https://site.test/catalog/manifest.json'));
  assert.equal(res.status,200);assert.equal((await res.json()).base_path,'/catalog/releases/new/builds/x');
  await assert.rejects(()=>data.readFile(roots.story,'CSV/absent.csv'),{status:404});
  await assert.rejects(()=>data.readFile(roots.story,'CSV/bad.csv'),{status:503});
  await bucket.put('mapped/releases/old/story/CSV/demo.csv','legacy');
  assert.equal(await data.readFile('releases/old/story','CSV/demo.csv'),'legacy');
  assert.equal(await data.readFile(roots.story,'CSV/legacy.csv'),'legacy');
}));

test('Idoly snapshot routes preserve MIME, ranges, HEAD, pointer switches and missing resources',()=>fixture(async bucket=>{
  const data=resources({RESOURCES:bucket,IDOLY_R2_PREFIX:'idoly'});
  const req=(path,opts)=>new Request('https://site.test'+path,opts);
  const media='media/'+'d'.repeat(64)+'/voice.wav';
  const files={};
  for(const path of ['web/data/catalog.json','web/data/directory.json','web/data/updates.json','web/data/media/400001.json','web/catalog/manifest.json']){
    files[path]='releases/first/'+path;await bucket.put('idoly/'+files[path],'{"ok":true}');
  }
  files['media/voice/voice.wav']=media;files['media/video/card.mp4']='media/'+'e'.repeat(64)+'/card.mp4';
  files['media/image/card.webp']='media/'+'f'.repeat(64)+'/card.webp';files['web/images/characters/test.png']='media/'+'a'.repeat(64)+'/test.png';
  for(const target of [media,files['media/video/card.mp4'],files['media/image/card.webp'],files['web/images/characters/test.png']])await bucket.put('idoly/'+target,'0123456789');
  await bucket.put('idoly/releases/first/file-map.json',JSON.stringify({schema_version:1,files}));
  await bucket.put('idoly/current.json',JSON.stringify({schema_version:1,release:'first'}));
  for(const path of ['/data/catalog.json','/data/directory.json','/data/updates.json','/data/media/400001.json','/catalog/releases/first/manifest.json'])assert.equal((await data.route(req(path))).status,200);
  for(const [path,type] of [['/api/media/voice/voice.wav','audio/wav'],['/api/media/video/card.mp4','video/mp4'],['/api/media/image/card.webp','image/webp'],['/images/characters/test.png','image/png']]){
    const full=await data.route(req(path));assert.equal(full.headers.get('Content-Type'),type);assert.equal(full.headers.get('Cache-Control'),'no-store');
    const etag=full.headers.get('ETag');assert.equal(await full.text(),'0123456789');
    for(const [range,body] of [['bytes=2-5','2345'],['bytes=-3','789'],['bytes=7-','789'],['bytes=0-99','0123456789']]){
      const res=await data.route(req(path,{headers:{Range:range}}));assert.equal(res.status,206);assert.equal(await res.text(),body);
    }
    for(const range of ['bytes=-0','bytes=30-','bytes=5-2','bytes=0-1,3-4','bytes=-','bytes=9007199254740992-'])assert.equal((await data.route(req(path,{headers:{Range:range}}))).status,416);
    const head=await data.route(req(path,{method:'HEAD',headers:{Range:'bytes=2-5'}}));assert.equal(head.status,206);assert.equal(head.headers.get('Content-Length'),'4');assert.equal(await head.text(),'');
    assert.equal((await data.route(req(path,{headers:{Range:'bytes=2-5','If-Range':'"stale"'}}))).status,200);
    assert.equal((await data.route(req(path,{headers:{'If-None-Match':etag}}))).status,304);
    assert.equal((await data.route(req(path,{method:'POST'}))).status,405);
  }
  for(const path of ['/api/media/image/missing.webp','/api/media/other/a','/images/missing.png','/data/missing.json'])await assert.rejects(()=>data.route(req(path)),{status:404});
  await assert.rejects(()=>data.route(req('/api/media/image/a%2F..%2Fb')),{status:400});
  await assert.rejects(()=>data.route(req('/data/%FF')),{status:400});
  assert.match((await data.route(req('/'+media))).headers.get('Cache-Control'),/immutable/);
  await bucket.put('idoly/releases/second/web/data/catalog.json','{"new":true}');
  await bucket.put('idoly/current.json',JSON.stringify({schema_version:1,release:'second'}));
  assert.deepEqual(await (await data.route(req('/data/catalog.json'))).json(),{new:true});
  assert.deepEqual(await (await data.route(req('/catalog/releases/first/manifest.json'))).json(),{ok:true});
  const pinned=await data.route(req('/data/catalog.json?release=first'));
  assert.deepEqual(await pinned.json(),{ok:true});assert.equal(pinned.headers.get('X-Idoly-Release'),'first');assert.match(pinned.headers.get('Cache-Control'),/immutable/);
  const pinnedAudio=await data.route(req('/api/media/voice/voice.wav?release=first',{headers:{Range:'bytes=-3'}}));
  assert.equal(await pinnedAudio.text(),'789');assert.equal(pinnedAudio.headers.get('X-Idoly-Release'),'first');
  await assert.rejects(()=>data.route(req('/data/catalog.json?release=missing')),{status:404});
  await assert.rejects(()=>data.route(req('/data/catalog.json?release=../bad')),{status:400});
}));

test('download endpoint exposes only the latest five Idoly archives and streams byte ranges',()=>fixture(async bucket=>{
 const data=resources({RESOURCES:bucket,IDOLY_R2_PREFIX:'downloads'});
 const versions=Array.from({length:6},(_,i)=>({revision:100-i,from_revision:99-i,filename:`idoly-resources-r${100-i}-abcdef123456.tar.gz`,bytes:10,sha256:'a'.repeat(64),created_at:'2026-10-01T00:00:00Z'}));
 await bucket.put('downloads/current.json',JSON.stringify({release:'r100',versions:{revision:100,versions}}));
 for(const version of versions)await bucket.put('downloads/downloads/'+version.filename,'0123456789',{httpMetadata:{contentType:'application/x-tar'}});
 const req=(path,init)=>new Request('https://site.test'+path,init);
 const listed=await (await data.route(req('/api/resources/versions'))).json();assert.equal(listed.versions.length,5);assert.equal(listed.versions[0].revision,100);
 for(const version of versions.slice(0,5)){
  const response=await data.route(req('/api/resources/download/'+version.filename,{headers:{Range:'bytes=3-6'}}));
  assert.equal(response.status,206);assert.equal(await response.text(),'3456');assert.equal(response.headers.get('Content-Type'),'application/gzip');assert.match(response.headers.get('Content-Disposition'),/attachment/);
 }
 await assert.rejects(()=>data.route(req('/api/resources/download/'+versions[5].filename)),{status:404});
}));

test('sharded maps hash UTF-8 paths, lazily cache a bounded working set and preserve flat entries',()=>fixture(async bucket=>{
 const reads=new Map();
 const observed={get:async(key,...rest)=>{reads.set(key,(reads.get(key)||0)+1);return bucket.get(key,...rest)},head:key=>bucket.head(key)};
 const data=resources({RESOURCES:observed,IDOLY_R2_PREFIX:'sharded'});
 const shards={}, paths=[];
 for(let i=0;paths.length<20;i++){
  const logical=`story/章节_${i}.csv`, shard=createHash('sha256').update(logical,'utf8').digest('hex').slice(0,2);
  if(shards[shard])continue;
  const shardKey=`releases/s1/maps/${shard}.json`, target='text/'+createHash('sha256').update(logical).digest('hex')+'/chapter.csv';
  shards[shard]=shardKey;paths.push({logical,shardKey});
  await bucket.put('sharded/'+target,logical);
  await bucket.put('sharded/'+shardKey,JSON.stringify({files:{[logical]:target}}));
 }
 await bucket.put('sharded/releases/s1/story/flat.csv','legacy-flat');
 await bucket.put('sharded/releases/s1/file-map.json',JSON.stringify({schema_version:1,files:{'story/flat.csv':'releases/s1/story/flat.csv'},shards}));
 const read=path=>data.readFile('releases/s1/story',path.logical.slice(6));
 assert.equal(await read(paths[0]),paths[0].logical);assert.equal(await read(paths[0]),paths[0].logical);
 assert.equal(reads.get('sharded/'+paths[0].shardKey),1);
 assert.equal([...reads.keys()].filter(key=>key.includes('/maps/')).length,1);
 assert.equal(await data.readFile('releases/s1/story','flat.csv'),'legacy-flat');
 for(const path of paths.slice(1))assert.equal(await read(path),path.logical);
 assert.equal(await read(paths[0]),paths[0].logical);
 assert.equal(reads.get('sharded/'+paths[0].shardKey),2,'oldest shard is evicted after 16 shard entries');
 assert.equal(reads.get('sharded/releases/s1/file-map.json'),1);
 await assert.rejects(()=>data.readFile('releases/s1/story','absent.csv'),{status:404});
 const missing='story/missing.csv', tag=createHash('sha256').update(missing).digest('hex').slice(0,2);
 await bucket.put('sharded/releases/s2/file-map.json',JSON.stringify({schema_version:1,files:{},shards:{[tag]:`releases/s2/maps/${tag}.json`}}));
 await assert.rejects(()=>data.readFile('releases/s2/story','missing.csv'),{status:503});
 await bucket.put(`sharded/releases/s2/maps/${tag}.json`,JSON.stringify({files:{[missing]:'releases/s1/story/flat.csv'}}));
 assert.equal(await data.readFile('releases/s2/story','missing.csv'),'legacy-flat','a missing shard is not cached');
 await bucket.put('sharded/releases/unsafe/file-map.json',JSON.stringify({schema_version:1,files:{},shards:{[tag]:'releases/s1/maps/'+tag+'.json'}}));
 await assert.rejects(()=>data.readFile('releases/unsafe/story','missing.csv'),{status:503});
}));

test('oversized root and shard maps are rejected before JSON is read',async()=>{
 let texts=0;
 const tooLarge=size=>({size,text:async()=>{texts++;return '{}'}});
 let bucket={get:async()=>tooLarge(8*1024*1024+1)};
 await assert.rejects(()=>resources({RESOURCES:bucket}).readFile('releases/r1/story','a.csv'),{status:503});
 assert.equal(texts,0);
 const logical='story/a.csv',tag=createHash('sha256').update(logical).digest('hex').slice(0,2);
 const root=JSON.stringify({schema_version:1,files:{},shards:{[tag]:`releases/r1/maps/${tag}.json`}});
 bucket={get:async key=>key.endsWith('/file-map.json')?{size:root.length,text:async()=>root}:tooLarge(2*1024*1024+1)};
 await assert.rejects(()=>resources({RESOURCES:bucket}).readFile('releases/r1/story','a.csv'),{status:503});assert.equal(texts,0);
});

test('FLAC streams directly with ranges and HEAD; retired WAV aliases are ignored',()=>fixture(async bucket=>{
 const data=resources({RESOURCES:{head:key=>bucket.head(key),get:(key,...args)=>{
  assert.ok(!key.includes('/voice-flac/'),'Worker must not read retired migration aliases');
  return bucket.get(key,...args);
 }},IDOLY_R2_PREFIX:'flactest'}),old='media/'+'a'.repeat(64)+'/voice.wav',replacement='media/'+'b'.repeat(64)+'/voice.flac';
 await bucket.put('flactest/current.json',JSON.stringify({release:'new'}));
 await bucket.put('flactest/releases/old/file-map.json',JSON.stringify({schema_version:1,files:{'media/voice/voice.wav':old}}));
 await bucket.put('flactest/releases/new/file-map.json',JSON.stringify({schema_version:1,files:{'media/voice/voice.flac':replacement}}));
 await bucket.put('flactest/'+replacement,'fLaC0123456789');
 const req=(path,opts)=>new Request('https://site.test'+path,opts);
 const versions=await (await data.route(req('/api/resources/versions'))).json();
 assert.ok(!('voice_flac_aliases' in versions));assert.equal(versions.release,'new');
 await bucket.put('flactest/voice-flac/aa.json',JSON.stringify({files:{[old]:replacement}}));
 await assert.rejects(()=>data.route(req('/api/media/voice/voice.wav?release=old')),{status:404});
 await assert.rejects(()=>data.route(req('/'+old)),{status:404});
 let response=await data.route(req('/api/media/voice/voice.flac?release=new'));
 assert.equal(response.headers.get('Content-Type'),'audio/flac');assert.equal(response.headers.get('X-Idoly-Release'),'new');assert.equal(await response.text(),'fLaC0123456789');
 response=await data.route(req('/'+replacement,{headers:{Range:'bytes=0-3'}}));assert.equal(response.status,206);assert.equal(await response.text(),'fLaC');
 response=await data.route(req('/api/media/voice/voice.flac',{method:'HEAD'}));assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'audio/flac');
 assert.equal(await response.text(),'');assert.equal(response.headers.get('Content-Length'),'14');
}));

test('music catalog, jacket and FLAC use the same pinned release with ranges',()=>fixture(async bucket=>{
 const data=resources({RESOURCES:bucket,IDOLY_R2_PREFIX:'music'});
 const req=(path,init)=>new Request('https://site.test'+path,init);
 await bucket.put('music/current.json',JSON.stringify({release:'old'}));
 await assert.rejects(()=>data.route(req('/data/music.json')),{status:404});
 const audio='media/'+ 'a'.repeat(64)+'/sud_music_short_hsm-001.flac';
 const cover='media/'+ 'b'.repeat(64)+'/img_music_jacket_hsm-001.webp';
 const catalog='text/'+ 'c'.repeat(64)+'/music.json';
 await bucket.put('music/'+audio,'fLaC0123456789');await bucket.put('music/'+cover,'RIFF0123WEBP');
 await bucket.put('music/'+catalog,JSON.stringify({tracks:[{id:'hsm-001',audio:'/api/media/voice/sud_music_short_hsm-001.flac',cover:'/api/media/image/img_music_jacket_hsm-001.webp'}]}));
 await bucket.put('music/releases/new/file-map.json',JSON.stringify({schema_version:1,files:{'web/data/music.json':catalog,'media/voice/sud_music_short_hsm-001.flac':audio,'media/image/img_music_jacket_hsm-001.webp':cover}}));
 await bucket.put('music/current.json',JSON.stringify({release:'new'}));
 const index=await data.route(req('/data/music.json'));assert.equal(index.headers.get('X-Idoly-Release'),'new');assert.equal((await index.json()).tracks.length,1);
 await bucket.put('music/current.json',JSON.stringify({release:'future'}));
 const voice=await data.route(req('/api/media/voice/sud_music_short_hsm-001.flac?release=new',{headers:{Range:'bytes=0-3'}}));
 assert.equal(voice.status,206);assert.equal(voice.headers.get('Content-Type'),'audio/flac');assert.equal(await voice.text(),'fLaC');
 const jacket=await data.route(req('/api/media/image/img_music_jacket_hsm-001.webp?release=new'));assert.equal(jacket.status,200);assert.equal(jacket.headers.get('Content-Type'),'image/webp');
}));
