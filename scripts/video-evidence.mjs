// Capture observed media through the same installed browser plugin. No browser/CDP bypass.
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { BrowserClient } from './mcp-client.mjs';

const { values: v } = parseArgs({ options: { session: { type: 'string' }, tab: { type: 'string' }, media: { type: 'string' }, out: { type: 'string' }, start: { type: 'string', default: '0' }, end: { type: 'string' }, interval: { type: 'string', default: '2' }, entry: { type: 'string' }, help: { type: 'boolean' } } });
if (v.help) {
  console.log('node scripts/video-evidence.mjs --session OBSERVED_ID --tab OBSERVED_ID --media OBSERVED_REF --out ABSOLUTE_DIR [--start 0 --end SECONDS --interval 2]\nCaptures actual video frames and audio; long videos use overlapping <=45s audio segments. Leaves playback paused. Does not transcribe or claim every frame was viewed.');
  process.exit(0);
}
if (!v.session || !v.tab || !v.media || !v.out || !isAbsolute(v.out)) throw new Error('Provide session, tab, media and an absolute output directory');
const output = resolve(v.out);
if (process.platform === 'win32' && /^C:/i.test(output)) throw new Error('Use a confirmed non-C output directory for media evidence');
const start = Number(v.start), interval = Number(v.interval);
if (!Number.isFinite(start) || start < 0 || !Number.isFinite(interval) || interval < 0.25 || interval > 30) throw new Error('Invalid start or interval (0.25–30 seconds)');
const c = await new BrowserClient(v.entry).init();
const target = { sessionId: v.session, tabId: Number(v.tab), mediaRef: v.media };
const manifest = { schemaVersion: 1, capturedAt: new Date().toISOString(), source: null, requested: {}, frames: [], audio: [], errors: [],
  visualCoverage: 'sampled_frames_only', interpretation: 'unreviewed', note: 'Audio is captured from playback. Frames are sampled, not every frame. A model must inspect images and listen/transcribe audio before claiming understanding.' };
await mkdir(output, { recursive: true });
const save = () => writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
const binary = async (result, filename) => {
  const { data, ...metadata } = result, bytes = Buffer.from(data, 'base64');
  await writeFile(join(output, filename), bytes);
  return { ...metadata, file: filename, sha256: createHash('sha256').update(bytes).digest('hex') };
};
let recording;
try {
  const media = (await c.call('browser_media', { sessionId: target.sessionId, tabId: target.tabId })).media.find(m => m.mediaRef === target.mediaRef);
  if (!media || media.kind !== 'video' || media.protected) throw new Error('Selected video is stale, absent, or protected');
  const end = v.end === undefined ? media.duration : Number(v.end);
  if (!Number.isFinite(end) || end <= start || end > 604800 || (media.duration && end > media.duration + 0.01)) throw new Error('Provide a finite end within the media duration; live streams require explicit bounds');
  manifest.source = media; manifest.requested = { start, end, frameIntervalSeconds: interval };
  manifest.page = await c.call('browser_snapshot', { sessionId: target.sessionId, tabId: target.tabId, compact: true, maxChars: 12000, maxNodes: 80 });
  let cursor = start, index = 0;
  while (cursor < end - 0.15) {
    await c.call('browser_media_control', { ...target, action: 'seek', time: Math.max(0, cursor - 0.25) });
    // Exact timestamp samples include the opening frame, even if playback begins later.
    manifest.frames.push(await binary(await c.call('browser_media_frame', { ...target }), `frame-${String(manifest.frames.length).padStart(5, '0')}.jpg`));
    await c.call('browser_media_control', { ...target, action: 'play' });
    const seconds = Math.min(45, end - Math.max(0, cursor - 0.25));
    recording = await c.call('browser_media_audio', { ...target, action: 'start', durationSeconds: Math.max(0.5, seconds) });
    const deadline = Date.now() + (seconds + 15) * 1000;
    let status = recording, nextFrame = 0;
    while (['recording', 'stopping'].includes(status.status)) {
      if (Date.now() > deadline) throw new Error('Recording exceeded deadline; partial evidence retained');
      if (Date.now() >= nextFrame) {
        manifest.frames.push(await binary(await c.call('browser_media_frame', { ...target }), `frame-${String(manifest.frames.length).padStart(5, '0')}.jpg`));
        nextFrame = Date.now() + interval * 1000; await save();
      }
      await new Promise(r => setTimeout(r, 250));
      status = await c.call('browser_media_audio', { ...target, action: 'status', recordingId: recording.recordingId });
    }
    const audio = await binary(await c.call('browser_media_audio', { ...target, action: 'read', recordingId: recording.recordingId }), `audio-${String(index++).padStart(4, '0')}.webm`);
    manifest.audio.push(audio); await save();
    await c.call('browser_media_audio', { ...target, action: 'discard', recordingId: recording.recordingId }); recording = null;
    if (audio.status !== 'complete' || !audio.timelineContinuous || audio.trackMuted) throw new Error(`Audio incomplete: ${audio.reason}; inspect saved evidence`);
    if (audio.mediaEnd <= cursor + 0.1) throw new Error('Playback did not advance; stopped without replay');
    cursor = audio.mediaEnd;
    console.log(JSON.stringify({ capturedThrough: cursor, requestedEnd: end, frames: manifest.frames.length, audioSegments: manifest.audio.length }));
  }
  await c.call('browser_media_control', { ...target, action: 'pause' });
  const tail = Math.max(start, end - 0.05);
  manifest.frames.push(await binary(await c.call('browser_media_frame', { ...target, time: tail }), `frame-${String(manifest.frames.length).padStart(5, '0')}.jpg`));
  const intervals = manifest.audio.filter(a => a.timelineContinuous && !a.trackMuted).map(a => [a.mediaStart, a.mediaEnd]).sort((a, b) => a[0] - b[0]);
  const gaps = []; let covered = start;
  for (const [a, b] of intervals) { if (a > covered) gaps.push([covered, Math.min(a, end)]); covered = Math.max(covered, b); }
  if (covered < end) gaps.push([covered, end]);
  manifest.audioCoverage = { intervals, gaps, maxGapSeconds: Math.max(0, ...gaps.map(([a, b]) => b - a)), status: gaps.length ? 'gaps_reported' : 'requested_interval_captured' };
} catch (error) { manifest.errors.push(error.message); process.exitCode = 1; }
finally {
  if (recording) {
    try {
      await c.call('browser_media_audio', { ...target, action: 'stop', recordingId: recording.recordingId });
      manifest.audio.push(await binary(await c.call('browser_media_audio', { ...target, action: 'read', recordingId: recording.recordingId }), 'audio-interrupted.webm'));
      await c.call('browser_media_audio', { ...target, action: 'discard', recordingId: recording.recordingId });
    } catch (error) { manifest.errors.push(`Audio cleanup: ${error.message}`); }
  }
  try { await c.call('browser_media_control', { ...target, action: 'pause' }); } catch (error) { manifest.errors.push(`Pause: ${error.message}`); }
  await save(); c.close(); console.log(JSON.stringify({ manifest: join(output, 'manifest.json'), errors: manifest.errors }));
}
