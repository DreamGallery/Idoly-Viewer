import type { IdolyVoices } from '../StoryChapter';
import { taskDatePages } from './date-pages';
import { TaskExport } from './TaskExport';
import { exportTxt, downloadFile } from './export';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { api, Auth, Github, decode, encode, Issue } from './github';
import { CsvTextInfo, extractInfoFromCsvText, mergeTranslation, toCsvText } from './upstream/csv';
import { displayWorkUser, findWorkUser, subscribeWorkUsers, workUsersVersion, applyTrack, completeStage, completionPath, docFromIssue, DocTask, draftInfoOf, fetchRecordForWrite, myStatusOf, sameWorkUser, saveDraft, setAssigneeUsers, syncRecordTracks, TrackKey, validateRowsHtmlTags, WORK_BRANCH, WORK_OWNER, WORK_REPO } from './upstream/workflow';
import { docStatus, STORY_LABELS, storyKind } from './upstream/document-filter';
import { ArrowLeft, UserRound } from 'lucide-react';
import { useCatalog, type ChapterVoices } from '../catalog';
import { VoicePlayer } from './VoicePlayer';
import { CompletionStats } from './CompletionStats';
import { TranslationInput } from './TranslationInput';
import {validateTranslation} from './idoly-script';
import './workbench.css';

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const taskTimestamp = (value?: string) => Date.parse(value || '') || 0;
const publishedDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Login({ auth, refresh }: { auth: Auth | null; refresh: () => void }) {
  const [error, setError] = useState(''),[localName,setLocalName]=useState('');
  useSyncExternalStore(subscribeWorkUsers, workUsersVersion);
  return <div className="work-login">{auth?.user ? <><span>{findWorkUser(auth.user.login)?.[0] || auth.user.name || auth.user.login}</span><button onClick={() => { api('auth/logout', {}, auth.csrf).then(refresh).catch(e => setError(message(e))); }}>退出登录</button></> : auth?.local ? <><input aria-label="本地协作者名称" placeholder="本地协作者名称" value={localName} onChange={e=>setLocalName(e.target.value)}/><button onClick={()=>api('auth/local',{login:localName}).then(refresh).catch(e=>setError(message(e)))}>进入本地协作</button></> : auth?.configured ? <a className="work-button" href={'/api/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search)}>GitHub 登录</a> : <span>{auth ? "GitHub 登录尚未配置" : "正在检查登录状态…"}</span>}{error && <span role="alert">{error}</span>}</div>;
}
export function WorkbenchPage() {
  const catalog=useCatalog();
  useSyncExternalStore(subscribeWorkUsers, workUsersVersion);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [docs, setDocs] = useState<DocTask[]>([]), [error, setError] = useState('');
  const [loading, setLoading] = useState(true), [reload, setReload] = useState(0);
  const [search, setSearch] = useState(''), [mine, setMine] = useState(false);
  const [category, setCategory] = useState('all'), [status, setStatus] = useState('all'), [sort, setSort] = useState('default');
  const [page, setPage] = useState(1);
  const [selectionMode, setSelectionMode] = useState<'export' | TrackKey | null>(null);
  const exportMode = selectionMode === 'export';
  const [claiming, setClaiming] = useState(false), [claimNotice, setClaimNotice] = useState('');
  const eligible = (d: DocTask) => selectionMode === 'export' || !!selectionMode && d[selectionMode].state === '待认领';
  const changeMode = (mode: 'export' | TrackKey) => { setSelectionMode(current => current === mode ? null : mode); setSelected(new Set()); setClaimNotice(''); };
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const refresh = () => { setAuth(null); setDocs([]); setSelected(new Set()); setSelectionMode(null); setReload(n => n + 1); };
  useEffect(() => {
    let active = true;
    setLoading(true); setError(''); setDocs([]);
    async function load() {
      const a = await api<Auth>('auth/status');
      if (!active) return;
      setAuth(a);
      if (!a.canCollaborate) return;
      const w = new Github(a);
      const users = await w.getContent(WORK_OWNER, WORK_REPO, WORK_BRANCH, 'users.json').catch(e => { if (e.response?.status !== 404) throw e; return null; });
      if (!active) return;
      setAssigneeUsers(users ? JSON.parse(decode(users.content)) : {});
      const all: DocTask[] = [];
      for (let p = 1; p <= 100; p++) {
        const batch = await api<Issue[]>('github/read', { kind: 'issues', page: p });
        if (!active) return;
        all.push(...batch.filter(i => !i.pull_request).map(docFromIssue));
        if (batch.length < 100) { setDocs([...new Map(all.map(d => [d.number, d])).values()]); return; }
      }
      throw new Error('任务数量超过加载上限，请在 GitHub 查看');
    }
    load().catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);
  async function claimSelected() {
    if (!auth?.user || !selectionMode || selectionMode === 'export' || claiming) return;
    const role = selectionMode, login = auth.user.login, w = new Github(auth);
    setClaiming(true); setClaimNotice('正在认领…');
    const failures: string[] = []; let completed = 0, processed = 0;
    try {
      for (const number of selected) {
        try {
          const fresh = docFromIssue(await w.getIssue(WORK_OWNER, WORK_REPO, number));
          setDocs(ds => ds.map(d => d.number === number ? fresh : d));
          if (fresh[role].state !== '待认领') throw new Error('该工序已不再待认领');
          await applyTrack(w, number, role, { user: login, state: '进行中' }, true);
          const claimed = { ...fresh, [role]: { user: login, state: '进行中' as const } };
          setDocs(ds => ds.map(d => d.number === number ? claimed : d));
          setSelected(previous => { const next = new Set(previous); next.delete(number); return next; });
          completed++;
          try { await syncRecordTracks(w, fresh.title, claimed.tr, claimed.pr); }
          catch (e) { throw new Error('已认领，但记录同步失败：' + message(e)); }
        } catch (e) { failures.push(`#${number}：${message(e)}`); }
        processed++;
        setClaimNotice(`已认领 ${completed} 项，已处理 ${processed} / ${selected.size} 项`);
      }
    } finally {
      setClaiming(false);
      setClaimNotice(`已认领 ${completed} 项${failures.length ? '\n' + failures.join('\n') : ''}`);
    }
  }
  const shown = docs.filter(d => (d.title+' '+(catalog.story_titles?.[d.title]||'')).toLowerCase().includes(search.trim().toLowerCase())
    && (!mine || !!auth?.user && [d.tr.user, d.pr.user].some(u => sameWorkUser(u, auth.user!.login)))
    && (category === 'all' || storyKind(d.title) === category)
    && (status === 'all' || docStatus(d) === status));
  if (sort === 'updated') shown.sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.number - b.number);
  if (sort === 'name') shown.sort((a,b) => a.title.localeCompare(b.title, 'ja', { numeric: true }) || a.number - b.number);
  const datePages = taskDatePages(shown);
  const pages = Math.max(1, datePages.length);
  const currentPage = Math.min(page, pages);
  const currentDate = datePages[currentPage - 1];
  const pageTasks = currentDate?.tasks || [];
  return <main className="work-page">
    <header className="work-heading"><div className="section-title"><span className="section-en" aria-hidden="true">TRANSLATION</span><div><h1>翻译协作</h1></div></div><Login auth={auth} refresh={refresh} /></header>
    <section className="category-directory">{auth?.local&&<p className="local-notice">本地协作测试 · 任务与稿件仅保存到本机，不会提交 GitHub。</p>}
    {error && <p className="work-error" role="alert">{error}<button onClick={refresh}>重试</button></p>}
    {loading && <p role="status">正在读取协作信息…</p>}
    {!loading && !error && !auth?.canCollaborate && <p className="work-access">{auth?.user ? '当前账号没有工作仓库的写权限，协作任务已隐藏。' : '登录并拥有工作仓库写权限后，可查看协作任务。'}</p>}
    {auth?.canCollaborate && !loading && !error && <>
      <CompletionStats tasks={docs} login={auth.user?.login || ''} />
      {mine && <button className="back-link" onClick={() => { setMine(false); setPage(1); }}><ArrowLeft size={16} />返回全部任务</button>}
      <div className="work-toolbar">
        <input className="work-task-search" type="search" aria-label="搜索协作任务" placeholder="搜索剧情标题或文件名" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        {!mine && <button onClick={() => { setMine(true); setPage(1); }}>我的任务</button>}
        <label>剧情分类 <select aria-label="剧情分类筛选" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}><option value="all">全部分类</option>{Object.entries(STORY_LABELS).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>任务状态 <select aria-label="任务状态" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}><option value="all">全部状态</option>{['待翻译','翻译中','待校对','校对中','已完成'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>排序 <select aria-label="任务排序" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}><option value="default">默认顺序</option><option value="updated">最近更新</option><option value="name">剧情名称</option></select></label>
        {(['export', 'tr', 'pr'] as const).map(mode => <button key={mode} disabled={claiming} aria-pressed={selectionMode === mode} onClick={() => changeMode(mode)}>{selectionMode === mode ? '退出选择' : { export: '选择导出', tr: '认领翻译', pr: '认领校对' }[mode]}</button>)}
        <span>{mine ? '我的任务' : '全部任务'} · {shown.length} 项</span>
      </div>
      {!shown.length && <p>没有符合条件的任务</p>}
      {selectionMode && <><div className="work-toolbar"><button disabled={claiming} onClick={() => setSelected(new Set(shown.filter(eligible).map(d => d.number)))}>选择筛选结果</button><button disabled={claiming} onClick={() => setSelected(prev => new Set([...prev, ...pageTasks.filter(eligible).map(d => d.number)]))}>选择本页</button><button disabled={claiming || !selected.size} onClick={() => setSelected(new Set())}>清空选择</button></div>
      {exportMode ? <TaskExport tasks={docs.filter(d => selected.has(d.number))} auth={auth} /> : <div className="work-toolbar"><span>已选 {selected.size} 项 · 仅可选择待认领任务</span><button className="work-primary" disabled={claiming || !selected.size} onClick={claimSelected}>确认认领{selectionMode === 'tr' ? '翻译' : '校对'}</button></div>}</>}
      {claimNotice && <p className="work-export-notice" role="status">{claimNotice}</p>}
      <div className="work-tasks">{pageTasks.map(d => {
        const content = <><small>{STORY_LABELS[storyKind(d.title)]} · {docStatus(d)}</small><strong>{catalog.story_titles?.[d.title]||d.title}</strong><small>{d.title}</small><span>翻译：{d.tr.state} {displayWorkUser(d.tr.user)}</span><span>校对：{d.pr.state} {displayWorkUser(d.pr.user)}</span><small className="work-task-date">{taskTimestamp(d.createdAt) ? <>发布于 <time dateTime={d.createdAt} title="北京时间">{publishedDate.format(new Date(d.createdAt!))}</time></> : '发布时间未提供'}</small></>;
        return selectionMode
          ? <button key={d.number} type="button" disabled={claiming || !eligible(d)} className="work-task-option" aria-label={'选择 ' + d.title} aria-pressed={selected.has(d.number)} onClick={() => setSelected(prev => { const next = new Set(prev); if (next.has(d.number)) next.delete(d.number); else next.add(d.number); return next; })}>{content}</button>
          : <Link key={d.number} to={'/chapter/' + encodeURIComponent(d.title) + '?issue=' + d.number}>{content}</Link>;
      })}</div>
      {currentDate && <nav className="work-task-pagination" aria-label="协作任务日期分页">
        <button disabled={currentPage===1} onClick={() => setPage(currentPage-1)}>较新日期</button>
        <label>发布日期 <select aria-label="任务发布日期" value={currentDate.date} onChange={e => setPage(datePages.findIndex(group => group.date === e.target.value) + 1)}>
          {datePages.map(group => <option key={group.date} value={group.date}>{group.date}（{group.tasks.length} 项）</option>)}
        </select></label>
        <span aria-live="polite">{currentPage} / {pages} · 当日 {pageTasks.length} 项 · 北京时间</span>
        <button disabled={currentPage===pages} onClick={() => setPage(currentPage+1)}>较早日期</button>
      </nav>}
    </>}
    </section>
  </main>;
}
function Speaker({ name, index, choice, title }: { name: string; index: number; choice: boolean; title: boolean }) {
  const catalog = useCatalog();
  const normalize = (value: string) => value.replace(/\s+/g, '');
  const matches = (catalog.speaker_avatars || catalog.characters.map(c => ({ ...c, aliases: [c.name, c.first_name] })))
    .filter(c => c.aliases.some(alias => normalize(alias) === normalize(name)));
  const avatar = matches.length === 1 ? matches[0].avatar : null;
  const label = name === '{user}' ? '经纪人' : matches[0]?.name || name || (title ? '标题' : choice ? '选项' : '旁白');
  const [failed, setFailed] = useState(false);
  return <div className="work-speaker"><span className="work-speaker-avatar">{avatar && !failed ? <img src={avatar} alt="" loading="lazy" onError={() => setFailed(true)} /> : <UserRound size={24} aria-hidden="true" />}</span><small>{String(index + 1).padStart(3, '0')} · {label}</small></div>;
}
export function ChapterWorkbench({ scriptId, voices, idolyVoices }: { scriptId: string; voices?: ChapterVoices; idolyVoices?: IdolyVoices }) {
  useSyncExternalStore(subscribeWorkUsers, workUsersVersion);
  const playingAudio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => { playingAudio.current?.pause(); }, []);
  const [doc, setDoc] = useState<CsvTextInfo | null>(null), [sourceHash, setSourceHash] = useState(''), [auth, setAuth] = useState<Auth | null>(null), [task, setTask] = useState<DocTask | null>(null);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [role, setRole] = useState<TrackKey>('tr'), [search, setSearch] = useState(''), [onlyEmpty, setOnlyEmpty] = useState(false), [changed, setChanged] = useState(false);
  const [revising, setRevising] = useState(false), [remoteReady, setRemoteReady] = useState(false), [remoteLabel, setRemoteLabel] = useState('本地原文'), [draftAvailable, setDraftAvailable] = useState<string | null>(null);
  const wrapper = useRef<Github | null>(null), baseRevision = useRef<Record<TrackKey, number>>({ tr: 0, pr: 0 }), storageKey = `idoly-draft-v1:${scriptId}`;
  const source = useRef<CsvTextInfo | null>(null);
  const refreshAuth = () => { api<Auth>('auth/status').then(setAuth).catch(e => setError(message(e))); };
  useEffect(() => {
    let active = true;
    api<Auth>('auth/status').then(a => { if (active) setAuth(a); }).catch(e => { if (active) setError(message(e)); });
    api<{ csv: string; sha256: string; label?: string }>('source/' + encodeURIComponent(scriptId)).then(s => {
      if (!active) return; const parsed = extractInfoFromCsvText(s.csv); setRemoteLabel(s.label||'仓库稿件'); source.current = parsed; setSourceHash(s.sha256); setDoc(parsed);
      try { const saved = localStorage.getItem(storageKey); if (saved) { const draft = JSON.parse(saved); if (draft.sha256 === s.sha256) { setDoc(mergeTranslation(parsed, draft.csv, false)); setNotice('已恢复此浏览器保存的译文；恢复操作不会修改 GitHub 文件'); setRemoteLabel('浏览器草稿'); setChanged(true); } else { setDraftAvailable(draft.csv); setNotice('原文已更新，旧草稿可下载后核对'); } } } catch { setNotice('本地草稿无法恢复，可继续编辑并导出 CSV'); }
    }).catch(e => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [scriptId, storageKey]);
  useEffect(() => { setRemoteReady(false); wrapper.current = null; }, [auth?.user?.login]);
  useEffect(() => {
    if (!auth?.user) return;
    let active = true;
    new Github(auth).getContent(WORK_OWNER, WORK_REPO, WORK_BRANCH, 'users.json').then(file => {
      if (active) setAssigneeUsers(JSON.parse(decode(file.content)));
    }).catch(() => { /* Keep original account labels if the directory is unavailable. */ });
    return () => { active = false; };
  }, [auth]);
  useEffect(() => {
    if (!doc || !changed) return;
    try { localStorage.setItem(storageKey, JSON.stringify({ sha256: sourceHash, csv: toCsvText(doc), savedAt: new Date().toISOString() })); } catch { setError('浏览器草稿保存失败，请导出 CSV 备份'); }
  }, [doc, changed, sourceHash, storageKey]);
  useEffect(() => { if (!changed) return; const leave = (e: BeforeUnloadEvent) => { e.preventDefault(); }; window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave); }, [changed]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function connect() {
    if (!auth?.canCollaborate) throw new Error('登录并拥有工作仓库写权限后才能连接任务');
    if (auth.work.owner !== WORK_OWNER || auth.work.repo !== WORK_REPO || auth.work.branch !== WORK_BRANCH) throw new Error('前后端工作仓库配置不一致');
    const w = new Github(auth);
    try { const users = await w.getContent(WORK_OWNER, WORK_REPO, WORK_BRANCH, 'users.json'); setAssigneeUsers(JSON.parse(decode(users.content))); } catch (e) { if ((e as { response?: { status: number } }).response?.status !== 404) throw e; }
    const matches = await api<Issue[]>('github/read', { kind: 'findIssue', scriptId }); const found = matches[0] && docFromIssue(matches[0]);
    if (!found) throw new Error('工作仓库尚未建立本章节任务；可以先本地编辑并导出 CSV');
    const record = await fetchRecordForWrite(w, scriptId);
    baseRevision.current = { tr: Number(record.translation?.revision || 0), pr: Number(record.proofread?.revision || 0) };
    // Read all editable stage files now, before editing, to retain a conflict baseline.
    for (const r of ['tr', 'pr'] as const) {
      const paths = [completionPath(found.aiPath, scriptId, r), draftInfoOf(record, r, auth.user?.login || '')?.path];
      for (const path of paths) if (path) try { await w.getContent(WORK_OWNER, WORK_REPO, WORK_BRANCH, path); } catch (e) { if ((e as { response?: { status: number } }).response?.status !== 404) throw e; }
    }
    wrapper.current = w; setTask(found); setRemoteReady(true); setNotice('已连接任务。连接操作不会载入远端译文；如需载入，请点击对应按钮。');
  }
  async function loadStage(stage: 'ai' | 'translated' | 'proofread' | 'draft') {
    if (!task || !wrapper.current || !source.current) return;
    if (changed && !window.confirm('载入远端译文将替换翻译框中的现有文字。建议先导出 CSV 备份，是否继续？')) return;
    const w = wrapper.current;
    const record = await fetchRecordForWrite(w, scriptId);
    const draft = draftInfoOf(record, role, auth?.user?.login || '');
    if (stage === 'draft' && (!draft || draft.stale)) throw new Error(draft?.stale ? '远端草稿基于旧版本，请在 GitHub 下载后核对' : '没有远端草稿');
    const path = stage === 'ai' ? task.aiPath : stage === 'translated' ? task.translatedPath : stage === 'proofread' ? task.proofreadPath : draft!.path;
    const file = await w.getContent(WORK_OWNER, WORK_REPO, WORK_BRANCH, path);
    setDoc(mergeTranslation(source.current, decode(file.content))); setChanged(true); setRemoteLabel({ ai: '机器译文', translated: '翻译正式稿', proofread: '校对正式稿', draft: '远端草稿' }[stage]); setNotice('已载入' + { ai: '机器译文', translated: '翻译正式稿', proofread: '校对正式稿', draft: 'GitHub 草稿' }[stage] + '，并保存到此浏览器；此操作不会修改 GitHub 文件');
  }
  async function freshTask() {
    if (!wrapper.current || !task || !auth?.user) throw new Error('请登录并连接任务');
    const fresh = docFromIssue(await wrapper.current.getIssue(WORK_OWNER, WORK_REPO, task.number)); setTask(fresh); return fresh;
  }
  async function claim() {
    const fresh = await freshTask(); const track = fresh[role];
    if (track.state !== '待认领' && !sameWorkUser(track.user, auth!.user!.login)) throw new Error('此工序已被其他人认领');
    if (track.state === '完成') throw new Error('此工序已经完成');
    await applyTrack(wrapper.current!, fresh.number, role, { user: auth!.user!.login, state: '进行中' });
    const claimed: DocTask = { ...fresh, [role]: { user: auth!.user!.login, state: '进行中' } };
    setTask(claimed);
    try { await syncRecordTracks(wrapper.current!, scriptId, claimed.tr, claimed.pr); } catch (e) { throw new Error('任务已认领，但记录同步失败：' + message(e)); }
    setNotice('已认领' + (role === 'tr' ? '翻译' : '校对'));
  }
  async function submit(complete: boolean) {
    if (!doc || !wrapper.current) return;
    const fresh = await freshTask(); const status = myStatusOf(fresh.tr, fresh.pr, auth!.user!.login, revising ? role : undefined);
    if (status.activeRole !== role) throw new Error(status.blockMsg || '请先认领此工序');
    if (complete) { if (doc.data.some(r => !r.trans.trim())) throw new Error('还有未翻译的文本，请填写后再完成'); const errors = validateRowsHtmlTags(doc.data); if (errors.length) throw new Error('译文检查未通过：' + errors.join('；')); }
    const opts = { fileId: scriptId, role, sourcePath: fresh.aiPath, contentB64: encode(toCsvText(doc)), operatorGithub: auth!.user!.login };
    if (complete) {
      const result = await completeStage(wrapper.current, { ...opts, baseRevision: baseRevision.current[role] });
      try { await applyTrack(wrapper.current, fresh.number, role, { user: auth!.user!.login, state: '完成' }); }
      catch (e) { setRemoteReady(false); throw new Error(`正式稿已保存（${result.commitSha.slice(0, 7)}），但任务状态同步失败：${message(e)}。请在 GitHub 修正状态，避免重复提交。`); }
      setTask({ ...fresh, [role]: { user: auth!.user!.login, state: '完成' } }); setNotice(auth?.local?'本地正式稿已保存，对应工序已标记为完成':'正式稿已保存到 GitHub，对应工序已标记为完成'); setRemoteReady(false);
    } else { await saveDraft(wrapper.current, opts); setNotice(auth?.local?'已保存到本地协作草稿':'已保存到 GitHub 草稿；正式稿和任务完成状态未修改'); }
    setChanged(false);
  }
  const active = task && auth?.user ? myStatusOf(task.tr, task.pr, auth.user.login, revising ? role : undefined) : null;
  const voiceMap = new Map<number, NonNullable<ChapterVoices>['lines'][number]>();
  if (doc && source.current && voices?.source_sha256 === sourceHash) {
    for (const line of voices.lines) {
      const record = source.current.records[line.record_index - 1];
      if (record && record.text === line.text && record.name === line.speaker) {
        const index = source.current.data.indexOf(record);
        if (index >= 0) voiceMap.set(index, line);
      }
    }
  }
  if (doc && source.current && idolyVoices) {
    for (const line of idolyVoices.lines) {
      const index = source.current.data.findIndex(row => row.id === line.row_id && row.text === line.text && row.name === line.speaker);
      if (index >= 0) voiceMap.set(index, { record_index: index + 1, text: line.text, speaker: line.speaker, clips: line.clips });
    }
  }
  const rows = doc?.data.map((row, i) => ({ row, i })).filter(({ row }) => (!onlyEmpty || !row.trans.trim()) && (!search || [row.name, row.text, row.trans].some(t => t.includes(search))));
  return <section className="work-editor" aria-label="剧情翻译编辑器"><header><h2>剧情文本</h2><Login auth={auth} refresh={refreshAuth} /></header>
    <div className="work-toolbar">{auth?.local&&<p className="local-notice">本地协作测试 · 所有提交保存在本机</p>}<span>{remoteLabel} · {doc?.data.filter(r => r.trans.trim()).length || 0} / {doc?.data.length || 0}</span><button disabled={!doc} onClick={() => run(async()=>{if(doc){const errors=validateRowsHtmlTags(doc.data);if(errors.length)throw new Error(errors.join('；'));download(toCsvText(doc),scriptId+'.csv')}})}>导出 CSV</button><label className="work-button">导入 CSV<input type="file" accept=".csv,text/csv" hidden disabled={!doc || busy} onChange={e => { const file = e.target.files?.[0]; if (file && source.current) run(async () => { setDoc(mergeTranslation(source.current!, await file.text())); setChanged(true); setRemoteLabel('导入译文'); }); e.target.value = ''; }} /></label><button disabled={!doc || busy} onClick={() => run(async () => { if (doc) { downloadFile(await exportTxt(scriptId, toCsvText(doc)), scriptId + '.txt'); setNotice('TXT 已导出；未翻译的台词保留原文'); } })}>导出 TXT</button>{draftAvailable && <button onClick={() => download(draftAvailable, scriptId + '-旧草稿.csv')}>下载旧草稿</button>}</div>
    {auth?.canCollaborate && <div className="work-collaboration"><div className="work-toolbar"><select aria-label="协作工序" value={role} disabled={busy} onChange={e => { setRole(e.target.value as TrackKey); setRevising(false); }}><option value="tr">翻译</option><option value="pr">校对</option></select>{remoteReady && task && <><button disabled={busy || !auth?.user || task[role].state !== '待认领'} onClick={() => run(claim)}>认领{role === 'tr' ? '翻译' : '校对'}</button>{task[role].state === '完成' && !revising && <button disabled={busy || !auth?.user} onClick={() => setRevising(true)}>修订{role === 'tr' ? '翻译' : '校对'}</button>}</>}<button disabled={busy || !doc || remoteReady} onClick={() => run(connect)}>{remoteReady ? '已连接任务' : '连接协作任务'}</button>{task && !auth?.local && <a href={`https://github.com/${WORK_OWNER}/${WORK_REPO}/issues/${task.number}`} target="_blank" rel="noreferrer">任务 #{task.number}</a>}</div>
    {remoteReady && task && <><p>翻译：{task.tr.state} {displayWorkUser(task.tr.user) || '—'} / 校对：{task.pr.state} {displayWorkUser(task.pr.user) || '—'}</p><div className="work-toolbar">{(['ai', 'translated', 'proofread', 'draft'] as const).map((s, i) => <button disabled={busy} key={s} onClick={() => run(() => loadStage(s))}>{['载入机器译文', '载入翻译稿', '载入校对稿', '恢复远端草稿'][i]}</button>)}</div>{active?.blocked && <p>{active.blockMsg}</p>}</>}
    </div>}{error && <p className="work-error" role="alert">{error}</p>}{notice && <p className="work-notice" role="status">{notice}</p>}{busy && <p role="status">正在处理…</p>}
    {voices?.source_sha256 && sourceHash && voices.source_sha256 !== sourceHash && <p className="work-notice">原文版本与语音索引不一致，请更新索引后播放。</p>}
    {doc ? <><div className="work-toolbar"><input aria-label="搜索台词" placeholder="搜索角色或台词" value={search} onChange={e => setSearch(e.target.value)} /><button aria-pressed={onlyEmpty} onClick={() => setOnlyEmpty(!onlyEmpty)}>只看未翻译</button><span>编辑自动保存到此浏览器；协作保存需先连接任务</span></div><div className="work-rows">{rows?.map(({ row, i }) => <article className="work-row" key={i}><div className="work-original"><Speaker name={row.name} index={i} choice={row.id.includes(':choice:')} title={row.id.includes(':title:')} /><p>{row.text.replace(/\\n/g, '\n')}</p>{voiceMap.get(i) && <VoicePlayer clips={voiceMap.get(i)!.clips} row={i + 1} onPlay={audio => { if (playingAudio.current !== audio) playingAudio.current?.pause(); playingAudio.current = audio; }} />}</div><div><TranslationInput index={i} value={row.trans} disabled={busy} onChange={trans => { setDoc(d => d && ({ ...d, data: d.data.map((r, n) => n === i ? { ...r, trans } : r) })); setChanged(true); }} />{validateTranslation(row.text,row.trans)&&<p className="row-validation" role="alert">{validateTranslation(row.text,row.trans)}</p>}</div></article>)}</div></> : !error && <p>正在读取原文…</p>}
    {doc && auth?.canCollaborate && <footer className="work-editor-actions">{remoteReady && task && <div className="work-toolbar"><button disabled={busy || active?.activeRole !== role} onClick={() => run(() => submit(false))}>{auth?.local?'保存本地协作草稿':'保存 GitHub 草稿'}</button><button className="work-primary" disabled={busy || active?.activeRole !== role} onClick={() => run(() => submit(true))}>完成{role === 'tr' ? '翻译' : '校对'}</button></div>}
{error && <p className="work-error" role="alert">{error}</p>}{busy && <p role="status">正在处理…</p>}</footer>}
  </section>;
}
