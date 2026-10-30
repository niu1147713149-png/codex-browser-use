// Browser-owned descendant targets only. Page messages, URLs and DOM attributes
// are never used to bind an extension ref to a renderer.
const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));

export class FrameTargets {
  constructor(api, tabId, alive) {
    this.api = api; this.tabId = tabId; this.alive = alive;
    this.sessions = new Map([['', { contexts: new Map() }]]);
  }
  command(sessionId, method, params = {}) {
    this.alive();
    if (!this.sessions.has(sessionId)) throw new Error('FRAME_TARGET_GONE: Take a fresh snapshot');
    return this.api.debugger.sendCommand({ tabId: this.tabId, ...(sessionId ? { sessionId } : {}) }, method, params);
  }
  initialize(sessionId) {
    const session = this.sessions.get(sessionId);
    session.ready ||= (async () => {
      await this.command(sessionId, 'Page.enable');
      await this.command(sessionId, 'Runtime.enable');
      await this.command(sessionId, 'Target.setAutoAttach', autoAttach);
    })().catch(error => { session.error = error; });
    return session.ready;
  }
  event(source, method, params) {
    const sessionId = source.sessionId || '', session = this.sessions.get(sessionId);
    if (!session) return;
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
      this.sessions.set(params.sessionId, { parent: sessionId, contexts: new Map() });
      this.initialize(params.sessionId);
    }
    if (method === 'Target.detachedFromTarget') this.remove(params.sessionId);
    if (method === 'Runtime.executionContextCreated') {
      const c = params.context;
      if (c.origin === `chrome-extension://${this.api.runtime.id}` && c.auxData?.type === 'isolated' && !c.auxData.isDefault && c.uniqueId) session.contexts.set(c.uniqueId, c);
    }
    if (method === 'Runtime.executionContextDestroyed') {
      for (const [id, c] of session.contexts) if (c.id === params.executionContextId) session.contexts.delete(id);
    }
    if (method === 'Runtime.executionContextsCleared') session.contexts.clear();
  }
  remove(sessionId) {
    for (const [id, session] of this.sessions) if (session.parent === sessionId) this.remove(id);
    this.sessions.delete(sessionId);
  }
  assert(route) {
    this.alive();
    const c = this.sessions.get(route.sessionId)?.contexts.get(route.contextId);
    if (!c || c.auxData.frameId !== route.frameId) throw new Error('FRAME_TARGET_GONE: Target document changed; input was not redirected');
  }
  async locate(token, guard) {
    await this.initialize('');
    // Diagnostics may have disabled Runtime while a dialog watch kept this
    // debugger attached. Restore context events before binding another ref.
    await this.command('', 'Runtime.enable');
    const deadline = Date.now() + 1200;
    do {
      guard();
      for (const [sessionId, session] of this.sessions) {
        await session.ready;
        if (session.error) throw session.error;
        for (const c of session.contexts.values()) {
          guard();
          // uniqueContextId cannot be reused by a new document after navigation.
          const result = await this.command(sessionId, 'Runtime.evaluate', { expression: 'globalThis.__codexBrowserBuddyRefsV3?.token', uniqueContextId: c.uniqueId, returnByValue: true });
          if (result.result?.value === token) {
            const route = { sessionId, contextId: c.uniqueId, frameId: c.auxData.frameId };
            this.assert(route); return route;
          }
        }
      }
      await pause();
    } while (Date.now() < deadline);
    throw new Error('FRAME_TARGET_UNAVAILABLE: Chrome could not bind the target document; take a fresh snapshot');
  }
  async project(route, point, guard) {
    this.assert(route);
    const frames = new Map();
    for (const [sessionId, session] of this.sessions) {
      guard(); await session.ready;
      if (session.error) throw session.error;
      const { frameTree } = await this.command(sessionId, 'Page.getFrameTree');
      const visit = (tree, parentId) => {
        // A frame may also appear in its parent's tree; its own target wins.
        if (!frames.get(tree.frame.id)?.targetRoot) frames.set(tree.frame.id, { ...tree.frame, parentId: tree.frame.parentId || parentId, sessionId, targetRoot: tree === frameTree });
        for (const child of tree.childFrames || []) visit(child, tree.frame.id);
      };
      visit(frameTree);
    }
    let frame = frames.get(route.frameId), projected = { x: point.x, y: point.y }, inputPoint;
    if (!frame || frame.sessionId !== route.sessionId) throw new Error('FRAME_TARGET_GONE: Target renderer changed');
    while (frame) {
      guard(); this.assert(route);
      if (frame.targetRoot && frame.sessionId === route.sessionId) inputPoint = { ...projected };
      if (!frame.parentId) break;
      const parent = frames.get(frame.parentId);
      if (!parent) throw new Error('FRAME_TARGET_UNAVAILABLE: Parent frame is unavailable');
      if (!inputPoint && (frame.securityOrigin !== parent.securityOrigin || !/^https?:\/\//.test(frame.securityOrigin))) {
        throw new Error('FRAME_ROUTING_UNAVAILABLE: Cross-origin frame has no dedicated Chrome input target; coordinate fallback is disabled');
      }
      const { backendNodeId } = await this.command(parent.sessionId, 'DOM.getFrameOwner', { frameId: frame.id });
      const { executionContextId } = await this.command(parent.sessionId, 'Page.createIsolatedWorld', { frameId: parent.id, worldName: 'codex-browser-use-frame-geometry' });
      const { object } = await this.command(parent.sessionId, 'DOM.resolveNode', { backendNodeId, executionContextId });
      try {
        const result = await this.command(parent.sessionId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: ownerPoint.toString(), arguments: [{ value: projected.x }, { value: projected.y }], returnByValue: true });
        if (result.exceptionDetails || !Number.isFinite(result.result?.value?.x) || !Number.isFinite(result.result?.value?.y)) throw new Error('FRAME_NOT_HITTABLE: Iframe is hidden, covered, detached, outside the viewport or transformed');
        projected = { x: result.result.value.x, y: result.result.value.y };
      } finally { await this.command(parent.sessionId, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {}); }
      frame = parent;
    }
    if (!inputPoint) throw new Error('FRAME_TARGET_UNAVAILABLE: No input target for this frame');
    this.assert(route);
    return { ...projected, inputPoint, route };
  }
}

// Runs on the browser-resolved owner element in a dedicated isolated world.
// Read-only: scrolling is performed and accounted for by the page action.
function ownerPoint(x, y) {
  if (!this.isConnected || !['IFRAME', 'FRAME'].includes(this.tagName) || !this.offsetWidth || !this.offsetHeight) throw new Error('Unavailable frame');
  for (let el = this; el; el = el.parentElement || el.getRootNode().host) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.opacity === '0') throw new Error('Hidden frame');
    if (style.transform !== 'none') {
      const m = new DOMMatrixReadOnly(style.transform);
      if (!m.is2D || m.b || m.c || m.a <= 0 || m.d <= 0) throw new Error('Unsupported frame transform');
    }
  }
  const box = this.getBoundingClientRect();
  x = box.left + (this.clientLeft + x) * box.width / this.offsetWidth;
  y = box.top + (this.clientTop + y) * box.height / this.offsetHeight;
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error('Outside viewport');
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot?.elementFromPoint) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (hit !== this) throw new Error('Covered frame');
  return { x, y };
}
