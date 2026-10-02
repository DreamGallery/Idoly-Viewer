import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {localMusicHandler} from './local-music.mjs';

test('local music serves only indexed resources with HEAD and byte ranges',async()=>{
 const root=await mkdtemp(join(tmpdir(),'idoly-music-'));
 let server;
 try {
  const cache=join(root,'.local/music');await mkdir(join(cache,'audio-hash'),{recursive:true});await mkdir(join(cache,'cover-hash'));
  await writeFile(join(cache,'catalog.json'),JSON.stringify({tracks:[{id:'hsm-001',title:'IDOLY PRIDE'}]}));
  await writeFile(join(cache,'plan.json'),JSON.stringify({assets:{'sud_music_short_hsm-001':{md5:'audio-hash'},'img_music_jacket_hsm-001':{md5:'cover-hash'}}}));
  await writeFile(join(cache,'audio-hash/audio.flac'),'fLaC0123456789');await writeFile(join(cache,'cover-hash/cover.webp'),'RIFF0123WEBP');
  const handler=localMusicHandler(root);
  server=createServer((req,res)=>handler(req,res,()=>{res.writeHead(404);res.end()}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/local-music/`;
  const catalog=await fetch(base+'catalog');assert.equal((await catalog.json()).tracks.length,1);
  const range=await fetch(base+'audio/hsm-001.flac',{headers:{Range:'bytes=0-3'}});
  assert.equal(range.status,206);assert.equal(range.headers.get('Content-Type'),'audio/flac');assert.equal(range.headers.get('Content-Range'),'bytes 0-3/14');assert.equal(await range.text(),'fLaC');
  const head=await fetch(base+'cover/hsm-001.webp',{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('Content-Length'),'12');assert.equal(await head.text(),'');
  assert.equal((await fetch(base+'audio/hsm-001.flac',{headers:{Range:'bytes=99-100'}})).status,416);
  assert.equal((await fetch(base+'audio/missing.flac')).status,404);
  assert.equal((await fetch(base+'audio/hsm-001.webp')).status,404);
  assert.equal((await fetch(base+'catalog',{method:'POST'})).status,405);
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true})}
});
