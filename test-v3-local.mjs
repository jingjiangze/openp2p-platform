// Local smoke test for o2p-platform v3 (handshake-only + fallback).
// Exercises: pure-302 direct rooms, p2p rooms with a fallback upstream, the
// fallback decision logic (tunnel down -> 302 to fallback), and API shape.
// Nothing here touches a real network except the fallback probe, which is
// pointed at a local fake server.
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_PORT = 18081;
const FAKE_UP_PORT = 18091;   // stands in for ms.show (http, but allowlist lets *.jiangjiangze.icu through)
const GAME_PORT = 18092;      // stands in for the host's openp2p-forwarded game port

// fake fallback upstream: /healthz 200
const fakeUp = http.createServer((req, res) => {
  if (req.url.startsWith('/healthz')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>fake fallback</title>');
});
fakeUp.listen(FAKE_UP_PORT, '127.0.0.1');

// stand-in for the host's game server behind the forward
const fakeGame = http.createServer((req, res) => { res.writeHead(200); res.end('game'); });
fakeGame.listen(GAME_PORT, '127.0.0.1');

// stub openp2p: a Node script (not .cmd — Node 24 on Windows refuses to spawn
// .cmd without shell:true, which would mask real behaviour). It parses the
// args, then listens on the room's srcport so forwardUp()'s TCP probe passes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'o2p-test-'));
const stub = path.join(tmp, 'fake-openp2p.mjs');
// Node on this box lives under "C:\Program Files" — copy it somewhere
// space-free so O2P_ARGS_PREFIX survives the split(' ').
const nodeCopy = path.join(tmp, 'node.exe');
try { fs.copyFileSync(process.execPath, nodeCopy); } catch { /* fall back to execPath */ }
const stubRunner = fs.existsSync(nodeCopy) ? nodeCopy : process.execPath;
fs.writeFileSync(stub, `import net from 'node:net';
const a = process.argv.slice(2);
let port = 0;
for (let i = 0; i < a.length; i++) if (a[i] === '-srcport') port = Number(a[i + 1]);
if (port) net.createServer().listen(port, '127.0.0.1', () => { console.log('login ok'); console.log('sdwan init ok'); console.log('connection ok'); });
setTimeout(() => process.exit(0), 300000);
`);

const env = {
  ...process.env,
  PORT: String(PLATFORM_PORT),
  O2P_BIN: stub,
  // The stub never dials the real openp2p network; the value only needs to be
  // non-empty so pub() echoes it. CI overrides it with O2P_TOKEN_TEST if set.
  O2P_TOKEN: process.env.O2P_TOKEN_TEST || '0000000000000000001',
  O2P_PROBE_TIMEOUT_MS: '1200',
  ROOM_APEX_HOST: 'p2p.jiangjiangze.icu',
  O2P_RELAY_NODE: 'ecs-relay',
  O2P_SHARE_BW: '0',
  O2P_STATE_DIR: path.join(tmp, 'state'),
  // Run the stub through the interpreter (the stub is a .mjs, not a binary).
  O2P_INTERP: stubRunner,
};
const plat = spawn(process.execPath, [fileURLToPath(new URL('./o2p-platform.mjs', import.meta.url))], { env, stdio: 'inherit' });

const wait = ms => new Promise(r => setTimeout(r, ms));
// Leftover detached stubs from an earlier run hold their srcport, which would
// make a "dead forward" look alive. Clean them before we start.
try {
  const ps = await import('node:child_process');
  ps.execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*fake-openp2p*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"', { stdio: 'ignore' });
} catch { /* nothing to clean */ }
const portOpen = async (port, budgetMs = 15000) => {
  const net = await import('node:net');
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const ok = await new Promise(res => {
      const s = new net.Socket();
      s.setTimeout(600);
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => { s.destroy(); res(false); });
      s.once('timeout', () => { s.destroy(); res(false); });
      s.connect(port, '127.0.0.1');
    });
    if (ok) return true;
    await wait(400);
  }
  return false;
};
const api = `http://127.0.0.1:${PLATFORM_PORT}`;
const post = (p, b) => fetch(api + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || !extra ? '' : '  -> ' + extra)); if (!cond) fails++; };
// follow a redirect WITHOUT following it: report where it points
const locOf = async (p) => {
  const r = await fetch(api + p, { redirect: 'manual' });
  return { status: r.status, location: r.headers.get('location') || '' };
};

await wait(1500);

