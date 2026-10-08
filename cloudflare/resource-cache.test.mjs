import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getPlatformProxy} from 'wrangler';
import {resources} from './resources.mjs';

async function fixture(fn) {
  const proxy=await getPlatformProxy({configPath:'wrangler.jsonc',persist:false});
  try {await fn(proxy.env.RESOURCES);} finally {await proxy.dispose();}
}
function timedCache() {
  let now=0;
  const entries=new Map();
  return {
    entries,
    advance:seconds=>{now+=seconds;},
    async put(request,response) {
      assert.equal(request.method,'GET');assert.notEqual(response.status,206);
      assert.equal(response.headers.has('Set-Cookie'),false);
      const ttl=Number(/max-age=(\d+)/.exec(response.headers.get('Cache-Control'))?.[1]);
      assert.ok(ttl>0);
      entries.set(request.url,{body:await response.arrayBuffer(),headers:new Headers(response.headers),status:response.status,expires:now+ttl});
    },
    async match(request) {
      const row=entries.get(request.url);if(!row || row.expires<=now)return undefined;
      const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range')||'');
      if(range && row.status===200) {
        const start=Number(range[1]),end=Number(range[2]),headers=new Headers(row.headers);
        headers.set('Content-Length',String(end-start+1));headers.set('Content-Range',`bytes ${start}-${end}/${row.body.byteLength}`);
        return new Response(row.body.slice(start,end+1),{status:206,headers});
      }
      return new Response(row.body.slice(0),{status:row.status,headers:row.headers});
    },
  };
}
function countedBucket(bucket) {
  const calls={get:0,head:0},keys=[];
  return {calls,keys,bucket:{get:(...args)=>{calls.get++;keys.push(args[0]);return bucket.get(...args);},head:(...args)=>{calls.head++;keys.push(args[0]);return bucket.head(...args);}}};
}
const request=(path,init)=>new Request('https://site.test'+path,init);
test('immutable cache ignores query/cookie variants and preserves HEAD, ETag, If-Range and byte ranges',()=>fixture(async bucket=>{
  const key='media/'+'c'.repeat(64)+'/voice.flac';
  await bucket.put('cache/'+key,'0123456789',{httpMetadata:{contentType:'audio/flac'}});
  const counted=countedBucket(bucket),cache=timedCache();
  const data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'cache',CAMPUS_PUBLIC_ORIGIN:'https://site.test'},{cache});
  const first=await data.route(request('/'+key));const etag=first.headers.get('ETag');
  assert.equal(await first.text(),'0123456789');assert.deepEqual(counted.calls,{get:1,head:0});
  for(let i=0;i<5;i++)assert.equal(await(await data.route(request('/'+key+'?random='+i,{headers:{Cookie:'idoly_session=anything'}}))).text(),'0123456789');
  const head=await data.route(request('/'+key,{method:'HEAD'}));assert.equal(head.headers.get('Content-Length'),'10');assert.equal(await head.text(),'');
  const conditional=await data.route(request('/'+key,{headers:{'If-None-Match':'"other", W/'+etag}}));
  assert.equal(conditional.status,304);assert.equal(conditional.headers.has('Content-Length'),false);
  assert.equal((await data.route(request('/'+key,{headers:{'If-None-Match':'*'}}))).status,304);
  for(const [range,body] of [['bytes=2-5','2345'],['bytes=-3','789'],['bytes=7-','789'],['bytes=0-99','0123456789']]) {
    const response=await data.route(request('/'+key,{headers:{Range:range,'If-Range':etag}}));
    assert.equal(response.status,206);assert.equal(await response.text(),body);
  }
  const stale=await data.route(request('/'+key,{headers:{Range:'bytes=2-5','If-Range':'"stale"'}}));
  assert.equal(stale.status,200);assert.equal(await stale.text(),'0123456789');
  for(const range of ['bytes=-0','bytes=10-','bytes=0-1,4-5','bytes=9007199254740993-']) {
    const invalid=await data.route(request('/'+key,{headers:{Range:range}}));assert.equal(invalid.status,416);assert.equal(invalid.headers.get('Content-Length'),'0');
  }
  assert.deepEqual(counted.calls,{get:1,head:0});
}));
test('cold small range requests populate a complete object cache for later playback',()=>fixture(async bucket=>{
  const key='media/'+'d'.repeat(64)+'/voice.flac';
  await bucket.put('partial/'+key,'0123456789');
  const counted=countedBucket(bucket),cache=timedCache(),data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'partial'},{cache});
  assert.equal(await(await data.route(request('/'+key,{headers:{Range:'bytes=-3'}}))).text(),'789');
  assert.deepEqual(counted.calls,{get:1,head:1});
  assert.equal(cache.entries.size,1);
  const stored=[...cache.entries.values()][0];
  assert.equal(stored.status,200);assert.equal(new TextDecoder().decode(stored.body),'0123456789');
  assert.equal(await(await data.route(request('/'+key))).text(),'0123456789');
  assert.deepEqual(counted.calls,{get:1,head:1});
  assert.equal(await(await data.route(request('/'+key,{headers:{Range:'bytes=1-2'}}))).text(),'12');
  assert.deepEqual(counted.calls,{get:1,head:1});
}));

