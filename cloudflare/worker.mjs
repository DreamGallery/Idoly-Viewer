import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from '../server/app.mjs';
import { sessionStore } from './session.mjs';
import { resources } from './resources.mjs';

const data = resources(env, {
  allowMiss: async request => (await env.RESOURCE_MISS_LIMITER.limit({key:'idoly:resource:'+(request.headers.get('CF-Connecting-IP') || 'unknown')})).success,
});
const server = createApp(env, fetch, {
  sessions: sessionStore(env.DB, env.SESSION_SECRET, 'session'),
  pending: sessionStore(env.DB, env.SESSION_SECRET, 'oauth'),
  allowLogin: async req => (await env.LOGIN_RATE_LIMITER.limit({key:'idoly:login:'+(req.headers['cf-connecting-ip'] || 'unknown')})).success,
  sourceRoots: data.sourceRoots,
  sourceCsv: data.sourceCsv,
  readFile: data.readFile,
  status: data.status,
  resourceRequest: async () => false,
});
server.listen(8787);
const api = httpServerHandler({ port: 8787 });
export default {
  async fetch(request, bindings, ctx) {
    try {
      const response = await data.route(request, ctx);
      if (response) return response;
      if (new URL(request.url).pathname.startsWith('/api/')) return api.fetch(request, bindings, ctx);
      return bindings.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({error: e.status === 429 ? '请求过于频繁，请稍后重试' : e.status === 404 ? '资源不存在' : '资源服务暂不可用'}, {status:e.status || 503, headers:{'Cache-Control':'no-store',...(e.status===429?{'Retry-After':'60'}:{})}});
    }
  },
  async scheduled(_event, bindings) {
    await bindings.DB.prepare('DELETE FROM auth_state WHERE expires<=?').bind(Date.now()).run();
  },
};
