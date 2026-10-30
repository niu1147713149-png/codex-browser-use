// Real installed Chrome integration, controlled exclusively through the plugin.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BrowserClient } from './mcp-client.mjs';

const output = fileURLToPath(new URL('../output/media-check/', import.meta.url));
await mkdir(output, { recursive: true });
const fixture = join(output, 'fixture.mp4');
const built = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', fixture], { encoding: 'utf8', windowsHide: true });
assert.equal(built.status, 0, built.stderr);
const bytes = await readFile(fixture);
const server = createServer((req, res) => {
  if (req.url.startsWith('/media.mp4')) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
    res.writeHead(match ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    res.end(bytes.subarray(start, end + 1)); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Browser Use media fixture</title><h1>Video pixels and tone; no subtitles</h1><video controls preload="auto" src="/media.mp4"></video><button id="replace">Replace source</button><script>document.querySelector('button').onclick=()=>document.querySelector('video').src='/media.mp4?second';</script>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const c = await new BrowserClient(process.argv[2]).init();
let session, report = { passed: false, checks: [], mockedTransport: false };
try {
  session = await c.call('browser_session_start', { name: '视频接口回归' });
  const tab = await c.call('browser_open', { sessionId: session.sessionId, url: `http://127.0.0.1:${server.address().port}`, active: true });
  const scope = { sessionId: session.sessionId, tabId: tab.tabId };
  let media;
  for (let i = 0; i < 30; i++) {
    media = (await c.call('browser_media', scope)).media[0];
    if (media?.readyState >= 2) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(media.duration > 7 && media.duration < 9); assert.equal(media.textTracks.length, 0);
  const target = { ...scope, mediaRef: media.mediaRef };
  const one = await c.call('browser_media_frame', { ...target, time: 1 });
  const two = await c.call('browser_media_frame', { ...target, time: 4 });
  assert.ok(Math.abs(two.mediaTime - 4) < 0.35);
  const hash = data => createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex');
  assert.notEqual(hash(one.data), hash(two.data));
  await writeFile(join(output, 'frame-1.jpg'), Buffer.from(one.data, 'base64'));
  await writeFile(join(output, 'frame-4.jpg'), Buffer.from(two.data, 'base64'));
  report.checks.push('No-subtitle video: source metadata, verified seeking, different decoded frames');
  await c.call('browser_media_control', { ...target, action: 'seek', time: 0 });
  // A genuine user-input event through the plugin permits browser autoplay.
  await c.call('browser_click', { ...scope, locator: { css: 'video' } });
  await c.call('browser_media_control', { ...target, action: 'play' });
  const recording = await c.call('browser_media_audio', { ...target, action: 'start', durationSeconds: 1.5 });
  await assert.rejects(c.call('browser_media_frame', { ...target, time: 3 }), /Stop audio/);
  let status;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 150));
    status = await c.call('browser_media_audio', { ...target, action: 'status', recordingId: recording.recordingId });
    if (status.status === 'complete') break;
  }
  assert.equal(status.status, 'complete'); assert.equal(status.timelineContinuous, true);
  await assert.rejects(c.call('browser_media_audio', { ...target, action: 'read', recordingId: 'wrong' }), /Unknown recording/);
  const audio = await c.call('browser_media_audio', { ...target, action: 'read', recordingId: recording.recordingId });
  assert.ok(Buffer.from(audio.data, 'base64').length > 1000);
  const audioFile = join(output, 'captured.webm'); await writeFile(audioFile, Buffer.from(audio.data, 'base64'));
  const decoded = spawnSync('ffmpeg', ['-hide_banner', '-i', audioFile, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  assert.equal(decoded.status, 0); assert.match(decoded.stderr, /max_volume: -?\d+(\.\d+)? dB/); assert.ok(!decoded.stderr.includes('max_volume: -inf'));
  report.checks.push('Actual media audio bytes decode with nonzero amplitude; timeline, read IDs and seek-during-recording guards');
  await c.call('browser_media_audio', { ...target, action: 'discard', recordingId: recording.recordingId });
  await c.call('browser_media_control', { ...target, action: 'seek', time: 0 });
  await c.call('browser_media_control', { ...target, action: 'play' });
  const interrupted = await c.call('browser_media_audio', { ...target, action: 'start', durationSeconds: 5 });
  await c.call('browser_media_control', { ...target, action: 'pause' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await c.call('browser_media_audio', { ...target, action: 'status', recordingId: interrupted.recordingId })).timelineContinuous, false);
  await c.call('browser_media_audio', { ...target, action: 'discard', recordingId: interrupted.recordingId });
  await c.call('browser_click', { ...scope, locator: { role: 'button', name: 'Replace source' } });
  await assert.rejects(c.call('browser_media_frame', target), /STALE_MEDIA/);
  report.checks.push('Pause marks audio interrupted; source replacement rejects old media refs');
  report.passed = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  if (session) { try { await c.call('browser_finalize', { sessionId: session.sessionId }); report.cleanedUp = true; } catch (error) { report.cleanupError = error.message; process.exitCode = 1; } }
  c.close(); server.close(); server.closeAllConnections(); report.checkedAt = new Date().toISOString();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
