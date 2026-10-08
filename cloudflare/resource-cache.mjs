export const IMMUTABLE_TTL = 31536000, POINTER_TTL = 30, MISSING_TTL = 15;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
export const resourceError = status => Object.assign(new Error('Resource unavailable'), {status});
export const contentType = key => ({json:'application/json; charset=utf-8',csv:'text/csv; charset=utf-8',txt:'text/plain; charset=utf-8',webp:'image/webp',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',svg:'image/svg+xml',wav:'audio/wav',flac:'audio/flac',ogg:'audio/ogg',mp3:'audio/mpeg',m4a:'audio/mp4',mp4:'video/mp4',webm:'video/webm',gz:'application/gzip'}[key.split('.').pop().toLowerCase()] || 'application/octet-stream');
export const safe = value => {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.split('/').some(p => !p || p === '.' || p === '..') || /[\\\x00-\x1f\x7f]/.test(value)) throw resourceError(400);
  return value;
};
const matchesEtag = (value, etag) => value?.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag);
function byteRange(raw, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null, last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first !== null && last !== null ? Math.min(last, size - 1) : size - 1;
  return start < 0 || start > end || start >= size ? null : {start, end};
}

function sliceBody(body, start, end) {
  const reader = body.getReader();
  let offset = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) throw resourceError(503);
          const from = Math.max(0, start - offset), to = Math.min(value.byteLength, end + 1 - offset);
          offset += value.byteLength;
          if (from < to) controller.enqueue(value.subarray(from, to));
          if (offset > end) {
            controller.close();
            // The cache copy may still be consuming its branch of the stream.
            reader.cancel().catch(() => {});
            return;
          }
          if (from < to) return;
        }
      } catch (error) {
        controller.error(error);
        reader.cancel().catch(() => {});
      }
    },
    cancel: reason => reader.cancel(reason),
  });
}

