import { readFile, realpath, open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export async function resourceRequest(env, req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const download = url.pathname.startsWith('/api/resources/download/');
  if (url.pathname !== '/api/resources/versions' && !download) return false;
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); };
  let index = { revision: null, versions: [] };
  if (env.CAMPUS_RUNTIME_ROOT) {
    try { index = JSON.parse(await readFile(resolve(env.CAMPUS_RUNTIME_ROOT, 'current/resource-versions.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  } else if (env.CAMPUS_WEB_DATA) {
    try { index.revision = JSON.parse(await readFile(resolve(env.CAMPUS_WEB_DATA, 'assets/manifest.json'), 'utf8')).revision; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (!download) { json(index); return true; }
  const name = decodeURIComponent(url.pathname.slice('/api/resources/download/'.length));
  if (!/^campus-resources-r[0-9]+-[a-f0-9]{12}\.tar\.gz$/.test(name) || !index.versions.some(v => v.filename === name)) { json({ error: '此版本资源包不可用' }, 404); return true; }
  let handle;
  try {
    const root = await realpath(resolve(env.CAMPUS_RUNTIME_ROOT, 'downloads'));
    const file = await realpath(resolve(root, name));
    if (!file.startsWith(root + sep)) { json({ error: '无效资源包路径' }, 403); return true; }
    handle = await open(file, 'r'); const stat = await handle.stat();
    if (!stat.isFile()) { await handle.close(); json({ error: '资源包不存在' }, 404); return true; }
    let start = 0, end = stat.size - 1, status = 200;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range) { start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2])); end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end; }
      if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
        await handle.close(); res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return true;
      }
      status = 206;
    }
    const headers = { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'private, no-store' };
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { await handle.close(); res.end(); return true; }
    const stream = handle.createReadStream({ start, end });
    stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  } catch (e) {
    if (handle) await handle.close().catch(() => {});
    if (e.code === 'ENOENT') json({ error: '此版本资源包已过期' }, 404); else throw e;
  }
  return true;
}
