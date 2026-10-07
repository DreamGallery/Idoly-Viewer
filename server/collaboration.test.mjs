import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {collaborationSources,validateSourceConfirmation} from './collaboration.mjs';
import {createApp} from './app.mjs';
const raw='[message text=原文 name=A]\n';
const sha=createHash('sha256').update(raw).digest('hex');
const sourceCommit='a'.repeat(40);
const manifest={schema_version:1,source_repository:'DreamGallery/Hoshimi-Adv',source_commit:sourceCommit,scripts:{adv_test:{csv_path:'card/adv_test.csv',source_sha256:sha,raw_path:'Resource/adv_test.txt'}}};
const csv=`id,name,text,trans\n1:text:1,A,原文,译文\ninfo,adv_test.txt,${sha},\n译者,,,\n`;
const blob=value=>({sha:'blob',content:Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64'),encoding:'base64'});
test('collaboration originals and CSV use pinned independent commits, never published R2',async()=>{
 const reads=[];
 const sources=collaborationSources({read:async(_s,path,head)=>{reads.push([path,head]);return path.endsWith('.json')?JSON.stringify(manifest):csv},remoteFetch:async url=>{assert.equal(url,`https://raw.githubusercontent.com/DreamGallery/Hoshimi-Adv/${sourceCommit}/Resource/adv_test.txt`);return new Response(raw)}});
 const result=await sources.source({},'frozen-work','adv_test');
 assert.equal(result.path,'card/adv_test.csv');assert.equal(result.sourceHash,sha);
 assert.ok(reads.every(([,head])=>head==='frozen-work'));
});
test('missing manifest, mismatched originals and unsafe source repositories fail closed',async()=>{
 const missing=collaborationSources({read:async()=>{throw Object.assign(Error(),{status:404})},remoteFetch:fetch});
 await assert.rejects(missing.source({},'one','adv_test'),/尚未同步/);
 const changed=collaborationSources({read:async()=>JSON.stringify(manifest),remoteFetch:async()=>new Response(raw+'[wait]')});
 await assert.rejects(changed.raw({},'two','adv_test'),/校验失败/);
 const unsafe=collaborationSources({read:async()=>JSON.stringify({...manifest,source_repository:'attacker/repo'}),remoteFetch:async()=>{throw Error('must not fetch')}});
 await assert.rejects(unsafe.raw({},'three','adv_test'),/清单无效/);
});
test('source confirmation must match pending source and submitting user',()=>{
 const before={source_change:{status:'needs-confirmation',source_sha256:sha}};
 const after={source_change:{status:'confirmed',source_sha256:sha},source_confirmation:{source_sha256:sha,confirmed_by:'tester'}};
 assert.throws(()=>validateSourceConfirmation(before,null,sha,'tester'),/核对/);
 assert.throws(()=>validateSourceConfirmation(before,after,sha,'other'),/核对/);
 assert.throws(()=>validateSourceConfirmation(before,after,'b'.repeat(64),'tester'),/核对/);
 validateSourceConfirmation(before,after,sha,'tester');
});
async function fixture(t,{race=false}={}) {
 const calls=[];let refs=0,patches=0;
 const session={token:'test-token',user:{login:'tester'},csrf:'csrf',expires:Date.now()+60000};
 const app=createApp({CAMPUS_PUBLIC_ORIGIN:'http://localhost'},async(url,opts)=>{
  calls.push([url,opts.method]);
  if(url.includes('raw.githubusercontent.com'))return new Response(raw);
  const path=new URL(url).pathname.replace('/repos/DreamGallery/Idoly-localify-translations','');
  if(path==='')return Response.json({permissions:{push:true}});
  if(path==='/git/ref/heads/collaboration')return Response.json({object:{sha:++refs===1?'head1':'head2'}});
  if(path==='/contents/automation/story-sources.json')return Response.json(blob(manifest));
  if(path==='/contents/story/ai/card/adv_test.csv')return Response.json(blob(csv));
  if(path.startsWith('/contents/'))return Response.json({message:'missing'},{status:404});
  if(path.startsWith('/git/commits/')&&opts.method==='GET')return Response.json({tree:{sha:'tree'}});
  if(path==='/git/refs/heads/collaboration'){
   assert.equal(JSON.parse(opts.body).force,false);patches++;
   return Response.json({},race&&patches===1?{status:422}:{});
  }
  if(['/git/blobs','/git/trees','/git/commits'].includes(path))return Response.json({sha:'new'});
  throw Error('Unexpected '+path);
 },{sessions:new Map([['session',session]]),readFile:async()=>{throw Error('Published source must not be read')}});
 app.listen(0,'127.0.0.1');await once(app,'listening');t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.address().port;
 const headers={Cookie:'idoly_session=session',Origin:'http://localhost','x-csrf-token':'csrf','Content-Type':'application/json'};
 return {calls,base,headers,patches:()=>patches,submit:content=>fetch(base+'/api/github/commit',{method:'POST',headers,body:JSON.stringify({files:[{path:'story/drafts/translation/card/adv_test.csv',expectedSha:null,content:Buffer.from(content).toString('base64')}]})})};
}
test('Worker serves collaboration source before R2 publication and requires access',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.base+'/api/collaboration/source/adv_test')).status,401);
 const response=await fetch(f.base+'/api/collaboration/source/adv_test',{headers:f.headers});
 assert.equal(response.status,200);assert.equal((await response.json()).sourceHash,sha);
});
test('autosave retries an unrelated branch advance but never writes main',async t=>{
 const f=await fixture(t,{race:true});const response=await f.submit(csv);
 assert.equal(response.status,200);assert.equal(f.patches(),2);
 assert.ok(f.calls.every(([url])=>!url.includes('heads/main')));
});
test('stale source cannot be saved after migration',async t=>{
 const f=await fixture(t);assert.equal((await f.submit(csv.replace(sha,'b'.repeat(64)))).status,400);assert.equal(f.patches(),0);
});
