// Runs in Chrome's isolated world. No refs or automation state are written to DOM attributes.
export function pageAction(action, args = {}) {
  function perform() {
    if (args._expiresAt && Date.now() >= args._expiresAt) throw new Error('Command expired before page operation');
    const key = '__codexBrowserBuddyRefsV3';
    const state = globalThis[key] ||= { token: crypto.randomUUID(), origin: performance.timeOrigin, refs: new Map(), reverse: new WeakMap(), next: 0 };
    const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const parent = el => el.parentElement || el.getRootNode()?.host;
    const ancestors = function* (el) { for (let p = el; p; p = parent(p)) yield p; };
    const visible = el => {
      if (!el?.isConnected || !el.getClientRects().length) return false;
      for (const p of ancestors(el)) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || ['hidden', 'collapse'].includes(s.visibility) || s.opacity === '0') return false;
      }
      return true;
    };
    const disabled = el => el.matches(':disabled') || [...ancestors(el)].some(p => p.inert || p.getAttribute('aria-disabled') === 'true');
    const label = el => clean([...el.labels || []].map(l => l.innerText || l.textContent).join(' '));
    function name(el) {
      const ids = el.getAttribute('aria-labelledby')?.trim().split(/\s+/);
      const labelled = ids?.map(id => el.getRootNode().getElementById?.(id)).filter(Boolean).map(n => n.getAttribute('aria-label') || n.textContent).join(' ');
      return clean(labelled || el.getAttribute('aria-label') || label(el) || el.getAttribute('alt') ||
        (['button', 'submit', 'reset'].includes(el.type) ? el.value : '') ||
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable ? '' : el.innerText || el.textContent) ||
        el.getAttribute('placeholder') || el.getAttribute('title')).slice(0, 500);
    }
    function role(el) {
      if (el.getAttribute('role')) return el.getAttribute('role').split(/\s+/)[0];
      if (el.tagName === 'INPUT') return ({ button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'button', hidden: 'none' })[el.type] || 'textbox';
      return ({ A: el.hasAttribute('href') ? 'link' : 'generic', BUTTON: 'button', TEXTAREA: 'textbox', SELECT: el.multiple || el.size > 1 ? 'listbox' : 'combobox', OPTION: 'option', SUMMARY: 'button', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' })[el.tagName] || (el.isContentEditable ? 'textbox' : 'generic');
    }
    const signature = el => JSON.stringify([el.tagName, el.id, el.getAttribute('type'), el.getAttribute('name'), el.tagName === 'A' ? el.href : el.getAttribute('href'), el.getAttribute('data-testid'), role(el), name(el)]);
    const context = el => [...ancestors(el)].slice(1, 5).map(p => [p.tagName, p.id, p.getAttribute('role'), p.getAttribute('aria-label')]);
    const strong = el => Boolean(el.id || el.getAttribute('data-testid'));
    function all(root = document) {
      const out = [];
      function scan(r) {
        for (const el of r.querySelectorAll('*')) {
          if (out.length >= 30000) return;
          out.push(el);
          if (el.shadowRoot) scan(el.shadowRoot);
        }
      }
      scan(root);
      return out;
    }
    function register(el, ax) {
      const sig = signature(el);
      let ref = state.reverse.get(el), saved = state.refs.get(ref);
      if (!saved || saved.signature !== sig || ax && saved.ax && JSON.stringify(ax) !== JSON.stringify(saved.ax)) {
        ref = state.token + ':e' + (++state.next);
        saved = { node: new WeakRef(el), signature: sig, context: JSON.stringify(context(el)), strong: strong(el), rebound: false };
        state.refs.set(ref, saved); state.reverse.set(el, ref);
        if (state.refs.size > 3000) state.refs.delete(state.refs.keys().next().value);
      }
      if (ax) saved.ax = ax;
      return ref;
    }
    function resolve(ref) {
      const saved = state.refs.get(ref);
      if (!saved) throw new Error('STALE_REF: Element ref is stale. Take a new browser_snapshot.');
      let el = saved.node.deref();
      if (el?.isConnected) {
        if (signature(el) !== saved.signature) throw new Error('STALE_REF: Element meaning changed. Take a new browser_snapshot.');
        return el;
      }
      if (!saved.strong || saved.rebound) throw new Error('STALE_REF: Element was removed. Take a new browser_snapshot.');
      const matches = all().filter(n => signature(n) === saved.signature && JSON.stringify(context(n)) === saved.context);
      if (matches.length !== 1) throw new Error('STALE_REF: Replacement is ' + (matches.length ? 'ambiguous' : 'missing') + '. Take a new browser_snapshot.');
      el = matches[0]; saved.node = new WeakRef(el); saved.rebound = true; state.reverse.set(el, ref);
      return el;
    }
    function describe(el, ref = register(el), useAX = false) {
      const saved = state.refs.get(ref), box = el.getBoundingClientRect();
      const ax = useAX ? saved?.ax : undefined;
      const item = { ref, tag: el.tagName.toLowerCase(), role: ax?.role || role(el), name: ax?.name ?? name(el), nameSource: ax ? 'chrome-ax' : 'dom', visible: visible(el), disabled: disabled(el), bounds: { x: box.x, y: box.y, width: box.width, height: box.height } };
      if (el.hasAttribute('type')) item.type = el.type;
      if (el.tagName === 'A') item.href = el.href;
      if (el.type === 'password') item.value = '[password hidden]';
      else if (el.type === 'file') item.files = [...el.files].map(f => ({ name: f.name, size: f.size }));
      else if ('value' in el) item.value = String(el.value).slice(0, 20000);
      else if (el.isContentEditable) item.value = el.textContent.slice(0, 20000);
      if (['checkbox', 'radio'].includes(el.type)) item.checked = el.indeterminate ? 'mixed' : el.checked;
      else if (el.hasAttribute('aria-checked')) item.checked = el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : el.getAttribute('aria-checked') === 'true';
      for (const attr of ['expanded', 'selected']) if (el.hasAttribute('aria-' + attr)) item[attr] = el.getAttribute('aria-' + attr) === 'true';
      if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 100).map(o => ({ value: o.value, label: o.label, selected: o.selected, disabled: o.disabled }));
      return item;
    }
    const matchesText = (actual, expected, exact) => expected === undefined || (exact !== false ? clean(actual) === clean(expected) : clean(actual).toLocaleLowerCase().includes(clean(expected).toLocaleLowerCase()));
    function matches(el, locator, ax) {
      return (!locator.css || el.matches(locator.css)) &&
        (!locator.role || (ax?.role || role(el)) === locator.role) &&
        matchesText(ax?.name ?? name(el), locator.name, locator.exact) &&
        matchesText(label(el), locator.label, locator.exact) &&
        matchesText(el.innerText || el.textContent, locator.text, locator.exact) &&
        matchesText(el.getAttribute('placeholder'), locator.placeholder, locator.exact) &&
        (!locator.testId || el.getAttribute('data-testid') === locator.testId);
    }
    function pathFor(el) {
      const path = [];
      for (let n = el; n !== document;) {
        if (n.parentNode) { path.unshift([...n.parentNode.childNodes].indexOf(n)); n = n.parentNode; }
        else if (n.host) { path.unshift('shadow'); n = n.host; }
        else throw new Error('Element belongs to a different document');
      }
      return path;
    }
    if (action === 'identity') return { token: state.token, url: location.href, origin: state.origin };
    if (action === 'viewport') return { width: innerWidth, height: innerHeight, scrollX, scrollY, dpr: devicePixelRatio };
    if (action === 'point') {
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.y < 0 || args.x >= innerWidth || args.y >= innerHeight) throw new Error('Coordinates are outside viewport; use a fresh screenshot');
      return { x: args.x, y: args.y };
    }
    if (action === 'text') return { text: (document.body?.innerText || '').slice(0, 200000), url: location.href, readyState: document.readyState };
    if (action === 'find') {
      const found = all().filter(el => (args.includeHidden || visible(el)) && matches(el, args.locator));
      return { elements: found.slice(0, 200).map(el => describe(el)), total: found.length, token: state.token, truncated: found.length > 200 };
    }
    if (action === 'registerAX') {
      if (args.token !== state.token) throw new Error('STALE_DOCUMENT: Document changed during AX lookup');
      let el = document;
      for (const step of args.path) el = step === 'shadow' ? el?.shadowRoot : el?.childNodes[step];
      if (!(el instanceof Element) || el.tagName !== args.tag || el.id !== args.id || el.getAttribute('type') !== (args.type ?? null) || name(el) !== args.domName) throw new Error('STALE_REF: AX target changed during lookup');
      if (!args.includeHidden && !visible(el) || !matches(el, args.locator || {}, args.ax)) return null;
      return describe(el, register(el, args.ax), true);
    }
    if (action === 'snapshot') {
      const nodes = all(), maxNodes = args.maxNodes || 300, maxChars = args.maxChars ?? 24000;
      const interactive = 'a[href],button,input,textarea,select,summary,[role],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
      const selected = nodes.filter(el => visible(el) && el.matches(interactive));
      const text = document.body?.innerText || '';
      return { documentToken: state.token, title: document.title, url: location.href, readyState: document.readyState,
        text: text.slice(0, maxChars), shadowText: nodes.filter(el => el.shadowRoot && visible(el)).slice(0, 20).map(el => clean(el.shadowRoot.textContent).slice(0, 2000)),
        elements: selected.slice(0, maxNodes).map(el => describe(el)), iframeCount: document.querySelectorAll('iframe').length,
        truncated: text.length > maxChars || selected.length > maxNodes || nodes.length >= 30000 };
    }
    const target = args.ref ? resolve(args.ref) : undefined;
    if (action === 'editable') {
      let el = target || document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      const focused = document.hasFocus() && el && !['IFRAME', 'FRAME'].includes(el.tagName);
      return { focused: Boolean(focused), password: el?.type === 'password', editable: Boolean(el && !disabled(el) && !el.readOnly && (el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(el.type))),
        ...(el && el.type !== 'password' ? { value: el.value ?? el.textContent, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd, ref: register(el) } : {}) };
    }
    if (action === 'state') return describe(target, args.ref);
    if (action === 'path') return { path: pathFor(target), token: state.token, tag: target.tagName, id: target.id, type: target.getAttribute('type'), ax: state.refs.get(args.ref)?.ax };
    if (target && !visible(target) && action !== 'fileInfo') throw new Error('ELEMENT_NOT_VISIBLE: Element is no longer visible');
    if (target && disabled(target)) throw new Error('ELEMENT_DISABLED: Element is disabled');
    if (action === 'ready') return { ready: true };
    if (action === 'unchanged') {
      if (args.operation === 'fill') {
        if (target.type === 'password') throw new Error('Enter passwords directly in Chrome');
        if (target.readOnly) throw new Error('Field is read-only');
        const types = args.mode === 'dom' ? ['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'time', 'datetime-local'] : ['text', 'search', 'email', 'url', 'tel', 'number'];
        if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement && types.includes(target.type)) && !target.isContentEditable) throw new Error('Element is not an editable text field');
        return { matches: (target.value ?? target.textContent) === args.text };
      }
      if (!(target instanceof HTMLSelectElement)) throw new Error('Use browser_click with a role/name locator for custom menus');
      const option = [...target.options].find(o => o.value === args.value);
      if (!option || option.disabled || option.parentElement?.disabled) throw new Error('Option is missing or disabled');
      return { matches: target.value === args.value && (!target.multiple || target.selectedOptions.length === 1) };
    }
    if (action === 'click') {
      if (args._scroll !== false) target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const box = target.getBoundingClientRect();
      const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right), topY = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
      if (right <= left || bottom <= topY) throw new Error('ELEMENT_NOT_VISIBLE: No clickable area in viewport');
      const point = { x: (left + right) / 2, y: (topY + bottom) / 2 };
      let hit = document.elementFromPoint(point.x, point.y);
      while (hit?.shadowRoot?.elementFromPoint) { const inner = hit.shadowRoot.elementFromPoint(point.x, point.y); if (!inner || inner === hit) break; hit = inner; }
      if (!hit || ![...ancestors(hit)].includes(target)) throw new Error('ELEMENT_OBSCURED: Element is covered by another element');
      return point;
    }
    if (action === 'fill') {
      if (target.type === 'password') throw new Error('Enter passwords directly in Chrome');
      if (target.readOnly) throw new Error('Field is read-only');
      if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'time', 'datetime-local'].includes(target.type)) && !target.isContentEditable) throw new Error('Element is not an editable text field');
      target.focus();
      if (target.isContentEditable) target.textContent = args.text;
      else Object.getOwnPropertyDescriptor(target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(target, args.text);
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: args.text }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    }
    if (action === 'select') {
      if (!(target instanceof HTMLSelectElement)) throw new Error('Use browser_click with a role/name locator for custom menus');
      const option = [...target.options].find(o => o.value === args.value);
      if (!option || option.disabled || option.parentElement?.disabled) throw new Error('Option is missing or disabled');
      target.value = args.value;
      target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: args.value };
    }
    if (action === 'fileInfo') {
      if (!(target instanceof HTMLInputElement) || target.type !== 'file') throw new Error('Expected an input[type=file]');
      return { ...describe(target, args.ref), multiple: target.multiple, directory: target.webkitdirectory };
    }
    if (action === 'scroll') {
      const amount = args.amount || 600, [x, y] = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[args.direction];
      (target || window).scrollBy({ left: x, top: y, behavior: 'instant' });
      return { x: target ? target.scrollLeft : scrollX, y: target ? target.scrollTop : scrollY };
    }
    throw new Error('Unsupported page operation');
  }
  try { return { ok: true, value: perform() }; }
  catch (error) { return { ok: false, error: error.message }; }
}
