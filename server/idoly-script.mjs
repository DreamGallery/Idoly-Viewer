const assignments=/(?:(?<=\[)|(?<= ))([A-Za-z_][A-Za-z_0-9]*)=/g;
const wanted={message:['text','name'],narration:['text'],title:['title'],choicegroup:['text'],choice:['text']};
function valueEnd(line,start){let depth=0;for(let i=start;i<line.length;i++){if(line[i]==='\\'&&i+1<line.length){i++;continue}if(line[i]==='[')depth++;else if(line[i]===']'){if(!depth)return i;depth--}else if(line[i]===' '&&!depth&&/^[A-Za-z_][A-Za-z_0-9]*=/.test(line.slice(i+1)))return i}throw Error('脚本指令未闭合')}
export function scriptFields(script){const fields=[];let offset=0,lineNumber=0;for(const line of script.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)||[]){if(!line)continue;lineNumber++;const command=line.replace(/[\r\n]+$/,'');const tag=/^\[([A-Za-z_][A-Za-z_0-9]*)\b/.exec(command)?.[1];const keys=wanted[tag];if(keys){const matches=[...command.matchAll(assignments)];const speaker=matches.find(m=>m[1]==='name');const name=speaker?command.slice(speaker.index+speaker[0].length,valueEnd(command,speaker.index+speaker[0].length)):'';const counts={};for(const m of matches){const key=m[1];if(!keys.includes(key))continue;const start=m.index+m[0].length,end=valueEnd(command,start),text=command.slice(start,end);if(!text)continue;counts[key]=(counts[key]||0)+1;const kind=tag.startsWith('choice')?'choice':tag==='narration'?'narration':key;fields.push({id:`${lineNumber}:${kind}:${counts[key]}`,legacyId:`${lineNumber}:${key}:${counts[key]}`,key,name,text,start:offset+start,end:offset+end})}}offset+=line.length}return fields}
const tokens=t=>(t.match(/\{[A-Za-z_][A-Za-z_0-9]*(?::[^{}]+)?\}|\{\d+(?::[^{}]+)?\}|<[^>]+>/g)||[]).sort().join('\0');
export function translationLineLengths(text) {
  return text.replace(/\\n/g, '\n').replace(/\r\n?/g, '\n')
    .replace(/<\/?(?:em|r)(?:\\?=[^>]*|\s[^>]*)?>/g, '')
    .split('\n').map(line => Array.from(line).length);
}
export function validateTranslation(source, value, {checkLength = true} = {}) {
  if (!value) return '';
  if (typeof value !== 'string' || /[\r\n\[\]]/.test(value)) return '译文含有不支持的脚本字符';
  if (tokens(source) !== tokens(value)) return '占位符或标签与原文不一致';
  if ((source.match(/\\n/g) || []).length !== (value.match(/\\n/g) || []).length) return '换行数量与原文不一致';
  if (checkLength && source.includes('\\n')) {
    const errors = translationLineLengths(value).flatMap((length, index) =>
      length > 21 ? [`第 ${index + 1} 行 ${length} 字，超过 21 字上限`] : []);
    if (errors.length) return errors.join('；');
  }
  return '';
}
// Match HoshimiToolkit merge_file, including exact-field names and player honorifics.
export function mergeIdolyScript(raw, rows, nameGlossary = {}, validation = {}) {
  const allFields = scriptFields(raw), fields = allFields.filter(f => f.key !== 'name');
  const data = rows.filter(r => !['info', '译者'].includes(r.id));
  if (fields.length !== data.length) throw Error('脚本与 CSV 行数或 ID 不一致');
  const changes = [];
  const honorifics = Object.entries(nameGlossary).filter(([key, value]) => key.startsWith('{user}') && key !== '{user}' && key !== value);
  function add(field, value) {
    if (!value || value === field.text) return;
    const error = validateTranslation(field.text, value, validation);
    if (error) throw Error(field.id + '：' + error);
    changes.push({...field, trans: value.replace(/(?<!\\)=/g, '\\=')});
  }
  fields.forEach((f, i) => {
    const row = data[i];
    if (![f.id, f.legacyId].includes(row.id) || row.text !== f.text || row.name !== f.name) throw Error('原文或说话人不匹配：' + f.id);
    const error = validateTranslation(f.text, row.trans, validation);
    if (error) throw Error(f.id + '：' + error);
    let value = row.trans;
    if (!value || value === f.text) value = nameGlossary[f.text] || value;
    if (!value || value === f.text) return;
    for (const [original, translated] of honorifics) {
      if (f.text.includes(original) && value.includes(original)) value = value.split(original).join(translated);
    }
    add(f, value);
  });
  for (const f of allFields.filter(f => f.key === 'name')) add(f, nameGlossary[f.text]);
  return changes.sort((a, b) => b.start - a.start).reduce((text, c) => text.slice(0, c.start) + c.trans + text.slice(c.end), raw);
}
