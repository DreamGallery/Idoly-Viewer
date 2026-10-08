import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.mjs';
const origin = 'http://127.0.0.1:5173';
async function fixture(t, extra = async () => new Response('{}', {status:404}), push = true, services = {}) {
  const calls=[];
  const app=createApp({GITHUB_CLIENT_ID:'test-id',GITHUB_CLIENT_SECRET:'test-secret',CAMPUS_PUBLIC_ORIGIN:origin,CAMPUS_WORK_BRANCH:'main'},async (url, opts) => {
    assert.equal(opts.redirect,'manual', 'GitHub requests must use the Workers-compatible non-following redirect mode');
    calls.push([url,opts]);
    if(url.endsWith('/access_token')) return Response.json({access_token:'private-token',expires_in:28800});
    if(url==='https://api.github.com/repos/DreamGallery/Idoly-localify-translations') return Response.json({permissions:{push}});
    if(url==='https://api.github.com/user')return Response.json({login:'tester',name:'Tester'});
    return extra(url,opts);
  }, services);
  app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.address().port}`;
  const login=await fetch(base+'/api/auth/login?returnTo=%2Fchapter%2Ftest',{redirect:'manual'});
  const authUrl=new URL(login.headers.get('location')); const state=authUrl.searchParams.get('state');
  assert.equal(authUrl.searchParams.get('code_challenge_method'),'S256'); assert.ok(authUrl.searchParams.get('code_challenge'));
  const callback=await fetch(base+`/api/auth/callback?state=${state}&code=test`,{redirect:'manual',headers:{cookie:`campus_oauth=${state}`}});
  assert.equal(callback.status,302); assert.equal(callback.headers.get('location'),'/chapter/test');
  const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('idoly_session=')).split(';')[0];
  assert.match(callback.headers.getSetCookie().join(';'),/HttpOnly/);
  const status=await(await fetch(base+'/api/auth/status',{headers:{cookie}})).json();
  assert.equal(status.user.login,'tester'); assert.ok(!JSON.stringify(status).includes('private-token'));assert.ok(!JSON.stringify(status).includes('test-secret'));
  const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':status.csrf,...headers},body:JSON.stringify(body)});
  return {base,post,calls,state,cookie};
}
test('OAuth uses PKCE, opaque cookie and rejects replay',async t=>{const f=await fixture(t);const r=await fetch(f.base+`/api/auth/callback?state=${f.state}&code=test`,{headers:{cookie:`campus_oauth=${f.state}`}});assert.equal(r.status,400);});
test('atomic OAuth consumption needs no second delete and still rejects replay',async t=>{
 const states=new Map();let taken=0;
 const pending={
  set:async(id,value)=>states.set(id,value),
  take:async id=>{taken++;const value=states.get(id);states.delete(id);return value;},
  delete:async()=>assert.fail('take already removed the OAuth state'),
 };
 const f=await fixture(t,undefined,true,{pending});
 assert.equal(taken,1);assert.equal(states.size,0);
 const replay=await fetch(f.base+`/api/auth/callback?state=${f.state}&code=test`,{headers:{cookie:`campus_oauth=${f.state}`}});
 assert.equal(replay.status,400);assert.equal(taken,2);
});
test('OAuth rejects mismatched cookie/state',async t=>{const f=await fixture(t);const r=await fetch(f.base+'/api/auth/callback?state=wrong&code=test');assert.equal(r.status,400);});
test('CSRF and origin are required for writes',async t=>{const f=await fixture(t);assert.equal((await f.post('/api/auth/logout',{}, {'X-CSRF-Token':''})).status,403);assert.equal((await f.post('/api/auth/logout',{}, {Origin:'https://evil.test'})).status,403);});
test('logout invalidates session',async t=>{const f=await fixture(t);assert.equal((await f.post('/api/auth/logout',{})).status,200);assert.equal((await f.post('/api/github/commit',{})).status,401);});
test('path traversal and arbitrary targets rejected',async t=>{const f=await fixture(t);assert.equal((await f.post('/api/github/read',{kind:'content',path:'../private'})).status,400);assert.equal((await f.post('/api/github/read',{kind:'proxy',url:'http://evil.test'})).status,400);});
test('writes outside translation directories rejected',async t=>{const f=await fixture(t);const r=await f.post('/api/github/commit',{files:[{path:'.github/workflows/run.yml',content:'test',expectedSha:null}]});assert.equal(r.status,400);});
test('changed file aborts before Git objects are created',async t=>{const f=await fixture(t,async url=>url.includes('/git/ref/')?Response.json({object:{sha:'head'}}):Response.json({sha:'new-sha'}));const r=await f.post('/api/github/commit',{files:[{path:'records/test.json',content:'dGVzdA==',expectedSha:'old-sha'}]});assert.equal(r.status,409);assert.equal(f.calls.filter(([,o])=>o.method==='POST'&&o.body?.includes('base64')).length,0);});
test('atomic Git commit uses non-force ref update',async t=>{const f=await fixture(t,async(url,opts)=>{
 if(url.includes('/git/ref/'))return Response.json({object:{sha:'head'}});
 if(url.includes('/contents/'))return Response.json({sha:'old'});
 if(url.endsWith('/git/commits/head'))return Response.json({tree:{sha:'oldtree'}});
 if(url.endsWith('/git/blobs'))return Response.json({sha:'blob'});
 if(url.endsWith('/git/trees'))return Response.json({sha:'tree'});
 if(url.endsWith('/git/commits'))return Response.json({sha:'commit'});
 if(url.includes('/git/refs/')){assert.deepEqual(JSON.parse(opts.body),{sha:'commit',force:false});return Response.json({});}
 throw new Error('unexpected request');
 });const r=await f.post('/api/github/commit',{files:[{path:'records/test.json',content:'dGVzdA==',expectedSha:'old'}]});assert.equal(r.status,200);assert.deepEqual(await r.json(),{sha:'commit',files:[{path:'records/test.json',sha:'blob'}]});});
test('issue change prevents stale status update',async t=>{const f=await fixture(t,async()=>Response.json({updated_at:'new',body:'other claim'}));const r=await f.post('/api/github/issue',{number:1,expectedUpdatedAt:'old',expectedBody:'',body:'',state:'open'});assert.equal(r.status,409);});

test('anonymous task requests are denied, including direct issue lookup',async t=>{const f=await fixture(t);for(const kind of ['issues','issue','findIssue']){const r=await f.post('/api/github/read',{kind,number:1,scriptId:'test'},{Cookie:''});assert.equal(r.status,401);}});
test('logged-in read-only account cannot view tasks or submit changes',async t=>{const f=await fixture(t,undefined,false);const status=await(await fetch(f.base+'/api/auth/status',{headers:{Cookie:f.cookie}})).json();assert.equal(status.canCollaborate,false);for(const kind of ['issues','issue','findIssue']){assert.equal((await f.post('/api/github/read',{kind,number:1,scriptId:'test'})).status,403);}assert.equal((await f.post('/api/github/commit',{})).status,403);});
test('writer can list tasks',async t=>{const f=await fixture(t,async()=>Response.json([{number:1,title:'test'}]));assert.equal((await f.post('/api/github/read',{kind:'issues'})).status,200);});

test('anonymous and read-only users cannot read any collaboration layer or published translations',async t=>{
 const paths=['story/ai/card/test.csv','story/human/card/test.csv','story/reviewed/card/test.csv','story/drafts/translation/card/test.csv','story/drafts/proofread/card/test.csv','records/test.json','proofread_txt/test.txt'];
 for(const push of [false,true]) {
  let fileReads=0;
  const f=await fixture(t,async()=>{fileReads++;return Response.json({content:'private'});},push,{sourceCsv:async()=>{fileReads++;return {csv:'private'};}});
  for(const path of paths) {
   const before=f.calls.length;
   assert.equal((await f.post('/api/github/read',{kind:'content',path},{Cookie:''})).status,401);
   assert.equal(f.calls.length,before);
   if(!push) assert.equal((await f.post('/api/github/read',{kind:'content',path})).status,403);
  }
  for(const path of ['/api/source/adv_test','/api/source/adv_test?release=old','/api/collaboration/source/adv_test','/api/script/adv_test?work=1']) {
   assert.equal((await fetch(f.base+path)).status,401);
   if(!push) assert.equal((await fetch(f.base+path,{headers:{Cookie:f.cookie}})).status,403);
  }
  assert.equal(fileReads,0);
 }
});

test('collaborators read approved data paths but not arbitrary repository files',async t=>{
 let files=0;
 const f=await fixture(t,async()=>{files++;return Response.json({sha:'current',content:'translated'});});
 for(const path of ['story/ai/card/test.csv','story/human/card/test.csv','story/reviewed/card/test.csv','story/drafts/translation/card/test.csv','records/test.json']) {
  assert.equal((await f.post('/api/github/read',{kind:'content',path},{'X-CSRF-Token':''})).status,403);
  const response=await f.post('/api/github/read',{kind:'content',path});
  assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
 }
 assert.equal(files,5);
 for(const path of ['users.json','README.md','.github/workflows/release.yml','automation/story-sources.json','story/drafts/translation']) assert.equal((await f.post('/api/github/read',{kind:'content',path})).status,403);
 assert.equal(files,5);
});

async function requestProbe({path='/api/github/read',method='POST',cookie='',csrf='csrf',push=true,chunks=['{}'],length,contentType='application/json',requestOrigin=origin}={}) {
 let reads=0,sessionReads=0,permissionChecks=0;
 const session={expires:Date.now()+60000,token:'test-token',csrf:'csrf'};
 const app=createApp({CAMPUS_PUBLIC_ORIGIN:origin},async()=>{permissionChecks++;return Response.json({permissions:{push}});},{
  resourceRequest:async()=>false,
  sessions:{get:async id=>{sessionReads++;return id==='valid'?session:undefined;}},
  sourceCsv:async()=>({csv:'id,name,text,trans\n1:text:1,A,原文,private'}),
 });
 const headers={origin:requestOrigin,cookie,'x-csrf-token':csrf,'content-type':contentType,...(length===undefined?{}:{'content-length':String(length)})};
 const req={method,url:path,headers,iterator:async function*(){for(const chunk of chunks){reads+=Buffer.byteLength(chunk);yield Buffer.from(chunk);}}};
 const result={headers:{}};
 const res={setHeader:(k,v)=>{result.headers[k]=v;},writeHead:status=>{result.status=status;},end:body=>{result.body=body;}};
 await app.listeners('request')[0](req,res);
 return {...result,reads,sessionReads,permissionChecks};
}
test('authentication, CSRF, permissions and route checks reject requests before consuming their bodies',async()=>{
 const large='x'.repeat(1024*1024);
 for(const [options,status] of [
  [{},401],
  [{cookie:'idoly_session=valid',csrf:'wrong'},403],
  [{cookie:'idoly_session=valid',push:false},403],
  [{path:'/api/unknown',cookie:'idoly_session=valid'},404],
  [{cookie:'idoly_session=valid',length:1024*1024},413],
  [{cookie:'idoly_session=valid',contentType:'text/plain'},415],
  [{cookie:'idoly_session=valid',requestOrigin:'https://other.test'},403],
 ]){
  const result=await requestProbe({...options,chunks:[large]});
  assert.equal(result.status,status);assert.equal(result.reads,0);
  assert.equal(result.permissionChecks,options.push===false?1:0);
  assert.equal(result.headers['Cache-Control'],'no-store');
  if(!options.cookie || options.path==='/api/unknown' || options.requestOrigin)assert.equal(result.sessionReads,0);
 }
});
test('small query limit also applies to chunked bodies and JSON must be an object',async()=>{
 const result=await requestProbe({cookie:'idoly_session=valid',chunks:[' '.repeat(16384),' '.repeat(16384),'x','ignored']});
 assert.equal(result.status,413);assert.equal(result.reads,32769);
 for(const input of ['null','[]','"text"','{'])assert.equal((await requestProbe({cookie:'idoly_session=valid',chunks:[input]})).status,400);
});
test('public original reading never queries the session store, even with an unrelated cookie',async()=>{
 const result=await requestProbe({path:'/api/original/adv_test',method:'GET',cookie:'idoly_session=valid'});
 assert.equal(result.status,200);assert.equal(result.sessionReads,0);assert.equal(result.permissionChecks,0);assert.ok(!result.body.includes('private'));
});

test('login limiting runs before session access and OAuth writes, and only applies to the login endpoint',async()=>{
 let checks=0,sessionReads=0,writes=0;
 const pending=new Map();let allow=true;
 const app=createApp({CAMPUS_PUBLIC_ORIGIN:origin,GITHUB_CLIENT_ID:'test-id',GITHUB_CLIENT_SECRET:'test-secret'},async()=>{throw Error('No upstream request expected');},{
  resourceRequest:async()=>false,
  sessions:{get:async()=>{sessionReads++;}},
  pending:{set:async(key,value)=>{writes++;pending.set(key,value);},get:key=>pending.get(key),delete:key=>pending.delete(key)},
  allowLogin:async req=>{checks++;assert.equal(req.headers['cf-connecting-ip'],'192.0.2.10');return allow;},
 });
 const call=async(path,cookie='idoly_session=unrelated')=>{
  const result={headers:{}};
  const req={method:'GET',url:path,headers:{cookie,'cf-connecting-ip':'192.0.2.10'}};
  const res={setHeader:(key,value)=>{result.headers[key]=value;},writeHead:(status,headers)=>{result.status=status;Object.assign(result.headers,headers);},end:body=>{result.body=body;}};
  await app.listeners('request')[0](req,res);return result;
 };
 const accepted=await call('/api/auth/login?returnTo=/workbench');
 assert.equal(accepted.status,302);assert.equal(writes,1);assert.equal(sessionReads,0);
 const auth=new URL(accepted.headers.Location),state=auth.searchParams.get('state');
 assert.equal(auth.origin,'https://github.com');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.ok(pending.has(state));
 allow=false;
 for(const query of ['', '?returnTo=/chapter/adv_test', '?random=changed']){
  const denied=await call('/api/auth/login'+query);
  assert.equal(denied.status,429);assert.equal(denied.headers['Retry-After'],'60');assert.equal(denied.headers['Cache-Control'],'no-store');
  assert.ok(!denied.headers['Set-Cookie']);assert.ok(!denied.headers.Location);
 }
 assert.equal(writes,1);assert.equal(sessionReads,0);assert.equal(checks,4);
 // Even after the limit is hit, an already started OAuth flow can finish.
 const callback=await call('/api/auth/callback?state='+state,'campus_oauth='+state);
 assert.equal(callback.status,400);assert.equal(checks,4);assert.equal(pending.has(state),false);
 assert.equal((await call('/api/health')).status,200);assert.equal(checks,4);
});

test('a failing login limiter does not create OAuth state',async()=>{
 let writes=0,reads=0;
 const app=createApp({CAMPUS_PUBLIC_ORIGIN:origin,GITHUB_CLIENT_ID:'test-id',GITHUB_CLIENT_SECRET:'test-secret'},fetch,{
  resourceRequest:async()=>false,sessions:{get:async()=>{reads++;}},pending:{set:async()=>{writes++;}},
  allowLogin:async()=>{throw Object.assign(Error('登录服务暂不可用'),{status:503});},
 });
 let status;
 await app.listeners('request')[0]({method:'GET',url:'/api/auth/login',headers:{cookie:'idoly_session=anything'}},{setHeader:()=>{},writeHead:value=>{status=value;},end:()=>{}});
 assert.equal(status,503);assert.equal(writes,0);assert.equal(reads,0);
});

test('originals stay public and the protected legacy alias never returns old R2 translations',async t=>{
 const csv='id,name,text,trans\n1:text:1,A,原文,private translation\ninfo,adv_test.txt,hash,\n译者,private credit,,';
 const reads=[];
 const f=await fixture(t,undefined,true,{sourceCsv:async(id,release)=>{reads.push([id,release]);return {csv,label:'人工校对稿'};}});
 const original=await fetch(f.base+'/api/original/adv_test?release=old');
 const publicData=await original.json();assert.equal(original.status,200);assert.equal(publicData.label,'原文');assert.ok(!publicData.csv.includes('private'));
 const source=await fetch(f.base+'/api/source/adv_test?release=old',{headers:{Cookie:f.cookie}});
 assert.equal(source.status,200);const value=await source.json();assert.equal(value.csv,publicData.csv);assert.equal(value.label,'原文');assert.equal(source.headers.get('Cache-Control'),'no-store');
 assert.deepEqual(reads,[['adv_test','old'],['adv_test','old']]);
});

test('local TXT endpoint confines reads, preserves source and reports missing scripts',async t=>{
 const {mkdtemp,writeFile,symlink,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'campus-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'adv_test.txt'),'[message text=原文 name=A]\r\n');await symlink('/etc/hosts',join(root,'adv_escape.txt'));
 const app=createApp({CAMPUS_ADV_ROOT:root});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());const base=`http://127.0.0.1:${app.address().port}`;
 assert.deepEqual(await(await fetch(base+'/api/script/adv_test')).json(),{txt:'[message text=原文 name=A]\r\n'});
 assert.equal((await fetch(base+'/api/script/adv_missing')).status,404);
 assert.equal((await fetch(base+'/api/script/adv_escape')).status,403);
 assert.equal((await fetch(base+'/api/script/%2E%2E%2Foutside')).status,400);
});


