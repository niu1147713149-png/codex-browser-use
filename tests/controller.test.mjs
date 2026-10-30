import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController, safeUrl, keyDefinition } from '../extension/controller.js';
import { interact } from '../extension/interactions.js';

export function fakeChrome() {
  const tabs = new Map([[5, { id: 5, title: 'User tab', url: 'https://example.com/private', windowId: 1, index: 0, active: true, status: 'complete', groupId: -1 }]]);
  const storage = {};
  let next = 10;
  const api = {
    tabs: {
      query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id); },
      create: async options => { const t = { ...options, id: next++, title: 'Created', windowId: 1, status: 'complete', groupId: -1 }; tabs.set(t.id, t); return t; },
      group: async ({ tabIds }) => { for (const id of tabIds) tabs.get(id).groupId = 42; return 42; },
      ungroup: async id => { tabs.get(id).groupId = -1; },
      remove: async id => { tabs.delete(id); },
      update: async (id, patch) => Object.assign(tabs.get(id), patch)
    },
    tabGroups: { update: async () => {} },
    windows: { getAll: async () => [{ id: 1, focused: true }] },
    storage: { session: { get: async key => ({ [key]: structuredClone(storage[key]) }), set: async value => Object.assign(storage, structuredClone(value)) },
      local: { get: async key => ({ [key]: structuredClone(storage[key]) }), set: async value => Object.assign(storage, structuredClone(value)) } }
  };
  return { api, tabs };
}

test('Only owned tabs are visible; cross-session access is rejected', async () => {
  const { api } = fakeChrome();
  const c = new BrowserController(api);
  const a = await c.execute('session.start', { name: 'A' });
  const b = await c.execute('session.start', { name: 'B' });
  assert.deepEqual(await c.execute('tabs.list', a), { tabs: [] });
  const opened = await c.execute('tabs.open', { sessionId: a.sessionId, url: 'https://example.com' });
  await assert.rejects(c.execute('tab.snapshot', { sessionId: b.sessionId, tabId: opened.tabId }), /not shared/);
  await assert.rejects(c.execute('tab.snapshot', { sessionId: a.sessionId, tabId: 5 }), /not shared/);
  await c.share(5, a.sessionId);
  await assert.rejects(c.share(5, b.sessionId), /另一个会话/);
  assert.equal((await c.execute('tabs.list', a)).tabs.length, 2);
});

test('Shared tabs cannot be closed and releasing/end leave tabs open', async () => {
  const { api, tabs } = fakeChrome();
  const c = new BrowserController(api);
  const a = await c.execute('session.start', { name: 'A' });
  await c.share(5, a.sessionId);
  await assert.rejects(c.execute('tab.close', { ...a, tabId: 5 }), /cannot be closed/);
  const opened = await c.execute('tabs.open', { ...a, url: 'https://example.com' });
  await c.execute('session.end', a);
  assert.ok(tabs.has(5));
  assert.ok(tabs.has(opened.tabId));
  assert.equal(tabs.get(opened.tabId).groupId, -1);
  assert.equal(c.tabs.size, 0);
});

test('Pause rejects browser actions and persists over worker restoration', async () => {
  const { api } = fakeChrome();
  const c = new BrowserController(api);
  const a = await c.execute('session.start', { name: 'A' });
  await c.share(5, a.sessionId);
  c.paused = true;
  await c.save();
  const restored = new BrowserController(api);
  await restored.restore();
  assert.equal((await restored.execute('status')).paused, true);
  await assert.rejects(restored.execute('tabs.open', { ...a, url: 'https://example.com' }), /暂停/);
  await restored.release(5);
  assert.equal(restored.tabs.size, 0);
});

test('Restricted URLs and invalid keys are rejected', () => {
  for (const url of ['file:///C:/secret', 'chrome://settings', 'javascript:alert(1)', 'https://user:pass@example.com']) assert.throws(() => safeUrl(url));
  assert.equal(safeUrl('https://example.com'), 'https://example.com/');
  assert.equal(keyDefinition('Ctrl+A').modifiers, 2);
  assert.equal(keyDefinition('Shift+Tab').windowsVirtualKeyCode, 9);
  assert.throws(() => keyDefinition('Super+X'));
});

