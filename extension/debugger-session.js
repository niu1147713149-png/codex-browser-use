import { FrameTargets } from './frame-targets.js';

// Owned CDP sessions only. Never detach another extension's or DevTools' debugger.
export const sanitize = value => String(value || '').slice(0, 2000)
  .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
  .replace(/((?:token|api[_-]?key|password|authorization|cookie|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
  .replace(/https?:\/\/[^\s"<>]+/g, text => safeDiagnosticUrl(text));
export function safeDiagnosticUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : '[non-http URL]'; }
  catch { return '[invalid URL]'; }
}

export class DebuggerSessions {
  constructor(api) { this.api = api; this.entries = new Map(); this.detaching = new Set(); }
  async acquire(tabId, guard = () => {}) {
    guard();
    let entry = this.entries.get(tabId);
    if (!entry) {
      entry = { users: 0, pins: new Set(), events: [], pendingDialog: null, requests: new Map(), dialogWaiters: new Set() };
      // Register before enabling domains so events cannot race the entry.
      await this.api.debugger.attach({ tabId }, '1.3');
      this.entries.set(tabId, entry);
      // Observe contexts even if diagnostics enables Runtime before the first
      // iframe action; a second Runtime.enable need not replay those events.
      entry.frames = new FrameTargets(this.api, tabId, () => {
        if (this.entries.get(tabId) !== entry) throw new Error('DEBUGGER_DISCONNECTED: Inspect the page before retrying');
      });
      try { guard(); await this.api.debugger.sendCommand({ tabId }, 'Page.enable', {}); }
      catch (error) { await this.close(tabId); throw error; }
    }
    entry.users++;
    return entry;
  }
  async run(tabId, callback, guard = () => {}) {
    const entry = await this.acquire(tabId, guard);
    let inputSent = false;
    const alive = () => {
      if (this.entries.get(tabId) !== entry) throw new Error('DEBUGGER_DISCONNECTED: Inspect the page before retrying');
    };
    const send = async (method, params = {}, route) => {
      guard();
      alive();
      if (route) {
        if (!entry.frames) throw new Error('FRAME_TARGET_UNAVAILABLE: No owned frame route');
        entry.frames.assert(route);
      }
      if (method.startsWith('Input.')) {
        if (entry.pendingDialog) throw new Error('DIALOG_OPEN: Handle the JavaScript dialog before further input');
        inputSent = true;
      }
      const command = this.api.debugger.sendCommand({ tabId, ...(route?.sessionId ? { sessionId: route.sessionId } : {}) }, method, params);
      if (!method.startsWith('Input.')) return command;
      let notify;
      const dialog = new Promise(resolve => { notify = () => resolve({ dialogPending: true }); entry.dialogWaiters.add(notify); });
      try { return await Promise.race([command, dialog]); }
      finally { entry.dialogWaiters.delete(notify); }
    };
    send.framePoint = async (token, point) => {
      guard(); alive();
      const route = await entry.frames.locate(token, guard);
      return entry.frames.project(route, point, guard);
    };
    try { return await callback(send, entry); }
    finally {
      // OOPIF input dispatch can finish after CDP acknowledges it.
      if (inputSent) await new Promise(resolve => setTimeout(resolve, 80));
      entry.users--;
      if (!entry.users && !entry.pins.size && this.entries.get(tabId) === entry) await this.close(tabId);
    }
  }
  async close(tabId) {
    const entry = this.entries.get(tabId);
    this.entries.delete(tabId);
    if (!entry) return;
    this.detaching.add(tabId);
    try { await this.api.debugger.detach({ tabId }); } catch { /* Already detached. */ }
    finally { this.detaching.delete(tabId); }
  }
  detached(tabId) { this.entries.delete(tabId); }
  event(source, method, params) {
    const e = this.entries.get(source.tabId);
    if (!e) return;
    e.frames?.event(source, method, params);
    // Child-target events require their own routing; never attribute them to root.
    if (source.sessionId) return;
    if (method === 'Page.javascriptDialogOpening') {
      e.pendingDialog = { type: params.type, message: sanitize(params.message), url: safeDiagnosticUrl(params.url) };
      e.pins.add('dialog');
      for (const notify of e.dialogWaiters) notify();
    }
    if (method === 'Page.javascriptDialogClosed') { e.pendingDialog = null; e.pins.delete('dialog'); }
    if (!e.pins.has('diagnostics')) return;
    let item;
    if (method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn', 'assert'].includes(params.type)) {
      // Console arguments can contain secrets: report level/count only, no values or object previews.
      item = { kind: 'console', level: params.type, argumentCount: params.args?.length || 0 };
    }
    if (method === 'Runtime.exceptionThrown') item = { kind: 'exception', text: sanitize(params.exceptionDetails?.text), line: params.exceptionDetails?.lineNumber };
    if (method === 'Network.requestWillBeSent') {
      e.requests.set(params.requestId, safeDiagnosticUrl(params.request.url));
      if (e.requests.size > 300) e.requests.delete(e.requests.keys().next().value);
    }
    if (method === 'Network.responseReceived' && params.response.status >= 400) item = { kind: 'http', url: safeDiagnosticUrl(params.response.url), status: params.response.status };
    if (method === 'Network.loadingFailed') item = { kind: 'network', url: e.requests.get(params.requestId), error: sanitize(params.errorText), canceled: Boolean(params.canceled) };
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') e.requests.delete(params.requestId);
    if (item) { e.events.push({ time: new Date().toISOString(), ...item }); if (e.events.length > 100) e.events.shift(); }
  }
}
