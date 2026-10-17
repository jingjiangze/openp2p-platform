#!/usr/bin/env node
// openp2p platform — fast-access API + per-room openp2p forward manager.
//
// Two room kinds:
//
//   p2p room     POST /api/room {hostNode, code?, upstream?}
//                One dedicated foreground `openp2p` process per room:
//                  -node ecs-<id> -token T -appname room-<id> -peernode <hostNode>
//                  -dstport 3000 -srcport <port> [-relaynode <ecs>] -sharebandwidth S
//                Game traffic goes host <-> joiner DIRECTLY (through the openp2p
//                tunnel); this process never touches game bytes. When `upstream`
//                is also given, /go/<id> redirects there if the tunnel fails.
//
//   direct room  POST /api/room {upstream, code?}
//                A public game server that cannot run an openp2p node (e.g. a
//                ModelScope studio container: no root/systemd, port locked).
//                /go/<id> is a pure 302 to the upstream — the players' browsers
//                talk to that server DIRECTLY, nothing is proxied here.
//
// Join entry (both kinds): https://<APEX>/go/<id>  -> 302 (to the joiner's own local
// game page when the tunnel is up, or to the fallback upstream when it is not).
//
// REST:
//   GET    /api/health | /api/config | /api/rooms | /api/room/<id>
//   POST   /api/room   | DELETE /api/room/<id>

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT || 8081);
const O2P = process.env.O2P_BIN || '/usr/local/bin/openp2p';
const TOKEN = process.env.O2P_TOKEN || '';
const DST_PORT = Number(process.env.O2P_DST_PORT || 3000);
const SHARE_BW = process.env.O2P_SHARE_BW || '0';
const RELAY_NODE = (process.env.O2P_RELAY_NODE || '').trim(); // our own node name, used as -relaynode when sharing bandwidth
const BASE_DOMAIN = (process.env.ROOM_BASE_DOMAIN || 'jiangjiangze.icu').toLowerCase();
const APEX_HOSTS = (process.env.ROOM_APEX_HOST || 'p2p.jiangjiangze.icu,aliyun.jiangjiangze.icu').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const UPSTREAM_ALLOW = process.env.O2P_UPSTREAM_ALLOW || '\\.(ms\\.show|modelscope\\.cn|jiangjiangze\\.icu)$';
const APEX_HOST = APEX_HOSTS[0];
const TTL = Number(process.env.ROOM_TTL_SEC || 6 * 3600);
const PROBE_TIMEOUT_MS = Number(process.env.O2P_PROBE_TIMEOUT_MS || 2500);
const BASE_DIR = process.env.O2P_STATE_DIR || '/var/lib/o2p-platform';
const ROOMS_DIR = path.join(BASE_DIR, 'rooms');
const STATE = path.join(BASE_DIR, 'rooms.json');
const PORT_MIN = 30000, PORT_MAX = 30200;

const log = (...a) => console.log(new Date().toISOString(), ...a);

let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { rooms = {}; }

const save = () => { fs.mkdirSync(BASE_DIR, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(rooms, null, 2)); };
const allocPort = () => {
  const used = new Set(Object.values(rooms).map(r => r.localPort));
  for (let p = PORT_MIN; p <= PORT_MAX; p++) if (!used.has(p)) return p;
  throw new Error('no free forward port');
};

