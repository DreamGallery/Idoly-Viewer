import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startGitHub} from './github.mjs';

test('GitHub mode uses real OAuth transport, disables local identities and keeps local source resolution',async t=>{
 const root=await mkdtemp(join(tmpdir(),'idoly-github-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const path of ['web/data','story/ai','story/human','story/reviewed','CSV'])await mkdir(join(root,path),{recursive:true});
 await writeFile(join(root,'web/data/catalog.json'),JSON.stringify({stories:[{id:'adv_test',path:'test.csv'},{id:'adv_original',path:'original.csv'},{id:'adv_escape',path:'escape.csv'}]}));
 const csv=trans=>`id,name,text,trans\n1:text:1,A,原文,${trans}\ninfo,adv_test.txt,hash,\n译者,private credit,,` ;
 await writeFile(join(root,'story/ai/test.csv'),csv('ai'));await writeFile(join(root,'story/human/test.csv'),csv('human'));
 await writeFile(join(root,'story/reviewed/test.csv'),csv('reviewed'));await writeFile(join(root,'CSV/original.csv'),csv(''));await writeFile(join(root,'CSV/test.csv'),csv(''));
 await writeFile(join(root,'outside.csv'),'private');await symlink(join(root,'outside.csv'),join(root,'CSV/escape.csv'));
 const env={GITHUB_CLIENT_ID:'test-id',GITHUB_CLIENT_SECRET:'test-secret',CAMPUS_PUBLIC_ORIGIN:'http://127.0.0.1:5173',CAMPUS_WEB_DATA:join(root,'web'),CAMPUS_STORY_ROOT:join(root,'story/ai'),IDOLY_CSV_ROOT:join(root,'CSV')};
 const calls=[];
 const app=await startGitHub({env,port:0,media:false,remoteFetch:async(url,opts)=>{
  calls.push([url,opts]);
  if(url.endsWith('/access_token')){assert.equal(JSON.parse(opts.body).client_secret,'test-secret');return Response.json({access_token:'test-token'})}
  if(url==='https://api.github.com/user')return Response.json({login:'tester',name:'Tester'});
  if(url==='https://api.github.com/repos/DreamGallery/Idoly-localify-translations')return Response.json({permissions:{push:true},archived:false});
  throw Error('Unexpected GitHub request');
 }});t.after(()=>app.close());
 const base=`http://127.0.0.1:${app.address().port}`;
 const status=await(await fetch(base+'/api/auth/status')).json();assert.equal(status.local,false);assert.equal(status.configured,true);assert.equal(status.user,null);
 assert.equal((await fetch(base+'/api/auth/local',{method:'POST',headers:{Origin:env.CAMPUS_PUBLIC_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({login:'tester'})})).status,404);
 assert.equal((await fetch(base+'/api/source/adv_test')).status,401);
 const publicCsv=(await(await fetch(base+'/api/original/adv_test')).json()).csv;assert.ok(publicCsv.includes('原文'));assert.ok(!publicCsv.includes('reviewed'));assert.ok(!publicCsv.includes('private credit'));
 assert.ok((await(await fetch(base+'/api/original/adv_original')).json()).csv.includes('原文'));
 assert.equal((await fetch(base+'/api/original/missing')).status,404);assert.equal((await fetch(base+'/api/original/adv_escape')).status,403);
 assert.equal(calls.length,0);
 const login=await fetch(base+'/api/auth/login?returnTo=%2Fworkbench',{redirect:'manual'}),url=new URL(login.headers.get('location')),state=url.searchParams.get('state');
 assert.equal(url.searchParams.get('redirect_uri'),env.CAMPUS_PUBLIC_ORIGIN+'/api/auth/callback');
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 const callback=await fetch(base+`/api/auth/callback?state=${state}&code=test`,{redirect:'manual',headers:{Cookie:`campus_oauth=${state}`}});
 assert.equal(callback.status,302);assert.equal(callback.headers.get('location'),'/workbench');
 const cookie=callback.headers.getSetCookie().find(c=>c.startsWith('idoly_session=')).split(';')[0];
 const published=await fetch(base+'/api/source/adv_test',{headers:{Cookie:cookie}});assert.equal((await published.json()).csv,publicCsv);assert.equal(published.headers.get('Cache-Control'),'no-store');
 const logged=await(await fetch(base+'/api/auth/status',{headers:{Cookie:cookie}})).json();
 assert.equal(logged.user.login,'tester');assert.equal(logged.canCollaborate,true);assert.equal(logged.local,false);
 assert.ok(!JSON.stringify(logged).includes('test-token'));assert.ok(!JSON.stringify(logged).includes('test-secret'));
 assert.ok(calls.every(([url,opts])=>url.endsWith('/access_token')||!opts.method||opts.method==='GET'));
});
