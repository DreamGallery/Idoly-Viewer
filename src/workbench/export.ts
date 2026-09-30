import { api, decode, Github } from './github';
import { mergeScriptText } from './script-text';
import { extractInfoFromCsvText, type CsvDataLine } from './upstream/csv';
import { type DocTask, validateRowsHtmlTags, WORK_BRANCH, WORK_OWNER, WORK_REPO } from './upstream/workflow';

// Based on upstream buildChineseTxt: replace only text attributes, keeping ADV commands intact.
// Match original occurrences once so repeated dialogue can have different translations.
export function translatedScript(raw: string, rows: CsvDataLine[]): string {
  const errors = validateRowsHtmlTags(rows);
  if (errors.length) throw new Error(errors.slice(0, 5).join('；'));
  return mergeScriptText(raw, rows);
}
export async function exportTxt(id: string, csv: string): Promise<string> {
  const { txt } = await api<{ txt: string }>('script/' + encodeURIComponent(id));
  const parsed=extractInfoFromCsvText(csv);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(txt))),b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==parsed.sourceHash)throw new Error('原始脚本版本不一致，请重新载入后导出');
  return translatedScript(txt, parsed.data);
}
export function downloadFile(content: BlobPart, name: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export type ExportStage = 'best' | 'translated' | 'proofread' | 'ai';
export async function taskCsv(w: Github, task: DocTask, stage: ExportStage): Promise<string> {
  const candidates = stage === 'best' ? [task.proofreadPath, task.translatedPath] : [stage === 'ai' ? task.aiPath : stage === 'proofread' ? task.proofreadPath : task.translatedPath];
  for (const path of [...new Set(candidates)].filter(Boolean)) {
    try {
      const csv = decode((await w.getContent(WORK_OWNER, WORK_REPO, WORK_BRANCH, path)).content);
      const errors = validateRowsHtmlTags(extractInfoFromCsvText(csv).data);
      if (errors.length) throw new Error(errors.slice(0, 5).join('；'));
      return csv;
    }
    catch (e) { if ((e as { response?: { status: number } }).response?.status !== 404) throw e; }
  }
  throw new Error('所选阶段没有稿件');
}
