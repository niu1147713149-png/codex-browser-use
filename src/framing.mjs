import { Transform } from 'node:stream';

// Chrome native messaging uses 32-bit little-endian byte lengths, not newline JSON.
export function nativeFrame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 1_000_000) throw new Error('Native request exceeds Chrome host limit');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class NativeDecoder extends Transform {
  constructor(maxBytes = 12 * 1024 * 1024) {
    super({ readableObjectMode: true });
    this.buffer = Buffer.alloc(0);
    this.maxBytes = maxBytes;
  }
  _transform(chunk, encoding, callback) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (!length || length > this.maxBytes) throw new Error('Invalid native message size');
        if (this.buffer.length < length + 4) break;
        const value = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
        this.buffer = this.buffer.subarray(length + 4);
        this.push(value);
      }
      callback();
    } catch (error) { callback(error); }
  }
  _flush(callback) {
    callback(this.buffer.length ? new Error('Truncated native message') : undefined);
  }
}
