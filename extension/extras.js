import { resolveTarget, delay } from './observations.js';
import { topElementObject } from './accessibility.js';
import { mutation } from './interactions.js';
import { safeDiagnosticUrl } from './debugger-session.js';

export async function extraAction(c, method, tabId, args, guard, safeUrl) {
  if (method === 'tab.upload') return mutation(c, tabId, args, guard, async markSent => {
    const resolved = await resolveTarget(c, tabId, args, guard, true);
    if (c.frameRef(tabId, resolved.ref).frameId !== 0) throw new Error('File selection currently supports the top document and its open shadow roots; iframe uploads are not supported');
    const before = await c.page(tabId, 'fileInfo', resolved);
    if (before.directory) throw new Error('Directory upload is not supported');
    if (!before.multiple && args.files.length > 1) throw new Error('This input does not accept multiple files');
    const info = await c.page(tabId, 'path', resolved);
    await c.withDebugger(tabId, async send => {
      const objectId = await topElementObject(send, info);
      try {
        const now = await c.page(tabId, 'path', resolved);
        if (now.token !== info.token || JSON.stringify(now.path) !== JSON.stringify(info.path)) throw new Error('STALE_REF: File input moved');
        markSent();
        await send('DOM.setFileInputFiles', { objectId, files: args.files });
      } finally { await send('Runtime.releaseObjectGroup', { objectGroup: 'buddy-upload' }).catch(() => {}); }
    }, guard);
    await delay(80); guard();
    const after = await c.page(tabId, 'fileInfo', resolved);
    const expected = args.files.map(p => p.split(/[\\/]/).at(-1));
    const selected = after.files?.length === expected.length && after.files.every((f, i) => f.name === expected[i]);
    return { status: selected ? 'confirmed' : 'uncertain', stage: 'files_selected', files: after.files, serverReceiptConfirmed: false, note: 'File selection only. Check the page for upload/server receipt confirmation.' };
  });
  if (method === 'tab.download') return mutation(c, tabId, args, guard, async markSent => {
    const url = safeUrl(args.url); guard(); markSent();
    const id = await c.api.downloads.download({ url, ...(args.filename ? { filename: args.filename } : {}), conflictAction: 'uniquify', saveAs: false });
    c.downloads.set(id, { sessionId: args.sessionId, tabId });
    await c.save();
    return { downloadId: id, stage: 'started' };
  });
  if (method === 'tab.downloads') {
    const owned = [...c.downloads].filter(([, owner]) => owner.sessionId === args.sessionId && owner.tabId === tabId);
    if (args.downloadId !== undefined && !owned.some(([id]) => id === args.downloadId)) throw new Error('Download does not belong to this session/tab');
    const downloads = [];
    for (const [id] of owned) {
      if (args.downloadId !== undefined && args.downloadId !== id) continue;
      guard();
      const [item] = await c.api.downloads.search({ id });
      downloads.push(item ? { id, state: item.state, filename: item.filename, bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, error: item.error, danger: item.danger, exists: item.exists, url: safeDiagnosticUrl(item.url) } : { id, state: 'unavailable' });
    }
    return { downloads, scope: 'Downloads started with browser_download on this session/tab only.' };
  }
  if (method === 'tab.dialog') {
    if (args.action === 'status') return { armed: Boolean(c.cdp.entries.get(tabId)?.pins.has('dialogWatch')), dialog: c.cdp.entries.get(tabId)?.pendingDialog || null };
    if (args.action === 'arm') return c.withDebugger(tabId, (_send, e) => { e.pins.add('dialogWatch'); return { armed: true, dialog: e.pendingDialog }; }, guard);
    const e = c.cdp.entries.get(tabId);
    if (args.action === 'disarm') {
      if (e?.pendingDialog) throw new Error('Handle the pending dialog before disarming');
      e?.pins.delete('dialogWatch');
      if (e && !e.users && !e.pins.size) await c.cdp.close(tabId);
      return { armed: false };
    }
    if (!e?.pendingDialog) throw new Error('No observed JavaScript dialog on this tab. Arm observation before the triggering action.');
    return mutation(c, tabId, args, guard, async markSent => {
      await c.withDebugger(tabId, async send => { markSent(); await send('Page.handleJavaScriptDialog', { accept: args.accept, ...(args.promptText !== undefined ? { promptText: args.promptText } : {}) }); }, guard);
      return { status: 'confirmed', handled: true, accepted: args.accept };
    });
  }
  if (method === 'tab.diagnostics') {
    const existing = c.cdp.entries.get(tabId);
    if (args.action === 'start') return c.withDebugger(tabId, async (send, e) => {
      await send('Runtime.enable'); await send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
      e.pins.add('diagnostics');
      return { collecting: true, limit: 100, note: 'Console values, request/response bodies, headers and URL queries are omitted.' };
    }, guard);
    if (args.action === 'clear') { if (existing) existing.events = []; return { cleared: true }; }
    const result = { collecting: Boolean(existing?.pins.has('diagnostics')), events: [...existing?.events || []] };
    if (args.action === 'stop' && existing) {
      await c.withDebugger(tabId, async (send, e) => { await send('Network.disable'); await send('Runtime.disable'); e.pins.delete('diagnostics'); e.requests.clear(); }, guard);
      result.collecting = false;
    }
    return result;
  }
  throw new Error('Unsupported extra operation');
}