test('managed runtime cold start, status and atomic release switch', async t => {
 const {mkdtemp,mkdir,writeFile,symlink,rename,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'campus-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const app=createApp({CAMPUS_RUNTIME_ROOT:root}); app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.address().port}`;
 assert.deepEqual(await (await fetch(base+'/api/health')).json(),{ok:true});
 assert.equal((await (await fetch(base+'/api/resources/status')).json()).state,'initializing');
 assert.equal((await fetch(base+'/api/original/adv_test')).status,503);
 assert.equal((await fetch(base+'/api/script/adv_test')).status,503);
 for (const version of ['one','two']) {
  const release=join(root,'releases',version);
  for(const dir of ['web/catalog/builds/test/chapters','story/CSV','adv'])await mkdir(join(release,dir),{recursive:true});
  await writeFile(join(release,'web/catalog/manifest.json'),JSON.stringify({base_path:'/catalog/builds/test'}));
  await writeFile(join(release,'web/catalog/builds/test/chapters/adv_test.json'),JSON.stringify({csv_path:'CSV/adv_test.csv'}));
  await writeFile(join(release,'story/CSV/adv_test.csv'),`id,name,text,trans\n1:text:1,A,${version},private translation\ninfo,adv_test.txt,hash,\n译者,private credit,,`);
  await writeFile(join(release,'adv/adv_test.txt'),version);
  await symlink(join('releases',version),join(root,'next'));await rename(join(root,'next'),join(root,'current'));
  const publicCsv=(await(await fetch(base+'/api/original/adv_test')).json()).csv;assert.ok(publicCsv.includes(version));assert.ok(!publicCsv.includes('private'));
  assert.equal((await(await fetch(base+'/api/script/adv_test')).json()).txt,version);
 }
 await writeFile(join(root,'status.json'),JSON.stringify({state:'ready',phase:'更新完成'}));
 assert.equal((await(await fetch(base+'/api/resources/status')).json()).state,'ready');
});


test('resource archives expose only published downloads and support byte ranges', async t => {
 const {mkdtemp,mkdir,writeFile,rm,symlink}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(join(tmpdir(),'campus-pack-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'current'));await mkdir(join(root,'downloads'));
 const filename='campus-resources-r63-abcdef123456.tar.gz';
 await writeFile(join(root,'downloads',filename),'0123456789');
 await writeFile(join(root,'current/resource-versions.json'),JSON.stringify({revision:'63',versions:[{revision:'63',filename}]}));
 const app=createApp({CAMPUS_RUNTIME_ROOT:root});app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.address().port}`;
 assert.equal((await(await fetch(base+'/api/resources/versions')).json()).revision,'63');
 const path=base+'/api/resources/download/'+filename;
 const range=await fetch(path,{headers:{Range:'bytes=2-4'}});assert.equal(range.status,206);assert.equal(await range.text(),'234');
 assert.equal((await fetch(path,{method:'HEAD'})).headers.get('content-length'),'10');
 assert.equal((await fetch(path,{headers:{Range:'bytes=99-'}})).status,416);
 assert.equal((await fetch(base+'/api/resources/download/campus-resources-r62-abcdef123456.tar.gz')).status,404);
 assert.equal((await fetch(base+'/api/resources/download/%2E%2E%2Fsecret')).status,404);
 await rm(join(root,'downloads',filename));await symlink('/etc/hosts',join(root,'downloads',filename));
 assert.equal((await fetch(path)).status,403);
});

test('source update completion archives only the exact existing formal CSV', async t => {
 const {createHash}=await import('node:crypto');
 const b64=s=>Buffer.from(s).toString('base64');
 const blob=s=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
 const raw='[narration text=新原文]\n', oldRaw='[narration text=旧原文]\n';
 const csv=(text,source,id='adv_test')=>`id,name,text,trans\n1:narration:1,,${text},译文\ninfo,${id}.txt,${createHash('sha256').update(source).digest('hex')},\n译者,作者,,\n`;
 const old=csv('旧原文',oldRaw), next=csv('新原文',raw);
 for (const role of ['translation','proofread']) await t.test(role,async t=>{
  const relative='group/サニーピース/01/adv_test.csv';
  const formal=`story/${role==='translation'?'human':'reviewed'}/${relative}`, backup=`story/backups/${role}/${relative}`;
  const f=await fixture(t,async(url,opts)=>{
   if(url.includes('/git/ref/'))return Response.json({object:{sha:'head'}});
   if(url.includes('/contents/')) {assert.ok(url.endsWith('?ref=head'));return url.includes('/'+formal.split('/').map(encodeURIComponent).join('/')+'?')?Response.json(role==='proofread'?{sha:blob(old),content:'',encoding:'none'}:{sha:blob(old),content:b64(old),encoding:'base64'}):new Response('{}',{status:404});}
   if(url.endsWith('/git/blobs/'+blob(old)))return Response.json({content:b64(old),encoding:'base64'});
   if(url.endsWith('/git/commits/head'))return Response.json({tree:{sha:'oldtree'}});
   if(url.endsWith('/git/blobs'))return Response.json({sha:blob(Buffer.from(JSON.parse(opts.body).content,'base64').toString())});
   if(url.endsWith('/git/trees'))return Response.json({sha:'tree'});
   if(url.endsWith('/git/commits'))return Response.json({sha:'commit'});
   if(url.includes('/git/refs/'))return Response.json({});
   throw Error('unexpected '+url);
  },true,{sourceRoots:()=>({adv:'adv'}),readFile:async(_root,path)=>{assert.equal(path,'adv_test.txt');return raw;},sourcePath:async id=>id==='adv_test'?relative:'other.csv'});
  const run=async(files,status)=>{const before=f.calls.filter(([,o])=>o.method==='POST').length;const r=await f.post('/api/github/commit',{files});assert.equal(r.status,status,await r.clone().text());if(status!==200)assert.equal(f.calls.filter(([,o])=>o.method==='POST').length,before);};
  const good=[{path:backup,content:b64(old),expectedSha:null},{path:formal,content:b64(next),expectedSha:blob(old)},{path:'records/adv_test.json',content:b64('{}'),expectedSha:null}];
  await run(good,200);
  await run([{...good[0],content:b64(old.replace('译文','伪造'))},good[1]],400);
  await run([{...good[0],content:b64(old.replace('adv_test.txt','adv_other.txt'))},good[1]],400);
  await run([{...good[0],path:`story/backups/${role}/wrong.csv`},good[1]],400);
  await run([good[0]],400);
  await run([good[0],{...good[1],content:b64(old)}],400);
  await run([good[0],{...good[1],content:b64(next.replace('新原文','篡改原文'))}],400);
  await run([good[0],{...good[1],expectedSha:'stale'}],409);
  await run([good[0],good[0],good[1]],400);
 });
});


test('Unicode story paths are encoded per segment; traversal and markup remain forbidden',async t=>{
 const paths=['group/サニーピース/01/adv_group_sun_01_01.csv','group/月のテンペスト/01/adv_group_moon_01_01.csv','group/ⅢX/01/adv_group_thrx_01_01.csv'];
 const f=await fixture(t,async url=>{assert.ok(paths.some(path=>url.endsWith('/contents/story/ai/'+path.split('/').map(encodeURIComponent).join('/')+'?ref=main')));return Response.json({content:'',sha:'existing'});});
 for(const path of paths)assert.equal((await f.post('/api/github/read',{kind:'content',path:'story/ai/'+path})).status,200);
 for(const path of ['story/ai/../secret','/story/ai/test.csv','story//test.csv','story/./test.csv','story/ai/%2e%2e/secret','story/ai/サニー\\secret.csv','story/ai/<b>月</b>.csv','story/ai/a\u0000.csv','story/ai/a\u202e.csv','story/ai/a?ref=other','story/ai/a#x']){
  assert.equal((await f.post('/api/github/read',{kind:'content',path})).status,400,path);
  assert.equal((await f.post('/api/github/commit',{files:[{path,content:'',expectedSha:null}]})).status,400,path);
 }
});
