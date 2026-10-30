// Uses only the installed plugin for web interactions. The extension's own
// maintenance page performs the explicit reload needed to test persistence.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BrowserClient } from './mcp-client.mjs';

const entry = process.argv[2], chrome = process.argv[3];
if (!entry || !chrome) throw new Error('Pass installed MCP entry and Chrome executable');
const output = fileURLToPath(new URL('../output/task-check/', import.meta.url));
await mkdir(output, { recursive: true });
const cookieName = 'browser_use_check_' + randomUUID().replaceAll('-', ''), cookieValue = randomUUID();
const fixturePath = '/browser-use-' + randomUUID();
const server = createServer((req, res) => {
  if (req.url === '/cleanup') { res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `${cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax` }); res.end('Test cookie cleared'); return; }
  const authenticated = (req.headers.cookie || '').split(';').some(v => v.trim() === `${cookieName}=${cookieValue}`);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    ...(!authenticated ? { 'Set-Cookie': `${cookieName}=${cookieValue}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax` } : {}) });
  res.end(`<!doctype html><meta charset="utf-8"><title>Browser Use 恢复验收</title>
<style>body{font:18px system-ui;padding:35px;line-height:1.8}button,input,select{font:inherit;margin:8px;padding:8px}</style>
<nav><button data-testid="signed-in">Account menu</button><a data-testid="identity" href="/account/alice">Alice</a></nav>
<p id="cookie">${authenticated ? 'Native HttpOnly session reused' : 'Native session initialized'}</p>
<label>Task value<input aria-label="Task value"></label><select aria-label="Task category"><option value="a">A</option><option value="b">B</option></select>
<p id="events"></p><button id="submit">Submit once</button><button id="delayed">Delayed submit</button><button id="switch">Switch account</button><p id="result"></p><p id="delayed-result"></p><p id="trusted"></p>
<script>
let inputs=0, selections=0, submissions=+(sessionStorage.submissions||0), delayed=+(sessionStorage.delayed||0);
function render(){document.querySelector('#events').textContent='Input events: '+inputs+'; Selection events: '+selections;document.querySelector('#result').textContent='Submissions: '+submissions;document.querySelector('#delayed-result').textContent='Delayed submissions: '+delayed}
document.querySelector('input').addEventListener('input',()=>{inputs++;render()});document.querySelector('select').addEventListener('change',()=>{selections++;render()});
document.querySelector('#submit').onclick=e=>{sessionStorage.submissions=++submissions;document.querySelector('#trusted').textContent='Trusted click: '+e.isTrusted;render()};
document.querySelector('#delayed').onclick=()=>setTimeout(()=>{sessionStorage.delayed=++delayed;render()},900);
document.querySelector('#switch').onclick=()=>{const a=document.querySelector('[data-testid=identity]');a.textContent=a.textContent==='Alice'?'Bob':'Alice';a.href='/account/'+a.textContent.toLowerCase()};render();
</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`, url = base + fixturePath;
let client = await new BrowserClient(entry).init(), scope, taskId, profileId;
const sessions = new Set(), checks = [];
const rules = { signedIn: { testId: 'signed-in' }, identity: { testId: 'identity' } };
const submit = { stepId: 'submit', action: 'click', args: { locator: { role: 'button', name: 'Submit once' }, expect: { state: 'text', text: 'Submissions: 1' } } };
const delayed = { stepId: 'delayed', action: 'click', args: { locator: { role: 'button', name: 'Delayed submit' }, expect: { state: 'text', text: 'Delayed submissions: 1' }, timeoutMs: 0 } };
const read = () => client.call('browser_snapshot', { ...scope, compact: true, maxChars: 5000, maxNodes: 20 });
let report;
try {
  assert.equal((await client.call('browser_status')).sessionCount, 0, 'Run reload validation only when no other task is controlling Chrome');
  profileId = (await client.call('browser_info')).profile.profileId;
  const session = await client.call('browser_session_start', { name: '去重与任务恢复验收', expectedProfileId: profileId }); sessions.add(session.sessionId);
  const tab = await client.call('browser_open', { sessionId: session.sessionId, url, active: true }); scope = { sessionId: session.sessionId, tabId: tab.tabId };
  assert.equal((await client.call('browser_open', { sessionId: session.sessionId, url })).tabId, tab.tabId);
  assert.equal((await client.call('browser_navigate', { ...scope, action: 'goto', url })).changed, false);
  checks.push('Exact URL reuse creates no second tab or reload');
  await client.call('browser_fill', { ...scope, locator: { label: 'Task value' }, text: 'ready' });
  assert.equal((await client.call('browser_fill', { ...scope, locator: { label: 'Task value' }, text: 'ready' })).changed, false);
  await client.call('browser_select', { ...scope, locator: { name: 'Task category', role: 'combobox' }, value: 'b' });
  assert.equal((await client.call('browser_select', { ...scope, locator: { name: 'Task category', role: 'combobox' }, value: 'b' })).changed, false);
  assert.match((await read()).text, /Input events: 1; Selection events: 1/);
  checks.push('Repeated native fill/select produce no extra input/change events');
  const account = await client.call('browser_account', { ...scope, rules });
  assert.equal(account.status, 'signed_in'); assert.ok(account.account.fingerprint); assert.equal(account.profileId, profileId);
  const task = await client.call('browser_task', { ...scope, action: 'create', name: 'Authenticated fixture flow', requireSignedIn: true, accountRules: rules }); taskId = task.taskId;
  assert.equal((await client.call('browser_task_step', { ...scope, taskId, ...submit })).status, 'confirmed');
  assert.equal((await client.call('browser_task_step', { ...scope, taskId, ...submit })).deduplicated, true);
  assert.match((await read()).text, /Trusted click: true/);
  assert.equal((await client.call('browser_task_step', { ...scope, taskId, ...delayed })).status, 'uncertain');
  await client.call('browser_wait', { ...scope, condition: delayed.args.expect });
  assert.equal((await client.call('browser_task_step', { ...scope, taskId, ...delayed })).deduplicated, true);
  await assert.rejects(client.call('browser_task_step', { ...scope, taskId, ...submit, stepId: 'blocked-next' }), /UNRESOLVED_STEP/);
  assert.equal((await client.call('browser_task', { ...scope, taskId, action: 'verify', stepId: 'delayed', condition: delayed.args.expect })).matched, true);
  checks.push('Trusted click sent once; delayed uncertain result blocks later steps and is verified without replay');
  await client.call('browser_click', { ...scope, locator: { role: 'button', name: 'Switch account' } });
  await assert.rejects(client.call('browser_task_step', { ...scope, taskId, ...submit, stepId: 'wrong-account' }), /ACCOUNT_CHANGED_OR_UNKNOWN/);
  await client.call('browser_click', { ...scope, locator: { role: 'button', name: 'Switch account' } });
  checks.push('Account identity change stops before another action');
  await client.call('browser_navigate', { ...scope, action: 'goto', url: url + '-other' });
  await assert.rejects(client.call('browser_task', { ...scope, taskId, action: 'resume' }), /TASK_PAGE_CHANGED/);
  await client.call('browser_navigate', { ...scope, action: 'goto', url });
  checks.push('A different page on the same site cannot silently receive resumed actions');
  assert.equal((await client.call('browser_status')).sessionCount, 1);
  console.log(JSON.stringify({ phase: 'reloading-extension', checks }));
  const updater = spawn(chrome, ['--new-tab', 'chrome-extension://hfkfnchdlckiiehcogghcfkegiikjlii/update.html?reload=1'], { windowsHide: true, stdio: 'ignore' });
  updater.on('error', error => console.error('Extension update launch failed: ' + error.message)); updater.unref();
  client.close(); client = await new BrowserClient(entry).init();
  let restored = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { if ((await client.call('browser_status')).sessionCount === 0) { restored = true; break; } } catch { /* Bridge reconnecting; read only. */ }
  }
  assert.ok(restored, 'Extension did not reload/reconnect');
  const resumed = await client.call('browser_session_start', { name: '恢复验收', expectedProfileId: profileId }); sessions.clear(); sessions.add(resumed.sessionId);
  await client.call('browser_user_tabs', { query: fixturePath });
  scope = { sessionId: resumed.sessionId, tabId: tab.tabId };
  await client.call('browser_claim', { ...scope, reason: 'Resume this test-created page after the extension reload' });
  await client.call('browser_navigate', { ...scope, action: 'reload' });
  assert.match((await read()).text, /Native HttpOnly session reused/);
  const recovery = await client.call('browser_task', { ...scope, taskId, action: 'resume' });
  assert.equal(recovery.actionsReplayed, 0); assert.equal(recovery.steps.length, 2); assert.equal(recovery.accountBinding, 'account_identity');
  assert.equal((await client.call('browser_task_step', { ...scope, taskId, ...submit })).deduplicated, true);
  assert.equal((await client.call('browser_task_step', { ...scope, taskId, ...delayed })).deduplicated, true);
  const text = (await read()).text; assert.match(text, /Submissions: 1/); assert.match(text, /Delayed submissions: 1/);
  await client.call('browser_task', { ...scope, taskId, action: 'finish' });
  checks.push('Actual extension reload and MCP restart preserve profile, HttpOnly login session and task progress; completed steps do not replay');
  report = { passed: true, checkedAt: new Date().toISOString(), transport: 'Installed MCP → Native Messaging → current Chrome', checks };
} catch (error) { report = { passed: false, checkedAt: new Date().toISOString(), checks, error: error.message }; process.exitCode = 1; }
finally {
  const cleanupErrors = [];
  if (scope) {
    if (taskId) try { await client.call('browser_task', { ...scope, taskId, action: 'discard' }); } catch (e) { cleanupErrors.push(e.message); }
    try { await client.call('browser_navigate', { ...scope, action: 'goto', url: base + '/cleanup' }); } catch (e) { cleanupErrors.push(e.message); }
    try { await client.call('browser_close', { ...scope, allowShared: true }); } catch (e) { cleanupErrors.push(e.message); }
  }
  for (const sessionId of sessions) try { await client.call('browser_session_end', { sessionId }); } catch (e) { cleanupErrors.push(e.message); }
  if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; process.exitCode = 1; } else report.cleanupComplete = true;
  client.close(); server.close(); server.closeAllConnections();
  await writeFile(output + 'report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
