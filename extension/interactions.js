import { pageAction } from './page-action.js';
import { waitFor, waitPoint, resolveTarget, delay } from './observations.js';

// A sent action is never retried. Only target readiness and read-only verification poll.
export async function mutation(c, tabId, args, guard, run) {
  let sent = false;
  const markSent = () => { guard(); sent = true; };
  try {
    const result = await run(markSent);
    if (args.expect) {
      const verification = await waitFor(c, tabId, args.expect, args.timeoutMs ?? 5000, guard);
      const confirmed = verification.matched && result.status !== 'uncertain';
      return { ...result, status: confirmed ? 'confirmed' : 'uncertain', ...(result.verification ? { inputVerification: result.verification } : {}), verification, ...(confirmed ? {} : { note: 'Action was sent once; expected effect was not confirmed. Inspect before retrying.' }) };
    }
    return { status: 'sent', ...result };
  } catch (error) {
    if (!sent) throw error;
    return { status: 'uncertain', actionSent: true, error: error.message, note: 'Input may have taken effect. It was not replayed. Inspect before retrying.' };
  }
}

async function click(send, point, markSent, button = 'left', count = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  for (let n = 1; n <= count; n++) {
    markSent();
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: n });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: n });
  }
}

async function verifyValue(c, tabId, ref, value, guard, timeoutMs) {
  // Allow controlled components to process/reject input before reading it back.
  await delay(80); guard();
  const verification = await waitFor(c, tabId, { state: 'value', ref, value }, timeoutMs ?? 1500, guard);
  return { status: verification.matched ? 'confirmed' : 'uncertain', verification };
}

export async function interact(c, method, tabId, args, guard, keyDefinition) {
  return mutation(c, tabId, args, guard, async markSent => {
    if (['tab.click', 'tab.doubleClick', 'tab.move'].includes(method)) {
      return c.withDebugger(tabId, async send => {
        const { point, resolved } = await waitPoint(c, tabId, args, guard);
        if (method === 'tab.move') { markSent(); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }); }
        else await click(send, point, markSent, args.button || 'left', method === 'tab.doubleClick' ? 2 : 1);
        return { action: method.slice(4), ref: resolved.ref, ...point };
      }, guard);
    }
    if (method === 'tab.check') {
      return c.withDebugger(tabId, async send => {
        const resolved = await resolveTarget(c, tabId, args, guard);
        const before = await c.page(tabId, 'state', resolved);
        if (!['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(before.role) || before.checked === undefined) throw new Error('Element is not a checkable control');
        if (before.checked === args.checked) return { status: 'confirmed', checked: args.checked, changed: false };
        if (['radio', 'menuitemradio'].includes(before.role) && !args.checked) throw new Error('Select a different radio option instead of unchecking this one');
        const { point } = await waitPoint(c, tabId, resolved, guard);
        await click(send, point, markSent);
        const verification = await waitFor(c, tabId, { state: 'checked', ref: resolved.ref, checked: args.checked }, args.timeoutMs ?? 1500, guard);
        return { status: verification.matched ? 'confirmed' : 'uncertain', changed: true, verification };
      }, guard);
    }
    if (method === 'tab.select' || method === 'tab.fill' && args.mode === 'dom') {
      const resolved = await resolveTarget(c, tabId, args, guard);
      const unchanged = await c.page(tabId, 'unchanged', { ...resolved, operation: method.slice(4) });
      guard();
      if (unchanged.matches) return { status: 'confirmed', changed: false, reason: 'already_correct' };
      markSent();
      const result = await c.page(tabId, method.slice(4), resolved);
      return { ...result, ...await verifyValue(c, tabId, resolved.ref, method === 'tab.fill' ? args.text : args.value, guard, args.timeoutMs) };
    }
    if (method === 'tab.type' || method === 'tab.fill') {
      return c.withDebugger(tabId, async send => {
        let resolved = args;
        if (args.ref || args.locator) {
          if (method === 'tab.fill') {
            resolved = await resolveTarget(c, tabId, args, guard);
            const unchanged = await c.page(tabId, 'unchanged', { ...resolved, operation: 'fill' });
            guard();
            if (unchanged.matches) return { status: 'confirmed', changed: false, reason: 'already_correct' };
          }
          ({ resolved } = await waitPoint(c, tabId, args, guard));
          const info = await c.page(tabId, 'editable', resolved);
          if (info.password) throw new Error('Enter passwords directly in Chrome');
          if (!info.editable) throw new Error('Element is not an editable field');
          const point = await c.point(tabId, resolved, guard);
          await click(send, point, markSent);
        }
        guard();
        const checks = await c.api.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: pageAction, args: ['editable', {}] });
        const focused = checks.filter(r => r.result?.ok && r.result.value.focused);
        if (focused.some(r => r.result.value.password)) throw new Error('Enter passwords directly in Chrome');
        if (focused.length !== 1 || !focused[0].result.value.editable) throw new Error('Focus exactly one editable field before typing');
        const info = focused[0].result.value;
        const field = c.remember(tabId, focused[0], { ref: info.ref });
        if (resolved.ref && field.ref !== resolved.ref) throw new Error('FOCUS_CHANGED: Target lost focus; no text was inserted');
        if (method === 'tab.fill') {
          const key = keyDefinition('Ctrl+A'); markSent();
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        }
        markSent();
        if (method === 'tab.fill' && !args.text) {
          const key = keyDefinition('Backspace');
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
        } else await send('Input.insertText', { text: args.text });
        const expected = method === 'tab.fill' ? args.text : Number.isInteger(info.selectionStart) && Number.isInteger(info.selectionEnd) ? info.value.slice(0, info.selectionStart) + args.text + info.value.slice(info.selectionEnd) : undefined;
        return { [method === 'tab.fill' ? 'filled' : 'typed']: args.text.length, ...(expected === undefined ? {} : await verifyValue(c, tabId, field.ref, expected, guard, args.timeoutMs)) };
      }, guard);
    }
    if (method === 'tab.press') {
      const key = keyDefinition(args.key);
      await c.withDebugger(tabId, async send => {
        const text = key.key === 'Enter' ? '\r' : key.key.length === 1 && !(key.modifiers & 7) ? key.key : undefined;
        markSent();
        await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...key, ...(text ? { text } : {}) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      }, guard);
      return { pressed: args.key };
    }
    if (method === 'tab.drag') {
      await c.withDebugger(tabId, async send => {
        for (const p of args.points) { guard(); await c.page(tabId, 'point', p); }
        const first = args.points[0], last = args.points.at(-1);
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...first });
        markSent();
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...first, button: 'left', buttons: 1, clickCount: 1 });
        for (const point of args.points.slice(1)) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, button: 'left', buttons: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...last, button: 'left', buttons: 0, clickCount: 1 });
      }, guard);
      return { dragged: true, points: args.points.length };
    }
    if (method === 'tab.scroll') {
      if (args.x === undefined) { const resolved = await resolveTarget(c, tabId, args, guard); markSent(); return c.page(tabId, 'scroll', resolved); }
      const point = await c.point(tabId, args), amount = args.amount || 600;
      const [deltaX, deltaY] = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[args.direction];
      await c.withDebugger(tabId, send => { markSent(); return send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX, deltaY }); }, guard);
      return { scrolled: args.direction, amount };
    }
    throw new Error('Unsupported interaction');
  });
}
