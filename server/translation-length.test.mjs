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
test('trailing line breaks are optional and do not make a title multiline',()=>{
 const source='星空編1章62話 アイドルへの第一歩\\n';
 const translated='星空篇第1章第62话 迈向偶像的第一步';
 assert.equal(validateTranslation(source,translated),'');
 assert.equal(validateTranslation(source,translated+'\\n'),'');
 assert.equal(validateTranslation(source,translated+'\\n\\n'),'');
 assert.equal(validateTranslation('标题\\n\\n','字'.repeat(80)),'');
 assert.equal(validateTranslation('标题','译文\\n'),'');
 assert.equal(validateTranslation(source,''),'');
});
test('ignoring trailing line breaks still enforces internal breaks, lengths and script safety',()=>{
 assert.equal(validateTranslation('第一行\\n第二行\\n','一行'),'换行数量与原文不一致（原文 1 处，译文 0 处）');
 assert.match(validateTranslation('第一行\\n第二行\\n','字'.repeat(22)+'\\n第二行'),/第 1 行 22 字/);
 assert.equal(validateTranslation('第一行\\n第二行\\n','第一行\\n第二行'),'');
 assert.match(validateTranslation('标题\\n','译文\n'),/脚本字符/);
 assert.match(validateTranslation('{user}\\n','译文'),/占位符/);
});
test('server accepts a title without its trailing break and preserves the original field',()=>{
 const raw='[title title=原题\\n]';
 const csv=Papa.unparse([
  ['id','name','text','trans'],['1:title:1','','原题\\n','译文'],
  ['info','adv_test.txt',createHash('sha256').update(raw).digest('hex'),''],['译者','','','']
 ]);
 const parsed=validateCsvAgainstScript(csv,raw);
 assert.equal(parsed.records[0].text,'原题\\n');
 assert.equal(parsed.records[0].trans,'译文');
});
test('length excludes emphasis and ruby annotation but includes punctuation',()=>{
 const source='<em\\=>原</em><r\\=annotation>文</r>\\n次';
 const value='<em\\=>'+'字'.repeat(19)+'</em><r\\=annotation>文</r>！\\n次';
 assert.deepEqual(translationLineLengths(value),[21,1]);
 assert.equal(validateTranslation(source,value),'');
 assert.match(validateTranslation(source,value.replace('！','！！')),/22 字/);
});
test('trailing empty lines do not appear in counts but internal blank lines still count',()=>{
 assert.deepEqual(translationLineLengths('甲\\n乙\\n\\n'),[1,1]);
 assert.deepEqual(translationLineLengths('甲\r\n乙\n \t\n'),[1,1]);
 assert.deepEqual(translationLineLengths('甲\\n \\n'),[1]);
 assert.deepEqual(translationLineLengths('甲\\n\\n乙\\n'),[1,0,1]);
 assert.deepEqual(translationLineLengths('甲 '),[2]);
 assert.deepEqual(translationLineLengths('\\n\\n'),[0]);
 assert.equal(validateTranslation('原\\n文','甲\\n乙\\n \t'),'');
 assert.match(validateTranslation('原\\n文','甲\\n\\n乙\\n'),/换行数量/);
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
