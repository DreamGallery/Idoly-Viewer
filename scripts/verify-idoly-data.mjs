import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scriptFields,mergeIdolyScript,validateTranslation} from '../server/idoly-script.mjs';
import assert from 'node:assert/strict';
const catalog=JSON.parse(await readFile('public/data/catalog.json','utf8'));
const expected=JSON.parse(await readFile('reports/toolkit-merge-hashes.json','utf8'));
const names=JSON.parse(await readFile('public/data/glossary.json','utf8')).names;
let count=0;const categories={};
for(const story of catalog.stories){
 const doc=JSON.parse(await readFile(`public/data/stories/${story.id}.json`,'utf8'));
 assert.equal(createHash('sha256').update(doc.script).digest('hex'),doc.sourceHash);
 const fields=scriptFields(doc.script).filter(f=>f.key!=='name');
 const originalPoints=Array.from(doc.script);
 assert.equal(fields.length,doc.rows.length,story.id);
 for(let i=0;i<fields.length;i++){const r=doc.rows[i],f=fields[i];assert.equal(f.id,r.id,story.id);assert.equal(f.text,r.text);assert.equal(f.name,r.name);assert.equal(originalPoints.slice(r.start,r.end).join(''),r.text);assert.equal(validateTranslation(r.text,r.trans),'',story.id+' '+r.id)}
 for(const [i,glossary] of [{},names].entries()) {
   const output=mergeIdolyScript(doc.script,doc.rows,glossary);
   assert.equal(createHash('sha256').update(output).digest('hex'),expected[story.id][i],story.id+' mode '+i);
 }
 assert.equal(mergeIdolyScript(doc.script,doc.rows.map(r=>({...r,trans:''}))),doc.script);
 count+=doc.rows.length;categories[doc.category]=(categories[doc.category]||0)+1;
}
const result={stories:catalog.stories.length,rows:count,categories,checks:['source SHA-256','independent Python/JS field parsing','translation validation','actual HoshimiToolkit merge_file parity: plain and name glossary modes','empty-translation byte-preserving roundtrip'],passed:true};
await writeFile('reports/full-corpus-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
