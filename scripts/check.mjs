import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VERSION } from '../extension/version.js';
import { tools } from '../src/tools.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const path of ['package.json', 'plugin.json', '.codex-plugin/plugin.json', 'mcp.json', '.mcp.json', '.agents/plugins/marketplace.json', 'extension/manifest.json']) {
  JSON.parse(await readFile(join(root, path), 'utf8'));
}
const extension = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
assert.ok(extension.key, 'Run prepare.mjs');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const path of ['plugin.json', '.codex-plugin/plugin.json', 'extension/manifest.json', 'package-lock.json']) {
  assert.equal(JSON.parse(await readFile(join(root, path), 'utf8')).version, pkg.version, `${path}: version mismatch`);
}
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root version mismatch');
assert.equal(VERSION, pkg.version, 'Runtime version mismatch');
const extensionId = createHash('sha256').update(Buffer.from(extension.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, x => String.fromCharCode(97 + parseInt(x, 16)));
assert.equal((await readFile(join(root, 'extension-id.txt'), 'utf8')).trim(), extensionId, 'Extension ID must match its public key');
assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length, 'Duplicate MCP tool names');
for (const file of Object.values(extension.icons)) assert.ok((await readFile(join(root, 'extension', file))).length > 40);
for (const dir of ['src', 'extension', 'scripts', 'tests']) {
  for (const file of await readdir(join(root, dir))) if (/\.m?js$/.test(file)) {
    const checked = spawnSync(process.execPath, ['--check', join(root, dir, file)], { encoding: 'utf8', windowsHide: true });
    assert.equal(checked.status, 0, `${file}: ${checked.stderr}`);
  }
}
console.log(`Manifest, version ${pkg.version}, extension identity, ${tools.length} tools, icons and JavaScript syntax checks passed.`);
