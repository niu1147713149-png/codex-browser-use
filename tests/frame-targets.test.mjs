import test from 'node:test';
import assert from 'node:assert/strict';
import { DebuggerSessions } from '../extension/debugger-session.js';

function fixture({ sameProcess = false, sameOrigin = false } = {}) {
  const calls = [];
  let manager;
  const root = { id: 'root', securityOrigin: 'https://parent.example' };
  const child = { id: 'child', parentId: 'root', securityOrigin: sameOrigin ? root.securityOrigin : 'https://child.example' };
  const context = { id: 7, uniqueId: 'document-unique', origin: 'chrome-extension://fixture', auxData: { frameId: 'child', type: 'isolated', isDefault: false } };
  const emit = (sessionId, method, params) => manager.event({ tabId: 5, ...(sessionId ? { sessionId } : {}) }, method, params);
  const api = { runtime: { id: 'fixture' }, debugger: {
    attach: async () => {}, detach: async () => {},
    sendCommand: async (target, method, params) => {
      calls.push({ target, method, params });
      const sid = target.sessionId || '';
      if (method === 'Runtime.enable') {
        if (sid || sameProcess) emit(sid, 'Runtime.executionContextCreated', { context });
        // A matching value in a page realm must never establish ownership.
        emit(sid, 'Runtime.executionContextCreated', { context: { ...context, id: 8, uniqueId: 'page-context', origin: 'https://child.example', auxData: { ...context.auxData, isDefault: true, type: 'default' } } });
        emit(sid, 'Runtime.executionContextCreated', { context: { ...context, id: 9, uniqueId: 'other-extension', origin: 'chrome-extension://other' } });
      }
      if (method === 'Target.setAutoAttach' && !sid && !sameProcess) emit('', 'Target.attachedToTarget', { sessionId: 'owned-child', targetInfo: { type: 'iframe', targetId: 'child' } });
      if (method === 'Runtime.evaluate') { assert.equal(params.uniqueContextId, 'document-unique'); return { result: { value: 'document-token' } }; }
      if (method === 'Page.getFrameTree') return { frameTree: sid ? { frame: child } : { frame: root, ...(sameProcess ? { childFrames: [{ frame: child }] } : {}) } };
      if (method === 'DOM.getFrameOwner') { assert.equal(target.sessionId, undefined); assert.equal(params.frameId, 'child'); return { backendNodeId: 13 }; }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 20 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'owner-object' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 210, y: 220, modifiers: 8 } } };
      return {};
    }
  } };
  manager = new DebuggerSessions(api);
  return { manager, calls, emit, context };
}

test('Frame input uses a related child session and never trusts page or other-extension contexts', async () => {
  const f = fixture();
  await f.manager.run(5, async send => {
    const point = await send.framePoint('document-token', { x: 10, y: 20 });
    assert.deepEqual(point.inputPoint, { x: 10, y: 20 }); assert.equal(point.x, 210); assert.equal(point.modifiers, undefined);
    assert.equal(point.route.sessionId, 'owned-child');
    f.manager.event({ tabId: 6 }, 'Target.attachedToTarget', { sessionId: 'other-tab', targetInfo: { type: 'iframe' } });
    f.manager.event({ tabId: 5, sessionId: 'unknown' }, 'Target.attachedToTarget', { sessionId: 'unowned', targetInfo: { type: 'iframe' } });
    await assert.rejects(send('Input.dispatchMouseEvent', { type: 'mousePressed' }, { ...point.route, sessionId: 'unowned' }), /FRAME_TARGET_GONE/);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point.inputPoint }, point.route);
    const inputs = f.calls.filter(c => c.method.startsWith('Input.'));
    assert.equal(inputs.length, 1); assert.deepEqual(inputs[0].target, { tabId: 5, sessionId: 'owned-child' });
    assert.ok(f.calls.every(c => c.target.tabId === 5 && !['other-tab', 'unowned'].includes(c.target.sessionId)));
    assert.ok(!f.calls.some(c => ['Target.getTargets', 'Target.attachToTarget'].includes(c.method)));
    // Evaluate failures are skipped, so check directly that untrusted realms were never queried.
    assert.ok(f.calls.filter(c => c.method === 'Runtime.evaluate').every(c => c.params.uniqueContextId === 'document-unique'));
  });
});