test('a denied concurrent pointer miss cannot reject a different allowed client',()=>fixture(async bucket=>{
  await bucket.put('clients/current.json','{"release":"r1"}');
  const counted=countedBucket(bucket),cache=timedCache();
  let enterDenied,releaseDenied;
  const entered=new Promise(resolve=>{enterDenied=resolve;});
  const gate=new Promise(resolve=>{releaseDenied=resolve;});
  const data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'clients'},{cache,allowMiss:async request=>{
    if(request.headers.get('CF-Connecting-IP')==='192.0.2.1') {enterDenied();await gate;return false;}
    return true;
  }});
  const denied=data.route(request('/api/resources/status',{headers:{'CF-Connecting-IP':'192.0.2.1'}})).catch(error=>error);
  await entered;
  const allowed=data.route(request('/api/resources/status',{headers:{'CF-Connecting-IP':'192.0.2.2'}})).catch(error=>error);
  releaseDenied();
  assert.equal((await denied).status,429);
  const response=await allowed;
  assert.equal(response.status,200,'a different IP must not inherit the first request’s 429');
  assert.equal((await response.json()).release,'r1');assert.deepEqual(counted.calls,{get:1,head:0});
}));

test('public original cache misses check each client before coalescing',()=>fixture(async bucket=>{
  const cache=timedCache(),counted=countedBucket(bucket);
  const csvKey='text/'+'a'.repeat(64)+'/demo.csv';
  await bucket.put('original-clients/'+csvKey,'id,name,text,trans\r\n1:text:1,A,原文,PRIVATE_TRANSLATION');
  await bucket.put('original-clients/releases/r1/web/catalog/manifest.json','{"base_path":"/catalog/releases/r1"}');
  await bucket.put('original-clients/releases/r1/web/catalog/chapters/adv_demo.json','{"csv_path":"demo.csv"}');
  await bucket.put('original-clients/releases/r1/file-map.json',JSON.stringify({schema_version:1,files:{
    'story/demo.csv':csvKey,'web/catalog/manifest.json':'releases/r1/web/catalog/manifest.json',
    'web/catalog/chapters/adv_demo.json':'releases/r1/web/catalog/chapters/adv_demo.json',
  }}));
  let enterDenied,releaseDenied;
  const entered=new Promise(resolve=>{enterDenied=resolve;});
  const gate=new Promise(resolve=>{releaseDenied=resolve;});
  const data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'original-clients'},{cache,allowMiss:async request=>{
    if(request.headers.get('CF-Connecting-IP')==='192.0.2.1') {enterDenied();await gate;return false;}
    return true;
  }});
  // Warm the map and chapter, leaving only the original CSV as a cache miss.
  await data.readFile('releases/r1/web','catalog/manifest.json');
  await data.readFile('releases/r1/web','catalog/chapters/adv_demo.json');
  const path='/api/original/adv_demo?release=r1';
  const denied=data.route(request(path,{headers:{'CF-Connecting-IP':'192.0.2.1'}})).catch(error=>error);
  await entered;
  const allowed=data.route(request(path,{headers:{'CF-Connecting-IP':'192.0.2.2'}})).catch(error=>error);
  await new Promise(setImmediate);
  releaseDenied();
  assert.equal((await denied).status,429);
  const response=await allowed;assert.equal(response.status,200);
  const value=await response.json();assert.ok(value.csv.includes('原文'));assert.ok(!value.csv.includes('PRIVATE_'));
}));

