import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestPath = join(root, 'extension', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (!manifest.key) {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  // Only the public identity key is retained. This is not an API credential.
  manifest.key = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, x => String.fromCharCode(97 + parseInt(x, 16)));
await writeFile(join(root, 'extension-id.txt'), `${extensionId}\n`);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function icon(size) {
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = x / size, ny = y / size;
    const inside = Math.hypot(Math.max(.16 - nx, 0, nx - .84), Math.max(.16 - ny, 0, ny - .84)) < .16;
    const vertical = nx > .29 && nx < .39 && ny > .24 && ny < .77;
    const top = ((nx - .43) ** 2 + (ny - .38) ** 2 < .145 ** 2) && ((nx - .43) ** 2 + (ny - .38) ** 2 > .065 ** 2) && nx > .36;
    const bottom = ((nx - .44) ** 2 + (ny - .62) ** 2 < .16 ** 2) && ((nx - .44) ** 2 + (ny - .62) ** 2 > .075 ** 2) && nx > .36;
    const dot = Math.hypot(nx - .73, ny - .72) < .055;
    const color = dot ? [178, 215, 153] : vertical || top || bottom ? [248, 250, 243] : [24, 62, 50];
    const i = y * (size * 4 + 1) + 1 + x * 4;
    rows.set([...color, inside ? 255 : 0], i);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
await mkdir(join(root, 'extension', 'icons'), { recursive: true });
for (const size of [16, 32, 48, 128]) await writeFile(join(root, 'extension', 'icons', `${size}.png`), icon(size));
console.log(`Prepared extension identity: ${extensionId}`);
