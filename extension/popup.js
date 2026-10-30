const $ = id => document.getElementById(id);
let state;
let busy = false;

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...data });
  if (!response) throw new Error('扩展后台未响应，请在扩展管理页重新加载。');
  if (response.error) throw new Error(response.error);
  return response.value;
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
async function act(type, data) {
  if (busy) return;
  busy = true;
  $('notice').hidden = true;
  try { await send(type, data); await refresh(); }
  catch (error) { $('notice').textContent = error.message; $('notice').hidden = false; }
  finally { busy = false; }
}
function render() {
  document.querySelector('.version').textContent = `v${state.version}`;
  $('connection').className = `connection ${state.paused ? 'paused' : state.connection}`;
  $('status').textContent = state.paused ? '控制已暂停' : { connected: 'Chrome 已连接', connecting: '正在连接', disconnected: '本机接口未连接' }[state.connection];
  $('detail').textContent = state.paused ? '恢复后，Codex 才能继续操作共享页面。' : state.detail;
  $('pause').textContent = state.paused ? '恢复控制' : '暂停控制';
  $('profile-label').textContent = state.profile ? `当前 Chrome 配置：${state.profile.profileId.slice(0, 8)} · 使用此配置的网站登录状态` : '';
  const selected = $('session-select').value;
  $('session-select').replaceChildren();
  if (!state.sessions.length) $('session-select').append(new Option('先在 Codex 创建浏览器会话', ''));
  for (const session of state.sessions) $('session-select').append(new Option(`${session.name} · ${session.id.slice(0, 6)}`, session.id));
  if (state.sessions.some(s => s.id === selected)) $('session-select').value = selected;
  $('share').disabled = state.paused || state.connection !== 'connected' || !state.sessions.length;
  $('count').textContent = state.sessions.length;
  $('sessions').replaceChildren();
  if (!state.sessions.length) {
    const empty = element('div', 'empty');
    empty.append(element('strong', '', '网页工作，从一句话开始'), element('p', '', '在 Codex 中说：“用 Codex Browser Use 打开网页”。会话与标签页会显示在这里。'));
    $('sessions').append(empty);
  }
  for (const session of state.sessions) {
    const card = element('article', 'session');
    const heading = element('div', 'session-top');
    const end = element('button', 'text-button', '结束');
    end.title = '结束会话并释放所有标签页，页面保持打开';
    end.addEventListener('click', () => act('end', { sessionId: session.id }));
    heading.append(element('span', 'session-title', session.name), element('span', 'session-id', session.id.slice(0, 6)), end);
    card.append(heading);
    if (!session.tabs.length) card.append(element('p', 'no-tabs', '暂无受控标签页，可在上方共享当前页面。'));
    for (const tab of session.tabs) {
      const row = element('div', 'tab-row');
      const focus = element('button', 'tab-open');
      focus.title = '切换到此标签页';
      focus.append(element('span', 'tab-title', tab.title), element('span', 'tab-url', tab.url));
      focus.addEventListener('click', () => act('focus', { tabId: tab.tabId }));
      const release = element('button', 'text-button', '释放');
      release.addEventListener('click', () => act('release', { tabId: tab.tabId }));
      row.append(focus, element('span', 'kind', tab.kind === 'opened' ? '新建' : '共享'), release);
      card.append(row);
    }
    $('sessions').append(card);
  }
}
async function refresh() { state = await send('state'); render(); }
$('reconnect').addEventListener('click', () => act('reconnect'));
$('share').addEventListener('click', () => act('share', { sessionId: $('session-select').value }));
$('pause').addEventListener('click', () => act('pause', { paused: !state?.paused }));
await refresh().catch(error => { $('notice').textContent = error.message; $('notice').hidden = false; });
setInterval(() => { if (!busy) void refresh().catch(() => {}); }, 1800);
