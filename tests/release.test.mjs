import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectReleaseFile } from '../scripts/release.mjs';

const entry = (path, text = 'ordinary source', mode) => ({ path, mode, bytes: Buffer.from(text) });

test('Release accepts public extension identity and required hidden manifests', async () => {
  const bytes = await readFile(new URL('../extension/manifest.json', import.meta.url));
  assert.deepEqual(inspectReleaseFile({ path: 'extension/manifest.json', bytes }), []);
  for (const path of ['.mcp.json', '.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', '.github/workflows/ci.yml']) {
    assert.deepEqual(inspectReleaseFile(entry(path)), []);
  }
});

test('Release rejects runtime data, credentials, browser evidence and unexpected files', () => {
  for (const path of ['output/live/report.json', 'backups/config.toml', '.env', 'extension/connection.json',
    'extension/cookies.json', 'extension/storage-state.json', 'node_modules/a/index.js', 'private.pem',
    'docs/screenshot.jpg', '../README.md', 'scripts/__pycache__/module.pyc']) {
    assert.ok(inspectReleaseFile(entry(path)).length, path);
  }
});

test('Release refuses symlinks and gitlinks even under approved source paths', () => {
  for (const mode of ['120000', '160000']) {
    assert.match(inspectReleaseFile(entry('src/paths.mjs', 'outside', mode)).join('\n'), /regular files/);
  }
});

test('Release detects common secret formats and machine paths without echoing their content', () => {
  const values = ['gh' + 'p_' + 'a'.repeat(36), 'sk-' + 'b'.repeat(40),
    '-----BEGIN ' + 'PRIVATE KEY-----', ['D:', 'work', 'project'].join('\\')];
  for (const value of values) {
    const issues = inspectReleaseFile(entry('README.md', value));
    assert.ok(issues.length);
    assert.ok(issues.every(issue => !issue.includes(value)));
  }
  assert.deepEqual(inspectReleaseFile(entry('README.md', '${PLUGIN_ROOT}/src/mcp-server.mjs')), []);
});
