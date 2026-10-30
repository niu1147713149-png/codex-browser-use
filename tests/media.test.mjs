import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { validateCommand } from '../src/tools.mjs';
import { startMcp } from '../src/mcp-server.mjs';
import { mediaAction, cleanupMedia } from '../extension/media.js';

const target = { sessionId: 'task', tabId: 5, mediaRef: 'observed-video' };
test('Media contract rejects implicit targets, unbounded audio and ambiguous lifecycle requests', () => {
  assert.throws(() => validateCommand('tab.mediaFrame', { sessionId: 'task', tabId: 5 }), /mediaRef/);
  assert.throws(() => validateCommand('tab.mediaControl', { ...target, action: 'seek' }), /time/);
  assert.throws(() => validateCommand('tab.mediaControl', { ...target, action: 'play', time: 5 }), /time/);
  assert.throws(() => validateCommand('tab.mediaAudio', { ...target, action: 'start', durationSeconds: 61 }), /range/);
  assert.throws(() => validateCommand('tab.mediaAudio', { ...target, action: 'read' }), /recordingId/);
  assert.throws(() => validateCommand('tab.mediaAudio', { ...target, action: 'start', recordingId: 'guessed' }), /creates/);
  assert.doesNotThrow(() => validateCommand('tab.mediaAudio', { ...target, action: 'start', durationSeconds: 2 }));
});

test('Audio bytes use typed MCP audio content and keep timeline metadata separate', async () => {
  const input = new PassThrough(), output = new PassThrough(), messages = [];
  output.on('data', chunk => messages.push(JSON.parse(chunk)));
  const mcp = startMcp({ input, output, command: async () => ({ data: 'YWJj', mimeType: 'audio/webm;codecs=opus', mediaStart: 2, mediaEnd: 4, timelineContinuous: true }) });
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_media_audio', arguments: { ...target, action: 'read', recordingId: 'owned' } } });
  assert.equal(messages[1].result.content[0].type, 'audio');
  assert.deepEqual(JSON.parse(messages[1].result.content[1].text), { mediaStart: 2, mediaEnd: 4, timelineContinuous: true });
  input.end(); output.end();
});

test('Media refs route to observed documents and cleanup invalidates routing before capture cleanup', async () => {
  const refs = new Map([['f7/one', { frameId: 7, documentId: 'doc-old', localRef: 'one' }]]);
  const c = { mediaRefs: new Map([[5, refs]]), api: { scripting: { executeScript: async () => {
    assert.equal(c.mediaRefs.has(5), false); return [];
  } } }, inject: async (_tab, _fn, [_action, args], frame) => {
    assert.equal(frame.documentId, 'doc-old'); assert.equal(args.mediaRef, 'one'); return { mediaTime: 3 };
  } };
  await assert.rejects(mediaAction(c, 'tab.mediaFrame', 6, { ...target, mediaRef: 'f7/one' }, () => {}), /stale/);
  assert.equal((await mediaAction(c, 'tab.mediaFrame', 5, { ...target, mediaRef: 'f7/one' }, () => {})).mediaTime, 3);
  await cleanupMedia(c, 5);
  await assert.rejects(mediaAction(c, 'tab.mediaFrame', 5, { ...target, mediaRef: 'f7/one' }, () => {}), /stale/);
});
