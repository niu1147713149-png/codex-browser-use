import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tools } from '../src/tools.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the absolute path to codex.exe');
const server = spawn(executable, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let sequence = 0;
server.stderr.resume(); // Do not print unrelated config, account or server diagnostics.
createInterface({ input: server.stdout }).on('line', line => {
  let response;
  try { response = JSON.parse(line); } catch { return; }
  const job = pending.get(response.id);
  if (job) { pending.delete(response.id); clearTimeout(job.timer); job.resolve(response); }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45000);
    pending.set(id, { resolve, reject, timer });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
let report;
try {
  const initialization = await rpc('initialize', { clientInfo: { name: 'buddy-install-diagnostic', version: '0.3.1' }, capabilities: { experimentalApi: true } });
  if (initialization.error) throw new Error(initialization.error.message);
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const servers = [];
  let cursor;
  do {
    const response = await rpc('mcpServerStatus/list', { ...(cursor ? { cursor } : {}), limit: 100 });
    if (response.error) throw new Error(response.error.message);
    servers.push(...(response.result.data || []));
    cursor = response.result.nextCursor;
  } while (cursor);
  const matching = servers.filter(s => /browser-use/i.test(s.name));
  report = { checkedAt: new Date().toISOString(), passed: matching.some(s => Object.keys(s.tools || {}).length === tools.length), matchingServers: matching.map(s => ({ name: s.name, toolNames: Object.keys(s.tools || {}), toolCount: Object.keys(s.tools || {}).length })), checkedVia: 'Codex app-server mcpServerStatus/list', createdChat: false };
  if (!report.passed) { report.availableServerNames = servers.map(s => s.name); process.exitCode = 1; }
} catch (error) {
  report = { passed: false, error: error.message, createdChat: false }; process.exitCode = 1;
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  server.stdin.end(); server.kill();
}
const output = fileURLToPath(new URL('../output/live/', import.meta.url));
await mkdir(output, { recursive: true });
await writeFile(join(output, 'codex-discovery.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
