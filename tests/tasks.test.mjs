import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController } from '../extension/controller.js';
import { classifyAccount } from '../extension/account.js';
import { validateCommand } from '../src/tools.mjs';

function fixture() {
  const local = {}, session = {}, tabs = new Map([[1, { id: 1, url: 'https://example.com/work', status: 'complete', windowId: 1 }]]);
  const state = { clicks: 0, text: 'Waiting', account: 'alice', signedOut: false, failWrite: false };
  const area = store => ({ get: async key => ({ [key]: structuredClone(store[key]) }), set: async values => {
    if (store === local && state.failWrite) { state.failWrite = false; throw new Error('Storage unavailable'); }
    Object.assign(store, structuredClone(values));
  } });
  const api = {
    storage: { local: area(local), session: area(session) },
    tabs: { get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id); }, query: async () => [...tabs.values()] },
    scripting: { executeScript: async ({ args }) => {
      const locator = args[1].locator;
      let elements = [];
      if (locator.testId === 'signed-in' && state.account) elements = [{ ref: 'in', tag: 'button', name: 'Account', visible: true }];
      if (locator.testId === 'signed-out' && state.signedOut) elements = [{ ref: 'out', tag: 'button', name: 'Log in', visible: true }];
      if (locator.testId === 'identity' && state.account) elements = [{ ref: 'identity', tag: 'a', name: state.account, href: `https://example.com/account/${state.account}`, visible: true }];
      return [{ frameId: 0, documentId: 'doc', result: { ok: true, value: { elements, total: elements.length, token: 'doc', truncated: false } } }];
    } }
  };
  function controller() {
    const c = new BrowserController(api);
    c.page = async (_tabId, action) => {
      if (action === 'identity') return { token: 'doc', url: tabs.get(1).url };
      if (action === 'text') return { text: state.text };
      throw new Error('Unexpected page read: ' + action);
    };
    const execute = c.execute.bind(c);
    c.execute = async (method, args, context) => {
      if (method !== 'tab.click') return execute(method, args, context);
      if (state.notSent) { if (state.onNotSent) state.onNotSent(); const error = new Error(state.notSent); error.inputSent = false; throw error; }
      state.clicks++; state.text = 'Submitted once';
      if (state.afterClick) await state.afterClick(c, args);
      return { status: 'confirmed' };
    };
    return c;
  }
  const rules = { signedIn: { testId: 'signed-in' }, signedOut: { testId: 'signed-out' }, identity: { testId: 'identity' } };
  async function start(c, options = {}) {
    const s = await c.execute('session.start', { name: 'test' });
    await c.share(1, s.sessionId);
    const scope = { sessionId: s.sessionId, tabId: 1 };
    const task = await c.execute('tab.task', { ...scope, action: 'create', name: 'Order', ...options });
    return { ...scope, taskId: task.taskId };
  }
  const step = scope => ({ ...scope, stepId: 'submit', action: 'click', args: { locator: { role: 'button', name: 'Submit' }, expect: { state: 'text', text: 'Submitted once' } } });
  return { api, state, local, session, tabs, controller, start, step, rules };
}

test('Task schema refuses nested scope changes and unobservable clicks before dispatch', () => {
  const scope = { sessionId: 's', tabId: 1, taskId: 't', stepId: 'submit', action: 'click' };
  assert.throws(() => validateCommand('tab.taskStep', { ...scope, args: { locator: { text: 'Send' } } }), /expect/);
  assert.throws(() => validateCommand('tab.taskStep', { ...scope, args: { tabId: 2 } }), /override/);
  assert.throws(() => validateCommand('tab.taskStep', { ...scope, args: { locator: { text: 'Send' }, expect: { state: 'complete' } } }), /specific/);
  assert.throws(() => validateCommand('tab.task', { sessionId: 's', tabId: 1, action: 'resume', taskId: 't', requireSignedIn: false }), /does not belong/);
  assert.throws(() => validateCommand('tab.account', { sessionId: 's', tabId: 1, rules: { identity: { text: 'Author' } } }), /signedIn/);
});

