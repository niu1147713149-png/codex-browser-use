import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { advancedFixture } from './advanced-fixture.mjs';
import { advancedChecks } from './advanced-checks.mjs';
import { reliabilityRoute } from './reliability-fixture.mjs';
import { reliabilityChecks } from './reliability-checks.mjs';
import { tools } from '../src/tools.mjs';

// An explicit live integration check: creates only its own test sessions/tabs.
// Invoke with the installed plugin's MCP entry to exercise the installed copy.
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = resolve(process.argv[2] || join(root, 'src/mcp-server.mjs'));
const output = join(root, 'output', 'live');
await mkdir(output, { recursive: true });
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codex Browser Use 连接验证</title>
<style>body{margin:0;background:#f5f7f4;color:#20312b;font:18px "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:820px;padding:44px;margin:auto}h1{font-size:32px}p{line-height:1.8}label{display:block;margin:18px 0}input,select{font:inherit;padding:12px;border:1px solid #bccdb5;border-radius:6px;margin-left:12px}button{font:inherit;padding:14px 24px;border:0;border-radius:7px;background:#183e32;color:white;cursor:pointer}#result{background:#e4efd9;padding:20px;border-radius:10px}.eyebrow{font-size:12px;letter-spacing:2px;color:#72846a}footer{margin-top:1000px}</style>
<main><p class="eyebrow">CHROME ↔ CODEX · LOCAL CONNECTION TEST</p><h1>Codex Browser Use 已连接</h1><p>这是一张本地测试页面，用于验证读取、表单填写、鼠标点击、键盘操作和截图。</p>
<form><label>测试内容<input aria-label="测试内容" id="content"></label><label>测试类型<select aria-label="测试类型" id="kind"><option value="read">页面读取</option><option value="interaction">页面交互</option></select></label><button type="submit">验证交互</button></form>
<p id="result">等待验证</p><p id="trusted">尚未点击</p><a href="/next">测试导航</a><footer>滚动验证区域</footer></main>
<script>document.querySelector('button').addEventListener('click',e=>document.querySelector('#trusted').textContent='真实鼠标事件：'+e.isTrusted);document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('#result').textContent='验证成功：'+document.querySelector('#content').value+' / '+document.querySelector('#kind').value});</script></html>`;
const fixtureServer = createServer(async (req, res) => {
  if (await reliabilityRoute(req, res)) return;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const advanced = advancedFixture(req.url, fixtureServer.address().port);
  if (advanced) { res.end(advanced); return; }
  res.end(req.url === '/next' ? '<!doctype html><meta charset="utf-8"><title>导航验证</title><h1>导航成功</h1><a href="/">返回</a>' : fixture);
});
await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${fixtureServer.address().port}`;
const server = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let sequence = 0;
createInterface({ input: server.stdout }).on('line', line => {
  const response = JSON.parse(line);
  const job = pending.get(response.id);
  if (!job) return;
  pending.delete(response.id); clearTimeout(job.timer); job.resolve(response);
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 32000);
    pending.set(id, { timer, resolve, reject });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name, args = {}, expectError = false) {
  const response = await rpc('tools/call', { name, arguments: args });
  assert.ok(!response.error, response.error?.message);
  const result = response.result;
  if (expectError) { assert.equal(result.isError, true); return result.content[0].text; }
  assert.ok(!result.isError, result.content?.[0]?.text);
  return result.content[0].type === 'image' ? { ...result.content[0], ...JSON.parse(result.content[1]?.text || '{}') } : JSON.parse(result.content[0].text);
}
const sessions = [];
const opened = [];
const checks = [];
let report;
try {
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'buddy-live-check', version: '1' }, capabilities: {} });
  assert.equal(initialized.result.serverInfo.name, 'codex-browser-use');
  const catalog = await rpc('tools/list');
  assert.equal(catalog.result.tools.length, tools.length);
  const status = await call('browser_status');
  assert.equal(status.connected, true);
  assert.equal(status.paused, false);
  checks.push(`已安装 MCP 服务完成握手，发现 ${tools.length} 个工具，真实 Chrome 已连接`);
  const session = await call('browser_session_start', { name: '安装连接验证' });
  sessions.push(session.sessionId);
  assert.equal((await call('browser_tabs', { sessionId: session.sessionId })).tabs.length, 0);
  const tab = await call('browser_open', { sessionId: session.sessionId, url: base, active: true });
  const args = { sessionId: session.sessionId, tabId: tab.tabId };
  opened.push(args);
  let snapshot = await call('browser_snapshot', args);
  assert.match(snapshot.text, /Codex Browser Use 已连接/);
  const input = snapshot.elements.find(e => e.name === '测试内容');
  const select = snapshot.elements.find(e => e.name === '测试类型');
  const submit = snapshot.elements.find(e => e.name === '验证交互');
  assert.ok(input && select && submit);
  await call('browser_fill', { ...args, ref: input.ref, text: 'Codex 与 Chrome 连接正常' });
  await call('browser_select', { ...args, ref: select.ref, value: 'interaction' });
  await call('browser_click', { ...args, ref: submit.ref });
  snapshot = await call('browser_snapshot', args);
  assert.match(snapshot.text, /验证成功：Codex 与 Chrome 连接正常 \/ interaction/);
  assert.match(snapshot.text, /真实鼠标事件：true/);
  checks.push('真实 Chrome 页面读取、填写、下拉选择、可信鼠标点击通过');
  const shot = await call('browser_screenshot', args);
  assert.equal(shot.mimeType, 'image/jpeg');
  const jpeg = Buffer.from(shot.data, 'base64');
  assert.ok(jpeg.length > 1000 && jpeg[0] === 255 && jpeg[1] === 216);
  await writeFile(join(output, 'chrome-connected.jpg'), jpeg);
  checks.push('真实 Chrome 视口截图通过，已保存验证截图');
  assert.equal(snapshot.elements.find(e => e.name === '验证交互').ref, submit.ref);
  const nextInput = snapshot.elements.find(e => e.name === '测试内容');
  await call('browser_fill', { ...args, ref: nextInput.ref, text: '键盘验证通过' });
  await call('browser_press', { ...args, key: 'Enter' });
  assert.match((await call('browser_snapshot', args)).text, /验证成功：键盘验证通过/);
  const scroll = await call('browser_scroll', { ...args, direction: 'down', amount: 500 });
  assert.ok(scroll.y > 0);
  await call('browser_navigate', { ...args, action: 'goto', url: `${base}/next` });
  assert.match((await call('browser_snapshot', args)).text, /导航成功/);
  await call('browser_navigate', { ...args, action: 'back' });
  assert.match((await call('browser_snapshot', args)).text, /Codex Browser Use 已连接/);
  checks.push('键盘输入、滚动、导航、历史返回与旧 ref 拒绝通过');
  const other = await call('browser_session_start', { name: '会话隔离验证' });
  sessions.push(other.sessionId);
  assert.match(await call('browser_snapshot', { ...args, sessionId: other.sessionId }, true), /not shared/);
  assert.equal((await call('browser_tabs', { sessionId: other.sessionId })).tabs.length, 0);
  checks.push('真实 Chrome 中的跨会话隔离通过');
  checks.push(...await advancedChecks(call, base, output));
  checks.push(...await reliabilityChecks(call, base, output));
  report = { passed: true, checkedAt: new Date().toISOString(), installedMcpEntry: entry, toolCount: tools.length, transport: 'Installed MCP stdio → authenticated local bridge → Chrome Native Messaging → actual Chrome extension', mockedTransport: false, checks, screenshot: join(output, 'chrome-connected.jpg') };
} catch (error) {
  report = { passed: false, checkedAt: new Date().toISOString(), checks, error: error.message };
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const args of opened) {
    try { await call('browser_close', args); }
    catch (error) { cleanupErrors.push(error.message); }
  }
  for (const sessionId of sessions) {
    try { await call('browser_session_end', { sessionId }); }
    catch (error) { cleanupErrors.push(error.message); }
  }
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; process.exitCode = 1; }
  else report.testTabsClosedAndSessionsEnded = true;
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const job of pending.values()) clearTimeout(job.timer);
  server.stdin.end(); server.kill();
  fixtureServer.close(); fixtureServer.closeAllConnections();
}
