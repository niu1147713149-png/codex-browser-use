import { mediaPage } from './media-page.js';

export async function cleanupMedia(c, tabId) {
  c.mediaRefs.delete(tabId);
  try { await c.api.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: mediaPage, args: ['cleanup'] }); }
  catch { /* Closed or navigated pages have already stopped their tracks. */ }
}

export async function mediaAction(c, method, tabId, args, guard) {
  guard();
  if (method === 'tab.media') {
    const results = await c.api.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: mediaPage, args: ['list'] });
    guard();
    const media = [], warnings = [];
    let refs = c.mediaRefs.get(tabId);
    if (!refs) { refs = new Map(); c.mediaRefs.set(tabId, refs); }
    for (const frame of results) {
      if (!frame.result?.ok) { warnings.push({ frameId: frame.frameId, error: frame.result?.error || 'Frame unavailable' }); continue; }
      for (const [key, value] of refs) if (value.frameId === frame.frameId && value.documentId !== frame.documentId) refs.delete(key);
      for (const item of frame.result.value.media) {
        const mediaRef = `f${frame.frameId}/${item.mediaRef}`;
        refs.set(mediaRef, { frameId: frame.frameId, documentId: frame.documentId, localRef: item.mediaRef });
        media.push({ ...item, mediaRef, frameId: frame.frameId, pageUrl: frame.result.value.url, title: frame.result.value.title });
      }
    }
    while (refs.size > 500) refs.delete(refs.keys().next().value);
    return { media, warnings, note: 'Choose an observed mediaRef explicitly. Inspect frames and audio separately; metadata is not video understanding.' };
  }
  const frame = c.mediaRefs.get(tabId)?.get(args.mediaRef);
  if (!frame) throw new Error('Unknown or stale mediaRef. Call browser_media in this session first.');
  const action = { 'tab.mediaControl': 'control', 'tab.mediaFrame': 'frame', 'tab.mediaAudio': 'audio' }[method];
  const result = await c.inject(tabId, mediaPage, [action, { ...args, mediaRef: frame.localRef }], frame);
  guard();
  return { ...result, mediaRef: args.mediaRef, frameId: frame.frameId };
}
