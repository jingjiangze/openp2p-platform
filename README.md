# o2p-platform

Handshake-only room platform for running [openp2p](https://openp2p.cn) tunnels as a service:
it registers game rooms, spawns one openp2p forward per p2p room, and answers the join link
with exactly **one HTTP 302**. Game bytes never transit this host — once the redirect is
sent, players talk to the game server (or to each other, through the P2P tunnel) directly.

## Room kinds

**p2p room** — `POST /api/room {"hostNode":"<host's openp2p node>","code":"ABCD","upstream?":"https://<fallback>"}`

The platform starts a foreground `openp2p` forward per room
(`-node ecs-<id> -peernode <hostNode> -dstport 3000 -srcport <port>`). The *joiner's* own
openp2p client maps the host's game port onto `127.0.0.1:<srcPort>` on their machine, so
`GET /go/<id>` redirects players to their own loopback: game traffic runs host ⇄ joiner
through the tunnel, never through this host. The forward process exists only so the
platform can answer "is the host reachable right now?" (process alive + handshake lines in
its log + TCP probe on the srcport). If the tunnel is down and an `upstream` fallback was
registered and answers `/healthz`, `/go/<id>` redirects there instead (`&o2pfallback=1`) —
which means a **fresh room**: match state lives in the game server's memory and cannot
migrate between hosts. Without any reachable target it redirects to the joiner's loopback
with `&o2pretry=1`.

**direct room** — `POST /api/room {"upstream":"https://<public game server>","code":"ABCD"}`

For public servers that cannot run an openp2p node (e.g. a ModelScope studio container:
no root, locked port). `GET /go/<id>` is a pure 302 to the upstream. Zero processes, zero
proxies, zero installed clients — players only ever click a link.

## REST

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/room` | open a room; body `{hostNode?, code?, srcPort?, upstream?}` (at least one of hostNode/upstream) |
| `GET` | `/api/room/<id>` | join parameters: `{kind, hostNode, upstream, fallback, code, dstPort, srcPort, token, joinUrl, expiresAt, ready}` |
| `DELETE` | `/api/room/<id>` | close the room and stop its forward |
| `GET` | `/api/rooms` | list rooms (same shape) |
| `GET` | `/api/health` | `{ok, rooms, uptime}` |
| `GET` | `/api/config` | platform-wide join parameters |
| `GET` | `/go/<id>` | the join entry: one 302, see above |

Validation enforced on `POST /api/room`: upstream must be an https origin with no path,
and its hostname must match `O2P_UPSTREAM_ALLOW` (default: `ms.show` / `modelscope.cn` /
`jiangjiangze.icu` suffixes — tighten it for your own deployment); `hostNode` is
8–63 chars `[A-Za-z0-9._-]`; `srcPort` (the port the **joiner** maps the game onto
locally) is an integer 1024–65535 and defaults to the game port. A `code` is the game's
room key, appended to every redirect as `?room=`.

Rooms expire after `ROOM_TTL_SEC` (default 6 h); a per-minute sweep stops forwards and
prunes them. State is a JSON file under `O2P_STATE_DIR` — after a restart, p2p rooms'
forwards are respawned automatically.

## Configuration (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8081` | API listen port (bound to 127.0.0.1 — put nginx in front) |
| `O2P_BIN` | `/usr/local/bin/openp2p` | path to the openp2p binary |
| `O2P_TOKEN` | *(empty)* | the openp2p mesh token (a **bare int64**, quoting it in CLI args parses as 0) |
| `O2P_DST_PORT` | `3000` | the host's game port |
| `O2P_SHARE_BW` | `0` | bandwidth the ECS shares; `0` = signalling only, no relay |
| `O2P_RELAY_NODE` | *(empty)* | this host's own node name, used as `-relaynode` only when `SHARE_BW > 0` (never a public relay) |
| `ROOM_BASE_DOMAIN` | `jiangjiangze.icu` | per-room subdomain base (reserved for future per-room DNS) |
| `ROOM_APEX_HOST` | `p2p.jiangjiangze.icu,aliyun.jiangjiangze.icu` | comma list; the first is used for `joinUrl` |
| `ROOM_TTL_SEC` | `21600` | room lifetime |
| `O2P_PROBE_TIMEOUT_MS` | `2500` | TCP/fallback probe timeout |
| `O2P_UPSTREAM_ALLOW` | see validation | regex on upstream hostnames |
| `O2P_STATE_DIR` | `/var/lib/o2p-platform` | rooms.json + per-room forward logs |

## Deploying

`deploy/` holds the templates used in production:

- `o2p-platform.service` — systemd unit; **secrets stay in `/etc/o2p-platform/env`
  (`EnvironmentFile`, chmod 600), never in the unit or the repo**.
- `nginx.conf` — reverse proxy for the apex hosts (and the reserved
  `<roomId>.<base>` wildcard vhost), websocket-ready, long read timeouts.
- `test-fake-host.mjs` — a stand-in game host (HTTP on 3000 + an openp2p node) for
  end-to-end checks on the server.

```sh
sudo install -m 755 o2p-platform.mjs /usr/local/sbin/
sudo mkdir -p /var/lib/o2p-platform /etc/o2p-platform
echo 'O2P_TOKEN=<your int64 token>' | sudo tee /etc/o2p-platform/env
sudo chmod 600 /etc/o2p-platform/env
sudo cp deploy/o2p-platform.service /etc/systemd/system/
sudo systemctl enable --now o2p-platform
```

The server listens on 127.0.0.1 only; expose it through nginx + your TLS front (production
uses Cloudflare tunnels on the apex domains).

## Testing

`test-v3-local.mjs` is the full local smoke (22 checks) and needs **no network**: it
stands up a fake fallback upstream, a fake game server, and a stub openp2p binary that
listens on the forward's srcport and logs a successful handshake. It covers: direct-room
pure 302, input validation (non-https / non-allowlisted / short hostNode / empty body /
srcPort bounds), tunnel-up redirect to the joiner's own loopback, dead-tunnel fallback
with `o2pfallback=1`, no-fallback retry with `o2pretry=1`, explicit `srcPort` honouring,
`/api/config` relay posture, health/rooms, and the `joinUrl` shape.

```sh
node --check o2p-platform.mjs
node test-v3-local.mjs    # exits 0 on "ALL LOCAL CHECKS PASS"
```

The test overrides `O2P_TOKEN` (or takes `O2P_TOKEN_TEST` from the environment) — the
stub never dials the real mesh, so the value is only checked for being echoed into room
parameters.

## Security posture

- The platform holds one openp2p token and hands it out through `/api/room/<id>` to
  anyone who knows a room id: keep room ids unguessable (they are: 4 random bytes hex)
  or rotate to a client-side provisioned token if you need stricter tenancy.
- Upstream allowlisting exists so the platform can never be turned into an open
  redirect/proxy to arbitrary hosts. Keep the regex tight.
- `body` is capped at 64 KiB; every handler is wrapped so one bad request cannot take
  the process down; a failed forward spawn is logged, not thrown (it would otherwise kill
  every room).
- Game traffic paths were deliberately designed out of this host (v3): if you need relay
  capacity, raise `O2P_SHARE_BW` and set `O2P_RELAY_NODE` to your own node — the code
  refuses to relay through anything else.

## Related

- Game-server side (rooms register themselves and publish `inviteUrl`): see the
  `openp2p 服务端接入` page on the project docs site and `docs/openp2p-platform.md` there.
