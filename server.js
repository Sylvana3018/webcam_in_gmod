// gSims — MJPEG relay + snapshot uploader (secure, minimal UI)
// Modernized UI, centered/zoomed camera, and JWT-based access control.
//
// Security overview:
// - If GSIMS_JWT_SECRET is set: /jpg/:sid, /mjpg/:sid and /ws require a valid JWT
//   with { sid: "<SteamID64>", scope: "view" | "upload" } and a (short) exp.
// - Tokens can be minted via POST /issue when you pass X-API-Key that equals GSIMS_API_KEY.
// - If GSIMS_JWT_SECRET is NOT set, the server runs in "open mode" (legacy behavior).
//
// Env:
//   PORT=4873
//   GSIMS_JWT_SECRET=super-long-random
//   GSIMS_API_KEY=another-long-random (only needed if you want to mint tokens via /issue)
//   NODE_ENV=production
//
// Install deps once:
//   npm i express ws helmet express-rate-limit jsonwebtoken compression dotenv

'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const compression = require('compression');
require('dotenv').config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4873;
const JWT_SECRET = process.env.GSIMS_JWT_SECRET || null; // if null => open mode
const API_KEY = process.env.GSIMS_API_KEY || null;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Trust reverse proxy if any (set if you use nginx/caddy)
// app.set('trust proxy', 1);

// ========== Storage (in-memory, no disk) ==========
/** @type {Map<string, Buffer>} sid64 -> latest JPEG */
const latest = new Map();
/** @type {Map<string, Set<import('http').ServerResponse>>} sid64 -> Set(res) multipart watchers */
const watchers = new Map();

