import type { DocTask } from './upstream/workflow';

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function taskDatePages(tasks: DocTask[]) {
  const grouped = new Map<string, DocTask[]>();
  for (const task of tasks) {
    const timestamp = Date.parse(task.createdAt || '');
    const date = Number.isFinite(timestamp) ? dateFormat.format(timestamp) : '日期未知';
    const group = grouped.get(date) || [];
    group.push(task);
    grouped.set(date, group);
  }
  return [...grouped]
    .sort(([a], [b]) => a === b ? 0 : a === '日期未知' ? 1 : b === '日期未知' ? -1 : b.localeCompare(a))
    .map(([date, tasks]) => ({ date, tasks }));
}
