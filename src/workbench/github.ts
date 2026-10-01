import {resourceUrl} from '../resource-snapshot';
/* Adapter for the upstream Octokit-style workflow. Tokens stay in the API service. */
export interface Auth { local?: boolean; canCollaborate: boolean; configured: boolean; user: { login: string; name: string } | null; csrf: string | null; work: { owner: string; repo: string; branch: string } }
export async function api<T>(path: string, body?: unknown, csrf?: string | null): Promise<T> {
  const response = await fetch(resourceUrl('/api/' + path), { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('协作服务未启动，请启动 API 服务');
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `请求失败 ${response.status}`), { response: { status: response.status } });
  return data;
}
export function encode(text: string) { return btoa(Array.from(new TextEncoder().encode(text), c => String.fromCharCode(c)).join('')); }
export function decode(text: string) { return new TextDecoder().decode(Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0))); }
interface Content { sha: string; content: string }
export interface Issue { number: number; title: string; body: string; created_at?: string; updated_at: string; pull_request?: unknown; labels?: unknown[] }
export class Github {
  baseline = new Map<string, string | null>();
  issues = new Map<number, Issue>();
  constructor(public auth: Auth) {}
  async getContent(_owner: string, _repo: string, _branch: string, path: string) {
    try {
      const file = await api<Content>('github/read', { kind: 'content', path });
      if (!this.baseline.has(path)) this.baseline.set(path, file.sha);
      return file;
    } catch (e) { if ((e as { response?: { status: number } }).response?.status === 404 && !this.baseline.has(path)) this.baseline.set(path, null); throw e; }
  }
  async getIssue(_owner: string, _repo: string, number: number) {
    const issue = await api<Issue>('github/read', { kind: 'issue', number });
    this.issues.set(number, issue); return issue;
  }
  async updateIssue(_owner: string, _repo: string, number: number, data: unknown) {
    const current = this.issues.get(number); if (!current) throw new Error('请先加载任务');
    return api('github/issue', { number, expectedUpdatedAt: current.updated_at, expectedBody: current.body, ...(data as object) }, this.auth.csrf);
  }
  async commitFiles(owner: string, repo: string, branch: string, message: string, files: { path: string; content: string | null }[]) {
    for (const file of files) if (!this.baseline.has(file.path)) {
      try { await this.getContent(owner, repo, branch, file.path); } catch (e) { if ((e as { response?: { status: number } }).response?.status !== 404) throw e; }
    }
    const result = await api<{ sha: string; files: { path: string; sha: string | null }[] }>('github/commit', { message, files: files.map(f => ({ ...f, expectedSha: this.baseline.get(f.path) })) }, this.auth.csrf);
    for (const file of result.files) this.baseline.set(file.path, file.sha); return result.sha;
  }
  updateContent(owner: string, repo: string, branch: string, path: string, message: string, content: string) { return this.commitFiles(owner, repo, branch, message, [{ path, content }]); }
}
