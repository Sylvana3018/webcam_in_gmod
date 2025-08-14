
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4873;
const SHARED_SECRET = String(process.env.GSIMS_SHARED_SECRET || 'devsecret-change-me');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });


const ADMIN_CODE = (process.env.GSIMS_ADMIN_CODE && String(process.env.GSIMS_ADMIN_CODE)) ||
                   crypto.randomBytes(16).toString('hex');

console.log('[gSims] Секретный код админа:', ADMIN_CODE);
console.log(`[gSims] Админ-URL: http://127.0.0.1:${PORT}/admin?code=${ADMIN_CODE}`);
if (SHARED_SECRET === 'devsecret-change-me') {
  console.warn('[gSims] ВНИМАНИЕ: Используется дефолтный GSIMS_SHARED_SECRET. Поменяйте его в проде!');
}

// sid64 -> Buffer(JPEG)
const latest = new Map();
// sid64 -> Set(res) для multipart-наблюдателей
const watchers = new Map();
// sid64 -> Set(ws) активных загрузчиков
const uploaders = new Map();

function corsNoCache(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function pushFrame(sid, buf){
  latest.set(sid, buf);
  const set = watchers.get(sid);
  if (!set) return;
  const head = '--gsims\r\nContent-Type: image/jpeg\r\nContent-Length: '+buf.length+'\r\n\r\n';
  for (const res of set) {
    try { res.write(head); res.write(buf); res.write('\r\n'); }
    catch(e){ try{res.end();}catch(_){} set.delete(res); }
  }
}

// Токен = sha256( SHARED_SECRET .. ":" .. SID64 ) в HEX  — должен совпадать с тем, что выдал GLua.
function tokenForSidHex(sid){
  return crypto.createHash('sha256').update(`${SHARED_SECRET}:${sid}`).digest('hex');
}
function safeEqual(a, b){
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

app.get('/mjpg/:sid', (req, res) => {
  const sid = String(req.params.sid||'0');
  corsNoCache(res);
  res.writeHead(200, { 'Connection':'keep-alive', 'Content-Type':'multipart/x-mixed-replace; boundary=gsims' });
  if (!watchers.has(sid)) watchers.set(sid, new Set());
  const set = watchers.get(sid);
  set.add(res);
  req.on('close', ()=> set.delete(res));
  res.on('error', ()=> set.delete(res));
  const buf = latest.get(sid);
  if (buf) {
    try{
      res.write('--gsims\r\nContent-Type: image/jpeg\r\nContent-Length: '+buf.length+'\r\n\r\n');
      res.write(buf); res.write('\r\n');
    }catch(_){}
  }
});

app.get('/jpg/:sid', (req, res) => {
  const sid = String(req.params.sid||'0');
  corsNoCache(res);
  const buf = latest.get(sid);
  if (!buf) { res.status(204).end(); return; }
  res.setHeader('Content-Type','image/jpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
});

app.get('/status', (req,res)=>{
  corsNoCache(res);
  res.json({
    streams: Array.from(latest.keys()),
    watchers: Object.fromEntries(Array.from(watchers.entries()).map(([k,v])=>[k,v.size])),
    uploaders: Object.fromEntries(Array.from(uploaders.entries()).map(([k,v])=>[k,v.size])),
    ts: Date.now()
  });
});

app.get('/uploader', (req, res) => {
  const q = req.query||{};
  const sid = (q.sid||'').toString();
  const fps = Math.max(1, Math.min(30, parseInt(q.fps||'8',10)));
  const quality = Math.max(0.1, Math.min(1.0, parseFloat(q.quality||'0.6')));
  const token = (q.token||'').toString();

  corsNoCache(res);
  res.send(`<!doctype html><meta charset="utf-8">
<title>gSims · Подключение камеры</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --bg:#0b0b0c; --panel:#111215; --muted:#7b7f87; --text:#e7e9ee; --accent:#8be9fd; --line:#1b1d22;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif}
a{color:var(--accent);text-decoration:none}
.header{padding:28px 20px 8px; text-align:center}
.header .dev{font-weight:600;color:var(--muted);letter-spacing:.08em;font-size:12px;text-transform:uppercase;opacity:.9}
.header h1{margin:6px 0 0;font-size:22px;font-weight:650}
.wrap{display:grid;grid-template-columns:1fr;gap:16px;max-width:920px;margin:22px auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.camWrap{position:relative;display:grid;place-items:center;padding:16px}
.camFrame{width:min(80vmin,520px);aspect-ratio:1/1;background:#000;border-radius:16px;overflow:hidden;border:1px solid var(--line);display:grid;place-items:center}
video,canvas{width:100%;height:100%;object-fit:cover;transform:scale(1.15)}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.input{display:flex;align-items:center;gap:8px;background:#0f1013;border:1px solid var(--line);padding:10px 12px;border-radius:12px}
.input input{background:transparent;border:0;outline:0;color:var(--text);min-width:0}
.select{appearance:none;background:#0f1013;border:1px solid var(--line);color:var(--text);padding:10px 12px;border-radius:12px;min-width:240px}
.btn{appearance:none;border:1px solid var(--line);background:#15171b;color:var(--text);padding:10px 14px;border-radius:12px;cursor:pointer}
.btn[disabled]{opacity:.45;cursor:not-allowed}
.btn.primary{border-color:#1f2a33;background:#1a2630}
.small{color:var(--muted);font-size:12px}
.links{display:flex;gap:12px;margin-top:8px}
#log{white-space:pre-wrap;max-height:220px;overflow:auto;border:1px dashed var(--line);padding:10px;border-radius:12px;background:#0f1013}
.footer{opacity:.7;text-align:center;padding:12px 0 22px;font-size:12px;color:var(--muted)}
.bad{color:#ff9aa2}
.good{color:#8be9fd}
</style>

<div class="header">
  <div class="dev">@maryblackfild dev</div>
  <h1>Подключение камеры</h1>
</div>

<div class="wrap">
  <div class="card camWrap">
    <div class="camFrame"><video id="v" autoplay playsinline muted></video></div>

    <div class="controls">
      <select id="devsel" class="select"><option value="">Выбор камеры…</option></select>
      <div class="input"><span>SID</span><input id="sid" value="${sid}" placeholder="SteamID64" style="width:240px"></div>
      <div class="input"><span>FPS</span><input id="fps" type="number" min="1" max="30" value="${fps}" style="width:72px"></div>
      <div class="input"><span>JPEG</span><input id="q" type="number" step="0.05" min="0.1" max="1.0" value="${quality}" style="width:88px"></div>
      <button class="btn primary" id="start">Запустить</button>
      <button class="btn" id="stop" disabled>Остановить</button>
    </div>

    <div class="links small">
      <span>Стрим: </span>
      <a id="mjpg" target="_blank" rel="noreferrer">MJPEG</a>
      <a id="jpg" target="_blank" rel="noreferrer">Снимок</a>
    </div>

    <div class="small" id="tokInfo"></div>
  </div>

  <div class="card">
    <div class="small" style="margin-bottom:8px">Журнал</div>
    <div id="log"></div>
  </div>
</div>

<div class="footer">gSims · Ретранслятор MJPEG + загрузчик</div>

<script>
let ws,timer,v,c,ctx,curStream;

const sidInit   = ${JSON.stringify(sid)};
const tokenInit = ${JSON.stringify(token)};

function log(){ const s=[...arguments].join(" "); console.log(s); const el=document.getElementById('log'); el.textContent+=s+"\\n"; el.scrollTop=el.scrollHeight; }
function setEnabled(b){ document.getElementById('start').disabled=!b; document.getElementById('stop').disabled=b; }

function tokInfo(){
  const el = document.getElementById('tokInfo');
  if (!sidInit || !tokenInit) {
    el.innerHTML = '<span class="bad">В ссылке отсутствует токен или SID. Сгенерируйте ссылку в меню игры.</span>';
  } else {
    el.innerHTML = '<span class="good">Токен принят. Подключение возможно.</span>';
  }
}

async function stopStream(){
  try {
    if (timer){ clearInterval(timer); timer=null; }
    if (ws) { try{ ws.close(); }catch(e){} }
    if (curStream){
      curStream.getTracks().forEach(t=>t.stop());
      curStream = null;
    }
    setEnabled(true);
  } catch(e){}
}

async function getDevices(){
  try{
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter(d=>d.kind === 'videoinput');
  }catch(e){ return []; }
}

async function populateDevices(){
  const sel = document.getElementById('devsel');
  sel.innerHTML = '<option value="">Выбор камеры…</option>';
  const devs = await getDevices();
  devs.forEach(d=>{
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.text = d.label || ('Камера ' + (sel.options.length));
    sel.appendChild(opt);
  });
}

async function start(){
  const sid = document.getElementById('sid').value.trim() || sidInit;
  const fps = Math.max(1,Math.min(30,parseInt(document.getElementById('fps').value||'8')));
  const q   = Math.max(0.1,Math.min(1.0,parseFloat(document.getElementById('q').value||'0.6')));
  if(!sid){ alert('Введите SteamID64'); return; }
  if(!tokenInit){ alert('Отсутствует токен. Сгенерируйте ссылку из меню в игре.'); return; }

  v=document.getElementById('v');
  const devId = document.getElementById('devsel').value;
  const constraints = { video:{ width:256, height:256, frameRate:fps }, audio:false };
  if (devId) constraints.video.deviceId = { exact: devId };

  try{
    await stopStream();
    const stream=await navigator.mediaDevices.getUserMedia(constraints);
    curStream = stream;
    v.srcObject=stream; log('[uploader] Камера готова');
  }catch(e){ log('[uploader] getUserMedia ошибка:',e.name||e); return; }

  c=document.createElement('canvas'); c.width=256; c.height=256; ctx=c.getContext('2d',{alpha:false,desynchronized:true});
  const proto=location.protocol==='https:'?'wss':'ws';
  const wsURL=proto+'://'+location.host+'/ws'
    + '?sid='   + encodeURIComponent(sid)
    + '&token=' + encodeURIComponent(tokenInit);

  try{
    ws=new WebSocket(wsURL); ws.binaryType='arraybuffer';
    ws.onopen=()=>{ log('[uploader] WS открыт',wsURL); setEnabled(false);
      timer=setInterval(()=>{ try{
        ctx.drawImage(v,0,0,256,256);
        c.toBlob(b=>b&&ws.readyState===1&&ws.send(b),'image/jpeg',q);
      }catch(e){} }, Math.floor(1000/fps));
    };
    ws.onclose=(ev)=>{ log('[uploader] WS закрыт',ev.code); stopStream(); };
    ws.onerror=()=>{ log('[uploader] WS ошибка'); stopStream(); };
  }catch(e){ log('[uploader] не удалось создать WS:', e); }

  document.getElementById('mjpg').href = location.origin + '/mjpg/' + encodeURIComponent(sid);
  document.getElementById('jpg').href  = location.origin + '/jpg/'  + encodeURIComponent(sid) + '?t=' + Date.now();
}

document.getElementById('start').onclick=start;
document.getElementById('stop').onclick=stopStream;
document.getElementById('devsel').addEventListener('change', ()=>{ if(!document.getElementById('start').disabled) return; start(); });

tokInfo();
populateDevices().catch(()=>{});
</script>`);
});

// ---------- adm panel ----------
function isAdmin(req){
  const codeQ = (req.query && req.query.code) ? String(req.query.code) : '';
  const codeH = req.headers['x-gsims-code'] ? String(req.headers['x-gsims-code']) : '';
  return (codeQ === ADMIN_CODE) || (codeH === ADMIN_CODE);
}

app.get('/admin', (req, res) => {
  if (!isAdmin(req)) return res.status(404).send('Not found');
  corsNoCache(res);
  res.send(`<!doctype html><meta charset="utf-8">
<title>gSims · Админ-панель камер</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0b0b0c;--panel:#111215;--muted:#8a8f99;--text:#e7e9ee;--line:#1b1d22;--accent:#8be9fd}
*{box-sizing:border-box}
html,body{height:100%;margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif}
.header{padding:22px 16px;text-align:center}
.header .dev{font-weight:600;color:var(--muted);letter-spacing:.08em;font-size:11px;text-transform:uppercase}
.header h1{margin:6px 0 0;font-size:20px;font-weight:650}
.wrap{max-width:1100px;margin:0 auto;padding:0 16px 22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:8px}
.cam{width:100%;aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:#000;border:1px solid var(--line)}
.cam img{width:100%;height:100%;object-fit:cover}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}
.sid{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;color:var(--muted)}
.btn{appearance:none;border:1px solid var(--line);background:#15171b;color:var(--text);padding:8px 10px;border-radius:10px;cursor:pointer;font-size:13px}
.btn.danger{border-color:#3a2023;background:#2a1518}
.info{color:var(--muted);font-size:12px;margin:0 0 10px}
</style>
<div class="header">
  <div class="dev">@maryblackfild dev</div>
  <h1>gSims · Админ-панель камер</h1>
</div>
<div class="wrap">
  <div class="info">Подключённые загрузчики и их живые MJPEG-потоки. Кнопка «Отключить» разрывает WS.</div>
  <div id="grid" class="grid"></div>
</div>
<script>
const code = ${JSON.stringify(String(req.query.code||''))};
async function fetchStatus(){
  const r = await fetch('/status',{cache:'no-store'});
  if(!r.ok) return;
  const s = await r.json();
  const ids = Object.keys(s.uploaders||{});
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  ids.forEach(sid=>{
    const card = document.createElement('div'); card.className='card';
    const cam = document.createElement('div'); cam.className='cam';
    const img = document.createElement('img'); img.loading='lazy'; img.decoding='async';
    img.src = '/mjpg/'+encodeURIComponent(sid);
    cam.appendChild(img);
    const row = document.createElement('div'); row.className='row';
    const sidEl = document.createElement('div'); sidEl.className='sid'; sidEl.textContent = sid;
    const btn = document.createElement('button'); btn.className='btn danger'; btn.textContent='Отключить';
    btn.onclick = async ()=>{
      btn.disabled = true;
      await fetch('/admin/disconnect/'+encodeURIComponent(sid)+'?code='+encodeURIComponent(code), {method:'POST', headers:{'x-gsims-code':code}});
      setTimeout(refresh, 300);
    };
    row.appendChild(sidEl); row.appendChild(btn);
    card.appendChild(cam); card.appendChild(row);
    grid.appendChild(card);
  });
}
function refresh(){ fetchStatus().catch(()=>{}); }
setInterval(refresh, 1500); refresh();
</script>`);
});


app.post('/admin/disconnect/:sid', (req,res)=>{
  if (!isAdmin(req)) return res.status(404).send('Not found');
  const sid = String(req.params.sid||'');
  const set = uploaders.get(sid);
  if (set) {
    for (const ws of set) { try{ ws.close(4000, 'Admin disconnect'); }catch(_){} }
  }
  latest.delete(sid);
  res.json({ok:true});
});


server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const sid   = String(url.searchParams.get('sid')||'');
  const token = String(url.searchParams.get('token')||'');

  if (!sid || !token || !safeEqual(tokenForSidHex(sid), token)) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true);
  wss.handleUpgrade(req, socket, head, (ws)=>{
    ws.sid = sid;
    wss.emit('connection', ws, req);
  });
});


wss.on('connection', ws => {
  const sid = String(ws.sid||'0');
  if (!uploaders.has(sid)) uploaders.set(sid, new Set());
  uploaders.get(sid).add(ws);

  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    pushFrame(sid, buf);
  });
  ws.on('close', ()=> {
    const set = uploaders.get(sid);
    if (set) { set.delete(ws); if (set.size===0) uploaders.delete(sid); }
  });
  ws.on('error', ()=>{});
});

server.listen(PORT, ()=> console.log('gSims MJPEG relay listening on http://127.0.0.1:'+PORT));