function startForward(room) {
  if (room.upstream && !room.hostNode) return; // direct room: no forward at all
  const dir = path.join(ROOMS_DIR, room.id);
  fs.mkdirSync(dir, { recursive: true });
  const args = ['-nv', '-newconfig',
    '-node', `ecs-${room.id}`, '-token', TOKEN,
    '-appname', `room-${room.id}`, '-peernode', room.hostNode,
    '-dstport', String(DST_PORT), '-srcport', String(room.localPort),
    '-protocol', 'tcp', '-sharebandwidth', SHARE_BW];
  // Only ever relay through OUR OWN node (never the public shared network), and
  // only when this node actually shares bandwidth (sharebandwidth>0).
  if (RELAY_NODE && Number(SHARE_BW) > 0) args.push('-relaynode', RELAY_NODE);
  const out = fs.openSync(path.join(dir, 'forward.log'), 'a');
  // O2P_INTERP lets a test run the "binary" through an interpreter (Node refuses
  // to spawn a .cmd without a shell). Production leaves it empty and spawns the
  // real openp2p binary directly. Layout: <interp...> <O2P> <args...>
  const interp = process.env.O2P_INTERP ? process.env.O2P_INTERP.split(' ') : [];
  const child = spawn(interp[0] || O2P, [...interp.slice(1), O2P, ...args], { cwd: dir, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  // An unhandled 'error' (binary missing / not executable / ENOENT) would take
  // the whole platform down with it — every room, not just this one.
  child.on('error', e => log(`room ${room.id}: forward spawn failed: ${e.message}`));
  child.on('exit', (code, sig) => log(`room ${room.id}: forward exited code=${code} sig=${sig}`));
  room.pid = child.pid;
  log(`room ${room.id}: forward pid=${room.pid} ${room.hostNode}:${DST_PORT} -> 127.0.0.1:${room.localPort}${RELAY_NODE && Number(SHARE_BW) > 0 ? ` (relaynode ${RELAY_NODE})` : ''}`);
}

function stopForward(room) {
  if (!room || !room.pid) return;
  for (const sig of ['SIGTERM', 'SIGKILL']) { try { process.kill(room.pid, sig); } catch {} }
  log(`room ${room.id}: forward pid=${room.pid} stopped`);
  room.pid = null;
}

// Can this platform's forward actually deliver the host's game port right now?
// The platform only needs this to decide "redirect to the fallback or not"; it
// never proxies game traffic in either case.
//
// Three signals, all required:
//   1. the forward process is alive
//   2. its log shows a successful handshake (openp2p logs "connection ok" /
//      "sdwan init ok" once the tunnel to the peer is usable) and no failure
//   3. the local srcport accepts a TCP connection
// Signal 2 matters: a live process with a dead tunnel still listens on the
// srcport, so a bare TCP probe would report "up" while every player's request
// would hang.
async function forwardUp(room) {
  if (!room.pid) return false;
  try { process.kill(room.pid, 0); } catch { return false; }   // process gone
  const log_ = (() => { try { return fs.readFileSync(path.join(ROOMS_DIR, room.id, 'forward.log'), 'utf8'); } catch { return ''; } })();
  if (/login fail|auth fail|token.*(invalid|expire|not match)|sdwan init fail|connect server fail|peer offline|relay disconnect/i.test(log_)) return false;
  if (!/(connection ok|sdwan init ok|login ok)/i.test(log_)) return false; // never finished the handshake
  return await new Promise(resolve => {
    const s = new net.Socket();
    let done = false;
    const fin = ok => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(PROBE_TIMEOUT_MS);
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
    s.once('timeout', () => fin(false));
    s.connect(room.localPort, '127.0.0.1');
  });
}

// Probe the fallback upstream's /healthz (read-only, HEAD-ish GET, no game state
// touched). Returns true when the public server answers 2xx/3xx — i.e. it is up
// and worth redirecting players to.
function upstreamUp(room) {
  return new Promise(resolve => {
    const u = new URL(room.upstream);
    // localhost/127.0.0.1 upstreams are only reachable over plain http; every
    // real upstream (ms.show / modelscope / jiangjiangze.icu) is https.
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    const req = (local ? http : https).request({ host: u.hostname, port: local ? u.port || 80 : 443, method: 'GET', path: '/healthz', servername: local ? undefined : u.hostname,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', 'accept': '*/*' } },
      res => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 400); });
    req.setTimeout(PROBE_TIMEOUT_MS, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

const q = room => room.code ? `?room=${encodeURIComponent(room.code)}` : '';
const pub = room => ({
  roomId: room.id,
  kind: room.hostNode ? 'p2p' : 'direct',
  hostNode: room.hostNode || null,
  upstream: room.upstream || null,
  fallback: room.upstream || null,
  code: room.code,
  dstPort: room.hostNode ? DST_PORT : null,
  token: room.hostNode ? TOKEN : null,
  // The port the JOINER maps the host's game port onto on their own machine
  // (openp2p -srcport). It is the joiner's own 127.0.0.1 address — nothing on
  // this host listens on it for them.
  srcPort: room.hostNode ? (room.srcPort || DST_PORT) : null,
  localPort: room.localPort || null,
  serverHost: 'api.openp2p.cn',
  serverPort: 27183,
  relayNode: room.hostNode && RELAY_NODE && Number(SHARE_BW) > 0 ? RELAY_NODE : null,
  wsPath: '/ws',
  protocol: 'tcp',
  joinUrl: `https://${APEX_HOST}/go/${room.id}${q(room)}`,       // entry: 302 -> local game or fallback
  expiresAt: new Date(room.expiresAt).toISOString(),
  ready: room.hostNode ? !!room.pid : true,
});

const send = (res, code, obj, extra = {}) => {
  const b = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  res.writeHead(code, { 'content-type': typeof obj === 'string' ? 'text/plain' : 'application/json', 'content-length': b.length, 'cache-control': 'no-store', ...extra });
  res.end(b);
};
const body = req => new Promise((resolve, reject) => {
  let b = '', n = 0;
  req.on('data', c => { n += c.length; if (n > 65536) { reject(new Error('body too large')); req.destroy(); } else b += c; });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } });
  req.on('error', reject);
});

// Where a joiner's game actually lives for each room kind. This host decides
// the destination and then gets out of the way — it never proxies game bytes.
//
//   direct room  the public game server (browser-direct; this host serves one
//                302 and sees no game traffic at all)
//   p2p room     the joiner's OWN machine: their openp2p client maps the host's
//                game port onto 127.0.0.1:<srcPort> locally, so the game runs
//                player-to-player through the openp2p tunnel. This host runs a
//                forward per room only to answer "is the host reachable?" — that
//                probe is a TCP connect, not a data path.
//
// Fallback: when the host is NOT reachable, /go/<id> sends the joiner to the
// public game server instead (a fresh room — match state lives in the game
// server's memory and cannot migrate between hosts).
function localGameUrl(room, extra) {
  const u = new URL('http://127.0.0.1:' + (room.srcPort || DST_PORT) + '/');
  if (room.code) u.searchParams.set('room', room.code);
  for (const [k, v] of Object.entries(extra || {})) u.searchParams.set(k, v);
  return u.toString();
}

function fallbackGameUrl(room) {
  const u = new URL(room.upstream);
  u.pathname = '/';
  u.hash = '';
  if (room.code) u.searchParams.set('room', room.code);
  u.searchParams.set('o2pfallback', '1');
  return u.toString();
}

async function goRoom(req, res, room) {
  if (!room.hostNode) { // direct room: pure hand-off, players' browsers go straight to the game server
    const u = new URL(room.upstream);
    u.pathname = '/';
    u.hash = '';
    if (room.code) u.searchParams.set('room', room.code);
    return sendRedirect(res, u.toString());
  }
  if (await forwardUp(room)) {
    // Host reachable -> send the joiner to their own local tunnel. The retry
    // marker only says "no fallback is available right now".
    const retry = room.upstream && await upstreamUp(room) ? null : { o2pretry: '1' };
    return sendRedirect(res, localGameUrl(room, retry));
  }
  if (room.upstream && await upstreamUp(room)) return sendRedirect(res, fallbackGameUrl(room));
  return sendRedirect(res, localGameUrl(room, { o2pretry: '1' }));
}

function sendRedirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, rooms: Object.keys(rooms).length, uptime: Math.round(process.uptime()) });
    if (p === '/api/config') return send(res, 200, { serverHost: 'api.openp2p.cn', serverPort: 27183, token: TOKEN, dstPort: DST_PORT, wsPath: '/ws', protocol: 'tcp', baseDomain: BASE_DOMAIN, apexHost: APEX_HOST, apexHosts: APEX_HOSTS, relayNode: RELAY_NODE && Number(SHARE_BW) > 0 ? RELAY_NODE : null, shareBandwidth: Number(SHARE_BW) });
    if (p === '/api/rooms') return send(res, 200, { rooms: Object.values(rooms).map(pub) });
    if (p === '/api/room' && req.method === 'POST') {
      const b = await body(req);
      const upstream = String(b.upstream || '').trim().replace(/\/+$/, '');
      if (upstream) {
        // localhost is accepted only for local testing (O2P_UPSTREAM_ALLOW may
        // widen this); production upstreams must be https origins.
        const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(upstream);
        if (!isLocal && !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(upstream)) return send(res, 400, { error: 'upstream must be an https origin (no path)' });
        if (!isLocal && !new RegExp(UPSTREAM_ALLOW).test(new URL(upstream).hostname)) {
          return send(res, 400, { error: 'upstream host not allowed (ms.show / modelscope.cn / jiangjiangze.icu only)' });
        }
      }
      const hostNode = String(b.hostNode || '').trim();
      if (hostNode && !/^[A-Za-z0-9][A-Za-z0-9._-]{7,62}$/.test(hostNode)) return send(res, 400, { error: 'hostNode must be 8-63 chars [A-Za-z0-9._-]' });
      // The joiner maps the host's game port onto this port on their own machine
      // (openp2p -srcport). Optional; defaults to the host's game port.
      const srcPort = b.srcPort === undefined || b.srcPort === null || b.srcPort === '' ? null : Number(b.srcPort);
      if (srcPort !== null && (!Number.isInteger(srcPort) || srcPort < 1024 || srcPort > 65535)) {
        return send(res, 400, { error: 'srcPort must be an integer 1024-65535' });
      }
      if (!hostNode && !upstream) return send(res, 400, { error: 'hostNode required: 8-63 chars [A-Za-z0-9._-] (or pass upstream for a direct room)' });
      const id = crypto.randomBytes(4).toString('hex');
      const room = { id, hostNode: hostNode || null, upstream: upstream || null, code: b.code ? String(b.code).slice(0, 10) : null, localPort: hostNode ? allocPort() : null, srcPort: hostNode ? (srcPort || DST_PORT) : null, createdAt: Date.now(), expiresAt: Date.now() + TTL * 1000, pid: null };
      rooms[id] = room; if (hostNode) startForward(room); save();
      log(`room ${id}: ${hostNode ? 'p2p' : 'direct'}${upstream ? ` fallback=${upstream}` : ''}${hostNode ? ` host=${hostNode}` : ''}`);
      return send(res, 200, pub(room));
    }
    let m = p.match(/^\/api\/room\/([a-z0-9]{4,32})$/);
    if (m) {
      const room = rooms[m[1]];
      if (!room) return send(res, 404, { error: 'no such room' });
      if (req.method === 'DELETE') { stopForward(room); delete rooms[m[1]]; save(); return send(res, 200, { closed: m[1] }); }
      return send(res, 200, pub(room));
    }
    m = p.match(/^\/go\/([a-z0-9]{4,32})\/?$/);
    if (m) {
      const room = rooms[m[1]];
      if (!room) return send(res, 404, 'no such room\n');
      return goRoom(req, res, room);
    }
    return send(res, 200, `o2p-platform (handshake-only: game bytes never transit this host)
POST /api/room {"hostNode":"<host openp2p node>","code":"ABCD"}                    -> p2p room (direct tunnel)
POST /api/room {"hostNode":"...","srcPort":3000,"upstream":"https://<game-host>","code":"ABCD"} -> p2p room + fallback
POST /api/room {"upstream":"https://<game-host>","code":"ABCD"}                    -> direct room (pure 302)
GET  /api/room/<id>   join params   |  GET /api/rooms  list  |  GET /api/health
GET  /go/<id>         302 -> joiner's own 127.0.0.1:<srcPort> (tunnel up) or the fallback upstream (down)
Web entry: https://${APEX_HOST}/go/<id>
`);
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const room of Object.values(rooms)) if (room.expiresAt && room.expiresAt < now) { stopForward(room); delete rooms[room.id]; }
  save();
}, 60000).unref();

for (const room of Object.values(rooms)) { room.pid = null; try { startForward(room); } catch (e) { log('respawn failed', room.id, e.message); } }
save();

server.listen(PORT, '127.0.0.1', () => log(`o2p-platform API on 127.0.0.1:${PORT} (token ${TOKEN ? 'set' : 'MISSING'}, apex ${APEX_HOST}, base ${BASE_DOMAIN}, sharebw ${SHARE_BW}${RELAY_NODE ? ` relay ${RELAY_NODE}` : ''})`));
