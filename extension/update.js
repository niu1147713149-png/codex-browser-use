import { VERSION } from './version.js';
const forceReload = new URL(location.href).searchParams.get('reload') === '1';
if (chrome.runtime.getManifest().version !== VERSION || forceReload) {
  document.querySelector('#message').textContent = `正在更新至 ${VERSION}…`;
  history.replaceState(null, '', chrome.runtime.getURL('update.html'));
  chrome.runtime.reload();
} else {
  document.querySelector('#message').textContent = `已更新至 ${VERSION}。Chrome 正在自动连接 Codex。`;
  // This maintenance page is created solely for the update and may close itself.
  setTimeout(() => window.close(), 2500);
}
