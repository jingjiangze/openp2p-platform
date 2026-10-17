#!/usr/bin/env node
// Test stand-in for a game HOST: an HTTP server on 127.0.0.1:3000 + an openp2p node
// so a room forward can be created against it. Usage (on the ECS):
//   FAKE_NODE=fakehost-xxxx O2P_TOKEN=<token> node test-fake-host.mjs
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const NODE = process.env.FAKE_NODE || 'fakehost-test01';
const TOKEN = process.env.O2P_TOKEN || '';
const DIR = '/var/lib/o2p-platform/fakehost';

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`FAKE-HOST-OK node=${NODE} path=${req.url} host=${req.headers.host}\n`);
}).listen(3000, '127.0.0.1', () => console.log('fake host HTTP on 127.0.0.1:3000'));

fs.mkdirSync(DIR, { recursive: true });
const out = fs.openSync(DIR + '/node.log', 'a');
const child = spawn('/usr/local/bin/openp2p', ['-nv', '-newconfig', '-node', NODE, '-token', TOKEN, '-sharebandwidth', '0'],
  { cwd: DIR, detached: true, stdio: ['ignore', out, out] });
child.unref();
console.log(`fake host openp2p node=${NODE} pid=${child.pid}`);
