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