test('Destroyed document or detached child refuses input without fallback to the root', async () => {
  for (const event of ['Runtime.executionContextDestroyed', 'Target.detachedFromTarget']) {
    const f = fixture();
    await f.manager.run(5, async send => {
      const point = await send.framePoint('document-token', { x: 10, y: 20 });
      if (event.startsWith('Runtime')) f.emit('owned-child', event, { executionContextId: f.context.id });
      else f.emit('', event, { sessionId: 'owned-child' });
      await assert.rejects(send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point.inputPoint }, point.route), /FRAME_TARGET_GONE/);
      assert.equal(f.calls.filter(c => c.method.startsWith('Input.')).length, 0);
    });
  }
});

test('Same-process projection permits same-origin ancestors and refuses cross-origin coordinate fallback', async () => {
  for (const sameOrigin of [false, true]) {
    const f = fixture({ sameProcess: true, sameOrigin });
    await f.manager.run(5, async send => {
      if (!sameOrigin) await assert.rejects(send.framePoint('document-token', { x: 10, y: 20 }), /FRAME_ROUTING_UNAVAILABLE/);
      else {
        const point = await send.framePoint('document-token', { x: 10, y: 20 });
        assert.equal(point.route.sessionId, ''); assert.deepEqual(point.inputPoint, { x: 210, y: 220 });
      }
    });
  }
});

test('Runtime contexts observed before an iframe action remain usable when diagnostics pins the debugger', async () => {
  const f = fixture({ sameProcess: true, sameOrigin: true });
  await f.manager.run(5, async (send, entry) => { entry.pins.add('diagnostics'); await send('Runtime.enable'); });
  // Subsequent Runtime.enable is allowed to emit no existing contexts.
  const original = f.manager.api.debugger.sendCommand;
  f.manager.api.debugger.sendCommand = (target, method, params) => method === 'Runtime.enable' ? Promise.resolve({}) : original(target, method, params);
  await f.manager.run(5, async (send, entry) => {
    assert.equal((await send.framePoint('document-token', { x: 10, y: 20 })).x, 210);
    entry.pins.delete('diagnostics');
  });
});

// Explicit target topology: session id -> { tree, attach: [[sessionId, frameId]], document, fail: [methods] }.
function topology(targets, { staleRoot = false } = {}) {
  const calls = [];
  let manager;
  const emit = (sessionId, method, params) => manager.event({ tabId: 5, ...(sessionId ? { sessionId } : {}) }, method, params);
  const isolated = (id, uniqueId, frameId) => ({ id, uniqueId, origin: 'chrome-extension://fixture', auxData: { frameId, type: 'isolated', isDefault: false } });
  const api = { runtime: { id: 'fixture' }, debugger: {
    attach: async () => {}, detach: async () => {},
    sendCommand: async (target, method, params) => {
      calls.push({ target, method, params });
      const sid = target.sessionId || '', t = targets[sid];
      if (t.fail?.includes(method)) throw new Error(`${method} failed`);
      if (method === 'Runtime.enable') {
        // Destroyed while Runtime was disabled, so no destroyed event removed it.
        if (staleRoot && !sid) emit('', 'Runtime.executionContextCreated', { context: isolated(3, 'stale', 'root') });
        if (t.document) emit(sid, 'Runtime.executionContextCreated', { context: isolated(7, t.document, t.tree.frame.id) });
      }
      if (method === 'Target.setAutoAttach') for (const [sessionId, targetId] of t.attach || []) emit(sid, 'Target.attachedToTarget', { sessionId, targetInfo: { type: 'iframe', targetId } });
      if (method === 'Runtime.evaluate') {
        if (params.uniqueContextId === 'stale') throw new Error('Cannot find context with specified id');
        return { result: { value: params.uniqueContextId === 'target-doc' ? 'document-token' : 'other-token' } };
      }
      if (method === 'Page.getFrameTree') return { frameTree: t.tree };
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 13 };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 20 };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'owner-object' } };
      if (method === 'Runtime.callFunctionOn') return { result: { value: { x: 210, y: 220 } } };
      return {};
    }
  } };
  manager = new DebuggerSessions(api);
  return { manager, calls };
}
const rootFrame = { id: 'root', securityOrigin: 'https://parent.example' };
const childFrame = (parentId = 'root') => ({ id: 'child', parentId, securityOrigin: 'https://child.example' });

