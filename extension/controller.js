import { pageAction } from './page-action.js';
import { installFrameBridge, projectFramePoint } from './frame-bridge.js';
import { VERSION } from './version.js';
import { DebuggerSessions } from './debugger-session.js';
import { findElements, waitFor } from './observations.js';
import { interact } from './interactions.js';
import { extraAction } from './extras.js';
import { verifyAX } from './accessibility.js';
import { mediaAction, cleanupMedia } from './media.js';
import { readAccount } from './account.js';
import { TaskJournal } from './tasks.js';

const batchMethods = { click: 'tab.click', double_click: 'tab.doubleClick', move: 'tab.move', drag: 'tab.drag', fill: 'tab.fill', select: 'tab.select', check: 'tab.check', type: 'tab.type', press: 'tab.press', scroll: 'tab.scroll', wait: 'tab.wait' };
const sortTabs = (a, b) => a.windowId - b.windowId || a.index - b.index;
const unwrap = result => {
  if (result?.error) throw new Error(result.error.message || 'Page operation failed');
  if (!result?.result?.ok) throw new Error(result?.result?.error || 'Page returned no result; it may have navigated. Inspect before retrying.');
  return result.result.value;
};

export function safeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('A valid HTTP(S) URL is required'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Only HTTP(S) URLs without embedded credentials are allowed');
  return parsed.href;
}

export function keyDefinition(key) {
  const parts = key.split('+');
  const main = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const flag = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Shift: 8 }[part];
    if (!flag) throw new Error('Unsupported key modifier');
    modifiers |= flag;
  }
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };
  if (!(main in codes) && !/^[a-zA-Z0-9]$/.test(main)) throw new Error('Unsupported key');
  const keyValue = main === 'Space' ? ' ' : main;
  return { key: keyValue, code: main.length === 1 ? (/\d/.test(main) ? `Digit${main}` : `Key${main.toUpperCase()}`) : main,
    windowsVirtualKeyCode: codes[main] ?? main.toUpperCase().charCodeAt(0), modifiers };
}

