import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function advancedChecks(call, base, output) {
  const session = await call('browser_session_start', { name: '插件新增能力验证' });
  const args = { sessionId: session.sessionId };
  const checks = [];
  const created = [];
  try {
    const tab = await call('browser_open', { ...args, url: `${base}/advanced` });
    args.tabId = tab.tabId; created.push(tab.tabId);
    assert.equal((await call('browser_tab_info', args)).title, 'Browser Use advanced fixture');
    assert.ok((await call('browser_selected', { sessionId: args.sessionId })).tabs.some(t => t.tabId === tab.tabId));
    await call('browser_release', args);
    const list = await call('browser_user_tabs', { query: `${base}/advanced` });
    assert.ok(list.tabs.some(t => t.tabId === tab.tabId && !t.controlled));
    assert.match(await call('browser_snapshot', args, true), /not shared/);
    await call('browser_claim', { ...args, reason: 'Claim this local integration fixture for the authorized plugin connection test' });
    await call('browser_focus', args);
    checks.push('真实标签清单、接管已有页、当前标签和页面信息');
    let snap = await call('browser_snapshot', args);
    assert.ok(snap.frames.length >= 3, `Expected nested frames: ${snap.frames.length}`);
    const get = name => { const el = snap.elements.find(e => e.name === name); assert.ok(el, `Missing ${name}`); return el; };
    await call('browser_double_click', { ...args, ref: get('Double click').ref, expect: { state: 'text', text: 'Double trusted: true' } });
    snap = await call('browser_snapshot', args);
    assert.match(snap.text, /Double trusted: true/);
    await call('browser_move', { ...args, ref: get('Hover').ref, expect: { state: 'text', text: 'Hover trusted: true' } });
    snap = await call('browser_snapshot', args);
    assert.match(snap.text, /Hover trusted: true/);
    const text = get('Native text').ref;
    await call('browser_type', { ...args, ref: text, text: 'initial' });
    const batch = await call('browser_batch', { ...args, actions: [
      { action: 'press', args: { key: 'Ctrl+A' } }, { action: 'type', args: { text: '原生输入✓' } }
    ] });
    assert.equal(batch.ok, true);
    snap = await call('browser_snapshot', args);
    assert.equal(get('Native text').value, '原生输入✓');
    const partial = await call('browser_batch', { ...args, actions: [
      { action: 'fill', args: { ref: get('Native text').ref, text: 'completed once' } },
      { action: 'click', args: { ref: 'deliberately-stale-ref' } },
      { action: 'fill', args: { ref: get('Native text').ref, text: 'should not execute' } }
    ] });
    assert.equal(partial.ok, false); assert.equal(partial.failedAt, 1); assert.equal(partial.completed.length, 1);
    snap = await call('browser_snapshot', args);
    assert.equal(get('Native text').value, 'completed once');
    const beforeDrag = await call('browser_screenshot', args);
    assert.ok(beforeDrag.data.length > 1000);
    const box = get('Drag slider').bounds;
    const x = box.x + 10, y = box.y + box.height / 2;
    await call('browser_drag', { ...args, points: [{ x, y }, { x: x + 70, y }, { x: x + 140, y }, { x: x + 240, y }] });
    snap = await call('browser_snapshot', args);
    assert.ok(Number(get('Drag slider').value) > 50);
    assert.match(snap.text, /Slider: \d+ trusted: true/);
    assert.match(await call('browser_click', { ...args, x: 49999, y: 0 }, true), /outside viewport/);
    checks.push('可信双击、悬停、坐标拖拽、原生文字输入、Ctrl+A、连续操作及首错停止');

    await call('browser_click', { ...args, ref: get('Frame click').ref });
    snap = await call('browser_snapshot', args);
    assert.match(snap.text, /Frame trusted: true/);
    const nestedPoint = await call('browser_click', { ...args, ref: get('Nested click').ref });
    snap = await call('browser_snapshot', args);
    if (!snap.text.includes('Nested trusted: true')) {
      const diagnostic = await call('browser_screenshot', args);
      await writeFile(join(output, 'iframe-diagnostic.jpg'), Buffer.from(diagnostic.data, 'base64'));
      console.log(JSON.stringify({ nestedPoint, frameButton: get('Nested click'), shot: { width: diagnostic.width, height: diagnostic.height, cssScale: diagnostic.cssScale, viewport: diagnostic.viewport } }));
    }
    assert.match(snap.text, /Nested trusted: true/);
    await call('browser_type', { ...args, ref: get('Frame text').ref, text: '跨域输入' });
    snap = await call('browser_snapshot', args);
    assert.equal(get('Frame text').value, '跨域输入');
    checks.push('跨域及两层嵌套 iframe 读取、可信点击、原生输入');

    const full = await call('browser_screenshot', { ...args, fullPage: true, format: 'png' });
    const bytes = Buffer.from(full.data, 'base64');
    assert.equal(full.mimeType, 'image/png'); assert.equal(bytes.readUInt32BE(16), full.width); assert.equal(bytes.readUInt32BE(20), full.height);
    assert.ok(full.height > beforeDrag.height && full.height <= 4096);
    await writeFile(join(output, 'full-page.png'), bytes);
    const clip = await call('browser_screenshot', { ...args, format: 'png', clip: { x: 20, y: 20, width: 320, height: 180 } });
    const clipBytes = Buffer.from(clip.data, 'base64');
    assert.equal(clipBytes.readUInt32BE(16), clip.width); assert.equal(clipBytes.readUInt32BE(20), clip.height);
    assert.equal(clip.width, Math.round(320 * clip.cssScale));
    await writeFile(join(output, 'clip.png'), clipBytes);
    checks.push('PNG 整页与区域截图、尺寸上限、像素到 CSS 坐标换算');
    await call('browser_scroll', { ...args, x: 15, y: 15, direction: 'down', amount: 200 });
    const disposable = await call('browser_open', { sessionId: args.sessionId, url: `${base}/nested` });
    created.push(disposable.tabId);
    const finalized = await call('browser_finalize', { sessionId: args.sessionId });
    assert.ok(finalized.closed.includes(disposable.tabId));
    assert.ok(finalized.released.includes(tab.tabId));
    checks.push('结束会话时关闭自建页、保留并释放已有页');
    return checks;
  } finally {
    // These IDs all belong to pages created by this test, including the one
    // deliberately released/claimed to exercise pre-existing-tab behavior.
    try { await call('browser_session_end', { sessionId: args.sessionId }); } catch { /* Already finalized. */ }
    const clean = await call('browser_session_start', { name: '清理插件验证页' });
    try {
      const inventory = await call('browser_user_tabs', { query: base });
      for (const id of created) if (inventory.tabs.some(t => t.tabId === id)) {
        await call('browser_claim', { sessionId: clean.sessionId, tabId: id, reason: 'Close only pages created by this integration test' });
        await call('browser_close', { sessionId: clean.sessionId, tabId: id, allowShared: true });
      }
    } finally { await call('browser_session_end', { sessionId: clean.sessionId }); }
  }
}
