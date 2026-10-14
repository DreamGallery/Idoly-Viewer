import { mergeTranslation, type CsvTextInfo } from './upstream/csv';

export type BrowserDraft = { sha256: string; csv: string; savedAt: number | string };
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const draftStorageKey = (scriptId: string, collaborator: boolean) => `${collaborator ? 'idoly-draft-v1' : 'idoly-local-draft-v1'}:${scriptId}`;
const loginKey = (scriptId: string) => `idoly-login-draft-v1:${scriptId}`;
const backupKey = (scriptId: string) => `idoly-draft-backups-v1:${scriptId}`;

function parseDraft(raw: string): BrowserDraft {
  const draft = JSON.parse(raw);
  if (!draft || typeof draft.sha256 !== 'string' || typeof draft.csv !== 'string'
    || !['number', 'string'].includes(typeof draft.savedAt)) throw new Error('浏览器草稿格式不正确');
  return draft;
}
const sameDraft = (a: BrowserDraft, b: BrowserDraft) => a.sha256 === b.sha256 && a.csv === b.csv;

// Take an exact snapshot before leaving for OAuth, including the last edit.
// The tab-scoped handoff only contains edits made without repository access.
export function prepareLoginDraft(storage: DraftStorage, session: DraftStorage, scriptId: string, draft: BrowserDraft | null) {
  if (!draft) { session.removeItem(loginKey(scriptId)); return; }
  const raw = JSON.stringify(draft);
  storage.setItem(draftStorageKey(scriptId, false), raw);
  session.setItem(loginKey(scriptId), raw);
}

export function restoreBrowserDraft(storage: DraftStorage, session: DraftStorage, scriptId: string, collaborator: boolean, source: CsvTextInfo, sha256: string) {
  const raw = storage.getItem(draftStorageKey(scriptId, collaborator));
  let draft = raw ? parseDraft(raw) : null;
  // Never read private drafts or their backups in the public editor.
  const storedBackups: unknown = collaborator ? JSON.parse(storage.getItem(backupKey(scriptId)) || '[]') : [];
  if (!Array.isArray(storedBackups)) throw new Error('浏览器草稿备份格式不正确');
  const backups = storedBackups.map(backup => parseDraft(JSON.stringify(backup)));
  let handoff: 'restored' | 'source-changed' | null = null;
  const pending = session.getItem(loginKey(scriptId));
  if (pending && collaborator) {
    const incoming = parseDraft(pending);
    let compatible = incoming.sha256 === sha256;
    if (compatible) {
      try { mergeTranslation(source, incoming.csv, false); }
      catch { compatible = false; }
    }
    const preserve = compatible ? draft : incoming;
    if (preserve && (!compatible || !sameDraft(preserve, incoming)) && !backups.some(backup => sameDraft(backup, preserve))) {
      backups.push(preserve);
      // Preserve the previous draft before replacing it. A quota error leaves
      // the old draft and the pending handoff intact so neither is lost.
      storage.setItem(backupKey(scriptId), JSON.stringify(backups));
    }
    if (compatible) {
      storage.setItem(draftStorageKey(scriptId, true), pending);
      draft = incoming;
      handoff = 'restored';
    } else {
      handoff = 'source-changed';
    }
  }
  const doc = draft?.sha256 === sha256 ? mergeTranslation(source, draft.csv, false) : null;
  if (pending) session.removeItem(loginKey(scriptId));
  return { doc, stale: draft && !doc ? draft.csv : null, backups, handoff };
}
