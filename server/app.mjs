import {inspectCsv,validateCsvAgainstScript} from './validate-csv.mjs';
import { resourceRequest } from './resources.mjs';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const fail = (status, message) => Object.assign(new Error(message), { status });
const random = () => randomBytes(32).toString('base64url');
export function createApp(env = process.env, remoteFetch = fetch, services = {}) {
  const origin = new URL(env.CAMPUS_PUBLIC_ORIGIN || 'http://127.0.0.1:5173').origin;
  const owner = env.CAMPUS_WORK_OWNER || 'DreamGallery', repo = env.CAMPUS_WORK_REPO || 'Idoly-localify-translations', branch = env.CAMPUS_WORK_BRANCH || 'main';
  const configured = !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const sessions = services.sessions || new Map(), pending = services.pending || new Map();
  const cookieName = 'idoly_session';
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
  const clean = () => { for (const map of [sessions, pending]) for (const [key, val] of (map instanceof Map ? map : [])) if (val.expires < Date.now()) map.delete(key); };
  async function gh(session, method, path, body) {
    const response = await remoteFetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path ? '/' + path : ''}`, {
      method, headers: { 'User-Agent': 'Campus-Story-Viewer', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000), redirect: 'manual',
    });
    if (!response.ok) throw fail(response.status, response.status === 404 ? 'GitHub 中没有此文件或任务' : response.status === 403 ? 'GitHub 拒绝操作：请检查仓库权限或 API 限额' : response.status === 409 || response.status === 422 ? '远端已变化，请重新加载后合并修改' : `GitHub 请求失败（${response.status}）`);
    return response.status === 204 ? null : response.json();
  }
  async function canCollaborate(session) {
    if (!session) return false;
    try { const repoInfo = await gh(session, 'GET', ''); return repoInfo.permissions?.push === true && !repoInfo.archived; }
    catch (error) { if ([401, 403, 404].includes(error.status)) return false; throw error; }
  }
  async function requireCollaborator(session) {
    if (!session) throw fail(401, '请登录后查看协作任务');
    if (!await canCollaborate(session)) throw fail(403, '当前账号没有工作仓库的写权限');
  }
  const filePath = (p) => {
    if (typeof p !== 'string' || p.length > 600 || !/^[\p{L}\p{M}\p{N}_./-]+$/u.test(p) || p.split('/').some(x => !x || x === '.' || x === '..')) throw fail(400, '无效文件路径');
    return p.split('/').map(encodeURIComponent).join('/');
  };
  const writable = p => /^(records\/[\w-]+\.json|(?:story\/human|story\/reviewed|story\/drafts\/translation|story\/drafts\/proofread|story\/backups\/translation|story\/backups\/proofread)\/.+\.csv|proofread_txt\/[\w-]+\.txt)$/.test(p);
  async function content(session, path, ref = branch) { return gh(session, 'GET', `contents/${filePath(path)}?ref=${encodeURIComponent(ref)}`); }
  async function shaAt(session, path, ref) { try { return (await content(session, path, ref)).sha; } catch (e) { if (e.status === 404) return null; throw e; } }
  async function localFile(root, relative) {
    if (services.readFile) return services.readFile(root, relative);
    if (!root) throw fail(503, '未配置本地文本目录');
    const realRoot = await realpath(root), file = await realpath(resolve(realRoot, relative));
    if (!file.startsWith(realRoot + sep)) throw fail(403, '文件不在配置目录内');
    return readFile(file, 'utf8');
  }
  async function bodyOf(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 6 * 1024 * 1024) throw fail(413, '请求过大'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, '无效 JSON'); }
  }
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (data, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const redirect = url => { res.writeHead(302, { Location: url }); res.end(); };
    let authStage = 'session-read';
    try {
      clean(); const url = new URL(req.url, origin);
      if (await (services.resourceRequest || resourceRequest)(env, req, res, url)) return;
      if (url.pathname === '/api/health' && req.method === 'GET') return json({ ok: true });
      if (url.pathname === '/api/resources/status' && req.method === 'GET') {
        if (services.status) return json(await services.status());
        if (!env.CAMPUS_RUNTIME_ROOT) return json({ state: 'unmanaged' });
        try { return json(JSON.parse(await localFile(env.CAMPUS_RUNTIME_ROOT, 'status.json'))); }
        catch (e) { if (e.code === 'ENOENT') return json({ state: 'initializing', phase: '等待资源初始化' }); throw e; }
      }
      async function sourceRoots() {
        if (services.sourceRoots) return services.sourceRoots();
        if (!env.CAMPUS_RUNTIME_ROOT) return { web: env.CAMPUS_WEB_DATA, story: env.CAMPUS_STORY_ROOT, adv: env.CAMPUS_ADV_ROOT };
        let release;
        try { release = await realpath(resolve(env.CAMPUS_RUNTIME_ROOT, 'current')); }
        catch (e) { if (e.code === 'ENOENT') throw fail(503, '资源尚未初始化完成'); throw e; }
        return { web: resolve(release, 'web'), story: resolve(release, 'story'), adv: resolve(release, 'adv') };
      }
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')));
      const candidate = await sessions.get(cookies[cookieName]);
      const session = candidate?.expires > Date.now() ? candidate : undefined;
      if (url.pathname === '/api/auth/status' && req.method === 'GET') return json({ local: !!services.localAuth, canCollaborate: await canCollaborate(session), configured, user: session?.user || null, csrf: session?.csrf || null, work: { owner, repo, branch } });
      if (url.pathname === '/api/auth/login' && req.method === 'GET') {
        if (!configured) throw fail(503, '请先配置 GitHub OAuth 应用');
        const state = random(), verifier = random();
        const requested = url.searchParams.get('returnTo') || '/idols';
        const returnTo = /^\/(?!\/)[a-zA-Z0-9_/?=&%.-]*$/.test(requested) ? requested : '/idols';
        await pending.set(state, { verifier, returnTo, expires: Date.now() + 600000 });
        res.setHeader('Set-Cookie', cookie('campus_oauth', state, 600));
        const query = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${origin}/api/auth/callback`, scope: 'public_repo read:user', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
        return redirect(`https://github.com/login/oauth/authorize?${query}`);
      }
      if (url.pathname === '/api/auth/callback' && req.method === 'GET') {
        authStage = 'oauth-state';
        const state = url.searchParams.get('state'); const flow = state && state === cookies.campus_oauth ? await (pending.take ? pending.take(state) : pending.get(state)) : null;
        if (!flow || flow.expires <= Date.now() || !state || state !== cookies.campus_oauth) throw fail(400, '登录验证已失效，请重新登录');
        await pending.delete(state); res.setHeader('Set-Cookie', cookie('campus_oauth', '', 0));
        if (!url.searchParams.get('code')) throw fail(400, 'GitHub 登录未授权');
        authStage = 'token-exchange';
        const tokenResponse = await remoteFetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { 'User-Agent': 'Campus-Story-Viewer', Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get('code'), redirect_uri: `${origin}/api/auth/callback`, code_verifier: flow.verifier }), signal: AbortSignal.timeout(30000), redirect: 'manual' });
        if (!tokenResponse.ok) throw fail(502, 'GitHub 令牌交换失败，请重新登录');
        authStage = 'token-response-json';
        const token = await tokenResponse.json();
        if (!tokenResponse.ok || !token.access_token) throw fail(502, 'GitHub 令牌交换失败，请重新登录');
        authStage = 'github-user';
        const userResponse = await remoteFetch('https://api.github.com/user', { headers: { 'User-Agent': 'Campus-Story-Viewer', Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000), redirect: 'manual' });
        if (!userResponse.ok) throw fail(502, '获取 GitHub 用户失败');
        authStage = 'github-user-json';
        const user = await userResponse.json(); const sid = random();
        authStage = 'session-save';
        await sessions.delete(cookies[cookieName]);
        await sessions.set(sid, { token: token.access_token, user: { login: user.login, name: user.name }, csrf: random(), expires: Date.now() + Math.min(28800, Number(token.expires_in) || 28800) * 1000 });
        res.setHeader('Set-Cookie', [cookie('campus_oauth', '', 0), cookie(cookieName, sid, 28800)]);
        return redirect(flow.returnTo);
      }
      if (url.pathname.startsWith('/api/script/') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/script/'.length));
        if (!/^[\w-]+$/.test(id)) throw fail(400, '无效章节');
        try { return json({ txt: await localFile((await sourceRoots()).adv, `${id}.txt`) }); }
        catch (e) { if (e.code === 'ENOENT') throw fail(404, '本地缺少此章节原始 TXT'); throw e; }
      }
      if (url.pathname.startsWith('/api/source/') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/source/'.length));
        if (!/^[\w-]+$/.test(id)) throw fail(400, '无效章节');
        if (services.sourceCsv) { const result = await services.sourceCsv(id); const csv=typeof result==='string'?result:result.csv;return json({csv,label:result.label||'原文',sha256:createHash('sha256').update(csv).digest('hex'),scriptId:id}); }
        const roots = await sourceRoots();
        const manifest = JSON.parse(await localFile(roots.web, 'catalog/manifest.json'));
        const chapter = JSON.parse(await localFile(roots.web, `${manifest.base_path.replace(/^\//, '')}/chapters/${id}.json`));
        if (!chapter.csv_path) throw fail(404, '本章节尚无 CSV');
        const csv = await localFile(roots.story, chapter.csv_path);
        return json({ csv, label: chapter.label || '仓库稿件', sha256: createHash('sha256').update(csv).digest('hex'), scriptId: id });
      }
      if (req.method !== 'POST') throw fail(404, '接口不存在');
      if (req.headers.origin !== origin) throw fail(403, '请求来源不匹配');
      const input = await bodyOf(req);
      if (url.pathname === '/api/auth/local' && services.localAuth) {
        if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !['127.0.0.1','localhost'].includes(new URL(origin).hostname)) throw fail(403,'本地身份只允许回环地址');
        if (typeof input.login !== 'string' || !/^[a-zA-Z0-9_-]{2,32}$/.test(input.login)) throw fail(400,'本地名字需要 2–32 个英文字母、数字或下划线');
        const sid=random();await sessions.set(sid,{token:'local-only',user:{login:input.login,name:input.login},csrf:random(),expires:Date.now()+28800000});res.setHeader('Set-Cookie',cookie(cookieName,sid,28800));return json({ok:true});
      }
      const requireAuth = () => { if (!session) throw fail(401, '请先登录 GitHub'); if (req.headers['x-csrf-token'] !== session.csrf) throw fail(403, '会话验证失败，请刷新页面'); };
      if (url.pathname === '/api/auth/logout') { requireAuth(); await sessions.delete(cookies[cookieName]); res.setHeader('Set-Cookie', cookie(cookieName, '', 0)); return json({ ok: true }); }
      if (url.pathname === '/api/github/read') {
        if (['findIssue', 'issue', 'issues'].includes(input.kind)) await requireCollaborator(session);
        if (input.kind === 'findIssue') {
          if (!/^[\w-]+$/.test(input.scriptId || '')) throw fail(400, '无效章节');
          const query = new URLSearchParams({ q: `repo:${owner}/${repo} is:issue in:title ${input.scriptId}`, per_page: '100' });
          const response = await remoteFetch(`https://api.github.com/search/issues?${query}`, { headers: { 'User-Agent': 'Campus-Story-Viewer', Accept: 'application/vnd.github+json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, signal: AbortSignal.timeout(30000), redirect: 'manual' });
          if (!response.ok) throw fail(response.status, '任务查询失败，请检查 GitHub 限额或稍后重试');
          const result = await response.json();
          return json(result.items.filter(i => i.title === input.scriptId));
        }
        if (input.kind === 'content') return json(await content(session, input.path));
        if (input.kind === 'issue' && Number.isSafeInteger(input.number)) return json(await gh(session, 'GET', `issues/${input.number}`));
        if (input.kind === 'issues') return json(await gh(session, 'GET', `issues?state=all&per_page=100&page=${Math.max(1, Math.min(1000, Number(input.page) || 1))}`));
        throw fail(400, '不支持的读取操作');
      }
      requireAuth();
      await requireCollaborator(session);
      if (url.pathname === '/api/github/issue') {
        if (!Number.isSafeInteger(input.number) || !input.expectedUpdatedAt) throw fail(400, '缺少任务版本');
        const current = await gh(session, 'GET', `issues/${input.number}`);
        if (current.updated_at !== input.expectedUpdatedAt || current.body !== input.expectedBody) throw fail(409, '任务认领已变化，请刷新');
        if (typeof input.body !== 'string' || input.body.length > 60000 || !['open', 'closed'].includes(input.state)) throw fail(400, '无效任务更新');
        // Issues have no atomic compare-and-swap; perform a fresh ownership check before updating.
        return json(await gh(session, 'PATCH', `issues/${input.number}`, { body: input.body, state: input.state, assignees: input.assignees }));
      }
      if (url.pathname === '/api/github/commit') {
        if (!Array.isArray(input.files) || !input.files.length || input.files.length > 12) throw fail(400, '无效提交');
        for (const f of input.files) {
          filePath(f.path);
          if (!writable(f.path) || !(typeof f.content === 'string' || f.content === null) || !(typeof f.expectedSha === 'string' || f.expectedSha === null)) throw fail(400, '提交缺少基准版本或路径不允许');
        }
        if (new Set(input.files.map(f => f.path)).size !== input.files.length) throw fail(400, '提交包含重复路径');
        const ref = await gh(session, 'GET', `git/ref/heads/${encodeURIComponent(branch)}`);
        const head = ref.object.sha;
        // Reject stale source/invalid translation even if the caller bypasses browser validation.
        for (const f of input.files) {
          if (f.content !== null && f.path.endsWith('.csv')) {
            let parsed;
            try {
              const csv = Buffer.from(f.content, 'base64').toString('utf8');
              parsed = inspectCsv(csv);
              const roots = await sourceRoots();
              const backup = f.path.match(/^story\/backups\/(translation|proofread)\/(.+)$/);
              if (backup) {
                const formalPath = `story/${backup[1] === 'translation' ? 'human' : 'reviewed'}/${backup[2]}`;
                const replacement = input.files.find(item => item.path === formalPath && item.content !== null);
                if (!replacement || inspectCsv(Buffer.from(replacement.content, 'base64').toString('utf8')).id !== parsed.id) throw new Error('备份必须与同章节正式稿更新一起提交');
                // Compare exact bytes with the existing Git blob at this transaction's head.
                // Historical source hashes may differ, but arbitrary historical CSVs are never accepted.
                const bytes = Buffer.from(f.content, 'base64');
                const existing = await content(session, formalPath, head);
                const existingBlob = existing.encoding === 'none' || typeof existing.content !== 'string'
                  ? await gh(session, 'GET', `git/blobs/${encodeURIComponent(existing.sha)}`) : existing;
                if (typeof existingBlob.content !== 'string' || !Buffer.from(existingBlob.content, 'base64').equals(bytes)) throw new Error('备份与仓库现有正式稿不一致');
              } else {
                const raw = await localFile(roots.adv, parsed.id + '.txt');
                validateCsvAgainstScript(csv, raw, {checkLength: !f.path.startsWith('story/drafts/')});
              }
              const manifest = services.sourcePath ? null : JSON.parse(await localFile(roots.web, 'catalog/manifest.json'));
              const relative = services.sourcePath ? await services.sourcePath(parsed.id) : JSON.parse(await localFile(roots.web, manifest.base_path.replace(/^\//, '') + '/chapters/' + parsed.id + '.json')).csv_path;
              if (!relative || !['story/human/', 'story/reviewed/', 'story/drafts/translation/', 'story/drafts/proofread/', 'story/backups/translation/', 'story/backups/proofread/'].some(prefix => f.path === prefix + relative)) throw new Error('提交目录与剧情索引不一致');
            } catch (error) { throw fail(400, error.message); }
          }
        }
        for (const f of input.files) if (await shaAt(session, f.path, head) !== f.expectedSha) throw fail(409, `远端 ${f.path} 已更新，请导出本地草稿并重新加载`);
        const commit = await gh(session, 'GET', `git/commits/${head}`);
        const tree = [];
        for (const f of input.files) {
          if (f.content === null && f.expectedSha === null) continue;
          const sha = f.content === null ? null : (await gh(session, 'POST', 'git/blobs', { content: f.content, encoding: 'base64' })).sha;
          tree.push({ path: f.path, mode: '100644', type: 'blob', sha });
        }
        const newTree = await gh(session, 'POST', 'git/trees', { base_tree: commit.tree.sha, tree });
        const next = await gh(session, 'POST', 'git/commits', { message: String(input.message || '更新剧情翻译').slice(0, 200), tree: newTree.sha, parents: [head] });
        // force:false also rejects a concurrent push after the comparison above.
        await gh(session, 'PATCH', `git/refs/heads/${encodeURIComponent(branch)}`, { sha: next.sha, force: false });
        return json({ sha: next.sha, files: tree.map(f => ({ path: f.path, sha: f.sha })) });
      }
      throw fail(404, '接口不存在');
    } catch (error) {
      if (!error.status) console.error('Campus API failure', JSON.stringify({stage:authStage,type:error.name || 'Error'}));
      const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
      json({ error: status === 500 ? '服务处理失败，请检查本地配置或稍后重试' : error.message }, status);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createApp().listen(Number(process.env.CAMPUS_API_PORT || 8787), process.env.CAMPUS_API_HOST || '127.0.0.1', () => console.log('Campus API ready'));
}
