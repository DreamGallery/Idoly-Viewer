import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.mjs';
const origin = 'http://127.0.0.1:5173';
async function fixture(t, extra = async () => new Response('{}', {status:404}), push = true) {
  const calls=[];
  const app=createApp({GITHUB_CLIENT_ID:'test-id',GITHUB_CLIENT_SECRET:'test-secret',CAMPUS_PUBLIC_ORIGIN:origin},async (url, opts) => {
    assert.equal(opts.redirect,'manual', 'GitHub requests must use the Workers-compatible non-following redirect mode');
    calls.push([url,opts]);
    if(url.endsWith('/access_token')) return Response.json({access_token:'private-token',expires_in:28800});
    if(url==='https://api.github.com/repos/DreamGallery/Idoly-localify-translations') return Response.json({permissions:{push}});
    if(url==='https://api.github.com/user')return Response.json({login:'tester',name:'Tester'});
    return extra(url,opts);
  });
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
 assert.equal((await fetch(base+'/api/source/adv_test')).status,503);
 assert.equal((await fetch(base+'/api/script/adv_test')).status,503);
 for (const version of ['one','two']) {
  const release=join(root,'releases',version);
  for(const dir of ['web/catalog/builds/test/chapters','story/CSV','adv'])await mkdir(join(release,dir),{recursive:true});
  await writeFile(join(release,'web/catalog/manifest.json'),JSON.stringify({base_path:'/catalog/builds/test'}));
  await writeFile(join(release,'web/catalog/builds/test/chapters/adv_test.json'),JSON.stringify({csv_path:'CSV/adv_test.csv'}));
  await writeFile(join(release,'story/CSV/adv_test.csv'),version);
  await writeFile(join(release,'adv/adv_test.txt'),version);
  await symlink(join('releases',version),join(root,'next'));await rename(join(root,'next'),join(root,'current'));
  assert.equal((await(await fetch(base+'/api/source/adv_test')).json()).csv,version);
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
