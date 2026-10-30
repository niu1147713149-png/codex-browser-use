// Temporary isolated-world bridge; accepts only direct child windows and the
// current nonce. It carries coordinates, never commands or page script.
export function installFrameBridge(nonce, remove = false) {
  const key = '__buddyFrameBridgeV2';
  if (globalThis[key]) removeEventListener('message', globalThis[key]);
  delete globalThis[key];
  if (remove) return;
  function findFrame(root, source) {
    for (const el of root.querySelectorAll('*')) {
      if (['IFRAME', 'FRAME'].includes(el.tagName) && el.contentWindow === source) return el;
      if (el.shadowRoot) { const frame = findFrame(el.shadowRoot, source); if (frame) return frame; }
    }
  }
  const handler = async event => {
    const message = event.data;
    if (message?.buddyFramePoint !== nonce || !event.ports[0]) return;
    const reply = value => { event.ports[0].postMessage(value); event.ports[0].close(); };
    try {
      const frame = findFrame(document, event.source);
      if (!frame || !Number.isFinite(message.x) || !Number.isFinite(message.y)) throw new Error('Cannot locate child iframe');
      for (let ancestor = frame; ancestor; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
        const transform = getComputedStyle(ancestor).transform;
        if (transform !== 'none') {
          const m = new DOMMatrixReadOnly(transform);
          if (!m.is2D || m.b || m.c || m.a <= 0 || m.d <= 0) throw new Error('Rotated or 3D iframe requires screenshot coordinates');
        }
      }
      frame.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      const box = frame.getBoundingClientRect();
      if (!frame.offsetWidth || !frame.offsetHeight) throw new Error('Iframe is hidden');
      const sx = box.width / frame.offsetWidth, sy = box.height / frame.offsetHeight;
      const x = box.left + (frame.clientLeft + message.x) * sx;
      const y = box.top + (frame.clientTop + message.y) * sy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) throw new Error('Iframe target is outside viewport');
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot?.elementFromPoint) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      if (hit !== frame) throw new Error('Iframe is covered by another element');
      if (window === top) { reply({ ok: true, value: { x, y } }); return; }
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); reply({ ok: false, error: 'Parent iframe translation timed out' }); }, 1500);
      channel.port1.onmessage = response => { clearTimeout(timer); channel.port1.close(); reply(response.data); };
      parent.postMessage({ buddyFramePoint: nonce, x, y }, '*', [channel.port2]);
    } catch (error) { reply({ ok: false, error: error.message }); }
  };
  globalThis[key] = handler;
  addEventListener('message', handler);
}

export async function projectFramePoint(nonce, point) {
  if (window === top) return { ok: true, value: point };
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve({ ok: false, error: 'Iframe point translation timed out' }); }, 2500);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    parent.postMessage({ buddyFramePoint: nonce, ...point }, '*', [channel.port2]);
  });
}
