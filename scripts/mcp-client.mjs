import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class BrowserClient {
  constructor(entry = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url))) {
    this.child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.resume(); this.pending = new Map(); this.sequence = 0;
    createInterface({ input: this.child.stdout }).on('line', line => {
      const response = JSON.parse(line), job = this.pending.get(response.id);
      if (job) { clearTimeout(job.timer); this.pending.delete(response.id); job.resolve(response); }
    });
    this.child.on('exit', () => { for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Browser MCP stopped')); } this.pending.clear(); });
  }
  rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('MCP timed out; inspect before repeating')); }, 32000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() { await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'browser-use-media', version: '0.5.0' } }); return this; }
  async call(name, args = {}) {
    const response = await this.rpc('tools/call', { name, arguments: args });
    if (response.error || response.result?.isError) throw new Error(response.error?.message || response.result.content[0].text);
    const blocks = response.result.content;
    const binary = blocks.find(b => b.type === 'image' || b.type === 'audio');
    const metadata = JSON.parse(blocks.find(b => b.type === 'text')?.text || '{}');
    return binary ? { ...metadata, data: binary.data, mimeType: binary.mimeType } : metadata;
  }
  close() { for (const job of this.pending.values()) clearTimeout(job.timer); this.pending.clear(); this.child.stdin.end(); this.child.kill(); }
}
