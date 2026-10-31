import { useEffect, useRef, useState } from 'react';
import { api, type Auth } from './github';
import { WorkbenchDialog } from './WorkbenchDialog';

type TaskGroup = { id: string; label: string; count: number; sha: string };
type TaskRequest = { state: 'requested' | 'busy'; runId: number | null; url: string };
type TaskRun = { runId: number; url: string; status: string; conclusion: string | null };

export function CreateStoryTask({ scriptId, auth, disabled, open, onClose, onReady }: {
  scriptId: string; auth: Auth; disabled: boolean; open: boolean; onClose: () => void; onReady: () => Promise<void>;
}) {
  const [group, setGroup] = useState<TaskGroup | null>(null), [reload, setReload] = useState(0);
  const [request, setRequest] = useState<TaskRequest | null>(null);
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const [refreshGroup, setRefreshGroup] = useState(false);
  const locked = useRef(false);
  const ready = useRef(onReady), mounted = useRef(true);
  const visible = useRef(open);
  useEffect(() => { ready.current = onReady; }, [onReady]);
  useEffect(() => { visible.current = open; }, [open]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setGroup(null); setError(''); setRefreshGroup(false); setRequest(null); setRetry(false); setNotice('');
    api<TaskGroup>('github/read', { kind: 'taskGroup', scriptId }, auth.csrf)
      .then(value => { if (active) setGroup(value); })
      .catch(e => { if (active) { setError(e instanceof Error ? e.message : String(e)); setRefreshGroup(true); } });
    return () => { active = false; };
  }, [scriptId, auth.csrf, reload]);
  async function run(action: () => Promise<void>) {
    if (locked.current || disabled) return;
    locked.current = true; setBusy(true); setError(''); setRefreshGroup(false);
    try { await action(); }
    catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRefreshGroup((e as { response?: { status: number } }).response?.status === 409);
    }
    finally { locked.current = false; setBusy(false); }
  }
  async function create() {
    if (!group) return;
    const result = await api<TaskRequest>('github/task', { scriptId, groupSha: group.sha }, auth.csrf);
    setRequest(result); setRetry(false);
    setNotice(result.state === 'busy'
      ? '已有协作同步或发布工作流在运行，结束后可添加本组任务。'
      : '已提交同组任务创建请求，已有任务会复用。');
  }
  async function check() {
    if (!request?.runId) { await ready.current(); return; }
    const result = await api<TaskRun>('github/read', { kind: 'taskRun', runId: request.runId }, auth.csrf);
    if (!mounted.current || !visible.current) return;
    if (result.status !== 'completed') {
      setNotice(result.status === 'in_progress' ? '工作流正在运行。' : '工作流正在排队。');
      return;
    }
    if (request.state === 'busy') { setRetry(true); setNotice('上一项工作流已结束，可以添加本组任务。'); return; }
    if (result.conclusion !== 'success') {
      setRetry(true); setNotice('工作流未成功完成，请查看运行记录后重试。'); return;
    }
    setNotice('工作流已完成，正在连接任务。');
    await ready.current();
    setNotice('同组任务处理完成。');
  }
  return <WorkbenchDialog open={open} className="work-task-dialog" title={request ? '创建协作任务' : '尚未建立协作任务'}
    description={request ? '创建完成后可连接任务。' : '可添加当前分组的缺失任务，已有任务会复用。'} onClose={onClose}>
    <div className="work-task-create">
      <p className="work-task-group">{group && <>{group.label} · {group.count} 篇</>}</p>
      <div className="work-task-status">
        <p role="status">{busy ? '正在处理…' : error ? '' : !group ? '正在读取分组…' : notice}</p>
        {error && <p className="work-error" role="alert">{error}{refreshGroup && <> <button type="button" disabled={busy || disabled} onClick={() => setReload(n => n + 1)}>刷新分组</button></>}</p>}
      </div>
      <div className="work-task-run-slot">
        {request && <a className="work-task-run" href={request.url} target="_blank" rel="noopener noreferrer">查看 Action</a>}
      </div>
      <div className="work-confirm-actions work-task-actions">
        <button type="button" autoFocus onClick={onClose}>{request ? '关闭' : '取消'}</button>
        {(!request || retry) && <button type="button" className="work-primary" disabled={!group || busy || disabled} onClick={() => run(create)}>{request ? '重新添加同组任务' : '添加同组缺失任务'}</button>}
        {request && !retry && <button type="button" disabled={busy || disabled} onClick={() => run(check)}>{request.runId ? '检查创建进度' : '连接协作任务'}</button>}
      </div>
    </div>
  </WorkbenchDialog>;
}
