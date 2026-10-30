import { pageAction } from './page-action.js';
import { axCandidates } from './accessibility.js';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function findElements(c, tabId, locator, includeHidden, guard) {
  guard();
  const target = locator.frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [locator.frameId] };
  const results = await c.api.scripting.executeScript({ target, world: 'ISOLATED', func: pageAction, args: ['find', { locator, includeHidden }] });
  guard();
  let elements = [], total = 0, truncated = false;
  const warnings = [];
  for (const r of results) {
    if (!r.result?.ok) throw new Error(r.result?.error || 'Frame lookup failed');
    total += r.result.value.total;
    truncated ||= r.result.value.truncated;
    for (const item of r.result.value.elements) elements.push(c.remember(tabId, r, item));
  }
  // Hidden/attached lookup must include nodes absent from Chrome's AX tree.
  if (!includeHidden && locator.source !== 'dom' && (locator.role || locator.name) && (!locator.frameId)) {
    const root = results.find(r => r.frameId === 0);
    if (root) {
      let ax;
      try { ax = await c.withDebugger(tabId, send => axCandidates(send, locator), guard); }
      catch (error) { guard(); warnings.push('Chrome AX unavailable; using DOM semantics: ' + error.message); }
      if (ax) {
        const mapped = [];
        for (const item of ax.elements) {
          guard();
          const registered = await c.inject(tabId, pageAction, ['registerAX', { ...item, token: root.result.value.token, locator }], root);
          if (registered) mapped.push(c.remember(tabId, root, registered));
        }
        total = total - root.result.value.total + mapped.length;
        elements = [...mapped, ...elements.filter(e => e.frameId !== 0)];
        truncated ||= ax.truncated;
      }
    }
  }
  return { elements, total, truncated, warnings, source: elements.some(e => e.nameSource === 'chrome-ax') ? 'chrome-ax+dom' : 'dom' };
}

export async function resolveTarget(c, tabId, args, guard, includeHidden = false) {
  guard();
  if (!args.locator) return args;
  const found = await findElements(c, tabId, args.locator, includeHidden, guard);
  if (found.truncated) throw new Error('AMBIGUOUS_TARGET: Search limit reached; narrow the locator');
  if (found.elements.length > 1) throw new Error(`AMBIGUOUS_TARGET: ${found.elements.length} matches; narrow locator or frameId`);
  if (!found.elements.length) throw new Error('ELEMENT_NOT_FOUND: No matching element');
  const { locator, ...rest } = args;
  return { ...rest, ref: found.elements[0].ref };
}

export async function waitPoint(c, tabId, args, guard) {
  const deadline = Date.now() + (args.timeoutMs ?? 5000);
  for (;;) {
    guard();
    try {
      const resolved = await resolveTarget(c, tabId, args, guard);
      const first = await c.point(tabId, resolved, guard);
      if (!resolved.ref) return { resolved, point: first };
      await delay(60); guard();
      const point = await c.point(tabId, resolved, guard);
      if (Math.abs(first.x - point.x) > 1 || Math.abs(first.y - point.y) > 1) throw new Error('ELEMENT_MOVING: Target is still moving');
      return { resolved, point };
    } catch (error) {
      guard();
      if (!/^ELEMENT_(NOT_FOUND|NOT_VISIBLE|DISABLED|OBSCURED|MOVING):/.test(error.message) || Date.now() >= deadline) throw error;
      await delay(Math.min(120, Math.max(0, deadline - Date.now())));
    }
  }
}

export async function waitFor(c, tabId, condition, timeoutMs = 5000, guard = () => {}) {
  const start = Date.now(), deadline = start + timeoutMs;
  let observed;
  for (;;) {
    guard();
    let matched = false;
    if (c.cdp.entries.get(tabId)?.pendingDialog) return { matched: false, elapsedMs: Date.now() - start, observed: { dialogPending: true } };
    try {
      const state = condition.state;
      if (state === 'complete' || state === 'url') {
        const tab = await c.api.tabs.get(tabId);
        observed = state === 'url' ? { url: tab.url } : { loading: tab.status !== 'complete' };
        matched = state === 'complete' ? !observed.loading : condition.exact !== false ? tab.url === condition.value : tab.url.includes(condition.value);
      } else if (state === 'text' || state === 'text_gone') {
        const page = await c.page(tabId, 'text');
        const present = condition.exact ? page.text.trim() === condition.text.trim() : page.text.includes(condition.text);
        observed = { textPresent: present }; matched = state === 'text' ? present : !present;
      } else {
        let target;
        if (condition.locator) {
          const found = await findElements(c, tabId, condition.locator, ['hidden', 'attached', 'detached'].includes(state), guard);
          if (found.truncated || found.elements.length > 1) throw new Error('AMBIGUOUS_TARGET: Condition has multiple matching elements');
          target = found.elements[0];
        } else target = await c.page(tabId, 'state', { ref: condition.ref });
        observed = target ? { count: 1, visible: target.visible, disabled: target.disabled, value: target.value, checked: target.checked } : { count: 0 };
        matched = ({ attached: () => !!target, detached: () => !target, visible: () => !!target?.visible,
          hidden: () => !target?.visible, enabled: () => !!target?.visible && !target.disabled,
          disabled: () => !!target && target.disabled, value: () => !!target && target.value === condition.value,
          checked: () => !!target && target.checked === condition.checked })[state]();
      }
    } catch (error) {
      guard();
      if (/AMBIGUOUS|STALE_REF|Invalid selector|not a valid selector/.test(error.message)) throw error;
      observed = { error: error.message };
    }
    guard();
    if (matched || Date.now() >= deadline) return { matched, elapsedMs: Date.now() - start, observed };
    await delay(Math.min(150, deadline - Date.now()));
  }
}
