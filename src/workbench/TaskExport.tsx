import { useState } from 'react';
import { Download } from 'lucide-react';
import { type Auth, Github } from './github';
import { type DocTask } from './upstream/workflow';
import { downloadFile, exportTxt, taskCsv, type ExportStage } from './export';
export function TaskExport({ tasks, auth }: { tasks: DocTask[]; auth: Auth }) {
  const [stage, setStage] = useState<ExportStage>('best');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  async function run(format: 'csv' | 'txt') {
    setBusy(true); setNotice('正在准备导出…');
    const failures: string[] = [], files: Record<string, Uint8Array> = {};
    try {
      const { zipSync, strToU8 } = await import('fflate');
      const w = new Github(auth);
      const unique = [...new Map(tasks.map(t => [t.title, t])).values()];
      for (const [index, task] of unique.entries()) {
        setNotice(`正在导出 ${index + 1} / ${unique.length}`);
        try {
          if (!/^[\w-]+$/.test(task.title)) throw new Error('无效章节名');
          const csv = await taskCsv(w, task, stage);
          files[task.title + '.' + format] = strToU8(format === 'csv' ? '\uFEFF' + csv.replace(/^\uFEFF/, '') : await exportTxt(task.title, csv));
        } catch (e) { failures.push(`${task.title}：${e instanceof Error ? e.message : String(e)}`); }
      }
      const count = Object.keys(files).length;
      if (count) {
        if (failures.length) files['导出失败.txt'] = strToU8(failures.join('\n'));
        if (unique.length === 1 && !failures.length) { const [name, bytes] = Object.entries(files)[0]; downloadFile(bytes, name); }
        else downloadFile(zipSync(files), `idoly-${stage}-${format}.zip`, 'application/zip');
      }
      setNotice(`已导出 ${count} 个文件${failures.length ? `；${failures.length} 项失败：\n${failures.join('\n')}` : ''}`);
    } catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <div className="work-export"><div className="work-toolbar">
    <span>已选 {tasks.length} 项</span>
    <label>导出版本 <select aria-label="导出版本" value={stage} disabled={busy} onChange={e => setStage(e.target.value as ExportStage)}><option value="best">正式稿（校对优先）</option><option value="translated">翻译稿</option><option value="proofread">校对稿</option><option value="ai">机器译文</option></select></label>
    <button disabled={busy || !tasks.length} onClick={() => run('csv')}><Download size={16} />导出 CSV</button>
    <button disabled={busy || !tasks.length} onClick={() => run('txt')}><Download size={16} />导出 TXT</button>
  </div>{notice && <p className="work-export-notice" role="status">{notice}</p>}</div>;
}