test('Login evidence remains unknown when absent, conflicting or ambiguous', () => {
  assert.equal(classifyAccount({}), 'unknown');
  assert.equal(classifyAccount({ identity: { present: true } }), 'unknown');
  assert.equal(classifyAccount({ signedIn: { present: true }, signedOut: { present: true } }), 'unknown');
  assert.equal(classifyAccount({ signedIn: { present: true }, identity: { ambiguous: true } }), 'unknown');
  assert.equal(classifyAccount({ signedOut: { present: true } }), 'signed_out');
});

test('Already-satisfied task outcomes emit no click; repeated step IDs never resend input', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.state.text = 'Submitted once';
  const skipped = await c.execute('tab.taskStep', f.step(scope));
  assert.equal(skipped.skipped, true); assert.equal(f.state.clicks, 0);
  f.state.text = 'Changed later';
  const duplicate = await c.execute('tab.taskStep', f.step(scope));
  assert.equal(duplicate.deduplicated, true); assert.equal(duplicate.historical, true); assert.equal(f.state.clicks, 0);
  await assert.rejects(c.execute('tab.taskStep', { ...f.step(scope), args: { ...f.step(scope).args, locator: { role: 'button', name: 'Other' } } }), /STEP_ID_CONFLICT/);
});

test('Lost response after a real effect blocks replay and later steps until observed verification', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.state.afterClick = () => { throw new Error('Response lost'); };
  assert.equal((await c.execute('tab.taskStep', f.step(scope))).status, 'uncertain');
  assert.equal((await c.execute('tab.taskStep', f.step(scope))).status, 'uncertain');
  assert.equal(f.state.clicks, 1);
  await assert.rejects(c.execute('tab.taskStep', { ...f.step(scope), stepId: 'another-submit' }), /UNRESOLVED_STEP/);
  await assert.rejects(c.execute('tab.task', { ...scope, action: 'verify', stepId: 'submit', condition: { state: 'text', text: 'Unrelated content' } }), /RESULT_CONDITION_CHANGED/);
  assert.equal((await c.execute('tab.task', { ...scope, action: 'verify', stepId: 'submit', condition: { state: 'text', text: 'Submitted once' } })).matched, true);
  assert.equal((await c.execute('tab.task', { ...scope, action: 'finish' })).state, 'complete');
  assert.equal(f.state.clicks, 1);
});

test('Checkpoint survives complete session loss and rebinds only after explicit resume', async () => {
  const f = fixture(), original = f.controller(), scope = await f.start(original);
  await original.execute('tab.taskStep', f.step(scope));
  for (const key of Object.keys(f.session)) delete f.session[key];
  const restored = f.controller(); await restored.restore();
  const s = await restored.execute('session.start', { name: 'restored', expectedProfileId: (await original.profile()).profileId });
  await restored.share(1, s.sessionId);
  const resumedScope = { ...scope, sessionId: s.sessionId };
  await assert.rejects(restored.execute('tab.taskStep', f.step(resumedScope)), /TASK_NOT_BOUND/);
  const result = await restored.execute('tab.task', { ...resumedScope, action: 'resume' });
  assert.equal(result.steps[0].state, 'confirmed'); assert.equal(result.actionsReplayed, 0);
  assert.equal((await restored.execute('tab.taskStep', f.step(resumedScope))).deduplicated, true);
  assert.equal(f.state.clicks, 1);
});

test('Account/profile/site changes stop before input; account metadata is not confused with authors', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c, { requireSignedIn: true, accountRules: f.rules });
  const read = await c.execute('tab.account', { sessionId: scope.sessionId, tabId: 1, rules: f.rules });
  assert.equal(read.status, 'signed_in'); assert.equal(read.account.label, '/account/alice');
  f.state.account = 'bob';
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /ACCOUNT_CHANGED_OR_UNKNOWN/);
  f.state.account = null; f.state.signedOut = true;
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /LOGIN_NOT_CONFIRMED/);
  f.tabs.get(1).url = 'https://other.example/work';
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /TASK_ORIGIN_CHANGED/);
  await assert.rejects(c.execute('session.start', { name: 'wrong', expectedProfileId: 'another-profile' }), /PROFILE_MISMATCH/);
  assert.equal(f.state.clicks, 0);
  assert.equal((await c.execute('tab.account', { sessionId: scope.sessionId, tabId: 1 })).status, 'unknown');
});

