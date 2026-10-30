import assert from 'node:assert/strict';

export function frameFixture(path, port) {
  if (path === '/same-parent') return `<!doctype html><title>Same-origin frames</title><div style="height:1200px">Before frames</div><iframe style="width:500px;height:350px;transform:scale(.9);border:7px solid green" src="/same-child"></iframe>`;
  if (path === '/same-child') return '<!doctype html><button onclick="document.querySelector(`p`).textContent=`Same trusted: ${event.isTrusted}`">Same click</button><p>Same ready</p><iframe src="/same-nested"></iframe>';
  if (path === '/same-nested') return '<!doctype html><button onclick="document.querySelector(`p`).textContent=`Same nested trusted: ${event.isTrusted}`">Same nested</button><p>Same nested ready</p>';
  if (path === '/switch-parent' || path === '/late-parent') return `<!doctype html><title>Switch input destination</title><style>body{margin:0}button,iframe{position:absolute;left:40px;top:80px;width:500px;height:250px;border:0}p{position:relative;top:400px}</style><button onclick="document.querySelector('p').textContent='WRONG PARENT CLICKED'">Parent danger</button><iframe src="http://localhost:${port}/${path === '/late-parent' ? 'late-child' : 'switch-child'}"></iframe><p>Parent untouched</p><p id="switched">No switch</p><script>addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow&&e.data==='fixture-hover'){document.querySelector('iframe').style.pointerEvents='none';switched.textContent='Switched after trusted hover'}})</script>`;
  if (path === '/late-child') return '<!doctype html><button onclick="document.querySelector(`p`).textContent=`Late child trusted: ${event.isTrusted}`">Late child</button><p>Late untouched</p>';
  if (path === '/switch-child') return '<!doctype html><button style="width:200px;height:60px" onmousemove="if(event.isTrusted)parent.postMessage(`fixture-hover`,`*`)" onclick="document.querySelector(`p`).textContent=`Child clicked`">Child switch</button><p>Child untouched</p>';
  if (path === '/hover-task' || path === '/scroll-task') return `<!doctype html><title>Task preparation</title><p id="effect">No effects</p><button id="action" style="margin-top:${path === '/scroll-task' ? 1400 : 0}px" onclick="effect.textContent='Button clicked'">Before effect</button><script>function effectful(e){if(!e.isTrusted)return;effect.textContent='Preparation effect: '+e.type;action.textContent='Meaning changed'};${path === '/hover-task' ? 'action.onmousemove=effectful' : 'onscroll=effectful'}</script>`;
}

export async function frameChecks(call, base, atFramePress) {
  const session = await call('browser_session_start', { name: 'Frame routing and durable input regression' });
  const args = { sessionId: session.sessionId };
  const checks = [];
  try {
    const tab = await call('browser_open', { ...args, url: `${base}/same-parent` }); args.tabId = tab.tabId;
    let snap = await call('browser_snapshot', args);
    const same = snap.elements.find(e => e.name === 'Same click'), nested = snap.elements.find(e => e.name === 'Same nested');
    assert.ok(same && nested);
    assert.equal((await call('browser_click', { ...args, ref: same.ref })).status, 'sent');
    assert.equal((await call('browser_click', { ...args, ref: nested.ref })).status, 'sent');
    snap = await call('browser_snapshot', args);
    assert.match(snap.text, /Same trusted: true/); assert.match(snap.text, /Same nested trusted: true/);
    checks.push('同源嵌套 iframe、缩放和离屏滚动后的可信点击');

    await call('browser_navigate', { ...args, action: 'goto', url: `${base}/switch-parent` });
    snap = await call('browser_snapshot', args);
    const result = await call('browser_click', { ...args, ref: snap.elements.find(e => e.name === 'Child switch').ref });
    assert.equal(result.status, 'uncertain'); assert.match(result.error, /FRAME_NOT_HITTABLE/);
    snap = await call('browser_snapshot', args);
    assert.match(snap.text, /Switched after trusted hover/); assert.match(snap.text, /Parent untouched/); assert.match(snap.text, /Child untouched/);
    checks.push('父页面在可信悬停后切换点击目标：停止按下，不误点父页');

    await call('browser_navigate', { ...args, action: 'goto', url: `${base}/late-parent` });
    snap = await call('browser_snapshot', args);
    // Inject the race *after* the last readiness check, at the real Chrome input
    // boundary. Only the disposable test extension has this hook.
    const late = await atFramePress(args.tabId, () => call('browser_click', { ...args, ref: snap.elements.find(e => e.name === 'Late child').ref }));
    assert.equal(late.status, 'sent');
    snap = await call('browser_snapshot', args);
    assert.match(snap.text, /Switched at press/); assert.match(snap.text, /Parent untouched/); assert.match(snap.text, /Late child trusted: true/);
    checks.push('最终检查后、按下前父页切换 pointer-events：原生输入仍只到达目标子 frame');

    for (const kind of ['hover', 'scroll']) {
      await call('browser_navigate', { ...args, action: 'goto', url: `${base}/${kind}-task` });
      snap = await call('browser_snapshot', args);
      const task = await call('browser_task', { ...args, action: 'create', name: `${kind} side effect` });
      const request = { ...args, taskId: task.taskId, stepId: 'click', action: 'click', args: { locator: { css: '#action', source: 'dom' }, timeoutMs: 0, expect: { state: 'text', text: 'Button clicked' } } };
      if (kind === 'hover') {
        assert.match(await call('browser_task_step', { ...request, args: { ...request.args, locator: { css: '#missing', source: 'dom' } } }, true), /STEP_NOT_SENT/);
        assert.equal((await call('browser_task', { ...args, taskId: task.taskId, action: 'status' })).steps.length, 0);
      }
      const result = await call('browser_task_step', request);
      assert.equal(result.status, 'uncertain'); assert.match(result.result.error, /STALE_REF/);
      snap = await call('browser_snapshot', args);
      assert.match(snap.text, new RegExp('Preparation effect: ' + (kind === 'hover' ? 'mousemove' : 'scroll')));
      assert.ok(!snap.text.includes('Button clicked'));
      const state = await call('browser_task', { ...args, taskId: task.taskId, action: 'status' });
      assert.equal(state.steps.length, 1); assert.equal(state.steps[0].state, 'uncertain');
      assert.equal((await call('browser_task_step', request)).deduplicated, true);
      assert.match(await call('browser_task_step', { ...request, stepId: 'new' }, true), /UNRESOLVED_STEP/);
      await call('browser_task', { ...args, taskId: task.taskId, action: 'discard' });
    }
    checks.push('悬停和准备滚动已生效后保留 uncertain 检查点，重复请求与后续步骤不重放');
    return checks;
  } finally { await call('browser_finalize', { sessionId: args.sessionId }); }
}
