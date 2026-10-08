import {createHash} from 'node:crypto';
import {validateCsvAgainstScript} from './validate-csv.mjs';
import {originalCsv} from './public-story.mjs';

const fail = (status, message) => Object.assign(new Error(message), {status});
const hash = text => createHash('sha256').update(text).digest('hex');
const sourceRepo = 'DreamGallery/Hoshimi-Adv';

// A manifest and its CSV are always read from the same immutable work commit.
export function collaborationSources({read, remoteFetch}) {
  const manifests = new Map(), scripts = new Map();
  const remember = (map, key, value, limit) => {
    if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value); return value;
  };
  async function manifest(session, head) {
    if (manifests.has(head)) return manifests.get(head);
    let value;
    try { value = JSON.parse(await read(session, 'automation/story-sources.json', head)); }
    catch (error) {
      if (error.status === 404) throw fail(503, '协作原文尚未同步，请先运行原文同步工作流');
      throw error;
    }
    if (value.schema_version !== 1 || value.source_repository !== sourceRepo || !/^[a-f0-9]{40}$/.test(value.source_commit) || !value.scripts || typeof value.scripts !== 'object') throw fail(503, '协作原文清单无效');
    return remember(manifests, head, value, 3);
  }
  async function entry(session, head, id) {
    const value = await manifest(session, head), item = value.scripts[id];
    if (!item) throw fail(404, '协作分支没有此章节原文');
    if (typeof item.csv_path !== 'string' || !item.csv_path.endsWith('/'+id+'.csv') && item.csv_path !== id+'.csv' || item.csv_path.split('/').some(p => !p || p === '.' || p === '..') || !/^[a-f0-9]{64}$/.test(item.source_sha256) || item.raw_path !== 'Resource/'+id+'.txt') throw fail(503, '协作原文路径无效');
    return {...item, source_commit: value.source_commit};
  }
  async function raw(session, head, id) {
    const item = await entry(session, head, id), key = item.source_commit+':'+id;
    if (scripts.has(key)) return scripts.get(key);
    const response = await remoteFetch(`https://raw.githubusercontent.com/${sourceRepo}/${item.source_commit}/${item.raw_path}`, {redirect:'manual', signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw fail(503, '暂时无法读取协作版本原文，请稍后重试');
    const text = await response.text();
    if (Buffer.byteLength(text) > 2*1024*1024 || hash(text) !== item.source_sha256) throw fail(503, '协作原文校验失败');
    return remember(scripts, key, text, 16);
  }
  async function source(session, head, id) {
    const item = await entry(session, head, id);
    const [value, txt] = await Promise.all([read(session, 'story/ai/'+item.csv_path, head), raw(session, head, id)]);
    validateCsvAgainstScript(value, txt, {checkLength:false});
    const csv = originalCsv(value);
    return {csv, txt, sha256:hash(csv), sourceHash:item.source_sha256, path:item.csv_path, head, label:'协作分支原文'};
  }
  return {entry, raw, source};
}

export function validateSourceConfirmation(before, after, sourceHash, login) {
  if (before?.source_change?.status !== 'needs-confirmation') return;
  const confirmation = after?.source_confirmation;
  if (after?.source_change?.status !== 'confirmed' || after.source_change.source_sha256 !== sourceHash || before.source_change.source_sha256 !== sourceHash || confirmation?.source_sha256 !== sourceHash || confirmation?.confirmed_by !== login) {
    throw fail(409, '原文已更新，请核对保留的译文并确认后再完成');
  }
}