test('A live task cannot be stolen by another session', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  const other = await c.execute('session.start', { name: 'other' });
  f.tabs.set(2, { ...f.tabs.get(1), id: 2 }); await c.share(2, other.sessionId);
  await assert.rejects(c.execute('tab.task', { sessionId: other.sessionId, tabId: 2, taskId: scope.taskId, action: 'resume' }), /TASK_IN_USE/);
});

test('Failure to save intent prevents input; failure after input leaves a durable unresolved step', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.state.failWrite = true;
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /Storage unavailable/);
  assert.equal(f.state.clicks, 0);
  f.state.afterClick = () => { f.state.failWrite = true; };
  assert.equal((await c.execute('tab.taskStep', f.step(scope))).status, 'uncertain');
  assert.equal(f.local.browserTasksV1[0][1].steps[0].state, 'running');
  const restored = f.controller(); await restored.restore();
  assert.equal((await restored.execute('tab.taskStep', f.step(scope))).status, 'uncertain');
  assert.equal(f.state.clicks, 1);
});

test('Checkpoint storage contains hashes and statuses, never raw action inputs/results', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  const request = f.step(scope); request.args.locator.name = 'sensitive-input-marker';
  await c.execute('tab.taskStep', request);
  const stored = JSON.stringify(f.local.browserTasksV1);
  assert.ok(!stored.includes('sensitive-input-marker'));
  assert.ok(!stored.includes('Submitted once'));
  assert.match(stored, /requestHash/);
});

test('Regular and incognito contexts cannot share a task even in a spanning extension', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.tabs.get(1).incognito = true;
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /BROWSER_CONTEXT_CHANGED/);
  assert.equal(f.state.clicks, 0);
});

test('An inactive checkpoint can be discarded after session loss without a working login', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c, { requireSignedIn: true, accountRules: f.rules });
  for (const key of Object.keys(f.session)) delete f.session[key];
  f.state.account = null;
  const restored = f.controller(); await restored.restore();
  const session = await restored.execute('session.start', { name: 'cleanup' }); await restored.share(1, session.sessionId);
  assert.equal((await restored.execute('tab.task', { ...scope, sessionId: session.sessionId, action: 'discard' })).browserChanged, false);
  assert.equal(f.local.browserTasksV1.length, 0);
});

test('A different page on the same site/account cannot silently receive resumed input', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.tabs.get(1).url = 'https://example.com/another-order';
  await assert.rejects(c.execute('tab.task', { ...scope, action: 'resume' }), /TASK_PAGE_CHANGED/);
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /TASK_PAGE_CHANGED/);
  assert.equal(f.state.clicks, 0);
});

test('A step that fails before input is not recorded and can be corrected and retried', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.state.notSent = 'ELEMENT_NOT_FOUND: No element matches the locator';
  await assert.rejects(c.execute('tab.taskStep', f.step(scope)), /STEP_NOT_SENT: ELEMENT_NOT_FOUND/);
  assert.equal(f.state.clicks, 0);
  assert.equal(f.local.browserTasksV1[0][1].steps.length, 0);
  f.state.notSent = undefined;
  assert.equal((await c.execute('tab.taskStep', f.step(scope))).status, 'confirmed');
  assert.equal(f.state.clicks, 1);
  assert.equal((await c.execute('tab.task', { ...scope, action: 'finish' })).state, 'complete');
});

test('A failed pre-input checkpoint removal retains the unresolved intent in memory and storage', async () => {
  const f = fixture(), c = f.controller(), scope = await f.start(c);
  f.state.notSent = 'ELEMENT_NOT_FOUND: Missing';
  f.state.onNotSent = () => { f.state.failWrite = true; };
  const result = await c.execute('tab.taskStep', f.step(scope));
  assert.equal(result.status, 'uncertain'); assert.match(result.note, /checkpoint removal failed/);
  assert.equal(f.state.clicks, 0); assert.equal(f.local.browserTasksV1[0][1].steps.length, 1);
  assert.equal((await c.execute('tab.taskStep', f.step(scope))).deduplicated, true);
  await assert.rejects(c.execute('tab.taskStep', { ...f.step(scope), stepId: 'new' }), /UNRESOLVED_STEP/);
  const restored = f.controller(); await restored.restore();
  assert.equal((await restored.execute('tab.taskStep', f.step(scope))).status, 'uncertain');
  assert.equal(f.state.clicks, 0);
});
