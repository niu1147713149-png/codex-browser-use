export async function reliabilityRoute(req, res) {
  if (req.url === '/buddy-download') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="buddy-check.txt"' }); res.end('Codex Browser Use download check\n'); return true; }
  if (req.url === '/buddy-upload' && req.method === 'POST') {
    const chunks = []; for await (const part of req) chunks.push(part);
    const received = Buffer.concat(chunks).toString().includes('Codex Browser Use upload check');
    res.writeHead(received ? 200 : 400, { 'Content-Type': 'text/plain' }); res.end(received ? 'Server received test file' : 'Missing fixture file'); return true;
  }
  if (req.url?.startsWith('/buddy-missing')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('missing'); return true; }
  if (req.url !== '/reliability') return false;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Browser Use reliability fixture</title>
<style>body{font:16px sans-serif;padding:24px}button,input,select{font:inherit;margin:6px;padding:8px}#cover{display:none;position:fixed;inset:0;background:#aaa;z-index:99}#file{display:none}</style>
<h1>Reliability fixture</h1><button id="stable">Stable action</button><p id="count">Actions: 0</p>
<button id="rerender">Rerender stable</button><button id="history">Change history</button><button id="rename">Change meaning</button>
<button id="ax-image"><img alt="AX image action" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'/%3E"></button><button id="ax-rename">Change AX meaning</button>
<button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>
<button id="prepare">Prepare delayed</button><button id="delayed" disabled>Delayed action</button><p id="delayed-result"></p>
<button id="cover-start">Start overlay</button><button id="covered">Covered action</button><div id="cover"></div><p id="covered-result"></p>
<label>Native label<input id="native" placeholder="Type a query"></label><p id="input-events"></p>
<label>Reject text<input id="reject"></label><label>Agreement<input id="check" type="checkbox"></label>
<label>Choice one<input type="radio" name="choice" value="one"></label><label>Choice two<input type="radio" name="choice" value="two"></label>
<div role="switch" tabindex="0" aria-checked="false" aria-label="Notifications" id="switch">Notifications</div>
<button id="menu" aria-haspopup="listbox">Choose topic</button><div id="options" role="listbox" hidden><div role="option" tabindex="0">AI research</div></div><p id="topic"></p>
<input id="file" type="file" aria-label="Test file"><button id="upload">Upload fixture</button><p id="upload-result"></p>
<button id="prompt">Open prompt</button><p id="dialog-result"></p>
<button id="diagnose">Generate diagnostics</button><p id="diagnostics-result"></p>
<script>
const byId=id=>document.getElementById(id);let count=0;
function wire(){byId('stable').onclick=()=>byId('count').textContent='Actions: '+(++count)}wire();
byId('rerender').onclick=()=>{byId('stable').replaceWith(byId('stable').cloneNode(true));wire()};
byId('history').onclick=()=>history.pushState({},'',location.pathname+'#same-document');
byId('rename').onclick=()=>byId('stable').textContent='Different action';
byId('ax-rename').onclick=()=>byId('ax-image').querySelector('img').alt='Different AX action';
byId('prepare').onclick=()=>{byId('delayed').disabled=true;setTimeout(()=>byId('delayed').disabled=false,450)};
byId('delayed').onclick=()=>byId('delayed-result').textContent='Delayed confirmed';
byId('cover-start').onclick=()=>{byId('cover').style.display='block';setTimeout(()=>byId('cover').style.display='none',650)};
byId('covered').onclick=()=>byId('covered-result').textContent='Covered confirmed';
byId('native').oninput=e=>byId('input-events').textContent='Native input trusted: '+e.isTrusted;
byId('reject').oninput=e=>e.target.value='';
byId('switch').onclick=e=>e.currentTarget.setAttribute('aria-checked',String(e.currentTarget.getAttribute('aria-checked')!=='true'));
byId('menu').onclick=()=>byId('options').hidden=false;
document.querySelector('[role=option]').onclick=()=>{byId('topic').textContent='Topic selected: AI';byId('options').hidden=true};
byId('upload').onclick=async()=>{const data=new FormData();data.append('file',byId('file').files[0]);byId('upload-result').textContent=await(await fetch('/buddy-upload',{method:'POST',body:data})).text()};
byId('prompt').onclick=()=>byId('dialog-result').textContent='Prompt reply: '+prompt('Fixture prompt');
byId('diagnose').onclick=()=>{console.error('token=DO_NOT_RECORD_THIS');fetch('/buddy-missing?token=DO_NOT_RECORD_THIS');byId('diagnostics-result').textContent='Diagnostics triggered'};
</script>`);
  return true;
}
