import type { Entry } from './catalog';
export interface TextUpdate {
  script_id: string; entry_id: string; title: string; group_title: string | null;
  group_id?: string | null; category_id: string; character_ids: string[]; pending: boolean;
  images: NonNullable<Entry['group_images']>; csv_path: string; line_count: number;
  portrait_cover?: boolean;
  origin?: string; repo?: string; revision?: string;
  updated_at: number | null; change_kind: 'added' | 'modified' | null; commit: string | null;
}
export function recentTextUpdates(rows: TextUpdate[], now: number): TextUpdate[] {
  const cutoff = now - 14 * 24 * 60 * 60 * 1000;
  return rows.filter(row => row.updated_at !== null && row.updated_at >= cutoff && row.updated_at <= now)
    .sort((a, b) => b.updated_at! - a.updated_at! || a.script_id.localeCompare(b.script_id));
}
export function textUpdateView(rows: TextUpdate[], pendingOnly: boolean, now: number): TextUpdate[] {
  return pendingOnly ? rows.filter(row => row.pending) : recentTextUpdates(rows, now);
}
// Only recognized filename families are grouped without masterdata.
export function pendingStoryKey(id: string): string {
  const match = /^(adv_(?:cidol-[a-z0-9]+-\d+-\d+|csprt-\d+-\d+))_\d+$/.exec(id)
    || /^(adv_event_\d+)_(?:main|sub)-\d+(?:-\d+)?$/.exec(id)
    || /^(adv_event_highscore_introduction)-\d+$/.exec(id);
  return match?.[1] || id;
}
export function groupUpdates(rows: TextUpdate[]) {
  const groups = new Map<string, { id: string; title: string; items: TextUpdate[]; images: TextUpdate['images'] }>();
  for (const row of rows) {
    const family = row.group_id || (row.pending ? pendingStoryKey(row.script_id) : row.group_title || row.script_id);
    const key = JSON.stringify([row.pending, row.category_id, family,
      row.group_id ? null : [...row.character_ids].sort()]);
    let group = groups.get(key);
    if (!group) { group = { id: key, title: row.group_title || (row.pending ? family : row.title), items: [], images: [] }; groups.set(key, group); }
    if (!group.items.some(item => item.script_id === row.script_id)) group.items.push(row);
    if (!group.images.length && row.images.length) group.images = row.images;
  }
  return [...groups.values()].map(group => ({ ...group, items: group.items.sort((a,b) => a.script_id.localeCompare(b.script_id, 'ja', { numeric: true })) }));
}
