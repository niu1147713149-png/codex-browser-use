import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../src/tools.mjs';
import { DebuggerSessions } from '../extension/debugger-session.js';
import { mutation } from '../extension/interactions.js';
import { waitFor } from '../extension/observations.js';

const scope = { sessionId: 'test-session', tabId: 5 };
test('Semantic actions and nested conditions reject ambiguous parameter contracts before dispatch', () => {
  assert.throws(() => validateCommand('tab.click', { ...scope, ref: 'r', locator: { name: 'Save' } }), /either/);
  assert.throws(() => validateCommand('tab.click', { ...scope, locator: { frameId: 0 } }), /nonempty/);
  assert.throws(() => validateCommand('tab.wait', { ...scope, condition: { state: 'value', value: 'a' } }), /exactly one/);
  assert.throws(() => validateCommand('tab.wait', { ...scope, condition: { state: 'text' } }), /requires text/);
  assert.throws(() => validateCommand('tab.wait', { ...scope, condition: { state: 'complete' }, timeoutMs: 25000 }), /range/);
  assert.throws(() => validateCommand('tab.dialog', { ...scope, action: 'handle' }), /explicit accept/);
  assert.throws(() => validateCommand('tab.upload', { ...scope, ref: 'file', files: ['relative.txt'] }), /absolute/);
  assert.throws(() => validateCommand('tab.download', { ...scope, url: 'https://example.com/file', filename: '../overwrite' }), /relative/);
  assert.throws(() => validateCommand('tab.batch', { ...scope, actions: [{ action: 'check', args: { locator: { label: 'Agree' }, checked: true, tabId: 6 } }] }), /override/);
  assert.doesNotThrow(() => validateCommand('tab.click', { ...scope, locator: { role: 'button', name: 'Save' }, expect: { state: 'url', value: 'https://example.com/done' } }));
});

test('Nested CDP use shares ownership and explicit observation pins survive ordinary actions', async () => {
  const calls = [];
  const manager = new DebuggerSessions({ debugger: { attach: async () => calls.push('attach'), detach: async () => calls.push('detach'), sendCommand: async (_tab, method) => calls.push(method) } });
  await manager.run(5, async (_send, entry) => {
    entry.pins.add('diagnostics');
    await manager.run(5, send => send('DOM.getDocument'));
  });
  assert.equal(calls.filter(x => x === 'attach').length, 1);
  assert.equal(calls.filter(x => x === 'detach').length, 0);
  await manager.run(5, (_send, entry) => entry.pins.delete('diagnostics'));
  assert.equal(calls.filter(x => x === 'detach').length, 1);
  assert.equal(manager.entries.size, 0);
});

test('An attach conflict never detaches an unowned debugger', async () => {
  let detached = false;
  const manager = new DebuggerSessions({ debugger: { attach: async () => { throw new Error('Another debugger attached'); }, detach: async () => { detached = true; } } });
  await assert.rejects(manager.run(5, () => {}), /Another debugger/);
  assert.equal(detached, false); assert.equal(manager.entries.size, 0);
});

test('Diagnostics bound memory and omit console values, headers, URL secrets and other targets', async () => {
  const manager = new DebuggerSessions({ debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => {} } });
  await manager.run(5, (_send, e) => e.pins.add('diagnostics'));
  manager.event({ tabId: 5 }, 'Network.responseReceived', { response: { status: 403, url: 'https://user:password@example.com/fail?token=secret#apiKey', headers: { Authorization: 'SECRET' } } });
  manager.event({ tabId: 5 }, 'Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'SECRET' }] });
  manager.event({ tabId: 6 }, 'Runtime.consoleAPICalled', { type: 'error', args: [] });
  manager.event({ tabId: 5, sessionId: 'unrouted-child' }, 'Runtime.consoleAPICalled', { type: 'error', args: [] });
  const entry = manager.entries.get(5);
  assert.equal(entry.events.length, 2);
  assert.equal(entry.events[0].url, 'https://example.com/fail');
  assert.ok(!JSON.stringify(entry.events).includes('SECRET'));
  for (let i = 0; i < 150; i++) manager.event({ tabId: 5 }, 'Runtime.consoleAPICalled', { type: 'warning', args: [] });
  assert.equal(entry.events.length, 100);
  await manager.close(5);
});

test('Mutation failure after dispatch is uncertain and never replays input', async () => {
  let count = 0;
  const result = await mutation({}, 5, {}, () => {}, async sent => { sent(); count++; throw new Error('Disconnected after routing'); });
  assert.equal(count, 1); assert.equal(result.status, 'uncertain'); assert.equal(result.actionSent, true);
  await assert.rejects(mutation({}, 5, {}, () => {}, async () => { throw new Error('Target not ready'); }), /Target not ready/);
});

test('Condition waiting observes revocation instead of confirming a late read', async () => {
  let revoked = false;
  const controller = { cdp: { entries: new Map() }, page: async () => { revoked = true; return { text: 'done' }; } };
  await assert.rejects(waitFor(controller, 5, { state: 'text', text: 'done' }, 1000, () => { if (revoked) throw new Error('Control revoked'); }), /revoked/);
});

test('A fulfilled page condition cannot hide a failed input value verification', async () => {
  const controller = { cdp: { entries: new Map() }, page: async () => ({ text: 'done' }) };
  const result = await mutation(controller, 5, { expect: { state: 'text', text: 'done' } }, () => {}, async sent => {
    sent(); return { status: 'uncertain', verification: { matched: false, observed: { value: '' } } };
  });
  assert.equal(result.status, 'uncertain'); assert.equal(result.inputVerification.matched, false); assert.equal(result.verification.matched, true);
});