test('range cache fill streams across chunks and finishes caching after the partial response',async()=>{
  const cache=timedCache(),waits=[];
  const key='media/'+'8'.repeat(64)+'/chunked.flac';
  let gets=0;
  const metadata={size:10,httpEtag:'"chunked"',writeHttpMetadata:headers=>headers.set('Content-Type','audio/flac')};
  const data=resources({IDOLY_R2_PREFIX:'chunks',RESOURCES:{
    head:async()=>metadata,
    get:async()=>{
      gets++;
      const chunks=['01','234','5','6789'];
      return {...metadata,body:new ReadableStream({pull(controller){
        if(chunks.length)controller.enqueue(new TextEncoder().encode(chunks.shift()));else controller.close();
      }})};
    },
  }},{cache});
  const partial=await data.route(request('/'+key,{headers:{Range:'bytes=3-6'}}),{waitUntil:promise=>waits.push(promise)});
  assert.equal(partial.status,206);assert.equal(partial.headers.get('Content-Length'),'4');
  assert.equal(await partial.text(),'3456');
  await Promise.all(waits);
  assert.equal(await(await data.route(request('/'+key))).text(),'0123456789');assert.equal(gets,1);
  assert.equal([...cache.entries.values()][0].status,200);
});

test('large ranges and disabled caches request only the needed R2 bytes',async()=>{
  const key='media/'+'9'.repeat(64)+'/large.mp4',calls=[],cache=timedCache();
  let size=8*1024*1024+1;
  const metadata=()=>({size,httpEtag:'"large"',writeHttpMetadata:()=>{}});
  const bucket={head:async()=>metadata(),get:async(path,options)=>{
    calls.push({path,options});
    assert.deepEqual(options,{range:{offset:2,length:2}});
    return {...metadata(),body:new Response('23').body};
  }};
  for(const selectedCache of [cache,null]) {
    const data=resources({RESOURCES:bucket,IDOLY_R2_PREFIX:'bounded'},{cache:selectedCache});
    const partial=await data.route(request('/'+key,{headers:{Range:'bytes=2-3'}}));
    assert.equal(partial.status,206);assert.equal(await partial.text(),'23');
    size=10;
  }
  assert.equal(calls.length,2);assert.equal(cache.entries.size,0);
});
test('pointer and missing caches expire, old releases stay pinned and unknown releases do not probe arbitrary objects',()=>fixture(async bucket=>{
  const counted=countedBucket(bucket),cache=timedCache(),data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'versions'},{cache});
  async function seed(release,digit) {
    const key='text/'+digit.repeat(64)+'/manifest.json';
    await bucket.put('versions/'+key,JSON.stringify({base_path:'/catalog/releases/'+release}));
    await bucket.put('versions/releases/'+release+'/file-map.json',JSON.stringify({schema_version:1,files:{'web/catalog/manifest.json':key}}));
    await bucket.put('versions/current.json',JSON.stringify({release}));
  }
  await seed('r1','1');
  assert.match((await(await data.route(request('/catalog/manifest.json'))).json()).base_path,/r1/);
  const before=counted.calls.get;await seed('r2','2');
  assert.match((await(await data.route(request('/catalog/manifest.json?reload=1'))).json()).base_path,/r1/);assert.equal(counted.calls.get,before);
  cache.advance(31);
  assert.match((await(await data.route(request('/catalog/manifest.json'))).json()).base_path,/r2/);
  const old=await data.route(request('/catalog/releases/r1/manifest.json'));
  assert.match((await old.json()).base_path,/r1/);assert.equal(old.headers.get('X-Idoly-Release'),'r1');
  const missing='/media/'+'f'.repeat(64)+'/new.flac';
  await assert.rejects(()=>data.route(request(missing)),{status:404});const missCalls=counted.calls.get;
  await bucket.put('versions'+missing,'new-audio');
  await assert.rejects(()=>data.route(request(missing+'?bypass=1')),{status:404});assert.equal(counted.calls.get,missCalls);
  cache.advance(16);assert.equal(await(await data.route(request(missing))).text(),'new-audio');
  await assert.rejects(()=>data.route(request('/api/media/voice/no.flac?release=unknown')),{status:404});
  const unknownCalls=counted.calls.get;
  await assert.rejects(()=>data.route(request('/api/media/image/no.webp?release=unknown')),{status:404});
  assert.equal(counted.calls.get,unknownCalls);assert.ok(!counted.keys.some(key=>key.includes('unknown/media/')));
  cache.advance(16);
  await bucket.put('versions/releases/unknown/file-map.json',JSON.stringify({schema_version:1,files:{'media/voice/no.flac':missing.slice(1)}}));
  assert.equal(await(await data.route(request('/api/media/voice/no.flac?release=unknown'))).text(),'new-audio');
}));
test('malformed paths and denied misses never read R2; warm cache hits bypass the limiter',()=>fixture(async bucket=>{
  let allowed=false,checks=0;
  const counted=countedBucket(bucket),cache=timedCache();
  const data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'limits'},{cache,allowMiss:async()=>{checks++;return allowed;}});
  for(const path of ['/catalog/releases/no/version.txt','/api/resources/download/invalid','/media/not-a-hash/file.flac','/data/secrets.json','/api/media/voice/secret.csv','/images/secret.csv','/catalog/releases/no/chapters/adv_test.csv'])await assert.rejects(()=>data.route(request(path)),{status:404});
  assert.equal(checks,0);assert.deepEqual(counted.calls,{get:0,head:0});
  const key='media/'+'a'.repeat(64)+'/voice.flac';await bucket.put('limits/'+key,'audio');
  await assert.rejects(()=>data.route(request('/'+key)),{status:429});assert.deepEqual(counted.calls,{get:0,head:0});
  allowed=true;assert.equal(await(await data.route(request('/'+key))).text(),'audio');
  const previousChecks=checks;allowed=false;
  assert.equal(await(await data.route(request('/'+key+'?random=2'))).text(),'audio');assert.equal(checks,previousChecks);assert.deepEqual(counted.calls,{get:1,head:0});
}));
test('resource status and version polling share the cached pointer and cannot bypass miss limits',()=>fixture(async bucket=>{
  let allowed=false,checks=0;
  const cache=timedCache(),counted=countedBucket(bucket);
  const data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'polling'},{cache,allowMiss:async()=>{checks++;return allowed;}});
  await bucket.put('polling/current.json',JSON.stringify({release:'r1',published_at:'2026-01-01T00:00:00Z',versions:{revision:62,versions:[]}}));
  for(const path of ['/api/resources/status','/api/resources/versions'])await assert.rejects(()=>data.route(request(path)),{status:429});
  assert.deepEqual(counted.calls,{get:0,head:0});
  allowed=true;
  const status=await data.route(request('/api/resources/status'));
  assert.equal(status.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(await status.json(),{state:'ready',revision:62,release:'r1',last_success:'2026-01-01T00:00:00Z'});
  const before=checks;allowed=false;
  assert.equal((await(await data.route(request('/api/resources/versions?random=1'))).json()).release,'r1');
  const head=await data.route(request('/api/resources/status',{method:'HEAD'}));
  assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(checks,before);
  cache.advance(31);
  await assert.rejects(()=>data.route(request('/api/resources/status?random=2')),{status:429});
  assert.deepEqual(counted.calls,{get:1,head:0});
}));
test('private source CSV and legacy translations never enter the shared cache; originals cannot bypass authorization',()=>fixture(async bucket=>{
  const cache=timedCache(),counted=countedBucket(bucket),data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'privacy'},{cache});
  const csv='id,name,text,trans\r\n1:text:1,A,原文,PRIVATE_TRANSLATION\r\ninfo,adv_demo.txt,hash,\r\n译者,PRIVATE_CREDIT,,';
  const csvKey='text/'+'a'.repeat(64)+'/demo.csv',storyKey='text/'+'b'.repeat(64)+'/demo.json';
  await bucket.put('privacy/'+csvKey,csv);
  await bucket.put('privacy/'+storyKey,JSON.stringify({id:'adv_demo',title:'PRIVATE_TITLE',originalTitle:'原題',rows:[{id:'1:text:1',name:'A',text:'原文',trans:'PRIVATE_TRANSLATION',ai:'PRIVATE_AI'}]}));
  await bucket.put('privacy/releases/r1/web/catalog/manifest.json','{"base_path":"/catalog/releases/r1"}');
  await bucket.put('privacy/releases/r1/web/catalog/chapters/adv_demo.json','{"csv_path":"CSV/demo.csv","label":"仓库稿件"}');
  await bucket.put('privacy/releases/r1/file-map.json',JSON.stringify({schema_version:1,files:{'story/CSV/demo.csv':csvKey,'web/data/stories/adv_demo.json':storyKey,'web/catalog/manifest.json':'releases/r1/web/catalog/manifest.json','web/catalog/chapters/adv_demo.json':'releases/r1/web/catalog/chapters/adv_demo.json'}}));
  await bucket.put('privacy/current.json','{"release":"r1"}');
  assert.equal(await data.readFile('releases/r1/story','CSV/demo.csv'),csv);
  const original=await(await data.route(request('/api/original/adv_demo?release=r1'))).json();
  assert.ok(original.csv.includes('原文'));assert.ok(!original.csv.includes('PRIVATE_'));
  const legacy=await(await data.route(request('/data/stories/adv_demo.json?release=r1'))).json();assert.ok(!JSON.stringify(legacy).includes('PRIVATE_'));
  const before=counted.calls.get;
  await data.route(request('/api/original/adv_demo?release=r1&random=1',{headers:{Cookie:'idoly_session=x'}}));
  await data.route(request('/data/stories/adv_demo.json?release=r1&random=2'));assert.equal(counted.calls.get,before);
  for(const path of ['/api/source/adv_demo?release=r1','/api/script/adv_demo?work=1&release=r1','/api/collaboration/source/adv_demo'])assert.equal(await data.route(request(path)),null);
  assert.ok(!(await data.sourceCsv('adv_demo','r1')).csv.includes('PRIVATE_'));assert.equal(counted.calls.get,before,'source helper uses the original-only cache');
  assert.equal(await data.readFile('releases/r1/story','CSV/demo.csv'),csv);assert.equal(counted.calls.get,before+1,'raw internal reads must not populate a public cache');
  for(const [key,row] of cache.entries){assert.ok(!new TextDecoder().decode(row.body).includes('PRIVATE_'),key);}
  assert.ok(![...cache.entries.keys()].some(key=>key.endsWith('/'+csvKey) && !key.includes('/original/csv/')));
}));
test('concurrent pointer reads coalesce and cache failure falls back to R2',()=>fixture(async bucket=>{
  await bucket.put('coalesce/current.json','{"release":"r1"}');
  const counted=countedBucket(bucket),cache=timedCache(),data=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'coalesce'},{cache});
  await Promise.all(Array.from({length:12},()=>data.sourceRoots()));assert.equal(counted.calls.get,1);
  const rejectedWrites=[];
  const broken={match:async()=>{throw Error('cache offline')},put:async(_request,response)=>{rejectedWrites.push(response);throw Error('cache offline')}};
  const key='media/'+'a'.repeat(64)+'/image.webp';await bucket.put('coalesce/'+key,'image');
  for(const cacheOption of [null,broken]) {
    const uncached=resources({RESOURCES:counted.bucket,IDOLY_R2_PREFIX:'coalesce'},{cache:cacheOption});
    assert.equal(await(await uncached.route(request('/'+key))).text(),'image');
    const partial=await uncached.route(request('/'+key,{headers:{Range:'bytes=1-2'}}));
    assert.equal(partial.status,206);assert.equal(await partial.text(),'ma');
  }
  assert.ok(rejectedWrites.length>0);assert.ok(rejectedWrites.every(response=>response.bodyUsed),'failed cache writes cancel their response bodies');
}));
test('large objects and download archives are not cached; latest-five membership refreshes with the pointer',()=>fixture(async bucket=>{
  const cache=timedCache(),data=resources({RESOURCES:bucket,IDOLY_R2_PREFIX:'large'},{cache});
  const key='media/'+'a'.repeat(64)+'/card.mp4';await bucket.put('large/'+key,new Uint8Array(8*1024*1024+1));
  const media=await data.route(request('/'+key));assert.equal((await media.arrayBuffer()).byteLength,8*1024*1024+1);assert.equal(cache.entries.size,0);
  const name='idoly-resources-r100-abcdef123456.tar.gz';await bucket.put('large/downloads/'+name,'archive');
  await bucket.put('large/current.json',JSON.stringify({release:'r1',versions:{versions:[{filename:name}]}}));
  assert.equal(await(await data.route(request('/api/resources/download/'+name))).text(),'archive');
  assert.ok(![...cache.entries.keys()].some(key=>key.includes('/downloads/')));
  await bucket.put('large/current.json',JSON.stringify({release:'r2',versions:{versions:[]}}));cache.advance(31);
  await assert.rejects(()=>data.route(request('/api/resources/download/'+name)),{status:404});
}));
