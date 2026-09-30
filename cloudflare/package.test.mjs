import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('offline packager inventories generated snapshots and reuses immutable media across releases',async()=>{
 const root=await mkdtemp(join(tmpdir(),'idoly-pack-'));
 try {
  const input=join(root,'input');
  const put=async(path,body)=>{const file=join(input,path);await mkdir(resolve(file,'..'),{recursive:true});await writeFile(file,body);};
  for(const [path,body] of Object.entries({'web/data/catalog.json':JSON.stringify({stories:[],provenance:{revision:12}}),'web/data/directory.json':'{}','web/data/updates.json':'{}','web/data/media/demo.json':'{}','web/images/characters/demo.png':'png','story/demo.csv':'name,text','adv/demo.txt':'script','media/voice/demo.wav':'audio','media/video/demo.mp4':'video'}))await put(path,body);
  const run=release=>spawnSync(process.execPath,['scripts/package-idoly-resources.mjs','--input',input,'--output',join(root,'output'),'--release',release],{encoding:'utf8'});
  await put('web/catalog/manifest.json','{"base_path":"/catalog/releases/first"}');
  assert.equal(run('first').status,0);
  const plan=JSON.parse(await readFile(join(root,'output/first/upload-manifest.json'),'utf8'));
  assert.equal(plan.publishLast,'idoly-v1/current.json');assert.equal(plan.objects.at(-1).key,plan.publishLast);
  const readMap=async release=>{
   const map=JSON.parse(await readFile(join(root,`output/${release}/releases/${release}/file-map.json`),'utf8'));
   assert.deepEqual(map.files,{});assert.ok(Object.keys(map.shards).length>1);
   for(const [shard,key] of Object.entries(map.shards)){
    assert.match(shard,/^[a-f0-9]{2}$/);assert.equal(key,`releases/${release}/maps/${shard}.json`);
    Object.assign(map.files,JSON.parse(await readFile(join(root,`output/${release}`,key),'utf8')).files);
   }
   return map;
  };
  const map=await readMap('first');
  for(const name of ['web/data/directory.json','web/data/updates.json','web/data/media/demo.json','media/video/demo.mp4','media/voice/demo.wav','web/images/characters/demo.png','adv/demo.txt','story/demo.csv'])assert.ok(map.files[name]);
  assert.match(map.files['media/voice/demo.wav'],/^media\/[a-f0-9]{64}\/demo.wav$/);
  assert.equal(plan.objects.find(o=>o.key==='idoly-v1/'+map.files['media/voice/demo.wav']).contentType,'audio/wav');
  await put('web/catalog/manifest.json','{"base_path":"/catalog/releases/second"}');
  assert.equal(run('second').status,0);
  const next=await readMap('second');
  assert.equal(next.files['media/voice/demo.wav'],map.files['media/voice/demo.wav']);
  assert.equal(next.files['media/video/demo.mp4'],map.files['media/video/demo.mp4']);
  assert.notEqual(run('wrong').status,0);
  assert.notEqual(run('../escape').status,0);
 } finally {await rm(root,{recursive:true,force:true});}
});
