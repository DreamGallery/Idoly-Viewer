import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

test('browser pins nested media and later data/source requests while preserving local and external URLs',async t=>{
 const result=await build({entryPoints:['src/resource-snapshot.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const client=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
 assert.equal(client.resourceUrl('/data/catalog.json'),'/data/catalog.json');
 assert.equal(client.resourceCatalogBase(),'/catalog');
 const seen=[];
 t.mock.method(globalThis,'fetch',async url=>{
  seen.push(String(url));
  return Response.json({image:'/images/a.png',voices:[{url:'/api/media/voice/a.wav'}],remote:'https://example.com/a.png'},{headers:{'X-Idoly-Release':String(url).includes('release=first')?'first':seen.length===1?'first':'second'}});
 });
 const first=await client.resourceJson('/data/catalog.json');
 assert.equal(first.image,'/images/a.png?release=first');assert.equal(first.voices[0].url,'/api/media/voice/a.wav?release=first');assert.equal(first.remote,'https://example.com/a.png');
 assert.equal(client.resourceCatalogBase(),'/catalog/releases/first');
 assert.equal(client.resourceUrl('/api/source/demo'),'/api/source/demo?release=first');assert.equal(client.resourceUrl('/api/github/read'),'/api/github/read');
 await client.resourceJson('/data/directory.json?schema=v2');
 assert.equal(seen.at(-1),'/data/directory.json?schema=v2&release=first');
 client.acceptResourceSnapshot(new Response(null,{headers:{'X-Idoly-Release':'second'}}));
 assert.equal(client.resourceUrl('/api/script/demo'),'/api/script/demo?release=first');
 // A bootstrap response from another generation is retried against the pinned one.
 let calls=0;
 t.mock.method(globalThis,'fetch',async url=>{calls++;return Response.json({url:String(url)},{headers:{'X-Idoly-Release':calls===1?'second':'first'}})});
 const retried=await client.resourceJson('/data/catalog.json');assert.equal(calls,2);assert.equal(retried.url,'/data/catalog.json?release=first');
});
