import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { NativeDecoder, nativeFrame } from '../src/framing.mjs';
import { startNativeHost } from '../src/native-host.mjs';
import { startMcp, browserCommand } from '../src/mcp-server.mjs';
import { tools, validateArguments, validateCommand } from '../src/tools.mjs';

const outputRoot = fileURLToPath(new URL('../output/tests/', import.meta.url));
await mkdir(outputRoot, { recursive: true });

test('Native framing handles UTF-8 split across arbitrary chunks', async () => {
  const decoder = new NativeDecoder();
  const actual = [];
  decoder.on('data', x => actual.push(x));
  const encoded = Buffer.concat([nativeFrame({ text: '中文 🌿' }), nativeFrame({ id: 2 })]);
  for (const byte of encoded) decoder.write(Buffer.from([byte]));
  decoder.end();
  await once(decoder, 'end');
  assert.deepEqual(actual, [{ text: '中文 🌿' }, { id: 2 }]);
});

test('Oversized and truncated native frames are rejected', async () => {
  const d = new NativeDecoder(20);
  const failure = once(d, 'error');
  d.end(Buffer.from([255, 255, 255, 127]));
  assert.match((await failure)[0].message, /size/);
  const truncated = new NativeDecoder();
  const failure2 = once(truncated, 'error');
  truncated.end(Buffer.from([4, 0, 0, 0, 123]));
  assert.match((await failure2)[0].message, /Truncated/);
});

test('Native host authenticates local requests and relays commands through framing', async () => {
  const dir = await mkdtemp(join(outputRoot, 'bridge-'));
  const file = join(dir, 'connection.json');
  const input = new PassThrough();
  const output = new PassThrough();
  const received = output.pipe(new NativeDecoder());
  const host = await startNativeHost({ input, output, file, timeoutMs: 80 });
  try {
    input.write(nativeFrame({ type: 'hello' }));
    received.on('data', message => {
      if (message.type === 'request' && message.method !== 'tabs.list') {
        input.write(nativeFrame({ type: 'response', id: message.id, result: { connected: true, echoed: message.params } }));
      }
    });
    const connection = JSON.parse(await readFile(file, 'utf8'));
    const base = `http://127.0.0.1:${host.port}`;
    assert.equal((await fetch(`${base}/health`)).status, 403);
    assert.equal((await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${connection.token}`, Origin: 'https://evil.example' } })).status, 403);
    const result = await browserCommand('status', {}, { file });
    assert.equal(result.connected, true);
    await assert.rejects(browserCommand('tabs.list', { sessionId: 'x' }, { file }), /timed out/);
    assert.equal((await fetch(`${base}/command`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method: 'eval', params: {} }) })).status, 400);
  } finally {
    await host.stop(); input.destroy(); output.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MCP negotiates, lists tools and returns typed text/image errors correctly', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const calls = [];
  const messages = [];
  output.on('data', data => { for (const line of data.toString().trim().split('\n')) messages.push(JSON.parse(line)); });
  const server = startMcp({ input, output, command: async (method, args) => {
    calls.push({ method, args });
    if (method === 'tab.screenshot') return { data: 'aGVsbG8=', mimeType: 'image/jpeg' };
    return { ok: true };
  } });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(messages[0].result.protocolVersion, '2025-06-18');
  assert.equal(messages[1].result.tools.length, tools.length);
  assert.ok(messages[1].result.tools.every(t => !('method' in t)));
  await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_open', arguments: { url: 'https://example.com' } } });
  assert.equal(messages[2].result.isError, true);
  assert.equal(calls.length, 0);
  await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'browser_screenshot', arguments: { sessionId: 'a', tabId: 1 } } });
  assert.equal(messages[3].result.content[0].type, 'image');
  input.end(); output.end();
});

test('Tool validation rejects unsafe parameter types and out-of-range payloads', () => {
  const scroll = tools.find(t => t.name === 'browser_scroll');
  assert.throws(() => validateArguments(scroll.inputSchema, { sessionId: 'x', tabId: 1, direction: 'down', amount: 99999 }));
  assert.throws(() => validateArguments(scroll.inputSchema, { sessionId: 'x', tabId: '1', direction: 'down' }));
  assert.throws(() => validateArguments(scroll.inputSchema, { sessionId: 'x', tabId: 1, direction: 'down', script: 'x' }));
});

test('Nested action validation rejects malformed batches before any browser mutation', () => {
  const tab = { sessionId: 'x', tabId: 1 };
  assert.throws(() => validateCommand('tab.click', { ...tab, x: 1 }), /both/);
  assert.throws(() => validateCommand('tab.click', { ...tab, ref: 'r', x: 1, y: 1 }), /either/);
  assert.throws(() => validateCommand('tab.click', { ...tab, x: NaN, y: 0 }), /number/);
  assert.throws(() => validateCommand('tab.screenshot', { ...tab, fullPage: true, clip: { x: 0, y: 0, width: 1, height: 1 } }), /fullPage or clip/);
  const batch = args => ({ ...tab, actions: [{ action: 'fill', args }] });
  assert.doesNotThrow(() => validateCommand('tab.batch', batch({ ref: 'r', text: 'ok' })));
  assert.throws(() => validateCommand('tab.batch', batch({ ref: 'r' })), /Missing argument: text/);
  assert.throws(() => validateCommand('tab.batch', batch({ ref: 'r', text: 'ok', sessionId: 'other' })), /override/);
  assert.throws(() => validateCommand('tab.batch', { ...tab, actions: [{ action: 'navigate', args: {} }] }), /Invalid value/);
});