try {
  // ---- A) direct room: /go is a PURE 302 to upstream, no proxy ----
  let r = await post('/api/room', { upstream: 'https://jingjiangze-stronghold-protocol.ms.show', code: 'ABCD' });
  let room = await r.json();
  check('direct room opens (200)', r.status === 200);
  check('kind=direct, hostNode null, token null', room.kind === 'direct' && room.hostNode === null && room.token === null);
  let g = await locOf(`/go/${room.roomId}`);
  check('direct /go -> 302 to upstream origin (pure hand-off)', g.status === 302 && g.location === 'https://jingjiangze-stronghold-protocol.ms.show/?room=ABCD', g.location);
  await fetch(api + `/api/room/${room.roomId}`, { method: 'DELETE' });

  // ---- B) validation: bad inputs still refused ----
  r = await post('/api/room', { upstream: 'http://evil.example.com' });
  check('non-local http upstream rejected (400)', r.status === 400);
  r = await post('/api/room', { upstream: 'https://evil.example.com' });
  check('non-allowlisted upstream rejected (400)', r.status === 400);
  r = await post('/api/room', { hostNode: 'short' });
  check('short hostNode rejected (400)', r.status === 400);
  r = await post('/api/room', {});
  check('empty body rejected (400)', r.status === 400 && (await r.text()).includes('hostNode required'));
  r = await post('/api/room', { hostNode: 'host-node-1234' });
  check('hostNode without forward upstream accepted', r.status === 200);
  await fetch(api + `/api/room/${(await r.json()).roomId}`, { method: 'DELETE' });

  // ---- C) p2p room with tunnel UP: /go sends the joiner to their OWN machine ----
  //    (stub openp2p listens on the srcport, so forwardUp()'s TCP probe passes)
  r = await post('/api/room', { hostNode: 'host-node-1234', code: 'WXYZ', upstream: `http://127.0.0.1:${FAKE_UP_PORT}` });
  room = await r.json();
  check('p2p+fallback room opens (200)', r.status === 200 && room.kind === 'p2p');
  check('fallback echoed + token present', room.fallback === `http://127.0.0.1:${FAKE_UP_PORT}` && !!room.token);
  check('srcPort defaults to the game port', room.srcPort === 3000, `srcPort=${room.srcPort}`);
  check('relayNode null while sharebandwidth=0', room.relayNode === null);
  const up = await portOpen(room.localPort);
  check('stub forward actually listening on localPort', up, `port=${room.localPort}`);
  g = await locOf(`/go/${room.roomId}`);
  check('p2p tunnel up -> /go points at the joiner own 127.0.0.1:srcPort (no ECS bytes)',
    g.status === 302 && g.location === 'http://127.0.0.1:3000/?room=WXYZ', g.location);
  const roomId = room.roomId;
  await fetch(api + `/api/room/${roomId}`, { method: 'DELETE' });

  // ---- D) p2p room whose forward is dead -> /go falls back ----
  //    Windows detached children survive a plain SIGKILL of the direct child,
  //    so instead of (unreliably) killing the tree, drive the deterministic
  //    "tunnel is not usable" state through the log: forwardUp() treats a
  //    failure line as authoritative.
  r = await post('/api/room', { hostNode: 'host-node-1234', code: 'WXYZ', upstream: `http://127.0.0.1:${FAKE_UP_PORT}` });
  room = await r.json();
  await portOpen(room.localPort);
  const logPath = path.join(env.O2P_STATE_DIR, 'rooms', room.roomId, 'forward.log');
  fs.appendFileSync(logPath, 'peer offline\n');
  g = await locOf(`/go/${room.roomId}`);
  check('dead forward + reachable fallback -> 302 to fallback upstream with o2pfallback=1',
    g.status === 302 && g.location === `http://127.0.0.1:${FAKE_UP_PORT}/?room=WXYZ&o2pfallback=1`, g.location);
  await fetch(api + `/api/room/${room.roomId}`, { method: 'DELETE' });

  // ---- D2) dead forward with NO fallback -> joiner's own machine + retry marker ----
  r = await post('/api/room', { hostNode: 'host-node-1234', code: 'WXYZ' });
  room = await r.json();
  await portOpen(room.localPort);
  fs.appendFileSync(path.join(env.O2P_STATE_DIR, 'rooms', room.roomId, 'forward.log'), 'login fail token invalid\n');
  g = await locOf(`/go/${room.roomId}`);
  check('dead forward + no fallback -> local retry marker', g.status === 302 && g.location === 'http://127.0.0.1:3000/?room=WXYZ&o2pretry=1', g.location);
  await fetch(api + `/api/room/${room.roomId}`, { method: 'DELETE' });

  // ---- D3) caller-chosen srcPort is honoured (launcher dictates its own port) ----
  r = await post('/api/room', { hostNode: 'host-node-1234', code: 'WXYZ', srcPort: 3000 });
  room = await r.json();
  check('explicit srcPort echoed', r.status === 200 && room.srcPort === 3000, `srcPort=${room.srcPort}`);
  await fetch(api + `/api/room/${room.roomId}`, { method: 'DELETE' });
  r = await post('/api/room', { hostNode: 'host-node-1234', srcPort: 80 });
  check('srcPort below 1024 rejected (400)', r.status === 400);

  // ---- E) /api/config advertises relay settings ----
  r = await fetch(api + '/api/config');
  const cfg = await r.json();
  check('config exposes relayNode/shareBandwidth', cfg.shareBandwidth === 0 && cfg.relayNode === null);

  // ---- F) health + rooms list ----
  r = await fetch(api + '/api/health');
  check('health ok', (await r.json()).ok === true);
  r = await fetch(api + '/api/rooms');
  check('rooms list is array', Array.isArray((await r.json()).rooms));

  // ---- G) joinUrl shape unchanged for agents ----
  r = await post('/api/room', { hostNode: 'host-node-1234', code: 'ABCD' });
  room = await r.json();
  check('joinUrl shape', /^https:\/\/p2p\.jiangjiangze\.icu\/go\/[a-f0-9]{8}\?room=ABCD$/.test(room.joinUrl || ''));
  await fetch(api + `/api/room/${room.roomId}`, { method: 'DELETE' });
} catch (e) {
  fails++;
  console.log('FAIL  unexpected: ' + (e && e.stack || e));
} finally {
  plat.kill();
  fakeUp.close();
  fakeGame.close();
  console.log(fails === 0 ? 'ALL LOCAL CHECKS PASS' : `FAILURES: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
