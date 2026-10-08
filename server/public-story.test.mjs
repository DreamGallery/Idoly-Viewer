import test from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import {originalCsv, originalStory} from './public-story.mjs';

test('public CSV preserves quoted source text and strips translations, credits and extra columns',()=>{
  const csv=Papa.unparse([
    {id:'1:text:1',name:'A',text:'原文,"引用"\n次の行',trans:'private translation',human:'private human'},
    {id:'info',name:'adv_test.txt',text:'a'.repeat(64),trans:'',human:''},
    {id:'译者',name:'private credit',text:'private metadata',trans:'private credit',human:''},
  ]);
  const result=originalCsv(csv), parsed=Papa.parse(result,{header:true});
  assert.deepEqual(parsed.meta.fields,['id','name','text','trans']);
  assert.equal(parsed.data[0].text,'原文,"引用"\n次の行');
  assert.equal(parsed.data[1].text,'a'.repeat(64));
  assert.ok(parsed.data.every(row=>row.trans===''));
  assert.deepEqual(parsed.data[2],{id:'译者',name:'',text:'',trans:''});
  assert.ok(!result.includes('private'));
  assert.throws(()=>originalCsv('invalid'),/原文/);
});

test('legacy story JSON exposes only source fields across all translation layers',()=>{
  const story={id:'adv_test',title:'private title',originalTitle:'原題',script:'original script',human:'private field',
    rows:[{id:'1:text:1',name:'A',text:'原文',trans:'private',ai:'private',human:'private',reviewed:'private'}],
    metadata:[{id:'译者',name:'private credit',text:'',trans:''}],names:{A:'private name'}};
  const result=originalStory(story);
  assert.equal(result.title,'原題');assert.equal(result.rows[0].text,'原文');assert.equal(result.rows[0].trans,'');
  assert.equal(result.names.A,'A');assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(story.rows[0].trans,'private');
});
