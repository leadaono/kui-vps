import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
const dir = mkdtempSync(path.join(tmpdir(), 'kui-test-'));
const origin = 'http://127.0.0.1:19381';
const password = 'smoke-test-password-12345';
let child;
async function start() {
 child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '19381', ADMIN_PASSWORD: password, PANEL_ORIGIN: origin, DATABASE_PATH: path.join(dir, 'test.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
 child.stdout.on('data', d => process.stdout.write(d));
 child.stderr.on('data', d => process.stderr.write(d));
 child.on('error', e => console.error('Spawn failed:', e));
 for (let i = 0; i < 100; i++) {
  try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
  if (child.exitCode !== null) throw new Error('Server exited');
  await new Promise(r => setTimeout(r, 100));
 }
 throw new Error('Startup timeout');
}
async function stop() { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; }
try {
 await start();
 assert.equal((await fetch(origin)).status, 200);
 assert.equal((await fetch(origin + '/vps/agent.py')).status, 200);
 for (const file of ['/server.js', '/package.json', '/data/kui.db', '/.env', '/vendor/K-UI/functions/api/test.js']) assert.equal((await fetch(origin + file)).status, 404);
 const login = await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
 assert.equal(login.status, 200, await login.clone().text());
 const { token } = await login.json();
 const headers = { Authorization: 'Bearer ' + token };
 const db = new DatabaseSync(path.join(dir, 'test.db'));
 db.prepare('INSERT INTO servers (ip, name, agent_token) VALUES (?, ?, ?)').run('192.0.2.1', 'smoke-agent', 'test-agent-secret');
 db.close();
 const agent = new WebSocket(origin.replace('http', 'ws') + '/agent/ws?ip=192.0.2.1&role=core', { headers: { Authorization: 'test-agent-secret' } });
 await new Promise((resolve, reject) => { agent.once('message', data => { try { assert.equal(JSON.parse(data).type, 'hello.ok'); resolve(); } catch (e) { reject(e); } }); agent.once('error', reject); setTimeout(() => reject(new Error('Agent timeout')), 5000).unref(); });
 agent.close();
 assert.equal((await fetch(origin + '/dashboard/snapshot')).status, 403);
 const ticketResponse = await fetch(origin + '/dashboard/ticket', { method: 'POST', headers });
 assert.equal(ticketResponse.status, 200);
 const { ticket } = await ticketResponse.json();
 const ws = new WebSocket(origin.replace('http', 'ws') + '/dashboard/ws?ticket=' + ticket);
 await new Promise((resolve, reject) => { ws.once('message', data => { try { assert.equal(JSON.parse(data).type, 'snapshot'); resolve(); } catch (e) { reject(e); } }); ws.once('error', reject); setTimeout(() => reject(new Error('WebSocket timeout')), 5000).unref(); });
 ws.close();
 await stop();
 await start();
 assert.equal((await fetch(origin + '/dashboard/snapshot', { headers })).status, 200, 'session persists after restart');
 console.log('PASS: startup, static allowlist, login, authorization, WebSocket, persistence');
} finally {
 if (child && child.exitCode === null) await stop();
 rmSync(dir, { recursive: true, force: true });
}