// ========== Helpers ==========
function noCache(res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function pushFrame(sid, buf) {
  latest.set(sid, buf);
  const set = watchers.get(sid);
  if (!set) return;
  const head = '--gsims\r\nContent-Type: image/jpeg\r\nContent-Length: ' + buf.length + '\r\n\r\n';
  for (const res of set) {
    try {
      res.write(head);
      res.write(buf);
      res.write('\r\n');
    } catch (e) {
      try { res.end(); } catch (_) {}
      set.delete(res);
    }
  }
}

function bearerOrQueryToken(req) {
  const h = req.headers['authorization'];
  if (h && typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim();
  if (req.query && typeof req.query.t === 'string') return req.query.t;
  return null;
}

function verifyTokenOrOpen(scopeCheck) {
  // scopeCheck: (payload, req) => boolean
  const openMode = !JWT_SECRET;
  return (req, res, next) => {
    if (openMode) return next(); // legacy compatibility
    try {
      const tok = bearerOrQueryToken(req);
      if (!tok) return res.status(401).json({ ok: false, error: 'missing_token' });
      const payload = jwt.verify(tok, JWT_SECRET, { algorithms: ['HS256'] });
      if (typeof scopeCheck === 'function' && !scopeCheck(payload, req)) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      // Attach payload for downstream usage
      req.jwt = payload;
      next();
    } catch (e) {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
  };
}

// Scopes:
// - view: GET /jpg/:sid and /mjpg/:sid for that sid
// - upload: WS /ws?sid=... for that sid
const viewGuard = verifyTokenOrOpen((p, req) => {
  const sid = String(req.params.sid || '');
  return p && p.sid === sid && p.scope === 'view';
});

// Helmet, compression, parsers, rate limiting
app.use(helmet({
  // keep defaults; frameguard keeps our uploader content tighter
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// careful with limits: snapshot polling can be frequent
const jpgLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3000, // allow up to 3000 req/min per IP for images (50 fps * multi)
  standardHeaders: true,
  legacyHeaders: false
});
const pageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // page/action endpoints
  standardHeaders: true,
  legacyHeaders: false
});

// ========== Minimal landing ==========
app.get('/', pageLimiter, (req, res) => {
  noCache(res);
  // redirect to uploader (nice to have)
  res.redirect('/uploader');
});

// ========== MJPEG stream (legacy compatibility) ==========
app.get('/mjpg/:sid', jpgLimiter, viewGuard, (req, res) => {
  const sid = String(req.params.sid || '0');
  noCache(res);
  res.writeHead(200, {
    'Connection': 'keep-alive',
    'Content-Type': 'multipart/x-mixed-replace; boundary=gsims'
  });
  if (!watchers.has(sid)) watchers.set(sid, new Set());
  const set = watchers.get(sid);
  set.add(res);
  req.on('close', () => set.delete(res));
  res.on('error', () => set.delete(res));
  const buf = latest.get(sid);
  if (buf) {
    try {
      res.write('--gsims\r\nContent-Type: image/jpeg\r\nContent-Length: ' + buf.length + '\r\n\r\n');
      res.write(buf); res.write('\r\n');
    } catch (_) {}
  }
});

// ========== Snapshot endpoint (polled by clients) ==========
app.get('/jpg/:sid', jpgLimiter, viewGuard, (req, res) => {
  const sid = String(req.params.sid || '0');
  noCache(res);
  const buf = latest.get(sid);
  if (!buf) { res.status(204).end(); return; }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
});

// ========== Status (admin only if JWT on; open otherwise) ==========
app.get('/status', pageLimiter, verifyTokenOrOpen((p) => p.scope === 'admin'), (req, res) => {
  noCache(res);
  res.json({
    mode: JWT_SECRET ? 'secure' : 'open',
    streams: Array.from(latest.keys()),
    watchers: Object.fromEntries(Array.from(watchers.entries()).map(([k, v]) => [k, v.size]))
  });
});

// ========== Token issue (server-to-server) ==========
// Use this from your GMod **server** only (NEVER from clients).
// POST /issue { sid, scope: "view"|"upload", ttlSeconds? }
// Header: X-API-Key: <GSIMS_API_KEY>
app.post('/issue', pageLimiter, (req, res) => {
  noCache(res);
  if (!JWT_SECRET || !API_KEY) return res.status(501).json({ ok: false, error: 'not_configured' });
  const key = req.get('X-API-Key') || '';
  if (key !== API_KEY) return res.status(403).json({ ok: false, error: 'bad_api_key' });
  const sid = String(req.body.sid || '');
  const scope = String(req.body.scope || '');
  if (!sid || !/^\d+$/.test(sid)) return res.status(400).json({ ok: false, error: 'bad_sid' });
  if (!['view', 'upload', 'admin'].includes(scope)) return res.status(400).json({ ok: false, error: 'bad_scope' });
  const ttl = Math.max(30, Math.min(86400 * 7, parseInt(req.body.ttlSeconds || '3600', 10))); // 30s..7d
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const token = jwt.sign({ sid, scope, exp }, JWT_SECRET, { algorithm: 'HS256' });
  res.json({ ok: true, token, exp });
});

// ========== Minimal, dark, centered uploader UI ==========
app.get('/uploader', pageLimiter, (req, res) => {
  noCache(res);
  const q = req.query || {};
  const sid = (q.sid || '').toString();
  const fps = Math.max(1, Math.min(30, parseInt(q.fps || '12', 10)));
  const quality = Math.max(0.1, Math.min(1.0, parseFloat(q.quality || '0.7')));
  const tok = (q.t || '').toString(); // optional; required in secure mode
  const wsProto = req.protocol === 'https' ? 'wss' : 'ws';
  const wsURL = `${wsProto}://${req.headers.host}/ws?sid=${encodeURIComponent(sid)}${tok ? '&t=' + encodeURIComponent(tok) : ''}`;
  const jpgURL = `/jpg/${encodeURIComponent(sid)}${tok ? '?t=' + encodeURIComponent(tok) : ''}`;
  const mjpgURL = `/mjpg/${encodeURIComponent(sid)}${tok ? '?t=' + encodeURIComponent(tok) : ''}`;

  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>gSims — Camera connection</title>
<style>
  :root{
    --bg:#0b0d10; --panel:#111418; --fg:#e8eaee; --muted:#93a1b133;
    --acc:#86b7ff; --ok:#37d67a; --err:#ff5c5c; --ring:#ffffff1a;
  }
  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    display:flex; align-items:center; justify-content:center; padding:24px;
  }
  .card{
    width:min(860px,100%); background:var(--panel); border-radius:16px;
    box-shadow:0 10px 30px rgba(0,0,0,.35); padding:24px; position:relative;
  }
  .brand{font-size:12px; letter-spacing:.04em; color:#b3b9c6; opacity:.8; margin-bottom:4px}
  .title{font-size:20px; font-weight:600; margin-bottom:18px}
  .grid{display:grid; gap:18px; grid-template-columns: 1fr 300px}
  @media (max-width:860px){ .grid{grid-template-columns:1fr} }
  .camWrap{
    aspect-ratio:1/1; width:100%; max-width:560px; margin:auto; position:relative;
    border-radius:50%;
    box-shadow:0 0 0 1px var(--ring), 0 16px 60px rgba(0,0,0,.5);
    overflow:hidden; background:black;
  }
  video,canvas{
    position:absolute; inset:0; width:100%; height:100%;
    object-fit:cover; transform:scale(1.08); /* subtle zoom-in */
    filter:contrast(1.03) saturate(1.02);
  }
  .col{display:flex; flex-direction:column; gap:12px}
  .row{display:flex; gap:10px; align-items:center}
  label{min-width:70px; color:#cbd5e1}
  input[type=text], input[type=number]{
    flex:1; background:#0f1318; border:1px solid #1a1f26;
    color:var(--fg); border-radius:10px; padding:10px 12px; outline:none;
  }
  input[type=number]{max-width:110px}
  input::placeholder{color:#8b98a6}
  .btn{
    appearance:none; border:1px solid #1a1f26; border-radius:12px; padding:10px 14px;
    background:#131820; color:var(--fg); cursor:pointer; font-weight:600;
  }
  .btn:disabled{opacity:.5; cursor:not-allowed}
  .btn.ok{border-color:#1e3b2d; background:#0e1f16}
  .links{display:flex; gap:10px; flex-wrap:wrap}
  .link{color:var(--acc); text-decoration:none; padding:8px 10px; border-radius:8px; background:#0f141d; border:1px solid #1a1f26}
  .log{white-space:pre; height:200px; overflow:auto; background:#0f141a; border:1px solid #1a1f26; padding:10px; border-radius:12px}
  .top{position:absolute; left:24px; top:22px; opacity:.9}
  .top small{display:block; color:#9aa4b2; margin-bottom:6px}
</style>
</head>
<body>
  <div class="card">
    <div class="top">
      <div class="brand">@maryblackfild dev</div>
      <div class="title">Camera connection</div>
    </div>
    <div class="grid" style="margin-top:56px">
      <div class="camWrap">
        <video id="v" autoplay playsinline muted></video>
        <canvas id="c" style="display:none"></canvas>
      </div>
      <div class="col">
        <div class="row"><label>SID</label><input id="sid" type="text" placeholder="SteamID64" value="${sid}"></div>
        <div class="row">
          <label>FPS</label><input id="fps" type="number" min="1" max="30" value="${fps}">
          <label>JPEG</label><input id="q" type="number" min="0.1" max="1.0" step="0.05" value="${quality}">
        </div>
        <div class="row">
          <label>Token</label><input id="tok" type="text" placeholder="${JWT_SECRET ? 'Required in secure mode' : 'Optional'}" value="${tok}">
        </div>
        <div class="row">
          <button id="start" class="btn ok">Start</button>
          <button id="stop"  class="btn" disabled>Stop</button>
        </div>
        <div class="links">
          <a class="link" id="mjpg" href="${mjpgURL}" target="_blank">Open MJPEG</a>
          <a class="link" id="jpg"  href="${jpgURL}"  target="_blank">Open Snapshot</a>
        </div>
        <div class="log" id="log"></div>
      </div>
    </div>
  </div>
<script>
  let ws = null, timer = null, v = document.getElementById('v'), c = document.getElementById('c'), ctx;
  const $ = (id)=>document.getElementById(id);
  function log(){ const s=[...arguments].join(" "); console.log(s); const el=$('log'); el.textContent+=s+"\\n"; el.scrollTop=el.scrollHeight; }
  function setEnabled(b){ $('start').disabled=!b; $('stop').disabled=b; }

  function buildWsURL(){
    const sid = $('sid').value.trim();
    const tok = $('tok').value.trim();
    const proto = location.protocol==='https:'?'wss':'ws';
    let u = proto+'://'+location.host+'/ws?sid='+encodeURIComponent(sid);
    if (tok) u += '&t='+encodeURIComponent(tok);
    return u;
  }
  function refreshLinks(){
    const sid = $('sid').value.trim();
    const tok = $('tok').value.trim();
    let jpg = location.origin + '/jpg/' + encodeURIComponent(sid);
    let mjpg = location.origin + '/mjpg/' + encodeURIComponent(sid);
    if (tok) { jpg += '?t='+encodeURIComponent(tok); mjpg += '?t='+encodeURIComponent(tok); }
    $('jpg').href = jpg; $('mjpg').href = mjpg;
  }

  async function start(){
    const sid = $('sid').value.trim();
    const fps = Math.max(1, Math.min(30, parseInt($('fps').value||'12',10)));
    const q   = Math.max(0.1, Math.min(1.0, parseFloat($('q').value||'0.7')));
    const tok = $('tok').value.trim();
    if(!sid){ alert('Enter SteamID64'); return; }
    if (${JWT_SECRET ? 'true' : 'false'} && !tok){ alert('Token required on this server'); return; }

    try{
      const s = await navigator.mediaDevices.getUserMedia({ video:{ width:360, height:360, frameRate:fps }, audio:false });
      v.srcObject = s; log('[uploader] Camera OK');
    }catch(e){ log('[uploader] getUserMedia failed: '+(e.name||e)); return; }

    c.width=360; c.height=360; ctx=c.getContext('2d',{alpha:false, desynchronized:true});
    const wsURL = buildWsURL();
    try{
      ws = new WebSocket(wsURL); ws.binaryType='arraybuffer';
      ws.onopen = ()=>{ log('[uploader] WS open '+wsURL); setEnabled(false);
        timer = setInterval(()=>{ try{
          ctx.drawImage(v,0,0,360,360);
          c.toBlob(b => b && ws && ws.readyState===1 && ws.send(b), 'image/jpeg', q);
        }catch(e){} }, Math.floor(1000/fps));
      };
      ws.onclose = (ev)=>{ log('[uploader] WS close '+ev.code); stop(); };
      ws.onerror = ()=>{ log('[uploader] WS error'); stop(); };
    }catch(e){ log('[uploader] WS create failed: '+e); }
    refreshLinks();
  }

  function stop(){
    if(timer){ clearInterval(timer); timer=null; }
    try{ if(ws) ws.close(); }catch(e){}
    setEnabled(true);
  }

  $('start').onclick = start;
  $('stop').onclick = stop;
  $('sid').oninput = refreshLinks;
  $('tok').oninput = refreshLinks;
  refreshLinks();
</script>
</body></html>`);
});

// ========== WS upgrade with auth ==========
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const sid = String(url.searchParams.get('sid') || '0');
    if (JWT_SECRET) {
      const tok = String(url.searchParams.get('t') || '');
      if (!tok) { socket.destroy(); return; }
      try {
        const p = jwt.verify(tok, JWT_SECRET, { algorithms: ['HS256'] });
        if (!(p && p.sid === sid && p.scope === 'upload')) { socket.destroy(); return; }
      } catch (e) { socket.destroy(); return; }
    }
    socket.setNoDelay(true);
    wss.handleUpgrade(req, socket, head, (ws) => { ws.sid = sid; wss.emit('connection', ws, req); });
  } catch (_) {
    try { socket.destroy(); } catch (e) {}
  }
});

// ========== WS events ==========
wss.on('connection', ws => {
  let frames = 0, t = Date.now();
  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    pushFrame(ws.sid, buf);
    frames++; const now = Date.now();
    if (now - t > 2000) { frames = 0; t = now; }
  });
  ws.on('error', ()=>{});
});

// ========== Start ==========
server.listen(PORT, () => {
  console.log(`[gSims] MJPEG relay listening on http://127.0.0.1:${PORT} (${JWT_SECRET ? 'SECURE' : 'OPEN'} mode)`);
});