export function resourceCache(env, prefix, options={}) {
  const bucket = env.RESOURCES;
  const origin = new URL(env.CAMPUS_PUBLIC_ORIGIN || 'https://idoly-cache.invalid').origin;
  const cache = () => options.cache === undefined ? globalThis.caches?.default : options.cache;
  // Use resolved objects, not client cookies or arbitrary query parameters.
  const cacheKey = key => new Request(origin + '/__idoly_resource_cache/v1/' + (prefix + '/' + safe(key)).split('/').map(encodeURIComponent).join('/'));
  async function match(key, headers) {
    try { return await cache()?.match(new Request(cacheKey(key), {headers})); }
    catch { return undefined; }
  }
  async function store(key, response, ttl, scope) {
    if (!ttl || !cache() || ![200,404].includes(response.status) || response.headers.has('Set-Cookie') || Number(response.headers.get('Content-Length') || 0) > MAX_CACHE_BYTES) return;
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${ttl}`);
    const copy = new Response(response.clone().body, {status:response.status, headers});
    const put = Promise.resolve().then(() => cache().put(cacheKey(key), copy)).catch(() => {
      // A failed cache write must not leave an unread fork buffering the body.
      copy.body?.cancel().catch(() => {});
    });
    if (scope?.ctx) scope.ctx.waitUntil(put); else await put;
  }
  async function beforeRead(scope) {
    if (scope && !scope.checked) {
      if (options.allowMiss && !await options.allowMiss(scope.request)) throw resourceError(429);
      scope.checked = true;
    }
  }
  async function missing(key, ttl, scope) {
    if (ttl) await store(key, new Response(null, {status:404}), MISSING_TTL, scope);
    throw resourceError(404);
  }
  function objectResponse(obj, key) {
    const headers = new Headers({'X-Content-Type-Options':'nosniff', 'Accept-Ranges':'bytes'});
    obj.writeHttpMetadata(headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', contentType(key));
    headers.set('ETag', obj.httpEtag);
    headers.set('Content-Length', String(obj.size));
    if (obj.uploaded) headers.set('Last-Modified', obj.uploaded.toUTCString());
    return new Response(obj.body ?? null, {headers});
  }
  async function cachedObject(key, {ttl=IMMUTABLE_TTL, maxBytes=Infinity}={}) {
    const cached = ttl && await match(key);
    if (cached) {
      if (cached.status === 404) throw resourceError(404);
      if (Number(cached.headers.get('Content-Length')) > maxBytes) { cached.body?.cancel().catch(() => {}); throw resourceError(503); }
      return cached;
    }
  }
  async function readObject(key, {ttl=IMMUTABLE_TTL, missingTtl=ttl, maxBytes=Infinity}={}, scope) {
    await beforeRead(scope);
    const obj = await bucket.get(prefix + '/' + safe(key));
    if (!obj) return missing(key, missingTtl, scope);
    if (obj.size > maxBytes) { obj.body?.cancel().catch(() => {}); throw resourceError(503); }
    const response = objectResponse(obj, key);
    await store(key, response, ttl, scope);
    return response;
  }
  async function fullObject(key, settings={}, scope) {
    return await cachedObject(key, settings) || readObject(key, settings, scope);
  }
  // Only small public text reads are coalesced; never retain private draft bodies.
  const pending = new Map();
  async function coalesce(key, read) {
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 32) return read();
    const promise = read(); pending.set(key, promise);
    try { return await promise; } finally { if (pending.get(key) === promise) pending.delete(key); }
  }
  async function text(key, settings={}, scope) {
    const consume = async response => {
      const value = await response.text();
      if (new TextEncoder().encode(value).byteLength > (settings.maxBytes ?? Infinity)) throw resourceError(503);
      return value;
    };
    const cached = await cachedObject(key, settings);
    if (cached) return consume(cached);
    // Check each client before sharing an upstream read. A denied client's
    // in-flight promise must never reject another client's request.
    await beforeRead(scope);
    const read = async () => consume(await readObject(key, settings, scope));
    const {ttl=IMMUTABLE_TTL, missingTtl=ttl, maxBytes=Infinity} = settings;
    return ttl === 0 ? read() : coalesce(JSON.stringify([key,ttl,missingTtl,maxBytes]), read);
  }
  async function publicText(key, variant, transform, scope) {
    const publicKey = 'original/' + variant + '/' + safe(key);
    const hit = await match(publicKey);
    if (hit) { if (hit.status === 404) throw resourceError(404); return hit.text(); }
    await beforeRead(scope);
    return coalesce(publicKey, async () => {
      let raw;
      try { raw = await text(key, {ttl:0, maxBytes:MAX_CACHE_BYTES}, scope); }
      catch (e) { if (e.status === 404) return missing(publicKey, MISSING_TTL, scope); throw e; }
      const value = transform(raw);
      const headers = {'Content-Type':contentType(key), 'Content-Length':String(new TextEncoder().encode(value).byteLength)};
      // Cache the sanitized result only, never the translated source CSV/JSON.
      await store(publicKey, new Response(value, {headers}), IMMUTABLE_TTL, scope);
      return value;
    });
  }
  async function stream(request, key, {download=false, immutable=false, release}={}, scope) {
    safe(key);
    const ttl = download ? 0 : IMMUTABLE_TTL;
    let full = ttl && await match(key);
    if (full?.status === 404) throw resourceError(404);
    let metadata;
    if (full) metadata = full.headers;
    else if (request.method === 'HEAD' || request.headers.has('Range')) {
      await beforeRead(scope);
      const head = await bucket.head(prefix + '/' + key);
      if (!head) return missing(key, ttl, scope);
      metadata = objectResponse(head, key).headers;
    } else {
      // R2 GET includes metadata; normal requests need no preceding HEAD.
      full = await fullObject(key, {ttl}, scope);
      metadata = full.headers;
    }
    const headers = new Headers(metadata);
    headers.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-store');
    if (release) headers.set('X-Idoly-Release', release);
    if (download) { headers.set('Content-Disposition', 'attachment; filename="'+key.split('/').pop()+'"'); headers.set('Content-Type', 'application/gzip'); }
    const discard = () => full?.body?.cancel().catch(() => {});
    if (matchesEtag(request.headers.get('If-None-Match'), headers.get('ETag'))) {
      discard(); headers.delete('Content-Length');
      return new Response(null, {status:304, headers});
    }
    const size = Number(headers.get('Content-Length')), raw = request.headers.get('Range');
    if (raw && (!request.headers.get('If-Range') || request.headers.get('If-Range') === headers.get('ETag'))) {
      const range = byteRange(raw, size);
      if (!range) {
        discard(); headers.set('Content-Range', `bytes */${size}`); headers.set('Content-Length', '0');
        return new Response(null, {status:416, headers});
      }
      const {start, end} = range;
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end-start+1));
      if (request.method === 'HEAD') { discard(); return new Response(null, {status:206, headers}); }
      const hit = ttl && await match(key, {Range:`bytes=${start}-${end}`});
      if (hit?.status === 206) { discard(); return new Response(hit.body, {status:206, headers}); }
      hit?.body?.cancel().catch(() => {});
      // Players can start with Range. Fill the complete-object cache for small
      // media; large files and archives remain bounded R2 range reads.
      if (!full && ttl && cache() && size <= MAX_CACHE_BYTES) full = await fullObject(key, {ttl}, scope);
      if (full) {
        if (Number(full.headers.get('Content-Length')) !== size || full.headers.get('ETag') !== headers.get('ETag')) {
          discard(); throw resourceError(503);
        }
        return new Response(sliceBody(full.body, start, end), {status:206, headers});
      }
      await beforeRead(scope);
      const obj = await bucket.get(prefix + '/' + key, {range:{offset:start, length:end-start+1}});
      if (!obj) return missing(key, ttl, scope);
      // Partial responses must never populate the whole-object cache.
      return new Response(obj.body, {status:206, headers});
    }
    if (request.method === 'HEAD') { discard(); return new Response(null, {headers}); }
    full ||= await fullObject(key, {ttl}, scope);
    return new Response(full.body, {headers});
  }
  return {text, publicText, stream};
}
