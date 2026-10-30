import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir, cp, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeDecoder, nativeFrame } from '../src/framing.mjs';
import { advancedFixture } from './advanced-fixture.mjs';
import { advancedChecks } from './advanced-checks.mjs';
import { reliabilityRoute } from './reliability-fixture.mjs';
import { reliabilityChecks } from './reliability-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output', 'playwright');
await mkdir(output, { recursive: true });
const runDir = await mkdtemp(join(output, 'isolated-'));
const stage = join(runDir, 'extension');
await cp(join(root, 'extension'), stage, { recursive: true });
const stateDir = join(runDir, 'state');
const browserMessages = [];
const native = spawn(process.execPath, [join(root, 'src/native-host.mjs')], { env: { ...process.env, BROWSER_BUDDY_STATE_DIR: stateDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
native.stdout.pipe(new NativeDecoder()).on('data', value => browserMessages.push(value));
const nativeErrors = [];
native.stderr.on('data', value => nativeErrors.push(value.toString()));

const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Browser Use 本地测试</title>
<style>body{font:18px sans-serif;padding:36px;background:#f5f7f4}input,select,button{font:inherit;padding:10px;margin:8px}main{max-width:800px}footer{margin-top:1600px}</style>
<main><h1>浏览器助手测试页面</h1><form><label>任务名称<input id="task" aria-label="任务名称"></label>
<label>类型<select aria-label="类型"><option value="read">读取</option><option value="write">填写</option></select></label>
<label>密码<input type="password" aria-label="密码" value="test-secret-do-not-read"></label>
<button type="submit">保存任务</button></form><p id="result">尚未保存</p><a href="/next">下一页</a><div id="shadow"></div><footer>页面底部</footer></main>
<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#result').textContent='已保存：'+document.querySelector('#task').value+':'+document.querySelector('select').value};document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow 操作</button>';</script></html>`;

const server = http.createServer(async (req, res) => {
  if (await reliabilityRoute(req, res)) return;
  if (req.url === '/native/pull') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(browserMessages.splice(0))); return; }
  if (req.url === '/native/push' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    native.stdin.write(nativeFrame(JSON.parse(Buffer.concat(chunks).toString())));
    res.end('{}'); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const advanced = advancedFixture(req.url, server.address().port);
  if (advanced) { res.end(advanced); return; }
  res.end(req.url === '/next' ? '<!doctype html><title>第二页</title><h1>导航已完成</h1><a href="/fixture">返回测试</a>' : fixture);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Test only: replace OS native-host discovery, without touching the user's registry.
// Production background/controller/page code, real Chrome APIs, native framing,
// native host HTTP authentication and MCP stdio remain in the tested path.
await writeFile(join(stage, 'test-native-shim.js'), `
chrome.runtime.connectNative = () => {
  const listeners = [], disconnected = [];
  let live = true;
  const poll = async () => {
    if (!live) return;
    try { const values = await (await fetch('${base}/native/pull')).json(); for (const v of values) for (const fn of listeners) fn(v); } catch {}
    if (live) setTimeout(poll, 35);
  };
  poll();
  return { onMessage: { addListener: fn => listeners.push(fn) }, onDisconnect: { addListener: fn => disconnected.push(fn) },
    postMessage: value => { fetch('${base}/native/push', {method:'POST', body:JSON.stringify(value)}); },
    disconnect: () => { live = false; for (const fn of disconnected) fn(); } };
};
`);
await writeFile(join(stage, 'test-transport.js'), "import './test-native-shim.js';\nimport './background.js';\n");
const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
manifest.background.service_worker = 'test-transport.js';
await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest));
const extensionId = (await readFile(join(root, 'extension-id.txt'), 'utf8')).trim();

const mcp = spawn(process.execPath, [join(root, 'src/mcp-server.mjs')], { env: { ...process.env, BROWSER_BUDDY_STATE_DIR: stateDir }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let requestId = 0;
const pending = new Map();
createInterface({ input: mcp.stdout }).on('line', line => {
  const response = JSON.parse(line);
  const job = pending.get(response.id);
  if (job) { clearTimeout(job.timer); pending.delete(response.id); job.resolve(response); }
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 35000);
    pending.set(id, { resolve, timer });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args = {}, expectError = false) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  const value = response.result;
  if (expectError) { assert.equal(value.isError, true); return value.content[0].text; }
  assert.ok(!value.isError, value.content?.[0]?.text);
  return value.content[0].type === 'image' ? { ...value.content[0], ...JSON.parse(value.content[1]?.text || '{}') } : JSON.parse(value.content[0].text);
}
async function eventually(check, label) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

let context;
let popup;
const checks = [];
try {
  context = await chromium.launchPersistentContext(join(runDir, 'profile'), {
    headless: true, channel: 'chromium', viewport: { width: 1000, height: 760 }, deviceScaleFactor: 1.5, downloadsPath: join(runDir, 'downloads'),
    args: [`--disable-extensions-except=${stage}`, `--load-extension=${stage}`]
  });
  // Leave dialogs pending for Codex Browser Use; Playwright otherwise auto-dismisses them.
  context.on('dialog', () => {});
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByText('Chrome 已连接', { exact: true }).waitFor({ timeout: 15000 });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buddy-e2e', version: '1' } });
  assert.equal((await call('browser_status')).connected, true);
  checks.push('MCP → local authenticated bridge → native framing → real extension connection');

  const a = await call('browser_session_start', { name: '网页研究' });
  const b = await call('browser_session_start', { name: '表单助手' });
  const owned = await call('browser_open', { sessionId: a.sessionId, url: `${base}/fixture` });
  const args = { sessionId: a.sessionId, tabId: owned.tabId };
  assert.match(await call('browser_snapshot', { ...args, sessionId: b.sessionId }, true), /not shared/);
  let snapshot = await call('browser_snapshot', args);
  assert.ok(snapshot.elements.some(e => e.name === 'Shadow 操作'));
  assert.ok(!JSON.stringify(snapshot).includes('test-secret-do-not-read'));
  const task = snapshot.elements.find(e => e.name === '任务名称');
  const select = snapshot.elements.find(e => e.tag === 'select');
  const submit = snapshot.elements.find(e => e.name === '保存任务');
  await call('browser_fill', { ...args, ref: task.ref, text: 'Codex 本地联调' });
  await call('browser_select', { ...args, ref: select.ref, value: 'write' });
  await call('browser_click', { ...args, ref: submit.ref });
  snapshot = await call('browser_snapshot', args);
  assert.match(snapshot.text, /已保存：Codex 本地联调:write/);
  assert.equal(snapshot.elements.find(e => e.name === '保存任务').ref, submit.ref);
  const password = snapshot.elements.find(e => e.type === 'password');
  assert.match(await call('browser_fill', { ...args, ref: password.ref, text: 'x' }, true), /password/i);
  checks.push('Real DOM snapshot, shadow root, fill, select, click, session isolation, stale refs and password exclusion');

  const field = snapshot.elements.find(e => e.name === '任务名称');
  await call('browser_fill', { ...args, ref: field.ref, text: '回车提交' });
  await call('browser_press', { ...args, key: 'Enter' });
  assert.match((await call('browser_snapshot', args)).text, /已保存：回车提交:write/);
  const scroll = await call('browser_scroll', { ...args, direction: 'down', amount: 600 });
  assert.ok(scroll.y > 0);
  const shot = await call('browser_screenshot', args);
  assert.equal(shot.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(shot.data, 'base64').length > 1000);
  await writeFile(join(output, 'controlled-page.jpg'), Buffer.from(shot.data, 'base64'));
  checks.push('Chrome debugger keyboard events, scrolling and real viewport screenshot');

  await call('browser_navigate', { ...args, action: 'goto', url: `${base}/next` });
  assert.match((await call('browser_snapshot', args)).text, /导航已完成/);
  await call('browser_navigate', { ...args, action: 'back' });
  assert.match((await call('browser_snapshot', args)).text, /浏览器助手测试页面/);
  checks.push('Navigation and history');

  checks.push(...await advancedChecks(call, base, output));
  checks.push(...await reliabilityChecks(call, base, output, { downloadRoot: runDir }));

  const existing = await context.newPage();
  await existing.goto(`${base}/fixture?existing=1`);
  await popup.locator('#session-select').selectOption(b.sessionId);
  await existing.bringToFront();
  await popup.locator('#share').dispatchEvent('click');
  await eventually(async () => (await call('browser_tabs', { sessionId: b.sessionId })).tabs.length === 1, 'share existing tab from popup');
  const shared = (await call('browser_tabs', { sessionId: b.sessionId })).tabs[0];
  assert.equal(shared.kind, 'shared');
  assert.match(await call('browser_close', { sessionId: b.sessionId, tabId: shared.tabId }, true), /cannot be closed/);
  await popup.setViewportSize({ width: 392, height: 760 });
  await popup.screenshot({ path: join(output, 'popup-connected.png'), fullPage: true });
  await popup.locator('#pause').click();
  assert.match(await call('browser_snapshot', args, true), /暂停/);
  await popup.getByRole('button', { name: '恢复控制' }).click();
  await call('browser_release', { sessionId: b.sessionId, tabId: shared.tabId });
  assert.match(await call('browser_snapshot', { sessionId: b.sessionId, tabId: shared.tabId }, true), /not shared/);
  assert.ok(!existing.isClosed());
  checks.push('Real popup sharing, pause/resume, protected pre-existing tab and revoke');

  await call('browser_session_end', { sessionId: a.sessionId });
  await call('browser_session_end', { sessionId: b.sessionId });
  assert.equal((await call('browser_status')).sessionCount, 0);
  assert.ok(context.pages().some(page => page.url() === `${base}/fixture`));
  await eventually(async () => (await popup.locator('#count').innerText()) === '0', 'empty sessions');
  await popup.screenshot({ path: join(output, 'popup-empty.png'), fullPage: true });
  checks.push('Session end releases ownership and preserves pages');
  assert.deepEqual(nativeErrors, []);
  const report = { passed: true, checks, limitation: 'Windows registry discovery and the user\'s installed Chrome profile were not modified. Native transport discovery was replaced only in a disposable test extension; all browser APIs, MCP and native framing were real.' };
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const diagnostic = popup ? await popup.locator('body').innerText().catch(() => 'popup unavailable') : 'browser not started';
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: false, checks, error: error.message, diagnostic, nativeErrors }, null, 2));
  throw error;
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  if (context) await context.close();
  mcp.stdin.end(); native.stdin.end();
  mcp.kill(); native.kill();
  server.close(); server.closeAllConnections();
  // Resolved temporary target is confined to this plugin's test output.
  assert.ok(runDir.startsWith(output + '\\') || runDir.startsWith(output + '/'));
  await rm(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
