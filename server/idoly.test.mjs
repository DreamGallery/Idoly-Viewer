import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,mkdtemp} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {validateCsvAgainstScript} from './validate-csv.mjs';import {startLocal} from './local.mjs';
const id='adv_bond_ai_01_01',path='story/human/bond/ai/'+id+'.csv',origin='http://127.0.0.1:5173';
test('real Idoly CSV accepts valid source, rejects tampered hashes, names, IDs and newline count',async()=>{const raw=await readFile('../Hoshimi-Adv/Resource/'+id+'.txt','utf8'),csv=await readFile('../Idoly-localify-translations/story/ai/bond/ai/'+id+'.csv','utf8');assert.equal(validateCsvAgainstScript(csv,raw).id,id);assert.throws(()=>validateCsvAgainstScript(csv,raw+'\n'),/版本/);assert.throws(()=>validateCsvAgainstScript(csv.replace('11:text:1','999:text:1'),raw),/不匹配/);assert.throws(()=>validateCsvAgainstScript(csv.replace('11:text:1,小美山愛','11:text:1,别人'),raw),/不匹配/)});
test('local collaboration persists commits, denies CSRF, rejects stale baselines and never contacts GitHub',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'idoly-acceptance-'));const app=await startLocal({port:0,directory});t.after(()=>app.close());const base='http://127.0.0.1:'+app.address().port;
 let cookie='',csrf='';const post=(route,body,overrides={})=>fetch(base+'/api/'+route,{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,...overrides},body:JSON.stringify(body)});
 assert.equal((await post('auth/local',{login:'tester'},{Origin:'https://evil.test'})).status,403);
 let r=await post('auth/local',{login:'tester'});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];const auth=await(await fetch(base+'/api/auth/status',{headers:{Cookie:cookie}})).json();csrf=auth.csrf;assert.equal(auth.local,true);assert.equal(auth.canCollaborate,true);
 const source=await(await fetch(base+'/api/source/'+id,{headers:{Cookie:cookie}})).json();const input={message:'本地测试',files:[{path,content:Buffer.from(source.csv).toString('base64'),expectedSha:null}]};
 assert.equal((await post('github/commit',input,{'X-CSRF-Token':''})).status,403);
 r=await post('github/commit',input);assert.equal(r.status,200,await r.clone().text());const commit=await r.json();assert.ok(commit.sha);
 assert.equal((await post('github/commit',input)).status,409);
 const file=await(await post('github/read',{kind:'content',path})).json();assert.equal(Buffer.from(file.content,'base64').toString(),source.csv);
 const bad={files:[{path,content:Buffer.from(source.csv.replace('11:text:1','999:text:1')).toString('base64'),expectedSha:file.sha}]};assert.equal((await post('github/commit',bad)).status,400);
 const disk=JSON.parse(await readFile(join(directory,'repository.json'),'utf8'));assert.equal(disk.files[path],source.csv);assert.equal(Object.keys(disk.files).length,1);
 // Issue stale-body protection uses the inherited Campus endpoint.
 const issues=await(await post('github/read',{kind:'findIssue',scriptId:id})).json(),issue=issues[0];const claim={number:issue.number,expectedUpdatedAt:issue.updated_at,expectedBody:issue.body,body:issue.body.replace('tr::待认领','tr:tester:进行中'),state:'open',assignees:['tester']};assert.equal((await post('github/issue',claim)).status,200);assert.equal((await post('github/issue',claim)).status,409);
});
