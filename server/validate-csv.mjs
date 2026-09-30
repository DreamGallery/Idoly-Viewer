import Papa from 'papaparse';
import {createHash} from 'node:crypto';
import {mergeIdolyScript} from './idoly-script.mjs';
export function inspectCsv(csv){
 const parsed=Papa.parse(csv.replace(/^\uFEFF/,''),{header:true,skipEmptyLines:'greedy'});
 if(parsed.errors.length||parsed.meta.fields?.join(',')!=='id,name,text,trans')throw Error('CSV 列格式不正确');
 const records=parsed.data,info=records.find(r=>r.id==='info');
 if(!info||!/^adv_[A-Za-z0-9_-]+\.txt$/.test(info.name)||!/^[a-f0-9]{64}$/.test(info.text))throw Error('CSV 缺少有效来源信息');
 if(records.filter(r=>r.id==='info').length!==1||records.filter(r=>r.id==='译者').length!==1||new Set(records.map(r=>r.id)).size!==records.length)throw Error('CSV ID 重复或元数据缺失');
 if(records.at(-2)!==info||records.at(-1)?.id!=='译者')throw Error('CSV 元数据必须位于末尾');
 return {records,info,id:info.name.slice(0,-4)};
}
export function validateCsvAgainstScript(csv,raw,validation={}){const parsed=inspectCsv(csv);if(createHash('sha256').update(raw).digest('hex')!==parsed.info.text)throw Error('原始脚本已变化，拒绝提交旧版本 CSV');mergeIdolyScript(raw,parsed.records,{},validation);return parsed}