export class BrowserController {
  constructor(api) {
    this.api = api;
    this.sessions = new Map();
    this.tabs = new Map();
    this.observed = new Map();
    this.refs = new Map();
    this.mediaRefs = new Map();
    this.cdp = new DebuggerSessions(api);
    this.detaching = this.cdp.detaching;
    this.downloads = new Map();
    this.paused = false;
    this.queue = Promise.resolve();
    this.profileState = null;
    this.tasks = new TaskJournal(this);
  }
  async profile() {
    if (!this.profileState) {
      const local = this.api.storage.local;
      await local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
      const stored = (await local.get('browserProfileV1')).browserProfileV1;
      const profile = stored || { profileId: crypto.randomUUID(), createdAt: new Date().toISOString() };
      if (!stored) await local.set({ browserProfileV1: profile });
      this.profileState = profile;
    }
    return { ...this.profileState, incognito: Boolean(this.api.extension?.inIncognitoContext),
      note: 'Stable identifier for this extension installation in this Chrome profile; not the Chrome profile name or Google account. Website cookies remain in Chrome.' };
  }
  async restore() {
    const saved = (await this.api.storage.session.get('buddyState')).buddyState;
    if (!saved) return;
    this.paused = Boolean(saved.paused);
    this.sessions = new Map(saved.sessions || []);
    this.downloads = new Map(saved.downloads || []);
    for (const [id, owned] of saved.tabs || []) {
      try {
        const tab = await this.api.tabs.get(id);
        safeUrl(tab.url);
        if (this.sessions.has(owned.sessionId)) this.tabs.set(id, owned);
      } catch { /* Closed or restricted tab. */ }
    }
  }
  async save() {
    await this.api.storage.session.set({ buddyState: { paused: this.paused, sessions: [...this.sessions], tabs: [...this.tabs], downloads: [...this.downloads] } });
  }
  enqueue(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  getSession(id) {
    const value = this.sessions.get(id);
    if (!value) throw new Error('Unknown session. Start a new browser session.');
    return value;
  }
  assertActive(sessionId, tabId, context = {}) {
    if (this.paused) throw new Error('Codex Browser Use 已暂停。请在 Chrome 扩展弹窗中恢复。');
    if (context.expiresAt && Date.now() >= context.expiresAt) throw new Error('Command expired. Inspect the page before retrying.');
    if (sessionId) this.getSession(sessionId);
    if (tabId && this.tabs.get(tabId)?.sessionId !== sessionId) throw new Error('Tab is not shared with this session. Use browser_user_tabs then browser_claim for the requested page.');
  }
  async getOwned(sessionId, tabId, context) {
    this.assertActive(sessionId, tabId, context);
    const tab = await this.api.tabs.get(tabId);
    safeUrl(tab.url);
    this.assertActive(sessionId, tabId, context);
    return { tab, ownership: this.tabs.get(tabId) };
  }
  metadata(tab, ownership = this.tabs.get(tab.id)) {
    let controllable = true;
    try { safeUrl(tab.url); } catch { controllable = false; }
    return { tabId: tab.id, windowId: tab.windowId, index: tab.index, title: tab.title || '未命名标签页', url: tab.url || '',
      active: Boolean(tab.active), pinned: Boolean(tab.pinned), discarded: Boolean(tab.discarded), incognito: Boolean(tab.incognito), status: tab.status,
      controlled: Boolean(ownership), kind: ownership?.kind, controllable };
  }
  async publicTab(id, ownership) {
    return this.metadata(await this.api.tabs.get(id), ownership);
  }
  async userTabs(args) {
    const all = (await this.api.tabs.query({})).sort(sortTabs);
    const focused = (await this.api.windows.getAll()).find(w => w.focused)?.id;
    const query = args.query?.toLocaleLowerCase();
    const matching = all.filter(t => (!args.windowId || t.windowId === args.windowId) && (!query || `${t.title}\n${t.url}`.toLocaleLowerCase().includes(query)));
    const offset = args.offset || 0, selected = matching.slice(offset, offset + (args.limit || 200));
    for (const tab of selected) this.observed.set(tab.id, Date.now());
    for (const [id, time] of this.observed) if (Date.now() - time > 600000 || !all.some(t => t.id === id)) this.observed.delete(id);
    return { total: matching.length, offset, hasMore: offset + selected.length < matching.length, tabs: selected.map(t => ({ ...this.metadata(t), windowFocused: t.windowId === focused })) };
  }
  async listTabs(sessionId) {
    this.getSession(sessionId);
    const result = [];
    for (const [id, ownership] of this.tabs) if (ownership.sessionId === sessionId) {
      try { result.push(await this.publicTab(id, ownership)); } catch { this.tabs.delete(id); }
    }
    return result.sort(sortTabs);
  }
  async popupState() {
    const sessions = [];
    for (const session of this.sessions.values()) sessions.push({ ...session, tabs: await this.listTabs(session.id) });
    return { paused: this.paused, sessions, version: VERSION, profile: await this.profile() };
  }
  async share(tabId, sessionId, context) {
    this.assertActive(sessionId, undefined, context);
    const tab = await this.api.tabs.get(tabId);
    safeUrl(tab.url);
    this.assertActive(sessionId, undefined, context);
    const previous = this.tabs.get(tabId);
    if (previous && previous.sessionId !== sessionId) throw new Error('该标签页已由另一个会话控制，请先释放');
    if (!previous) this.tabs.set(tabId, { sessionId, kind: 'shared' });
    await this.save();
    return { shared: tabId, ...(await this.publicTab(tabId)) };
  }
  async release(tabId) {
    const ownership = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    this.refs.delete(tabId);
    await cleanupMedia(this, tabId);
    await this.cdp.close(tabId);
    for (const [id, owner] of this.downloads) if (owner.tabId === tabId) this.downloads.delete(id);
    if (ownership?.groupId !== undefined) {
      try {
        const tab = await this.api.tabs.get(tabId);
        if (tab.groupId === ownership.groupId) await this.api.tabs.ungroup(tabId);
      } catch { /* Already closed. */ }
    }
    await this.save();
    return { released: tabId };
  }
  async debuggerDetached(source, reason) {
    this.cdp.detached(source.tabId);
    if (reason === 'canceled_by_user' && !this.detaching.has(source.tabId)) await this.release(source.tabId);
  }
  async inject(tabId, func, args, frame) {
    const target = frame?.documentId ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [frame?.frameId || 0] };
    const results = await this.api.scripting.executeScript({ target, world: 'ISOLATED', func, args });
    return unwrap(results[0]);
  }
  frameRef(tabId, ref) {
    if (!ref) return undefined;
    const frame = this.refs.get(tabId)?.get(ref);
    if (!frame) throw new Error('Element ref is stale. Take a new browser_snapshot.');
    return frame;
  }
  async page(tabId, action, args = {}) {
    const frame = this.frameRef(tabId, args.ref);
    return this.inject(tabId, pageAction, [action, { ...args, ...(frame ? { ref: frame.localRef } : {}) }], frame);
  }
  remember(tabId, frame, item) {
    let refs = this.refs.get(tabId);
    if (!refs) { refs = new Map(); this.refs.set(tabId, refs); }
    for (const [key, old] of refs) if (old.frameId === frame.frameId && old.documentId !== frame.documentId) refs.delete(key);
    const ref = `f${frame.frameId}/${item.ref}`;
    refs.set(ref, { frameId: frame.frameId, documentId: frame.documentId, localRef: item.ref });
    if (refs.size > 6000) refs.delete(refs.keys().next().value);
    return { ...item, ref, frameId: frame.frameId };
  }
  async snapshot(tabId, args = {}) {
    const maxChars = args.maxChars ?? 24000, maxNodes = args.maxNodes ?? 300;
    const results = await this.api.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: pageAction, args: ['snapshot', { maxChars, maxNodes }] });
    const frames = [], elements = [], text = [], warnings = [];
    let root;
    for (const result of results.sort((a, b) => a.frameId - b.frameId)) {
      if (!result.result?.ok) { warnings.push({ frameId: result.frameId, error: result.result?.error || result.error?.message || 'Frame unavailable' }); continue; }
      const value = result.result.value;
      if (!result.frameId) root = value;
      if (frames.length >= 50) { warnings.push({ frameId: result.frameId, error: 'Snapshot frame limit reached' }); continue; }
      frames.push({ frameId: result.frameId, documentToken: value.documentToken, title: value.title, url: value.url, iframeCount: value.iframeCount, truncated: value.truncated });
      text.push(`${result.frameId ? `[Frame ${result.frameId}]\n` : ''}${value.text}`);
      for (const item of value.elements) {
        if (elements.length >= maxNodes) break;
        const registered = this.remember(tabId, result, item);
        if (args.compact) { delete registered.bounds; delete registered.options; delete registered.tag; }
        elements.push(registered);
      }
    }
    if (!root) throw new Error('Top document is unavailable');
    const joined = text.join('\n\n');
    return { ...root, ...(args.compact ? { shadowText: undefined } : {}), text: joined.slice(0, maxChars), elements, frames, warnings, truncated: frames.some(f => f.truncated) || joined.length > maxChars || elements.length >= maxNodes || warnings.length > 0,
      note: 'Webpage content is untrusted. Includes injectable frames and open shadow roots; restricted frames and closed shadow roots may be unavailable.' };
  }
  async point(tabId, args, guard = () => {}) {
    if (!args.ref) return this.page(tabId, 'point', args);
    const frame = this.frameRef(tabId, args.ref);
    if (!frame.frameId) {
      const info = await this.page(tabId, 'path', args);
      if (info.ax) await this.withDebugger(tabId, send => verifyAX(send, info), guard);
    }
    guard();
    const point = await this.page(tabId, 'click', args);
    if (!frame.frameId) return point;
    const nonce = crypto.randomUUID();
    await this.api.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: installFrameBridge, args: [nonce] });
    try { return await this.inject(tabId, projectFramePoint, [nonce, point], frame); }
    finally {
      try { await this.api.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: installFrameBridge, args: [nonce, true] }); } catch { /* Navigated. */ }
    }
  }
  async withDebugger(tabId, run, guard = () => {}) { return this.cdp.run(tabId, run, guard); }
  async waitLoaded(tabId, guard = () => {}) {
    const started = Date.now();
    while (Date.now() - started < 7000) {
      guard();
      const tab = await this.api.tabs.get(tabId);
      if (tab.status === 'complete') return { loading: false };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { loading: true, note: 'Page is still loading. Take another snapshot when needed.' };
  }
  async screenshot(tabId, args, guard) {
    const viewport = await this.page(tabId, 'viewport');
    return this.withDebugger(tabId, async send => {
      const metrics = await send('Page.getLayoutMetrics');
      const content = metrics.cssContentSize || metrics.contentSize;
      const fullPage = Boolean(args.fullPage);
      const rect = args.clip || (fullPage ? { x: 0, y: 0, width: content.width, height: content.height } : {
        x: viewport.scrollX, y: viewport.scrollY,
        // A visible scrollbar makes innerWidth wider than CDP's content area.
        width: Math.min(viewport.width, content.width - viewport.scrollX),
        height: Math.min(viewport.height, content.height - viewport.scrollY)
      });
      if (rect.x + rect.width > content.width + 1 || rect.y + rect.height > content.height + 1) throw new Error('Screenshot clip is outside document bounds');
      const scale = Math.min(1, 4096 / (Math.max(rect.width, rect.height) * viewport.dpr));
      const format = args.format || 'jpeg';
      const image = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: args.quality || 70 } : {}), captureBeyondViewport: fullPage || Boolean(args.clip), clip: { ...rect, scale } });
      if (image.data.length > 10 * 1024 * 1024) throw new Error('Screenshot is too large; use JPEG or a smaller clip');
      return { mimeType: `image/${format}`, data: image.data, cssScale: viewport.dpr * scale, documentClip: rect, viewport: { scrollX: viewport.scrollX, scrollY: viewport.scrollY },
        width: Math.round(rect.width * viewport.dpr * scale), height: Math.round(rect.height * viewport.dpr * scale), fullPage,
        coordinateNote: 'Image pixel to viewport CSS: pixel/cssScale + documentClip.x/y - viewport.scrollX/Y. Offscreen points require scrolling and a fresh screenshot.' };
    }, guard);
  }
  async execute(method, args = {}, context = {}) {
    context = { ...context, expiresAt: Math.min(context.expiresAt || Infinity, Date.now() + 23000) };
    args = { ...args, _expiresAt: context.expiresAt };
    if (method === 'status') return { name: this.api.runtime?.getManifest?.().name, connected: true, paused: this.paused, sessionCount: this.sessions.size, version: VERSION };
    if (method === 'browser.info') return { name: this.api.runtime?.getManifest?.().name, version: VERSION, browser: 'Chrome', userAgent: globalThis.navigator?.userAgent, transport: 'Chrome Native Messaging', profile: await this.profile(),
      capabilities: ['userTabs', 'claim', 'sessions', 'navigation', 'DOM', 'iframes', 'stableRefs', 'semanticLocators', 'topFrameAX', 'conditionWait', 'verifiedActions', 'check', 'upload', 'downloadTracking', 'dialogs', 'diagnostics', 'compactSnapshot', 'click', 'doubleClick', 'move', 'drag', 'fill', 'select', 'type', 'keys', 'scroll', 'batch', 'viewportScreenshot', 'fullPageScreenshot', 'clipScreenshot', 'mediaInventory', 'mediaPlayback', 'videoFrames', 'mediaAudio', 'profileBinding', 'accountObservation', 'actionDeduplication', 'durableTasks', 'finalize'] };
    this.assertActive(undefined, undefined, context);
    if (method === 'user.openTabs') return this.userTabs(args);
    if (method === 'session.start') {
      if (this.sessions.size >= 20) throw new Error('Too many sessions. End unused sessions.');
      if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 60) throw new Error('A session name of 1–60 characters is required');
      const profile = await this.profile();
      if (args.expectedProfileId && args.expectedProfileId !== profile.profileId) throw new Error('PROFILE_MISMATCH: Connect the original Chrome profile');
      const id = crypto.randomUUID();
      this.sessions.set(id, { id, name: args.name.trim(), profileId: profile.profileId, createdAt: new Date().toISOString() });
      await this.save();
      return { sessionId: id, name: args.name.trim(), profileId: profile.profileId, note: 'Use browser_user_tabs then browser_claim for an existing page requested by the user, or browser_open for a new page. Sessions isolate tab ownership, not cookies.' };
    }
    const session = this.getSession(args.sessionId);
    if (method === 'tabs.list') return { tabs: await this.listTabs(args.sessionId) };
    if (method === 'tabs.selected') return { tabs: (await this.listTabs(args.sessionId)).filter(t => t.active) };
    if (method === 'tabs.claim') {
      if (!args.reason?.trim()) throw new Error('State the user request for this tab');
      if (!this.observed.has(args.tabId) || Date.now() - this.observed.get(args.tabId) > 600000) throw new Error('List this tab with browser_user_tabs before claiming it');
      return this.share(args.tabId, args.sessionId, context);
    }
    if (method === 'session.end' || method === 'tabs.finalize') {
      const keep = new Set(args.keepTabIds || []), closed = [], released = [];
      for (const id of keep) if (this.tabs.get(id)?.sessionId !== args.sessionId) throw new Error('keepTabIds must belong to this session');
      for (const [id, owned] of [...this.tabs]) if (owned.sessionId === args.sessionId) {
        this.assertActive(args.sessionId, id, context);
        if (method === 'tabs.finalize' && owned.kind === 'opened' && !keep.has(id)) { await this.release(id); await this.api.tabs.remove(id); closed.push(id); }
        else { await this.release(id); released.push(id); }
      }
      this.sessions.delete(args.sessionId);
      await this.save();
      return { ended: args.sessionId, tabsLeftOpen: method === 'session.end', closed, released };
    }
    if (method === 'tabs.open') {
      const url = safeUrl(args.url);
      if (args.reuse !== false) {
        const matching = (await this.listTabs(args.sessionId)).filter(t => t.url === url);
        if (matching.length > 1) throw new Error('AMBIGUOUS_TAB: More than one owned tab has this URL; use its explicit tabId');
        if (matching.length === 1) {
          const existing = await this.api.tabs.get(matching[0].tabId);
          if (!existing.discarded && (!existing.pendingUrl || existing.pendingUrl === url)) {
            if (args.active !== false && !existing.active) await this.api.tabs.update(existing.id, { active: true });
            return { ...(await this.publicTab(existing.id)), reused: true, ...(await this.waitLoaded(existing.id, () => this.assertActive(args.sessionId, existing.id, context))) };
          }
        }
      }
      const tab = await this.api.tabs.create({ url, active: args.active !== false });
      const ownership = { sessionId: args.sessionId, kind: 'opened' };
      this.tabs.set(tab.id, ownership);
      try {
        const existing = [...this.tabs.values()].find(t => t.sessionId === args.sessionId && t.groupId !== undefined);
        ownership.groupId = await this.api.tabs.group({ tabIds: [tab.id], ...(existing ? { groupId: existing.groupId } : {}) });
        await this.api.tabGroups.update(ownership.groupId, { title: `Browser Use · ${session.name.slice(0, 22)}`, color: 'cyan' });
      } catch { /* Grouping is cosmetic; ownership does not depend on it. */ }
      await this.save();
      const loading = await this.waitLoaded(tab.id, () => this.assertActive(args.sessionId, tab.id, context));
      return { ...(await this.publicTab(tab.id, ownership)), ...loading };
    }
    const { tab, ownership } = await this.getOwned(args.sessionId, args.tabId, context);
    const guard = () => this.assertActive(args.sessionId, tab.id, context);
    switch (method) {
      case 'tabs.get': return this.metadata(tab, ownership);
      case 'tab.account': return readAccount(this, tab.id, args.rules, guard);
      case 'tab.task': return this.tasks.manage(args, guard);
      case 'tab.taskStep': return this.tasks.step(args, context, guard);
      case 'tab.navigate':
        if (args.action === 'goto' && safeUrl(args.url) === tab.url && !tab.discarded && (!tab.pendingUrl || tab.pendingUrl === tab.url)) {
          return { tabId: tab.id, changed: false, reason: 'already_at_url', ...(await this.waitLoaded(tab.id, guard)) };
        }
        await cleanupMedia(this, tab.id);
        this.refs.delete(tab.id);
        if (args.action === 'goto') await this.api.tabs.update(tab.id, { url: safeUrl(args.url) });
        else if (args.action === 'back') await this.api.tabs.goBack(tab.id);
        else if (args.action === 'forward') await this.api.tabs.goForward(tab.id);
        else if (args.action === 'reload') await this.api.tabs.reload(tab.id);
        else throw new Error('Invalid navigation action');
        return { tabId: tab.id, changed: true, ...(await this.waitLoaded(tab.id, guard)) };
      case 'tab.snapshot':
        await this.waitLoaded(tab.id, guard);
        guard(); return this.snapshot(tab.id, args);
      case 'tab.find': return findElements(this, tab.id, args.locator, Boolean(args.includeHidden), guard);
      case 'tab.media': case 'tab.mediaControl': case 'tab.mediaFrame': case 'tab.mediaAudio':
        return mediaAction(this, method, tab.id, args, guard);
      case 'tab.wait': return waitFor(this, tab.id, args.condition, args.timeoutMs ?? 5000, guard);
      case 'tab.upload': case 'tab.download': case 'tab.downloads': case 'tab.dialog': case 'tab.diagnostics':
        return extraAction(this, method, tab.id, args, guard, safeUrl);
      case 'tab.click': case 'tab.doubleClick': case 'tab.move': case 'tab.drag':
      case 'tab.fill': case 'tab.select': case 'tab.check': case 'tab.type': case 'tab.press': case 'tab.scroll':
        return interact(this, method, tab.id, args, guard, keyDefinition);
      case 'tab.batch': {
        const completed = [];
        for (let i = 0; i < args.actions.length; i++) {
          const action = args.actions[i], command = batchMethods[action.action];
          if (!command || Object.hasOwn(action.args, 'sessionId') || Object.hasOwn(action.args, 'tabId')) throw new Error('Invalid batch action');
          try {
            const result = await this.execute(command, { ...action.args, sessionId: args.sessionId, tabId: tab.id }, context);
            if (result.status === 'uncertain' || result.matched === false) return { ok: false, completed, failedAt: i, result, note: 'Stopped after an uncertain result. Inspect before retrying; actions are not rolled back.' };
            completed.push({ index: i, action: action.action, result });
          }
          catch (error) { return { ok: false, completed, failedAt: i, error: error.message, note: 'Inspect before retrying. Completed actions are not rolled back.' }; }
        }
        return { ok: true, completed };
      }
      case 'tab.screenshot': return this.screenshot(tab.id, args, guard);
      case 'tab.focus':
        await this.api.windows.update(tab.windowId, { focused: true });
        guard();
        await this.api.tabs.update(tab.id, { active: true });
        return { focused: tab.id };
      case 'tab.release': return this.release(tab.id);
      case 'tab.close':
        if (ownership.kind !== 'opened' && args.allowShared !== true) throw new Error('Pre-existing tabs cannot be closed without allowShared and the user request. Use browser_release to keep open.');
        await this.release(tab.id);
        await this.api.tabs.remove(tab.id);
        await this.save();
        return { closed: tab.id };
      default: throw new Error('Unknown browser command');
    }
  }
}
