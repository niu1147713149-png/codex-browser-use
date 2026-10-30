import assert from 'node:assert/strict';
import { join, basename, resolve, sep } from 'node:path';
import { writeFile, readFile, unlink } from 'node:fs/promises';

export async function reliabilityChecks(call, base, output, { downloadRoot } = {}) {
  const session = await call('browser_session_start', { name: '可靠性与新能力验证' });
  const checks = [];
  let args;
  const click = (locator, extra = {}) => call('browser_click', { ...args, locator: { ...locator, source: 'dom' }, ...extra });
  const find = (locator, extra = {}) => call('browser_find', { ...args, locator, ...extra });
  const confirm = result => assert.equal(result.status, 'confirmed', JSON.stringify(result));
  try {
    const tab = await call('browser_open', { sessionId: session.sessionId, url: base + '/reliability' });
    args = { sessionId: session.sessionId, tabId: tab.tabId };
    const first = await call('browser_snapshot', args);
    const stable = first.elements.find(e => e.name === 'Stable action').ref;
    assert.equal((await call('browser_snapshot', args)).elements.find(e => e.name === 'Stable action').ref, stable);
    await click({ name: 'Change history', role: 'button' });
    confirm(await call('browser_click', { ...args, ref: stable, expect: { state: 'text', text: 'Actions: 1' } }));
    await click({ name: 'Rerender stable', role: 'button' });
    confirm(await call('browser_click', { ...args, ref: stable, expect: { state: 'text', text: 'Actions: 2' } }));
    await click({ name: 'Rerender stable', role: 'button' });
    assert.match(await call('browser_click', { ...args, ref: stable }, true), /STALE_REF/);
    const changed = (await find({ role: 'button', name: 'Stable action', source: 'dom' })).elements[0].ref;
    await click({ role: 'button', name: 'Change meaning' });
    assert.match(await call('browser_click', { ...args, ref: changed }, true), /STALE_REF/);
    assert.match(await call('browser_click', { ...args, locator: { role: 'button', name: 'Duplicate' } }, true), /AMBIGUOUS_TARGET/);
    const ax = await find({ role: 'button', name: 'AX image action' });
    assert.equal(ax.elements.length, 1, JSON.stringify(ax)); assert.equal(ax.elements[0].nameSource, 'chrome-ax');
    assert.equal((await call('browser_click', { ...args, ref: ax.elements[0].ref })).status, 'sent');
    await click({ role: 'button', name: 'Change AX meaning' });
    assert.match(await call('browser_click', { ...args, ref: ax.elements[0].ref }, true), /STALE_REF/);
    const axChanged = await find({ role: 'button', name: 'Different AX action' });
    assert.equal(axChanged.elements.length, 1); assert.notEqual(axChanged.elements[0].ref, ax.elements[0].ref);
    checks.push('稳定 ref、同文档 history、唯一强等价重绘、二次重绘/语义改变拒绝、同名歧义拒绝、真实 Chrome AX 图像按钮命名');

    await click({ role: 'button', name: 'Prepare delayed' });
    confirm(await click({ role: 'button', name: 'Delayed action' }, { expect: { state: 'text', text: 'Delayed confirmed' } }));
    await click({ role: 'button', name: 'Start overlay' });
    confirm(await click({ role: 'button', name: 'Covered action' }, { expect: { state: 'text', text: 'Covered confirmed' } }));
    assert.equal((await call('browser_wait', { ...args, condition: { state: 'text', text: 'never appears' }, timeoutMs: 100 })).matched, false);
    const uncertain = await click({ css: '#stable' }, { expect: { state: 'text', text: 'never appears' }, timeoutMs: 150 });
    assert.equal(uncertain.status, 'uncertain');
    assert.match((await call('browser_snapshot', args)).text, /Actions: 3/);
    const batch = await call('browser_batch', { ...args, actions: [
      { action: 'click', args: { locator: { css: '#stable' }, expect: { state: 'text', text: 'not observed' }, timeoutMs: 100 } },
      { action: 'click', args: { locator: { css: '#stable' } } }
    ] });
    assert.equal(batch.ok, false); assert.equal(batch.failedAt, 0);
    assert.match((await call('browser_snapshot', args)).text, /Actions: 4/);
    checks.push('disabled/遮挡自动等待、条件超时、效果未确认返回 uncertain、失败批次停止且点击不重放');

    confirm(await call('browser_fill', { ...args, locator: { label: 'Native label' }, text: 'semantic input ✓' }));
    assert.match((await call('browser_snapshot', args)).text, /Native input trusted: true/);
    assert.equal((await call('browser_fill', { ...args, locator: { label: 'Reject text' }, text: 'rejected', timeoutMs: 150 })).status, 'uncertain');
    confirm(await call('browser_check', { ...args, locator: { label: 'Agreement' }, checked: true }));
    assert.equal((await call('browser_check', { ...args, locator: { label: 'Agreement' }, checked: true })).changed, false);
    confirm(await call('browser_check', { ...args, locator: { label: 'Agreement' }, checked: false }));
    confirm(await call('browser_check', { ...args, locator: { label: 'Choice two' }, checked: true }));
    assert.match(await call('browser_check', { ...args, locator: { label: 'Choice two' }, checked: false }, true), /different radio/);
    confirm(await call('browser_check', { ...args, locator: { role: 'switch', name: 'Notifications' }, checked: true }));
    await click({ role: 'button', name: 'Choose topic' });
    confirm(await click({ role: 'option', name: 'AI research' }, { expect: { state: 'text', text: 'Topic selected: AI' } }));
    checks.push('可信原生输入、实际值回读与受控输入拒绝、checkbox 幂等设置、radio、ARIA switch、自定义下拉选项');

    const file = join(output, 'buddy-upload-check.txt'); await writeFile(file, 'Codex Browser Use upload check\n');
    const upload = await call('browser_upload', { ...args, locator: { css: '#file' }, files: [file] });
    confirm(upload); assert.equal(upload.stage, 'files_selected'); assert.equal(upload.serverReceiptConfirmed, false);
    confirm(await click({ role: 'button', name: 'Upload fixture' }, { expect: { state: 'text', text: 'Server received test file' } }));
    const filename = 'browser-use-check-' + Date.now() + '.txt';
    const started = await call('browser_download', { ...args, url: base + '/buddy-download', filename });
    let download;
    for (let n = 0; n < 30; n++) {
      download = (await call('browser_downloads', { ...args, downloadId: started.downloadId })).downloads[0];
      if (download.state === 'complete') break;
      assert.notEqual(download.state, 'interrupted', JSON.stringify(download));
      await new Promise(r => setTimeout(r, 150));
    }
    assert.equal(download.state, 'complete');
    // Playwright's disposable profile rewrites downloads to GUID filenames.
    if (downloadRoot) assert.ok(resolve(download.filename).startsWith(resolve(downloadRoot) + sep));
    else assert.equal(basename(download.filename), filename);
    assert.equal(await readFile(download.filename, 'utf8'), 'Codex Browser Use download check\n');
    // Only delete the exact random-name fixture just downloaded and verified.
    await unlink(download.filename);
    assert.match(await call('browser_downloads', { ...args, downloadId: 2147483647 }, true), /does not belong/);
    checks.push('隐藏文件选择框、文件名回读、页面服务器回执、Chrome 下载完成/字节内容及下载 ID 隔离');

    await call('browser_dialog', { ...args, action: 'arm' });
    await click({ role: 'button', name: 'Open prompt' });
    const dialog = await call('browser_dialog', { ...args, action: 'status' });
    assert.equal(dialog.dialog?.type, 'prompt', JSON.stringify(dialog));
    confirm(await call('browser_dialog', { ...args, action: 'handle', accept: true, promptText: 'fixture accepted' }));
    await call('browser_dialog', { ...args, action: 'disarm' });
    assert.equal((await call('browser_wait', { ...args, condition: { state: 'text', text: 'Prompt reply: fixture accepted' } })).matched, true);
    await call('browser_diagnostics', { ...args, action: 'start' });
    await click({ role: 'button', name: 'Generate diagnostics' });
    await new Promise(r => setTimeout(r, 200));
    const diagnostics = await call('browser_diagnostics', { ...args, action: 'read' });
    assert.ok(diagnostics.events.some(e => e.kind === 'console'), JSON.stringify(diagnostics));
    assert.ok(diagnostics.events.some(e => e.kind === 'http' && e.status === 404), JSON.stringify(diagnostics));
    assert.ok(!JSON.stringify(diagnostics).includes('DO_NOT_RECORD_THIS'));
    await call('browser_diagnostics', { ...args, action: 'stop' });
    checks.push('指定标签页 JavaScript prompt 处理、受限 console/HTTP 诊断、不记录测试凭据或 URL 查询参数');

    const compact = await call('browser_snapshot', { ...args, compact: true, maxChars: 80, maxNodes: 4 });
    assert.ok(compact.text.length <= 80 && compact.elements.length <= 4 && compact.truncated);
    assert.ok(compact.elements.every(e => !e.bounds && !e.options));
    const old = compact.elements[0].ref;
    await call('browser_navigate', { ...args, action: 'reload' });
    assert.match(await call('browser_click', { ...args, ref: old }, true), /stale|document/i);
    checks.push('精简快照与预算、换文档拒绝旧 ref');
    return checks;
  } finally {
    if (args) { try { await call('browser_dialog', { ...args, action: 'status' }).then(async s => { if (s.dialog) await call('browser_dialog', { ...args, action: 'handle', accept: false }); }); } catch {} }
    await call('browser_finalize', { sessionId: session.sessionId });
  }
}
