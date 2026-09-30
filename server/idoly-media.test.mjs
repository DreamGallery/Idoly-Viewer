import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRange,localMediaHandler} from './idoly-media.mjs';
import {resolve} from 'node:path';

test('audio byte ranges support seek, suffix, open end and reject invalid requests',()=>{
 assert.equal(parseRange(undefined,100),null);
 assert.deepEqual(parseRange('bytes=10-19',100),{start:10,end:19});
 assert.deepEqual(parseRange('bytes=90-',100),{start:90,end:99});
 assert.deepEqual(parseRange('bytes=-10',100),{start:90,end:99});
 assert.deepEqual(parseRange('bytes=90-200',100),{start:90,end:99});
 for(const value of ['bytes=-','bytes=-0','bytes=100-','bytes=20-10','bytes=1-2,4-5','bytes=abc'])assert.throws(()=>parseRange(value,100));
});
test('local media accepts only indexed names, routes and read methods',async()=>{
 const handle=await localMediaHandler(resolve(import.meta.dirname,'..'));
 for(const [url,method,status] of [['/api/media/image/unindexed.webp','GET',404],['/api/media/voice/anything.webp','GET',404],['/api/media/image/a.webp','POST',405]]){
  const response={headersSent:false,writeHead(n){this.status=n;this.headersSent=true},end(){}};
  assert.equal(await handle({url,method,headers:{}},response),true);assert.equal(response.status,status);
 }
 assert.equal(await handle({url:'/api/auth/status'},{}),false);
});
