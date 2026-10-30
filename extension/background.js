import { BrowserController } from './controller.js';
import { VERSION } from './version.js';
import { cleanupMedia } from './media.js';

const controller = new BrowserController(chrome);
const initialized = controller.restore();
let port = null;
let connection = 'disconnected';
let detail = '请运行安装脚本，随后重新连接。';

function badge() {
  chrome.action.setBadgeText({ text: controller.paused ? 'Ⅱ' : connection === 'connected' ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: controller.paused ? '#a76b16' : '#187566' });
}

function connect() {
  if (port) return;
  connection = 'connecting';
  detail = '正在连接本机 Chrome 接口…';
  try {
    const next = chrome.runtime.connectNative('local.codex.browser_buddy');
    port = next;
    next.onMessage.addListener(message => {
      if (message.type === 'ready') {
        connection = 'connected';
        detail = '本机通道已就绪，等待 Codex 调用。';
        badge();
      } else if (message.type === 'request') {
        controller.enqueue(async () => {
          await initialized;
          if (message.expiresAt && Date.now() > message.expiresAt) throw new Error('Command expired before execution. No action was taken.');
          return controller.execute(message.method, message.params, { expiresAt: message.expiresAt });
        }).then(result => {
          try { next.postMessage({ type: 'response', id: message.id, result }); } catch { /* Disconnected. */ }
        }, error => {
          try { next.postMessage({ type: 'response', id: message.id, error: error.message }); } catch { /* Disconnected. */ }
        });
      }
    });
    next.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError;
      if (port !== next) return;
      port = null;
      connection = 'disconnected';
      detail = error?.message || '本机连接已断开，请重新连接。';
      badge();
    });
    next.postMessage({ type: 'hello', version: VERSION });
  } catch (error) {
    port = null;
    connection = 'disconnected';
    detail = error.message;
  }
  badge();
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Only our popup may send popup-control messages. MCP has its own claim path.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  const run = async () => {
    await initialized;
    switch (message.type) {
      case 'state': return { ...(await controller.popupState()), connection, detail };
      case 'reconnect':
        if (port) { const old = port; port = null; old.disconnect(); }
        connect();
        return { ok: true };
      case 'pause':
        controller.paused = Boolean(message.paused);
        if (controller.paused) {
          for (const id of [...controller.tabs.keys()]) await cleanupMedia(controller, id);
          for (const id of [...controller.cdp.entries.keys()]) await controller.cdp.close(id);
        }
        await controller.save(); badge(); return { ok: true };
      case 'share': {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active?.id) throw new Error('没有可共享的当前标签页');
        return controller.share(active.id, message.sessionId);
      }
      case 'release': return controller.release(message.tabId);
      case 'end': {
        controller.getSession(message.sessionId);
        for (const [id, owned] of [...controller.tabs]) if (owned.sessionId === message.sessionId) await controller.release(id);
        controller.sessions.delete(message.sessionId);
        await controller.save();
        return { ok: true };
      }
      case 'focus':
        if (!controller.tabs.has(message.tabId)) throw new Error('标签页已释放');
        await chrome.tabs.update(message.tabId, { active: true });
        return { ok: true };
      default: throw new Error('Unknown popup request');
    }
  };
  // Revocation must interrupt a running batch/drag rather than wait in its queue.
  const urgent = ['pause', 'release', 'end'].includes(message.type);
  (urgent ? run() : controller.enqueue(run)).then(value => reply({ value }), error => reply({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(id => { void initialized.then(() => controller.release(id)); });
chrome.debugger.onDetach.addListener((source, reason) => { void controller.debuggerDetached(source, reason); });
chrome.debugger.onEvent.addListener((source, method, params) => controller.cdp.event(source, method, params));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'buddy-reconnect' && !port) connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('buddy-reconnect', { periodInMinutes: 1 }); connect(); });
void initialized.then(() => {
  chrome.alarms.create('buddy-reconnect', { periodInMinutes: 1 });
  connect();
});
