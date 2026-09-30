import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Papa from 'papaparse';
import {validateTranslation, translationLineLengths} from './idoly-script.mjs';
import {validateCsvAgainstScript} from './validate-csv.mjs';

test('multiline source limits every line to 21 visible characters',()=>{
 assert.equal(validateTranslation('原\\n文','字'.repeat(21)+'\\n'+'😀'.repeat(21)),'');
 assert.match(validateTranslation('原\\n文','短句\\n'+'字'.repeat(22)),/第 2 行 22 字/);
 assert.equal(validateTranslation('原文','字'.repeat(100)),'');
 assert.equal(validateTranslation('原\\n文',''),'');
 assert.match(validateTranslation('原\\n文','短句'),/换行数量/);
 assert.equal(validateTranslation('原\\n文','字'.repeat(22)+'\\n短句',{checkLength:false}),'');
});
test('length excludes emphasis and ruby annotation but includes punctuation',()=>{
 const source='<em\\=>原</em><r\\=annotation>文</r>\\n次';
 const value='<em\\=>'+'字'.repeat(19)+'</em><r\\=annotation>文</r>！\\n次';
 assert.deepEqual(translationLineLengths(value),[21,1]);
 assert.equal(validateTranslation(source,value),'');
 assert.match(validateTranslation(source,value.replace('！','！！')),/22 字/);
});
test('server submission rejects overlong work, including unchanged copies, while draft can be saved',()=>{
 const source='字'.repeat(22)+'\\n原文', raw='[narration text='+source+']';
 const csv=Papa.unparse([
 ['id','name','text','trans'],['1:narration:1','',source,source],
 ['info','adv_test.txt',createHash('sha256').update(raw).digest('hex'),''],['译者','','','']
 ]);
 assert.throws(()=>validateCsvAgainstScript(csv,raw),/21 字上限/);
 assert.equal(validateCsvAgainstScript(csv,raw,{checkLength:false}).id,'adv_test');
});
