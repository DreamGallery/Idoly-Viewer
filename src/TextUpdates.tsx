import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpen, ChevronDown, Search, X } from 'lucide-react';
import { useJson } from './catalog';
import CardPreview from './CardPreview';
import type { Catalog } from './idoly-types';
import { groupUpdates, textUpdateView, type TextUpdate } from './text-updates';
import { isTextOnlyStoryGroup } from './story-presentation';
import ListPagination from './ListPagination';

type Updates = { items: TextUpdate[]; source_commit: string; translation_commit: string; pending_count: number };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeZone: 'Asia/Shanghai' });
const normalize = (text: string) => text.normalize('NFKC').replace(/\s/g, '').toLocaleLowerCase();
const pageSize = 24;

// Adapted from Campus Viewer's TextUpdates: recent CSV commits, grouped chapters,
// category/change filters and pagination; uses this project's local catalog.
export default function TextUpdates({ catalog, categories }: { catalog: Catalog; categories: Record<string, string> }) {
  const { data, error } = useJson<Updates>('/data/updates.json');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [kind, setKind] = useState('all');
  const [page, setPage] = useState(1);
  const [openedAt] = useState(() => Date.now());
  const [params, setParams] = useSearchParams();
  const pendingOnly = params.get('view') === 'pending';
  const names = useMemo(() => new Map(catalog.characters.map(c => [c.id, c.name])), [catalog.characters]);
  const viewRows = useMemo(() => textUpdateView(data?.items || [], pendingOnly, openedAt), [data, pendingOnly, openedAt]);
  const rows = useMemo(() => {
    const search = normalize(query);
    return viewRows.filter(row => (category === 'all' || row.category_id === category)
      && (kind === 'all' || row.change_kind === kind)
      && (!search || normalize(`${row.title} ${row.group_title || ''} ${row.script_id} ${row.character_ids.map(id => names.get(id) || id).join(' ')}`).includes(search)));
  }, [viewRows, category, kind, query, names]);
  const groups = useMemo(() => groupUpdates(rows), [rows]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const current = Math.min(page, pages);
  return <section className="text-updates" aria-label="剧情文本更新">
    <div className="updates-intro">
      <p>更新列表仅显示最近两周的 CSV 提交，修改可能包含翻译调整。待补全资料不受时间限制。</p>
      <a href="https://github.com/DreamGallery/Hoshimi-Adv/tree/main/CSV" target="_blank" rel="noreferrer">查看文本仓库 ↗</a>
    </div>
    <div className="updates-tabs" role="group" aria-label="文本更新视图"><button aria-pressed={!pendingOnly} onClick={() => { setParams({}); setPage(1); }}>近两周更新</button><button aria-pressed={pendingOnly} onClick={() => { setParams({view:'pending'}); setPage(1); }}>待补全资料</button></div>
    <div className="filterbar updates-filters">
      <label className="search"><Search size={19}/><input aria-label="搜索文本更新" placeholder="搜索角色、章节或文件名" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/>{query && <button aria-label="清空更新搜索" onClick={() => { setQuery(''); setPage(1); }}><X size={16}/></button>}</label>
      <label className="updates-select">剧情分类<select aria-label="更新剧情分类" value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}><option value="all">全部分类</option>{Object.entries(categories).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="updates-select">变更类型<select aria-label="文本变更类型" value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="all">全部变更</option><option value="added">新增文件</option><option value="modified">修改文件</option></select></label>
    </div>
    {!data ? <div className="empty" role={error ? 'alert' : 'status'}>{error || '正在载入文本更新…'}</div> : <>
      <p className="updates-results" role="status">{rows.length.toLocaleString()} 篇文本</p>
      {!rows.length && <div className="empty">{pendingOnly ? '暂无符合条件的待补全资料' : viewRows.length ? '暂无符合筛选条件的文本更新' : '最近两周暂无文本更新'}</div>}
      <div className="updates-grid">{groups.slice((current - 1) * pageSize, current * pageSize).map(group => <article key={group.id} className={`updates-card updates-${group.items[0].category_id}`}>
        {!isTextOnlyStoryGroup(group.items[0].group_id || '') && (group.images.length ? <CardPreview images={group.images.map(image => ({ ...image, aspect_ratio: image.aspect_ratio ?? undefined }))} title={group.title} compact portrait={group.items[0].portrait_cover} zoomable={!['main','group','event'].includes(group.items[0].category_id)}/> : <div className="updates-cover-placeholder" aria-hidden="true"><BookOpen size={36} strokeWidth={1.25}/></div>)}
        <details>
          <summary><div><span className="updates-category">{categories[group.items[0].category_id]}</span><h3>{group.title}</h3>{group.items.some(row => row.updated_at !== null) && <time>{dateFormat.format(Math.max(...group.items.map(row => row.updated_at || 0)))}</time>}{group.items[0].pending && <span className="updates-pending">待补全资料</span>}</div><ChevronDown size={18}/></summary>
          <ul className="updates-chapters">{group.items.map(row => <li key={row.script_id}>
            <div className="updates-meta"><time>{row.updated_at === null ? '提交时间未知' : dateFormat.format(row.updated_at)}</time><span>{row.origin}</span>{row.change_kind && <span className={'update-kind ' + row.change_kind}>{row.change_kind === 'added' ? '新增' : '修改'}</span>}</div>
            <Link className="updates-chapter-link" to={`/chapter/${encodeURIComponent(row.script_id)}`}><span><strong>{row.title}</strong>{row.pending && <small>{row.script_id}</small>}<small>{row.line_count} 条文本</small></span><ArrowRight size={16}/></Link>
            {row.commit && <div className="updates-links"><a href={`https://github.com/DreamGallery/${row.repo}/blob/${row.revision}/${row.csv_path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer">CSV ↗</a><a href={`https://github.com/DreamGallery/${row.repo}/commit/${row.commit}`} target="_blank" rel="noreferrer">查看提交 ↗</a></div>}
          </li>)}</ul>
        </details>
      </article>)}</div>
      <ListPagination page={current} pages={pages} label="文本更新分页" onChange={next=>{setPage(next);window.scrollTo({top:0,left:0,behavior:'instant'})}}/>
    </>}
  </section>;
}