test('Inventory is ordered and paginated; listing grants no control and claiming cannot steal ownership', async () => {
  const { api, tabs } = fakeChrome();
  tabs.set(7, { id: 7, title: 'Settings', url: 'chrome://settings', windowId: 1, index: 1 });
  const c = new BrowserController(api);
  const a = await c.execute('session.start', { name: 'A' });
  const b = await c.execute('session.start', { name: 'B' });
  await assert.rejects(c.execute('tabs.claim', { ...a, tabId: 5, reason: 'Read user-selected page' }), /List this tab/);
  const inventory = await c.execute('user.openTabs', { limit: 1 });
  assert.equal(inventory.total, 2); assert.equal(inventory.hasMore, true);
  assert.equal(inventory.tabs[0].tabId, 5); assert.equal(inventory.tabs[0].windowFocused, true);
  await assert.rejects(c.execute('tabs.get', { ...a, tabId: 5 }), /not shared/);
  await c.execute('tabs.claim', { ...a, tabId: 5, reason: 'Read requested page' });
  await assert.rejects(c.execute('tabs.claim', { ...b, tabId: 5, reason: 'Read requested page' }), /另一个会话/);
  const internal = await c.execute('user.openTabs', { offset: 1 });
  assert.equal(internal.tabs[0].controllable, false);
  await assert.rejects(c.execute('tabs.claim', { ...a, tabId: 7, reason: 'Read settings' }), /HTTP/);
  await c.execute('tab.release', { ...a, tabId: 5 });
  await assert.rejects(c.execute('tabs.get', { ...a, tabId: 5 }), /not shared/);
});

test('Finalize closes only created non-kept tabs; explicit shared close requires allowShared', async () => {
  const { api, tabs } = fakeChrome();
  const c = new BrowserController(api);
  const a = await c.execute('session.start', { name: 'A' });
  await c.share(5, a.sessionId);
  const opened = await c.execute('tabs.open', { ...a, url: 'https://example.com/a' });
  const kept = await c.execute('tabs.open', { ...a, url: 'https://example.com/b' });
  await assert.rejects(c.execute('tabs.finalize', { ...a, keepTabIds: [99] }), /belong/);
  const result = await c.execute('tabs.finalize', { ...a, keepTabIds: [kept.tabId] });
  assert.deepEqual(result.closed, [opened.tabId]);
  assert.ok(tabs.has(5) && tabs.has(kept.tabId) && !tabs.has(opened.tabId));
  const b = await c.execute('session.start', { name: 'B' });
  await c.share(5, b.sessionId);
  await c.execute('tab.close', { ...b, tabId: 5, allowShared: true });
  assert.equal(tabs.has(5), false);
});

test('Batch stops after a failure and pause or debugger cancellation revokes pending control', async () => {
  const { api } = fakeChrome();
  const c = new BrowserController(api);
  const a = await c.execute('session.start', { name: 'A' });
  await c.share(5, a.sessionId);
  const attempted = [];
  let value = '';
  c.page = async (_id, action, args) => { if (action === 'state') return { value }; if (action === 'unchanged') return { matches: value === args.text }; attempted.push(args.text); if (args.text === 'bad') throw new Error('Rejected field'); value = args.text; return { filled: true }; };
  const actions = ['one', 'bad', 'three'].map(text => ({ action: 'fill', args: { ref: 'ref', text, mode: 'dom' } }));
  const result = await c.execute('tab.batch', { ...a, tabId: 5, actions });
  assert.equal(result.ok, false); assert.equal(result.failedAt, 1); assert.equal(result.completed.length, 1);
  assert.deepEqual(attempted, ['one', 'bad']);
  await assert.rejects(c.execute('tabs.get', { ...a, tabId: 5 }, { expiresAt: Date.now() - 1 }), /expired/);
  await c.debuggerDetached({ tabId: 5 }, 'canceled_by_user');
  await assert.rejects(c.execute('tabs.get', { ...a, tabId: 5 }), /not shared/);
});

test('Iframe clicks use only frame-local coordinates and the browser-owned route', async () => {
  const { api } = fakeChrome();
  const c = new BrowserController(api);
  await c.share(5, (await c.execute('session.start', { name: 'frames' })).sessionId);
  c.refs.set(5, new Map([['f9/e1', { frameId: 9, documentId: 'child', localRef: 'e1' }]]));
  const route = { sessionId: 'child', contextId: 'doc-context', frameId: 'cdp-frame' };
  const projected = { x: 210, y: 220, inputPoint: { x: 10, y: 20 }, route, modifiers: 8, type: 'mousePressed' };
  c.page = async (_tab, action) => {
    if (action === 'path') return { token: 'isolated-token' };
    return { x: 10, y: 20 };
  };
  const sent = [];
  const send = async (method, params, target) => sent.push({ method, params, target });
  send.framePoint = async (token, point) => { assert.equal(token, 'isolated-token'); assert.deepEqual(point, { x: 10, y: 20 }); return projected; };
  c.withDebugger = async (_tab, run) => run(send);
  const result = await interact(c, 'tab.click', 5, { ref: 'f9/e1', timeoutMs: 0 }, () => {}, keyDefinition);
  assert.equal(result.status, 'sent'); assert.equal(result.x, 210); assert.equal(result.y, 220); assert.equal(result.route, undefined);
  assert.deepEqual(sent.map(e => e.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  for (const e of sent) { assert.equal(e.target, route); assert.equal(e.params.x, 10); assert.equal(e.params.y, 20); assert.equal(e.params.modifiers, undefined); assert.equal(e.params.route, undefined); }
  await assert.rejects(c.point(5, { ref: 'f9/e1' }), /FRAME_TARGET_UNAVAILABLE/);
});
