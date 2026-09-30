import assert from 'node:assert/strict';
import test from 'node:test';
import { groupUpdates, recentTextUpdates, textUpdateView, type TextUpdate } from './text-updates';
const now = Date.parse('2026-09-30T08:00:00Z');
function row(id: string, time: number | null, cast = ['ktn']): TextUpdate {
  return {script_id:id, entry_id:id, title:id, group_title:'同一章节', group_id:'chapter-1',category_id:'main', character_ids:cast, pending:false, images:[], csv_path:`CSV/${id}.csv`,line_count:10, updated_at:time, change_kind:'modified', commit:'abc'};
}
test('rolling fourteen-day window includes boundary and excludes unknown/future/older dates', () => {
  const cutoff=now-14*86400000;
  assert.deepEqual(recentTextUpdates([row('old',cutoff-1),row('boundary',cutoff),row('now',now),row('future',now+1),row('unknown',null)],now).map(r=>r.script_id),['now','boundary']);
});
test('one master group stays together when chapter casts differ; newest group comes first', () => {
  const rows=recentTextUpdates([row('adv_01',now-100,['ktn']),row('adv_02',now,['ski']),{...row('adv_03',now-200),group_id:'chapter-2'}],now);
  const groups=groupUpdates(rows);
  assert.equal(groups.length,2);
  assert.deepEqual(groups[0].items.map(r=>r.script_id),['adv_01','adv_02']);
  assert.equal(groups[1].items[0].script_id,'adv_03');
});
test('pending view includes older and undated texts without including mapped stories', () => {
  const rows=[{...row('old-pending',now-30*86400000),pending:true},{...row('undated-pending',null),pending:true},row('mapped',now)];
  assert.deepEqual(textUpdateView(rows,true,now).map(r=>r.script_id),['old-pending','undated-pending']);
  assert.deepEqual(textUpdateView(rows,false,now).map(r=>r.script_id),['mapped']);
});
