import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { localRequestURL } from './local-origin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(resolve(root, '.env.local'))) process.loadEnvFile(resolve(root, '.env.local'));
const port = Number(process.env.PORT || 3000);
const origin = `http://localhost:${port}`;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const pending = new Set();
globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil(promise) {
  pending.add(promise);
  promise.catch(() => console.error('Background task failed')).finally(() => pending.delete(promise));
} }) };

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = localRequestURL(incoming.url, incoming.headers.host, port);
    if (!url) { outgoing.writeHead(400).end('Use localhost or 127.0.0.1 for this local server.'); return; }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/api/')) {
      if (!/^\/api\/[a-z][a-z-]*$/.test(pathname)) { outgoing.writeHead(404).end(); return; }
      const file = resolve(root, pathname.slice(1) + '.mjs');
      if (!existsSync(file)) { outgoing.writeHead(404).end(); return; }
      const handler = (await import(pathToFileURL(file).href))[incoming.method];
      if (!handler) { outgoing.writeHead(405).end(); return; }
      const options = { method: incoming.method, headers: incoming.headers };
      if (!['GET', 'HEAD'].includes(incoming.method)) Object.assign(options, { body: Readable.toWeb(incoming), duplex: 'half' });
      const response = await handler(new Request(url, options));
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') outgoing.setHeader(key, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader('set-cookie', cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405).end(); return; }
    // Serve only storefront files; credentials, source modules and dependencies stay private.
    if (!/^\/(?:[a-z][a-z0-9-]*(?:\.html)?|(?:admin|css|js|products|public)\/[a-zA-Z0-9_./ -]+)?$/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) {
      outgoing.writeHead(404).end(); return;
    }
    let file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep)) { outgoing.writeHead(404).end(); return; }
    if (!extname(file)) file += '.html';
    if (!types[extname(file)] || !(await stat(file)).isFile()) { outgoing.writeHead(404).end(); return; }
    outgoing.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    outgoing.end(incoming.method === 'HEAD' ? undefined : await readFile(file));
  } catch (error) {
    if (!outgoing.headersSent) outgoing.writeHead(error.code === 'ENOENT' ? 404 : 500);
    outgoing.end('Request could not be completed.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`RUNAWAY storefront and API: ${origin}\nOpen ${origin}/collection in your browser. Keep this terminal running.`));
