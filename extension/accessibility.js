// Chrome's computed accessibility names are used for the top document. Child
// frames retain DOM semantic lookup until CDP child-target routing is implemented.
function nodePath() {
  if (this.ownerDocument !== document || this.nodeType !== 1) return null;
  const path = [];
  for (let n = this; n !== document;) {
    if (n.parentNode) { path.unshift([...n.parentNode.childNodes].indexOf(n)); n = n.parentNode; }
    else if (n.host) { path.unshift('shadow'); n = n.host; }
    else return null;
  }
  const el = this, clean = v => String(v || '').replace(/\s+/g, ' ').trim();
  const ids = el.getAttribute('aria-labelledby')?.trim().split(/\s+/);
  const labelled = ids?.map(id => el.getRootNode().getElementById?.(id)).filter(Boolean).map(n => n.getAttribute('aria-label') || n.textContent).join(' ');
  const domName = clean(labelled || el.getAttribute('aria-label') || [...el.labels || []].map(l => l.innerText || l.textContent).join(' ') || el.getAttribute('alt') ||
    (['button', 'submit', 'reset'].includes(el.type) ? el.value : '') ||
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable ? '' : el.innerText || el.textContent) || el.getAttribute('placeholder') || el.getAttribute('title')).slice(0, 500);
  return { path, tag: el.tagName, id: el.id, type: el.getAttribute('type'), domName };
}

export async function axCandidates(send, locator, limit = 100) {
  const { frameTree } = await send('Page.getFrameTree');
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'BrowserBuddyAX' });
  const { nodes } = await send('Accessibility.getFullAXTree');
  const match = v => locator.name === undefined || (locator.exact !== false ? v === locator.name : v.toLocaleLowerCase().includes(locator.name.toLocaleLowerCase()));
  const candidates = nodes.filter(n => !n.ignored && n.backendDOMNodeId && (!locator.role || n.role?.value === locator.role) && match(n.name?.value || ''));
  const results = [], objectGroup = 'buddy-ax-' + crypto.randomUUID();
  try {
    for (const n of candidates.slice(0, limit)) {
      const { object } = await send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId, executionContextId, objectGroup });
      if (!object.objectId) continue;
      const result = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: nodePath.toString(), returnByValue: true });
      if (result.result?.value) results.push({ ...result.result.value, ax: { role: n.role?.value, name: n.name?.value || '' } });
    }
  } finally { await send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {}); }
  return { elements: results, truncated: candidates.length > limit };
}

export async function topElementObject(send, info, objectGroup = 'buddy-upload') {
  const { frameTree } = await send('Page.getFrameTree');
  const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'BrowserBuddyAX' });
  const expression = `(function(info) { let el = document; for (const step of info.path) el = step === 'shadow' ? el?.shadowRoot : el?.childNodes[step]; if (!el || el.tagName !== info.tag || el.id !== info.id || el.getAttribute('type') !== (info.type ?? null)) throw new Error('Element changed'); return el; })(${JSON.stringify(info)})`;
  const result = await send('Runtime.evaluate', { expression, contextId: executionContextId, objectGroup });
  if (result.exceptionDetails || !result.result?.objectId) throw new Error('STALE_REF: Element changed');
  return result.result.objectId;
}

export async function verifyAX(send, info) {
  const objectGroup = 'buddy-verify-' + crypto.randomUUID();
  try {
    const objectId = await topElementObject(send, info, objectGroup);
    const { nodes } = await send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false });
    const node = nodes[0];
    if (!node || node.ignored || node.role?.value !== info.ax.role || (node.name?.value || '') !== info.ax.name) throw new Error('STALE_REF: Chrome AX meaning changed. Find the target again.');
  } finally { await send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {}); }
}
