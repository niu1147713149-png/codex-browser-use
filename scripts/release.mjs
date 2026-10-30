// Audit Git objects, then archive the exact checked commit. Never copy the workspace.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootFiles = new Set(['.gitattributes', '.gitignore', '.mcp.json', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'FEATURES.md', 'LICENSE', 'README.md', 'SECURITY.md',
  'THIRD_PARTY_NOTICES.md', 'extension-id.txt', 'mcp.json', 'package.json',
  'package-lock.json', 'plugin.json', 'requirements-media.txt']);
const allowed = /^(?:\.agents\/plugins\/marketplace\.json|\.codex-plugin\/plugin\.json|\.github\/(?:[\w-]+\/)*[\w.-]+\.(?:md|yml|yaml)|docs\/(?:[\w-]+\/)*[\w.-]+\.md|skills\/browser-use\/SKILL\.md|src\/[\w-]+\.mjs|scripts\/[\w-]+\.(?:mjs|ps1|py)|tests\/[\w.-]+\.test\.mjs|extension\/[\w-]+\.(?:js|html|css|json)|extension\/icons\/(?:16|32|48|128)\.png)$/;
const privatePath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|connection\.json|cookies?[^/]*\.json|storage[-_]state[^/]*\.json|config\.toml|native-host\.(?:json|cmd)|[^/]*\.(?:key|pem|log|bak|zip))$/i;
const contentRules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['service API key', /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|AIza[0-9A-Za-z_-]{35}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/],
  ['credential literal', /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_+=/-]{20,}['"]/i],
  ['machine path', /(?:\b[A-Za-z]:\\[^\s"'<>\\]+\\|\b[A-Za-z]:\/(?!\/)[^\s"'<>/]+\/|\/(?:Users|home)\/[^\s/]+\/)/],
];

export function inspectReleaseFile({ path, mode = '100644', bytes }) {
  const errors = [];
  if (!['100644', '100755'].includes(mode)) errors.push('only regular files are allowed');
  if ((!rootFiles.has(path) && !allowed.test(path)) || privatePath.test(path)) errors.push('path is not approved for release');
  if (bytes.length > 1024 * 1024) errors.push('file exceeds 1 MiB source limit');
  if (!path.endsWith('.png')) {
    const value = bytes.toString('utf8');
    if (value.includes('\0')) errors.push('unexpected binary content');
    for (const [label, pattern] of contentRules) if (pattern.test(value)) errors.push(label);
  }
  // Report the rule, never echo matching content (which may contain a credential).
  return errors.map(error => `${path}: ${error}`);
}

function git(args, input) {
  const result = spawnSync('git', args, { cwd: root, input, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed. Use a Git checkout with Git on PATH.`);
  return result.stdout;
}

function snapshot(index) {
  const listing = git(index ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).toString('utf8');
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), path = line.slice(tab + 1), fields = line.slice(0, tab).split(' ');
    const [mode, hash, stage] = index ? fields : [fields[0], fields[2], '0'];
    if (stage !== '0') throw new Error('Resolve merge conflicts before auditing a release.');
    if (!['100644', '100755'].includes(mode)) throw new Error(`${path}: only regular files are allowed`);
    return { path, mode, hash };
  });
  if (!entries.length) throw new Error('No Git files to inspect. Stage the intended project files first.');
  const blobs = git(['cat-file', '--batch'], entries.map(entry => entry.hash).join('\n') + '\n');
  let cursor = 0;
  for (const entry of entries) {
    const newline = blobs.indexOf(10, cursor);
    const [hash, type, length] = blobs.subarray(cursor, newline).toString().split(' ');
    const size = Number(length);
    if (hash !== entry.hash || type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git object response');
    entry.bytes = blobs.subarray(newline + 1, newline + 1 + size);
    if (entry.bytes.length !== size) throw new Error('Incomplete Git object response');
    cursor = newline + 1 + size + 1;
  }
  return entries;
}

function audit(entries) {
  const errors = entries.flatMap(inspectReleaseFile);
  const files = new Map(entries.map(entry => [entry.path, entry.bytes]));
  const required = [...rootFiles, '.agents/plugins/marketplace.json', '.codex-plugin/plugin.json',
    'extension/manifest.json', 'extension/background.js', 'extension/version.js',
    'src/mcp-server.mjs', 'src/native-host.mjs', 'scripts/install.ps1', 'scripts/uninstall.ps1',
    'scripts/release.mjs', 'skills/browser-use/SKILL.md', '.github/workflows/ci.yml'];
  for (const path of required) if (!files.has(path)) errors.push(`${path}: required file missing`);
  if (errors.length) throw new Error(`Release audit failed:\n${errors.join('\n')}`);
  const json = path => JSON.parse(files.get(path).toString('utf8'));
  const version = json('package.json').version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Release requires a numeric major.minor.patch version.');
  for (const path of ['plugin.json', '.codex-plugin/plugin.json', 'extension/manifest.json', 'package-lock.json']) {
    if (json(path).version !== version) throw new Error(`${path}: release version mismatch`);
  }
  if (json('package-lock.json').packages?.['']?.version !== version) throw new Error('Lockfile root version mismatch');
  if (!files.get('extension/version.js').toString().includes(`export const VERSION = '${version}';`)) throw new Error('Extension runtime version mismatch');
  const key = json('extension/manifest.json').key;
  if (!key) throw new Error('Missing extension public key');
  const id = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, character => String.fromCharCode(97 + parseInt(character, 16)));
  if (files.get('extension-id.txt').toString().trim() !== id) throw new Error('Extension identity mismatch');
  return version;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: node scripts/release.mjs [--check]');
  const check = args[0] === '--check';
  if (!check && git(['status', '--porcelain', '--untracked-files=all']).length) throw new Error('Commit the intended files and resolve untracked files before packaging. Ignored output is allowed.');
  const entries = snapshot(check), version = audit(entries);
  console.log(`Release audit passed: ${entries.length} ${check ? 'staged' : 'committed'} files, version ${version}.`);
  if (check) return;
  const commit = git(['rev-parse', 'HEAD']).toString().trim();
  const directory = join(root, 'output', 'release'), name = `codex-browser-use-${version}`;
  await mkdir(directory, { recursive: true });
  const archive = join(directory, `${name}.zip`);
  git(['archive', '--format=zip', '--prefix=codex-browser-use/', `--output=${archive}`, commit]);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}.zip\n`);
  await writeFile(join(directory, `${name}.manifest.json`), JSON.stringify({ name: 'codex-browser-use', version, commit,
    archive: `${name}.zip`, sha256, files: entries.map(({ path, bytes }) => ({ path, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') })) }, null, 2) + '\n');
  console.log(`Created output/release/${name}.zip, SHA-256 and file manifest.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
