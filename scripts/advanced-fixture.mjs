// Controlled local pages for integration checks; no real user content is used.
export function advancedFixture(path, port) {
  if (path === '/advanced') return `<!doctype html><meta charset="utf-8"><title>Browser Use advanced fixture</title>
<style>body{font:18px sans-serif;margin:24px;min-height:3800px}button,input{font:inherit;margin:8px;padding:8px}iframe{display:block;width:620px;height:420px;border:6px solid #457b68;margin:20px}#slider{width:300px}</style>
<h1>Advanced plugin actions</h1><input aria-label="Native text" id="text"><button aria-label="Double click" id="double">Double click</button><button aria-label="Hover" id="hover">Hover</button>
<p id="events">Ready</p><label>Slider<input aria-label="Drag slider" id="slider" type="range" min="0" max="100" value="0"></label><p id="range">Slider: 0</p>
<iframe src="http://localhost:${port}/frame" title="Cross origin test"></iframe>
<script>double.ondblclick=e=>events.textContent='Double trusted: '+e.isTrusted;hover.onmouseenter=e=>events.textContent='Hover trusted: '+e.isTrusted;slider.oninput=e=>range.textContent='Slider: '+slider.value+' trusted: '+e.isTrusted;</script>`;
  if (path === '/frame') return `<!doctype html><meta charset="utf-8"><title>Child frame</title><style>body{margin:12px}iframe{width:450px;height:160px;border:4px solid #aaa;margin-top:15px}</style>
<input aria-label="Frame text"><button aria-label="Frame click" onclick="document.querySelector('p').textContent='Frame trusted: '+event.isTrusted">Frame click</button><p>Frame ready</p><iframe src="http://127.0.0.1:${port}/nested"></iframe>`;
  if (path === '/nested') return '<!doctype html><meta charset="utf-8"><title>Nested frame</title><button aria-label="Nested click" onclick="document.querySelector(\'p\').textContent=\'Nested trusted: \'+event.isTrusted">Nested click</button><p>Nested ready</p>';
}
