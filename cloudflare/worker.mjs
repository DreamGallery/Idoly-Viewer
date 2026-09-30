import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from '../server/app.mjs';
import { sessionStore } from './session.mjs';
import { resources } from './resources.mjs';

const data = resources(env);
const server = createApp(env, fetch, {
  sessions: sessionStore(env.DB, env.SESSION_SECRET, 'session'),
  pending: sessionStore(env.DB, env.SESSION_SECRET, 'oauth'),
  sourceRoots: data.sourceRoots,
  readFile: data.readFile,
  status: data.status,
  resourceRequest: async () => false,
});
server.listen(8787);
const api = httpServerHandler({ port: 8787 });
export default {
  async fetch(request, bindings, ctx) {
    try {
      const response = await data.route(request);
      if (response) return response;
      if (new URL(request.url).pathname.startsWith('/api/')) return api.fetch(request, bindings, ctx);
      return bindings.ASSETS.fetch(request);
    } catch (e) {
      return Response.json({error: e.status === 404 ? '资源不存在' : '资源服务暂不可用'}, {status:e.status || 503, headers:{'Cache-Control':'no-store'}});
    }
  },
  async scheduled(_event, bindings) {
    await bindings.DB.prepare('DELETE FROM auth_state WHERE expires<=?').bind(Date.now()).run();
  },
};
