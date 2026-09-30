import test from 'node:test';
import assert from 'node:assert/strict';
import {translatedScript,taskCsv} from './export';
import type {CsvDataLine} from './upstream/csv';
import type {Github} from './github';
import {docFromIssue,completionPath,draftPath} from './upstream/workflow';
import {mergeTranslation,extractInfoFromCsvText} from './upstream/csv';
const row=(id:string,text:string,trans:string,name='A'):CsvDataLine=>({id,name,text,trans});
test('Idoly line IDs distinguish repeated dialogue and preserve nontext and CRLF',()=>{const raw='[message text=はい name=A clip=timing]\r\n[voice voice=x]\r\n[message text=はい name=A]\r\n';assert.equal(translatedScript(raw,[row('1:text:1','はい','好'),row('3:text:1','はい','是的')]),'[message text=好 name=A clip=timing]\r\n[voice voice=x]\r\n[message text=是的 name=A]\r\n')});
test('nested choices, title and narration use their real field identifiers',()=>{const raw='[title title=原題]\n[choicegroup choices=[choice text=選択 id=1][choice text=取消 id=2]]\n[narration text=一\\n二]';assert.equal(translatedScript(raw,[row('1:title:1','原題','标题',''),row('2:choice:1','選択','选择',''),row('2:choice:2','取消','',''),row('3:narration:1','一\\n二','甲\\n乙','')]),'[title title=标题]\n[choicegroup choices=[choice text=选择 id=1][choice text=取消 id=2]]\n[narration text=甲\\n乙]')});
test('source, names, placeholders, unsafe brackets and newlines cannot silently change',()=>{assert.throws(()=>translatedScript('[message text=one name=A]',[row('1:text:1','two','中')]),/不匹配/);assert.throws(()=>translatedScript('[message text={user} name=A]',[row('1:text:1','{user}','制作人')]),/占位符/);assert.throws(()=>translatedScript('[message text=one name=A]',[row('1:text:1','one','[voice evil]')]),/脚本字符/);assert.throws(()=>translatedScript('[narration text=一\\n二]',[row('1:narration:1','一\\n二','甲乙','')]),/换行/)});
test('translations never cascade into subsequent occurrences',()=>assert.equal(translatedScript('[message text=a name=A]\n[message text=b name=A]',[row('1:text:1','a','b'),row('2:text:1','b','$&')]),'[message text=b name=A]\n[message text=$& name=A]'));
test('repository paths preserve game categories and filenames',()=>{assert.equal(completionPath('story/ai/card/ktn/adv_card_ktn_01_01.csv','adv_card_ktn_01_01','tr'),'story/human/card/ktn/adv_card_ktn_01_01.csv');assert.equal(draftPath('story/ai/card/ktn/adv_card_ktn_01_01.csv','adv_card_ktn_01_01','pr'),'story/drafts/proofread/card/ktn/adv_card_ktn_01_01.csv')});
test('CSV import rejects changed source metadata even with identical visible rows',()=>{const csv='id,name,text,trans\n1:text:1,A,日,中\ninfo,adv_test.txt,hash1,\n译者,,,\n';assert.throws(()=>mergeTranslation(extractInfoFromCsvText(csv),csv.replace('hash1','hash2')),/不一致/)});
test('best-stage export falls back only for missing file, never permission failures',async()=>{const task=docFromIssue({number:1,title:'adv_test',body:'',updated_at:''});const paths:string[]=[];const w={async getContent(_a:string,_b:string,_c:string,path:string){paths.push(path);if(path===task.proofreadPath)throw {response:{status:404}};return {content:Buffer.from('id,name,text,trans\n1:text:1,A,日,中\ninfo,adv_test.txt,hash,\n译者,,,').toString('base64')}}} as unknown as Github;assert.match(await taskCsv(w,task,'best'),/^id,name,text,trans/);assert.deepEqual(paths,[task.proofreadPath,task.translatedPath]);await assert.rejects(()=>taskCsv({async getContent(){throw {response:{status:403}}}} as unknown as Github,task,'best'))});
test('invalid in-progress browser drafts can be recovered for repair but cannot import as validated work',()=>{const csv='id,name,text,trans\n1:text:1,A,{user},{user}\ninfo,adv_test.txt,hash,\n译者,,,\n';const bad=csv.replace('A,{user},{user}','A,{user},错误译文');assert.throws(()=>mergeTranslation(extractInfoFromCsvText(csv),bad),/占位符/);assert.equal(mergeTranslation(extractInfoFromCsvText(csv),bad,false).data[0].trans,'错误译文')});

test('TXT escapes equals, preserves unchanged source, and rejects reordered CSV',()=>{
 const raw='[message text=a name=A]';
 assert.equal(translatedScript(raw,[row('1:text:1','a','x=y')]),'[message text=x\\=y name=A]');
 assert.equal(translatedScript(raw,[row('1:text:1','a','x\\=y')]),'[message text=x\\=y name=A]');
 assert.throws(()=>translatedScript('[message text=a name=A]\n[message text=b name=A]',[row('2:text:1','b','乙'),row('1:text:1','a','甲')]),/不匹配/);
});

test('formal CSV exports retain the single translator and reviewer credit row exactly',async()=>{
 const task=docFromIssue({number:1,title:'adv_test',body:'',updated_at:''});
 const translated='id,name,text,trans\r\n1:text:1,A,日,中\r\ninfo,adv_test.txt,hash,\r\n译者,翻译：甲,,';
 const reviewed=translated.replace('翻译：甲','翻译：甲；校对：乙');
 const w={async getContent(_a:string,_b:string,_c:string,path:string){return {content:Buffer.from(path===task.proofreadPath?reviewed:translated).toString('base64')}}} as unknown as Github;
 for(const stage of ['best','proofread','translated'] as const){
  const exported=await taskCsv(w,task,stage);
  assert.equal(exported,stage==='translated'?translated:reviewed);
  const parsed=extractInfoFromCsvText(exported);
  assert.equal(parsed.records[parsed.records.length-1]?.id,'译者');
  assert.equal(parsed.records.filter(r=>r.id==='译者').length,1);
 }
});

test('21-character rule applies only to source with literal newline and permits repair imports',()=>{
 const source='原\\n文', valid='字'.repeat(21)+'\\n短句', invalid='字'.repeat(22)+'\\n短句';
 assert.equal(translatedScript('[narration text='+source+']',[row('1:narration:1',source,valid,'')]),'[narration text='+valid+']');
 assert.throws(()=>translatedScript('[narration text='+source+']',[row('1:narration:1',source,invalid,'')]),/第 1 行 22 字/);
 const single='字'.repeat(80);
 assert.equal(translatedScript('[narration text=原文]',[row('1:narration:1','原文',single,'')]),'[narration text='+single+']');
 const original='id,name,text,trans\n1:narration:1,,原\\n文,\ninfo,adv_test.txt,hash,\n译者,,,';
 const overlong=original.replace('原\\n文,','原\\n文,'+invalid);
 assert.equal(mergeTranslation(extractInfoFromCsvText(original),overlong).data[0].trans,invalid);
});

test('batch CSV export rejects overlong multiline translations',async()=>{
 const task=docFromIssue({number:1,title:'adv_test',body:'',updated_at:''});
 const csv='id,name,text,trans\n1:narration:1,,原\\n文,'+'字'.repeat(22)+'\\n短句\ninfo,adv_test.txt,hash,\n译者,,,';
 const w={async getContent(){return {content:Buffer.from(csv).toString('base64')}}} as unknown as Github;
 await assert.rejects(()=>taskCsv(w,task,'translated'),/第 1 条：第 1 行 22 字/);
});
