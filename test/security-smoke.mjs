// Targeted smoke tests for Issue #2 (login throttle XFF bypass) and
// Issue #3 (unbounded request body). Run: node security-smoke.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'kui-sec-test-'));
const PORT = 19383;
const origin = `http://127.0.0.1:${PORT}`;
const password = 'smoke-test-password-12345';
let child;

async function start() {
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: password, PANEL_ORIGIN: origin, DATABASE_PATH: path.join(dir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    if (child.exitCode !== null) throw new Error('Server exited');
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Startup timeout');
}
async function stop() { const done = new Promise(r => child.once('exit', r)); child.kill(); await done; }

function rawPost(pathname, headers, chunks) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers }, res => {
      const bufs = [];
      res.on('data', c => bufs.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(bufs).toString() }));
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

const login = (headers, pw) => fetch(origin + '/api/login', { signal: AbortSignal.timeout(15000),
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ username: 'admin', password: pw }),
});

try {
  await start();

  // ---------- Issue #2: rotating XFF first segment must NOT reset the throttle ----------
  // Simulate production topology: Caddy on loopback overwrites CF-Connecting-IP
  // with the observed remote host and appends it as the last XFF segment.
  // The attacker rotates only the first (self-claimed) XFF segment.
  const asClientA = i => ({ 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': `10.0.0.${i}, 203.0.113.7` });
  for (let i = 1; i <= 8; i++) {
    const r = await login(asClientA(i), 'wrong-password');
    assert.equal(r.status, 401, `attempt ${i} with rotated XFF should be 401, got ${r.status}`);
  }
  const ninth = await login(asClientA(99), 'wrong-password');
  assert.equal(ninth.status, 429, `9th attempt with rotated XFF should be 429, got ${ninth.status}`);
  console.log('PASS #2a: 8 failed logins with rotating XFF first segment -> 401 x8, 9th -> 429 (throttle holds)');

  // Control: a genuinely different client is not blocked by client A's failures.
  const other = await login({ 'CF-Connecting-IP': '203.0.113.8', 'X-Forwarded-For': '198.51.100.9, 203.0.113.8' }, 'wrong-password');
  assert.equal(other.status, 401, `different client should be 401, got ${other.status}`);
  console.log('PASS #2b: different real client IP is keyed separately (401, not 429)');

  // Correct login still works from a fresh client identity.
  const ok = await login({}, password);
  assert.equal(ok.status, 200, 'valid login should succeed');
  const { token } = await ok.json();
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  console.log('PASS #2c: valid login still succeeds');

  // ---------- Issue #3: oversized bodies -> 413, normal bodies unaffected ----------
  const big = JSON.stringify({ ip: '192.0.2.9', name: 'x'.repeat(2 * 1024 * 1024) });
  const declared = await fetch(origin + '/api/vps', { method: 'POST', headers: auth, body: big, signal: AbortSignal.timeout(15000) });
  assert.equal(declared.status, 413, `declared 2MiB body should be 413, got ${declared.status}`);
  console.log('PASS #3a: 2 MiB body with Content-Length -> 413 Payload Too Large');

  const chunk = Buffer.alloc(256 * 1024, 'a');
  const chunked = await rawPost('/api/vps', { ...auth, 'Transfer-Encoding': 'chunked' },
    Array.from({ length: 8 }, () => chunk)); // 2 MiB, no Content-Length
  assert.equal(chunked.status, 413, `chunked 2 MiB body should be 413, got ${chunked.status}: ${chunked.body}`);
  console.log('PASS #3b: 2 MiB chunked body (no Content-Length) -> 413 Payload Too Large');

  const small = await fetch(origin + '/api/vps', { method: 'POST', headers: auth, body: JSON.stringify({ ip: '192.0.2.9', name: 'ok' }), signal: AbortSignal.timeout(15000) });
  assert.equal(small.status, 200, `normal small body should be 200, got ${small.status}: ${await small.clone().text()}`);
  console.log('PASS #3c: normal small JSON body still accepted (200)');

  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200, 'server must stay responsive after oversized requests');
  console.log('PASS #3d: server healthy after oversized requests');

  console.log('ALL SECURITY SMOKE TESTS PASSED');
} finally {
  if (child && child.exitCode === null) await stop();
  rmSync(dir, { recursive: true, force: true });
}
