import { fingerprint, readAccount } from './account.js';
import { waitFor } from './observations.js';

export const taskMethods = Object.freeze({ click: 'tab.click', double_click: 'tab.doubleClick', fill: 'tab.fill', select: 'tab.select', check: 'tab.check', type: 'tab.type', press: 'tab.press', navigate: 'tab.navigate', wait: 'tab.wait' });
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
const now = () => new Date().toISOString();

export function stepCondition(action, args) {
  if (args.expect) return args.expect;
  if (action === 'wait') return args.condition;
  if (['fill', 'select'].includes(action)) return { state: 'value', ...(args.ref ? { ref: args.ref } : { locator: args.locator }), value: action === 'fill' ? args.text : args.value };
  if (action === 'check') return { state: 'checked', ...(args.ref ? { ref: args.ref } : { locator: args.locator }), checked: args.checked };
  if (action === 'navigate' && args.action === 'goto') return { state: 'url', value: new URL(args.url).href };
  return undefined;
}

// Persist intent before dispatch, but never persist form text, credentials, raw
// page results, or replayable actions. Recovery observes; it never replays input.
export class TaskJournal {
  constructor(controller) { this.c = controller; this.records = null; }
  async load() {
    if (!this.records) {
      await this.c.profile();
      const stored = (await this.c.api.storage.local.get('browserTasksV1')).browserTasksV1;
      this.records = new Map(stored || []);
    }
    return this.records;
  }
  async save() { await this.c.api.storage.local.set({ browserTasksV1: [...this.records] }); }
  async get(id) {
    const task = (await this.load()).get(id);
    if (!task) throw new Error('UNKNOWN_TASK: Use the taskId returned for this task');
    return task;
  }
  view(task) {
    return { taskId: task.id, name: task.name, profileId: task.profileId, incognito: task.incognito, origin: task.origin, state: task.state,
      tabId: task.tabId, accountBinding: task.accountFingerprint ? 'account_identity' : task.requireSignedIn ? 'login_status_only' : 'profile_and_origin',
      createdAt: task.createdAt, updatedAt: task.updatedAt,
      steps: task.steps.map(({ id, action, state, startedAt, finishedAt, skipped, verifiedBy }) => ({ stepId: id, action, state: state === 'running' ? 'uncertain' : state, startedAt, finishedAt, skipped, verifiedBy })),
      note: 'Saved states describe past observations, not a fresh guarantee of page state. Resume never sends input. Keep this taskId in this conversation.' };
  }
  async checkContext(task, args, guard, allowRebind = false) {
    const profile = await this.c.profile();
    if (task.profileId !== profile.profileId) throw new Error('PROFILE_MISMATCH: Use the original Chrome profile');
    if (!allowRebind && (task.ownerSessionId !== args.sessionId || task.tabId !== args.tabId)) throw new Error('TASK_NOT_BOUND: Explicitly resume on this owned tab first');
    const page = await this.c.page(args.tabId, 'identity');
    if (new URL(page.url).origin !== task.origin) throw new Error('TASK_ORIGIN_CHANGED: Return to the original site and inspect the page');
    const pageHash = await fingerprint(page.url);
    const pending = task.steps.find(s => s.state !== 'confirmed');
    if (task.pageHash !== pageHash && pending?.expectedPageHash !== pageHash) throw new Error('TASK_PAGE_CHANGED: Return to the last task page before continuing');
    const account = await readAccount(this.c, args.tabId, task.accountRules, guard);
    if (account.origin !== task.origin) throw new Error('TASK_ORIGIN_CHANGED: Page changed during account verification');
    if (Boolean(task.incognito) !== account.incognito) throw new Error('BROWSER_CONTEXT_CHANGED: Use the original regular/incognito window context');
    if (task.requireSignedIn && account.status !== 'signed_in') throw new Error('LOGIN_NOT_CONFIRMED: Inspect the account control or log in in Chrome');
    if (task.accountFingerprint && account.account?.fingerprint !== task.accountFingerprint) throw new Error('ACCOUNT_CHANGED_OR_UNKNOWN: Restore the original account before continuing');
    guard();
    return account;
  }
  async manage(args, guard) {
    if (args.action === 'create') {
      const records = await this.load();
      if (records.size >= 30) throw new Error('TASK_LIMIT: Discard finished checkpoints before starting more');
      const profile = await this.c.profile();
      const account = await readAccount(this.c, args.tabId, args.accountRules, guard);
      if (args.requireSignedIn && account.status !== 'signed_in') throw new Error('LOGIN_NOT_CONFIRMED: Inspect the account controls first');
      const task = { id: crypto.randomUUID(), name: args.name, profileId: profile.profileId, origin: account.origin, ownerSessionId: args.sessionId, tabId: args.tabId,
        incognito: account.incognito, requireSignedIn: Boolean(args.requireSignedIn), accountFingerprint: account.account?.fingerprint || null, accountRules: args.accountRules,
        state: 'active', createdAt: now(), updatedAt: now(), steps: [] };
      const page = await this.c.page(args.tabId, 'identity');
      if (new URL(page.url).origin !== task.origin) throw new Error('TASK_ORIGIN_CHANGED');
      task.pageHash = await fingerprint(page.url);
      guard(); records.set(task.id, task); await this.save();
      return { ...this.view(task), account };
    }
    const task = await this.get(args.taskId);
    if (args.action === 'discard') {
      if (task.ownerSessionId !== args.sessionId && this.c.sessions.has(task.ownerSessionId) && this.c.tabs.get(task.tabId)?.sessionId === task.ownerSessionId) throw new Error('TASK_IN_USE: Cannot discard another active session\'s checkpoint');
      if ((await this.c.profile()).profileId !== task.profileId) throw new Error('PROFILE_MISMATCH');
      guard(); this.records.delete(task.id); await this.save(); return { discarded: task.id, browserChanged: false };
    }
    if (args.action === 'resume') {
      if (task.ownerSessionId !== args.sessionId && this.c.sessions.has(task.ownerSessionId) && this.c.tabs.get(task.tabId)?.sessionId === task.ownerSessionId) throw new Error('TASK_IN_USE: Release the original task tab before resuming elsewhere');
      const account = await this.checkContext(task, args, guard, true);
      task.ownerSessionId = args.sessionId; task.tabId = args.tabId;
      for (const step of task.steps) if (step.state === 'running') step.state = 'uncertain';
      task.updatedAt = now(); await this.save();
      return { ...this.view(task), account, resumed: true, actionsReplayed: 0 };
    }
    if (task.ownerSessionId !== args.sessionId || task.tabId !== args.tabId) throw new Error('TASK_NOT_BOUND: Explicitly resume first');
    if (args.action === 'status') return this.view(task);
    await this.checkContext(task, args, guard);
    if (args.action === 'verify') {
      const step = task.steps.find(s => s.id === args.stepId);
      if (!step) throw new Error('UNKNOWN_STEP');
      if (step.conditionHash !== await fingerprint(canonical(args.condition))) throw new Error('RESULT_CONDITION_CHANGED: Verify the original expected result');
      const verification = await waitFor(this.c, args.tabId, args.condition, args.timeoutMs ?? 3000, guard);
      guard();
      if (verification.matched) { await this.checkContext(task, args, guard); task.pageHash = await fingerprint((await this.c.page(args.tabId, 'identity')).url); step.state = 'confirmed'; step.verifiedBy = 'recovery_observation'; step.finishedAt = now(); task.updatedAt = now(); await this.save(); }
      return { ...this.view(task), matched: verification.matched, actionsReplayed: 0 };
    }
    if (args.action === 'finish') {
      if (task.steps.some(s => s.state !== 'confirmed')) throw new Error('UNRESOLVED_STEP: Verify uncertain results before finishing');
      task.state = 'complete'; task.updatedAt = now(); await this.save(); return this.view(task);
    }
    throw new Error('Invalid task action');
  }
  async step(args, context, guard) {
    const task = await this.get(args.taskId);
    await this.checkContext(task, args, guard);
    const hash = await fingerprint(canonical({ action: args.action, args: args.args }));
    const previous = task.steps.find(s => s.id === args.stepId);
    if (previous) {
      if (previous.requestHash !== hash) throw new Error('STEP_ID_CONFLICT: This stepId already describes a different operation');
      return { status: previous.state === 'confirmed' ? 'confirmed' : 'uncertain', deduplicated: true, historical: true, actionsReplayed: 0,
        step: this.view(task).steps.find(s => s.stepId === args.stepId), note: 'No input was sent. Use browser_task verify to check an uncertain result.' };
    }
    if (task.state !== 'active') throw new Error('TASK_COMPLETE: Create a new task for new work');
    if (task.steps.some(s => s.state !== 'confirmed')) throw new Error('UNRESOLVED_STEP: Inspect and verify the previous result before another step');
    if (task.steps.length >= 100) throw new Error('STEP_LIMIT: Finish this task and start a new one');
    const command = taskMethods[args.action], condition = stepCondition(args.action, args.args);
    if (!command || !condition || condition.state === 'complete') throw new Error('TASK_REQUIRES_RESULT: Supply a meaningful expect condition');
    if (args.action === 'navigate' && args.args.action === 'goto' && new URL(args.args.url).origin !== task.origin) throw new Error('TASK_ORIGIN_CHANGED: Task navigation is limited to its original site');
    const before = await waitFor(this.c, args.tabId, condition, 0, guard);
    guard();
    const step = { id: args.stepId, requestHash: hash, conditionHash: await fingerprint(canonical(condition)), action: args.action, state: before.matched ? 'confirmed' : 'running', startedAt: now(), skipped: before.matched };
    if (condition.state === 'url' && condition.exact !== false) step.expectedPageHash = await fingerprint(new URL(condition.value).href);
    if (before.matched) { step.finishedAt = now(); step.verifiedBy = 'already_satisfied'; }
    task.steps.push(step); task.updatedAt = now();
    try { await this.save(); } catch (error) { task.steps.pop(); throw error; }
    if (before.matched) return { status: 'confirmed', changed: false, skipped: true, reason: 'desired_result_already_present', taskId: task.id, stepId: step.id };
    let result, dispatching = false;
    try {
      // Recheck after durable intent is written, immediately before dispatch.
      await this.checkContext(task, args, guard);
      dispatching = true;
      result = await this.c.execute(command, { ...args.args, sessionId: args.sessionId, tabId: args.tabId }, context);
      const verification = await waitFor(this.c, args.tabId, condition, args.args.timeoutMs ?? 3000, guard);
      guard();
      const account = await readAccount(this.c, args.tabId, task.accountRules, guard);
      const sameAccount = (!task.requireSignedIn || account.status === 'signed_in') && (!task.accountFingerprint || account.account?.fingerprint === task.accountFingerprint);
      step.state = result.status !== 'uncertain' && verification.matched && sameAccount && account.origin === task.origin ? 'confirmed' : 'uncertain';
      step.verifiedBy = step.state === 'confirmed' ? 'postcondition' : undefined;
    } catch (error) {
      // Only drop the intent before input or any effectful preparation.
      if (!dispatching || args.action === 'wait' || error?.inputSent === false) {
        const index = task.steps.indexOf(step);
        task.steps.splice(index, 1); task.updatedAt = now();
        try { await this.save(); }
        catch {
          // Keep memory consistent with the durable running intent. A failed
          // removal must not permit a new step or advertise a safe retry.
          step.state = 'uncertain'; task.steps.splice(index, 0, step);
          return { status: 'uncertain', taskId: task.id, stepId: step.id, note: 'No page input was sent, but checkpoint removal failed. The unresolved intent was retained; inspect before recovery.' };
        }
        throw new Error(`STEP_NOT_SENT: ${error?.message || 'Step failed'}. No input or page preparation was sent and the checkpoint was removed; correct the request and retry.`);
      }
      // Even if the response was lost after a click, the durable intent survives.
      step.state = 'uncertain';
    }
    try {
      guard();
      const page = await this.c.page(args.tabId, 'identity');
      if (new URL(page.url).origin === task.origin) task.pageHash = await fingerprint(page.url);
    } catch { /* Keep the last known page and, if present, the explicit expected URL hash. */ }
    step.finishedAt = now(); task.updatedAt = now();
    try { await this.save(); } catch { step.state = 'uncertain'; return { status: 'uncertain', taskId: task.id, stepId: step.id, note: 'Checkpoint update failed after intent was saved. Inspect the page; do not repeat input.' }; }
    return { status: step.state, taskId: task.id, stepId: step.id, ...(result ? { result } : {}),
      ...(step.state === 'uncertain' ? { note: 'The result could not be confirmed. Use browser_task verify after inspecting the page; this step will not replay.' } : {}) };
  }
}
