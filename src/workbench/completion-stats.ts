import { DocTask, displayWorkUser, canonicalOperator } from './upstream/workflow';
export interface CompletionStat { id: string; name: string; translation: number; proofread: number; chapters: number; total: number }
export function completionStats(tasks: DocTask[]): CompletionStat[] {
  const people = new Map<string, CompletionStat & { scripts: Set<string> }>();
  const counted = new Set<string>();
  for (const task of tasks) for (const role of ['tr', 'pr'] as const) {
    const track = task[role];
    if (track.state !== '完成' || !track.user.trim()) continue;
    const name = displayWorkUser(track.user);
    const id = canonicalOperator(track.user).toLowerCase();
    const identity = `${task.title}:${role}:${id}`;
    if (counted.has(identity)) continue;
    counted.add(identity);
    const stat = people.get(id) || { id, name, translation: 0, proofread: 0, chapters: 0, total: 0, scripts: new Set<string>() };
    stat[role === 'tr' ? 'translation' : 'proofread']++;
    stat.total++; stat.scripts.add(task.title); stat.chapters = stat.scripts.size;
    people.set(id, stat);
  }
  return [...people.values()].map(s => ({ id: s.id, name: s.name, translation: s.translation, proofread: s.proofread, chapters: s.chapters, total: s.total })).sort((a,b) => b.total-a.total || a.name.localeCompare(b.name));
}
