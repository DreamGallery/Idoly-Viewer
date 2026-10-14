import test from 'node:test';
import assert from 'node:assert/strict';
import { draftStorageKey, prepareLoginDraft, restoreBrowserDraft, type BrowserDraft } from './browser-drafts';
import { extractInfoFromCsvText, toCsvText } from './upstream/csv';

class MemoryStorage {
  values = new Map<string, string>();
  reads: string[] = [];
  failWrites = false;
  getItem(key: string) { this.reads.push(key); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}
const id = 'adv_test';
const source = extractInfoFromCsvText('id,name,text,trans\n1,A,原文一,\n2,A,原文二,\ninfo,adv_test.txt,source-v1,\n译者,,,');
function draft(text: string, sha256 = 'csv-v1'): BrowserDraft {
  return { csv: toCsvText({ ...source, data: source.data.map(row => ({ ...row, trans: text })) }), sha256, savedAt: 1 };
}
function setup() {
  const storage = new MemoryStorage(), session = new MemoryStorage();
  const restore = (collaborator = true, sha256 = 'csv-v1') => restoreBrowserDraft(storage, session, id, collaborator, source, sha256);
  return { storage, session, restore };
}

test('OAuth return keeps the exact pre-login text, including empty rows and line breaks', () => {
  const { storage, session, restore } = setup();
  const incoming = draft('登录前\n最后一笔');
  prepareLoginDraft(storage, session, id, incoming);
  // A second tab editing the ordinary draft must not change this login snapshot.
  storage.setItem(draftStorageKey(id, false), JSON.stringify(draft('另一页的内容')));
  const result = restore();
  assert.equal(result.handoff, 'restored');
  assert.equal(result.doc?.data[0].trans, '登录前\\n最后一笔');
  assert.deepEqual(JSON.parse(storage.getItem(draftStorageKey(id, true))!), incoming);
  assert.equal(session.values.size, 0);
  assert.equal(restore().doc?.data[0].trans, '登录前\\n最后一笔');
  assert.equal(restore().handoff, null);

  prepareLoginDraft(storage, session, id, draft(''));
  assert.equal(restore().doc?.data[0].trans, '');
});

test('an existing collaboration draft is preserved and remains downloadable after refresh', () => {
  const { storage, session, restore } = setup();
  const previous = draft('原有协作草稿');
  storage.setItem(draftStorageKey(id, true), JSON.stringify(previous));
  prepareLoginDraft(storage, session, id, draft('本次登录前修改'));
  assert.deepEqual(restore().backups, [previous]);
  assert.deepEqual(restore().backups, [previous]);
  assert.equal(restore().doc?.data[0].trans, '本次登录前修改');
  prepareLoginDraft(storage, session, id, draft('本次登录前修改'));
  assert.deepEqual(restore().backups, [previous]);
});

test('later logins retain all distinct previous drafts instead of replacing the backup', () => {
  const { storage, session, restore } = setup();
  storage.setItem(draftStorageKey(id, true), JSON.stringify(draft('第一份')));
  prepareLoginDraft(storage, session, id, draft('第二份'));
  restore();
  prepareLoginDraft(storage, session, id, draft('第三份'));
  const result = restore();
  assert.deepEqual(result.backups.map(saved => saved.csv), [draft('第一份').csv, draft('第二份').csv]);
  assert.equal(result.doc?.data[0].trans, '第三份');
});

test('logout and users without write access never read or expose collaboration drafts or backups', () => {
  const { storage, session, restore } = setup();
  storage.setItem(draftStorageKey(id, true), JSON.stringify(draft('协作私有内容')));
  prepareLoginDraft(storage, session, id, draft('公开编辑内容'));
  restore();
  storage.setItem(draftStorageKey(id, true), JSON.stringify(draft('登录后继续编辑')));
  storage.reads.length = 0;
  const result = restore(false);
  assert.equal(result.doc?.data[0].trans, '公开编辑内容');
  assert.deepEqual(result.backups, []);
  assert.deepEqual(storage.reads, [draftStorageKey(id, false)]);
  assert.equal(result.handoff, null);
});

test('login without collaboration permission restores the ordinary draft without overwriting a private draft', () => {
  const { storage, session, restore } = setup();
  const previous = JSON.stringify(draft('协作草稿'));
  storage.setItem(draftStorageKey(id, true), previous);
  prepareLoginDraft(storage, session, id, draft('普通用户编辑'));
  assert.equal(restore(false).doc?.data[0].trans, '普通用户编辑');
  assert.equal(storage.getItem(draftStorageKey(id, true)), previous);
  assert.equal(session.values.size, 0);
});

test('without an explicit login handoff an older public draft cannot replace collaboration work', () => {
  const { storage, session, restore } = setup();
  storage.setItem(draftStorageKey(id, false), JSON.stringify(draft('旧的公开草稿')));
  storage.setItem(draftStorageKey(id, true), JSON.stringify(draft('正在进行的协作稿')));
  prepareLoginDraft(storage, session, id, null);
  assert.equal(restore().doc?.data[0].trans, '正在进行的协作稿');
});

test('source changes keep the login draft as a downloadable backup and preserve current collaboration work', () => {
  const { storage, session, restore } = setup();
  const incoming = draft('基于旧原文的修改', 'csv-old');
  storage.setItem(draftStorageKey(id, true), JSON.stringify(draft('当前原文协作稿')));
  prepareLoginDraft(storage, session, id, incoming);
  const result = restore();
  assert.equal(result.handoff, 'source-changed');
  assert.equal(result.doc?.data[0].trans, '当前原文协作稿');
  assert.deepEqual(result.backups, [incoming]);
  assert.deepEqual(restore().backups, [incoming]);
});

test('different rows with the same hash are not silently imported', () => {
  const { storage, session, restore } = setup();
  const incoming = draft('待保留');
  incoming.csv = incoming.csv.replace('原文一', '另一个版本的原文');
  prepareLoginDraft(storage, session, id, incoming);
  const result = restore();
  assert.equal(result.handoff, 'source-changed');
  assert.equal(result.doc, null);
  assert.deepEqual(result.backups, [incoming]);
  assert.equal(storage.getItem(draftStorageKey(id, true)), null);
});

test('an unrelated chapter or tab cannot consume the handoff', () => {
  const { storage, session, restore } = setup();
  prepareLoginDraft(storage, session, id, draft('当前章节的文字'));
  assert.equal(restoreBrowserDraft(storage, session, 'another', true, source, 'csv-v1').doc, null);
  assert.equal(restoreBrowserDraft(storage, new MemoryStorage(), id, true, source, 'csv-v1').doc, null);
  assert.equal(restore().doc?.data[0].trans, '当前章节的文字');
});

test('storage failure before login does not allow an incomplete handoff', () => {
  const { storage, session } = setup();
  storage.failWrites = true;
  assert.throws(() => prepareLoginDraft(storage, session, id, draft('尚未保存')), /Quota/);
  assert.equal(session.values.size, 0);
  storage.failWrites = false;
  session.failWrites = true;
  assert.throws(() => prepareLoginDraft(storage, session, id, draft('已保存在普通草稿')), /Quota/);
  assert.equal(JSON.parse(storage.getItem(draftStorageKey(id, false))!).csv, draft('已保存在普通草稿').csv);
});

test('storage failure during restoration preserves both versions and can be retried', () => {
  const { storage, session, restore } = setup();
  const previous = JSON.stringify(draft('原协作稿'));
  storage.setItem(draftStorageKey(id, true), previous);
  prepareLoginDraft(storage, session, id, draft('登录前稿'));
  storage.failWrites = true;
  assert.throws(() => restore(), /Quota/);
  assert.equal(storage.getItem(draftStorageKey(id, true)), previous);
  assert.equal(session.values.size, 1);
  storage.failWrites = false;
  assert.equal(restore().doc?.data[0].trans, '登录前稿');
  assert.deepEqual(restore().backups, [draft('原协作稿')]);
});

test('ordinary stale drafts remain downloadable without being applied to a new source', () => {
  const { storage, restore } = setup();
  storage.setItem(draftStorageKey(id, false), JSON.stringify(draft('原文更新前', 'old')));
  const result = restore(false);
  assert.equal(result.doc, null);
  assert.equal(result.stale, draft('原文更新前', 'old').csv);
});

test('a failed replacement after backup creation remains retryable without duplicate backups', () => {
  const { storage, session, restore } = setup();
  const previous = JSON.stringify(draft('原协作稿'));
  storage.setItem(draftStorageKey(id, true), previous);
  prepareLoginDraft(storage, session, id, draft('登录前稿'));
  const write = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === draftStorageKey(id, true)) throw new Error('QuotaExceededError');
    write(key, value);
  };
  assert.throws(() => restore(), /Quota/);
  assert.equal(storage.getItem(draftStorageKey(id, true)), previous);
  assert.equal(session.values.size, 1);
  storage.setItem = write;
  const result = restore();
  assert.equal(result.doc?.data[0].trans, '登录前稿');
  assert.deepEqual(result.backups, [draft('原协作稿')]);
});
