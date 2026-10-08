import Papa from 'papaparse';

const unavailable = () => Object.assign(new Error('原文数据格式无效'), {status:503});
const sourceRow = row => ({
  id:row.id,
  name:row.id === '译者' ? '' : row.name,
  text:row.id === '译者' ? '' : row.text,
  trans:'',
});

// Public responses contain source fields only, including for older R2 snapshots.
export function originalCsv(csv) {
  const parsed = Papa.parse(csv.replace(/^\uFEFF/, ''), {header:true, skipEmptyLines:'greedy'});
  if (parsed.errors.length || !['id','name','text','trans'].every(key => parsed.meta.fields?.includes(key))) throw unavailable();
  return Papa.unparse(parsed.data.map(sourceRow), {columns:['id','name','text','trans'], newline:'\r\n'});
}

export function originalStory(story) {
  if (!story || !Array.isArray(story.rows)) throw unavailable();
  const publicFields = ['id','path','category','originalTitle','characters','lines','aiLines','humanLines','reviewedLines','translationStatus','masterId','references','sourceHash','sourceFileHash','script'];
  return {
    ...Object.fromEntries(publicFields.filter(key => Object.hasOwn(story,key)).map(key => [key,story[key]])),
    title:story.originalTitle || story.id,
    rows:story.rows.map(row => ({...sourceRow(row),start:row.start,end:row.end,character:row.character})),
    metadata:(story.metadata || []).map(sourceRow),
    names:Object.fromEntries(story.rows.filter(row => row.name).map(row => [row.name,row.name])),
  };
}
