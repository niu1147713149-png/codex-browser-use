import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { stateDir, discoveryPath } from './paths.mjs';
import { NativeDecoder, nativeFrame } from './framing.mjs';
import { methods, validateCommand } from './tools.mjs';
import { VERSION } from '../extension/version.js';

export async function startNativeHost({ input = process.stdin, output = process.stdout, file = discoveryPath(), timeoutMs = 25000 } = {}) {
  const token = randomBytes(32).toString('hex');
  const instance = randomUUID();
  const pending = new Map();
  let ready = false;
  let stopped = false;
  const send = message => output.write(nativeFrame(message));
  const decoder = input.pipe(new NativeDecoder());
  decoder.on('data', message => {
    if (message?.type === 'hello') { ready = true; send({ type: 'ready', version: VERSION }); return; }
    if (message?.type !== 'response' || !pending.has(message.id)) return;
    const job = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(job.timer);
    job.resolve(message);
  });

  const respond = (res, status, value) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.headers.authorization || '');
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` ||
        actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      respond(res, 403, { error: 'Forbidden' }); return;
    }
    if (req.url === '/health' && req.method === 'GET') { respond(res, 200, { connected: ready, version: VERSION, instance }); return; }
    if (req.url !== '/command' || req.method !== 'POST') { respond(res, 404, { error: 'Not found' }); return; }
    if (!ready) { respond(res, 503, { error: 'Chrome extension is not ready' }); return; }
    if (pending.size >= 32) { respond(res, 429, { error: 'Too many pending commands' }); return; }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 100000) { respond(res, 413, { error: 'Command too large' }); return; }
        chunks.push(chunk);
      }
      const { method, params = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!methods.has(method) || !params || typeof params !== 'object' || Array.isArray(params)) {
        respond(res, 400, { error: 'Unknown command or invalid parameters' }); return;
      }
      try { validateCommand(method, params); } catch (error) { respond(res, 400, { error: error.message }); return; }
      const id = randomUUID();
      const result = await new Promise(resolve => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ error: 'Browser command timed out. Check the page before retrying; the action may have occurred.' });
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        send({ type: 'request', id, method, params, expiresAt: Date.now() + timeoutMs });
      });
      respond(res, 200, result.error ? { error: result.error } : { result: result.result });
    } catch {
      respond(res, 400, { error: 'Invalid command request' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 40;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { dirname } = await import('node:path');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${instance}.tmp`;
  await writeFile(temp, JSON.stringify({ port: server.address().port, token, instance, pid: process.pid }), { mode: 0o600 });
  await rename(temp, file);

  async function stop() {
    if (stopped) return;
    stopped = true;
    ready = false;
    for (const job of pending.values()) {
      clearTimeout(job.timer);
      job.resolve({ error: 'Chrome disconnected. Inspect the page before retrying.' });
    }
    pending.clear();
    server.close();
    server.closeAllConnections();
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.instance === instance) await unlink(file);
    } catch { /* Already replaced by a newer Chrome connection. */ }
  }
  input.once('end', stop);
  decoder.once('error', stop);
  return { stop, port: server.address().port, file };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startNativeHost().then(host => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await host.stop(); process.exit(0); });
  }).catch(() => { process.stderr.write('Codex Browser Use native host could not start.\n'); process.exit(1); });
}
