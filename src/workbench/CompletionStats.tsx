import { useState, useSyncExternalStore } from 'react';
import { DocTask, sameWorkUser, subscribeWorkUsers, workUsersVersion } from './upstream/workflow';
import { completionStats } from './completion-stats';
export function CompletionStats({ tasks, login }: { tasks: DocTask[]; login: string }) {
  useSyncExternalStore(subscribeWorkUsers, workUsersVersion);
  const stats = completionStats(tasks);
  const [sort, setSort] = useState<'total' | 'translation' | 'proofread' | 'chapters'>('total');
  const mine = stats.find(s => sameWorkUser(s.id, login));
  const sorted = [...stats].sort((a,b) => b[sort]-a[sort] || b.total-a.total || a.name.localeCompare(b.name));
  return <section className="completion-stats" aria-label="完成统计">
    <div className="completion-overview"><h2>完成统计</h2><span>我的翻译 <strong>{mine?.translation || 0}</strong></span><span>我的校对 <strong>{mine?.proofread || 0}</strong></span><span>参与完成章节 <strong>{mine?.chapters || 0}</strong></span></div>
    <details><summary>成员统计 · {stats.length} 人</summary>
      <div className="work-toolbar"><label>统计排序 <select aria-label="统计排序" value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="total">完成工序</option><option value="translation">翻译数量</option><option value="proofread">校对数量</option><option value="chapters">章节数量</option></select></label></div>
      <p className="completion-note">按全部任务当前的完成归属统计，不受列表筛选影响。同一章节的翻译与校对各计一道工序，章节数按成员去重；不追溯历史修订。</p>
      <div className="completion-table"><table><thead><tr><th scope="col">成员</th><th scope="col">翻译</th><th scope="col">校对</th><th scope="col">完成工序</th><th scope="col">章节</th></tr></thead><tbody>{sorted.map(s => <tr key={s.id} className={sameWorkUser(s.id, login) ? 'is-me' : ''}><th scope="row">{s.name}{sameWorkUser(s.id, login) && <small>（我）</small>}</th><td>{s.translation}</td><td>{s.proofread}</td><td>{s.total}</td><td>{s.chapters}</td></tr>)}</tbody></table></div>
      {!stats.length && <p>暂时没有已完成任务</p>}
    </details>
  </section>;
}
