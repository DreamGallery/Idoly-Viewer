import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Serve mounted data directly: Vite's public-file inventory does not reliably
// discover newly published files inside an external symlink without a restart.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CAMPUS_');
  return {
    publicDir: process.env.CAMPUS_CLOUDFLARE_BUILD ? '.wrangler/ui-public' : 'public',
    build: { outDir: process.env.CAMPUS_CLOUDFLARE_BUILD ? '.cloudflare-dist' : 'dist' },
    plugins: [react(), {
      name: 'campus-local-data',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const url = req.url || '';
          const folder = url.startsWith('/audio/') ? 'audio' : url.startsWith('/catalog/') ? 'catalog' : url.startsWith('/assets/images/') ? 'assets' : null;
          if (!folder) return next();
          if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; res.end(); return; }
          try {
            const root = folder === 'audio' ? resolve(env.CAMPUS_AUDIO_CLIPS || 'public/audio') : resolve(env.CAMPUS_WEB_DATA || 'public', folder);
            const relative = decodeURIComponent(url.split('?')[0].slice(folder.length + 2));
            const file = resolve(root, relative);
            if (!file.startsWith(root + sep)) { res.statusCode = 403; res.end(); return; }
            const info = await stat(file);
            if (!info.isFile()) { res.statusCode = 404; res.end(); return; }
            res.setHeader('Content-Type', file.endsWith('.wav') ? 'audio/wav' : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'image/webp');
            if (folder === 'audio') {
              res.setHeader('Accept-Ranges', 'bytes');
              if (req.headers.range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
                const start = match?.[1] ? Number(match[1]) : Math.max(0, info.size - Number(match?.[2] || 0));
                const end = match?.[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
                if (!match || (!match[1] && !match[2]) || start > end || start >= info.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${info.size}`); res.end(); return; }
                res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`); res.setHeader('Content-Length', end-start+1);
                if (req.method === 'HEAD') { res.end(); return; }
                createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res); return;
              }
            }
            res.setHeader('Content-Length', info.size);
            res.setHeader('Cache-Control', 'no-cache');
            if (req.method === 'HEAD') { res.end(); return; }
            createReadStream(file).on('error', () => res.destroy()).pipe(res);
          } catch { res.statusCode = 404; res.end('Resource not found'); }
        });
      },
    }],
    server: { proxy: { '/api': { target: 'http://127.0.0.1:8787' } } },
    optimizeDeps: { exclude: ['lucide-react'] },
  };
});
