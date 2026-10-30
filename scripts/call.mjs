// Thin stdio MCP client for an already-open Codex chat whose tool catalog has
// not refreshed yet. The same installed plugin/native bridge handles actions.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
if (typeof request.name !== 'string') throw new Error('Provide {name, arguments} JSON on stdin');
const entry = process.env.BROWSER_BUDDY_MCP_ENTRY || fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));
const server = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
server.stderr.resume();
const pending = new Map();
let sequence = 0;
createInterface({ input: server.stdout }).on('line', line => {
  const response = JSON.parse(line), job = pending.get(response.id);
  if (job) { clearTimeout(job.timer); pending.delete(response.id); job.resolve(response); }
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP call timed out; inspect before repeating')); }, 32000);
    pending.set(id, { resolve, reject, timer });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-use-local-client', version: '0.3.1' } });
  const response = await rpc('tools/call', { name: request.name, arguments: request.arguments || {} });
  if (response.error) throw new Error(response.error.message);
  if (response.result.isError) throw new Error(response.result.content[0].text);
  const content = response.result.content;
  if (content[0].type === 'image' || content[0].type === 'audio') {
    const destination = content[0].type === 'audio' ? request.audioOutput : request.imageOutput;
    if (!destination) throw new Error('Media captured; provide imageOutput or audioOutput to save it locally');
    const path = resolve(destination);
    await writeFile(path, Buffer.from(content[0].data, 'base64'));
    console.log(JSON.stringify({ path, mimeType: content[0].mimeType, ...JSON.parse(content[1]?.text || '{}') }, null, 2));
  } else console.log(content[0].text);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  for (const job of pending.values()) clearTimeout(job.timer);
  server.stdin.end(); server.kill();
}