test('A stale extension context whose evaluate fails is skipped instead of aborting frame binding', async () => {
  const f = topology({
    '': { tree: { frame: rootFrame }, attach: [['owned-child', 'child']] },
    'owned-child': { tree: { frame: childFrame() }, document: 'target-doc' }
  }, { staleRoot: true });
  await f.manager.run(5, async send => {
    const point = await send.framePoint('document-token', { x: 10, y: 20 });
    assert.equal(point.route.sessionId, 'owned-child'); assert.equal(point.x, 210);
    assert.ok(f.calls.some(c => c.method === 'Runtime.evaluate' && c.params.uniqueContextId === 'stale'));
  });
});

test('An unrelated failing iframe target neither blocks other frames nor stays poisoned', async () => {
  const targets = {
    '': { tree: { frame: rootFrame, childFrames: [{ frame: { id: 'ad', parentId: 'root', securityOrigin: 'https://ads.example' } }] }, attach: [['ad-session', 'ad'], ['owned-child', 'child']] },
    'ad-session': { tree: { frame: { id: 'ad', parentId: 'root', securityOrigin: 'https://ads.example' } }, fail: ['Page.enable'] },
    'owned-child': { tree: { frame: childFrame() }, document: 'target-doc' }
  };
  const f = topology(targets);
  const on = (sessionId, method) => f.calls.filter(c => c.target.sessionId === sessionId && c.method === method).length;
  await f.manager.run(5, async send => {
    const point = await send.framePoint('document-token', { x: 10, y: 20 });
    assert.equal(point.route.sessionId, 'owned-child');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point.inputPoint }, point.route);
    assert.deepEqual(f.calls.find(c => c.method.startsWith('Input.')).target, { tabId: 5, sessionId: 'owned-child' });
    assert.equal(on('ad-session', 'Page.getFrameTree'), 0);
    // Once the target recovers, the next action retries setup rather than reusing the old failure.
    targets['ad-session'].fail = [];
    await send.framePoint('document-token', { x: 10, y: 20 });
    // Attach, retry during the first action, retry during this one.
    assert.equal(on('ad-session', 'Page.enable'), 3); assert.equal(on('ad-session', 'Page.getFrameTree'), 1);
  });
});

test('A skipped ancestor target stops projection instead of using its stale parent-side entry', async () => {
  const middle = { id: 'middle', parentId: 'root', securityOrigin: 'https://middle.example' };
  const f = topology({
    '': { tree: { frame: rootFrame, childFrames: [{ frame: middle }] }, attach: [['middle-session', 'middle']] },
    'middle-session': { tree: { frame: middle }, attach: [['owned-child', 'child']], fail: ['Page.getFrameTree'] },
    'owned-child': { tree: { frame: childFrame('middle') }, document: 'target-doc' }
  });
  await f.manager.run(5, async send => {
    await assert.rejects(send.framePoint('document-token', { x: 10, y: 20 }), /FRAME_TARGET_UNAVAILABLE: Parent frame/);
    assert.ok(!f.calls.some(c => c.method === 'DOM.getFrameOwner'));
  });
});
