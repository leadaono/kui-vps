import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(path.join(tmpdir(), 'kui-hy2-'));
const origin = 'http://127.0.0.1:19382';
const ip = '192.0.2.11';
const pin = 'a'.repeat(64);
let child;
try {
  child = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: '19382', ADMIN_PASSWORD: 'test-password-12345', PANEL_ORIGIN: origin, DATABASE_PATH: path.join(dir, 'test.db') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', data => process.stderr.write(data));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/health')).ok) break; } catch {}
    if (child.exitCode !== null) throw new Error('Server exited');
    if (i === 99) throw new Error('Startup timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await fetch(origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  const db = new DatabaseSync(path.join(dir, 'test.db'));
  db.prepare('INSERT INTO servers (ip, name, agent_token) VALUES (?, ?, ?)').run(ip, 'test-vps', 'agent-secret');
  db.prepare('INSERT INTO servers (ip, name, agent_token) VALUES (?, ?, ?)').run('192.0.2.12', 'other-vps', 'other-secret');
  db.prepare('INSERT INTO nodes (id, uuid, vps_ip, protocol, port, sni) VALUES (?, ?, ?, ?, ?, ?)').run('hy2-1', 'fake-auth', ip, 'Hysteria2', 8882, 'addons.mozilla.org');
  db.prepare('INSERT INTO nodes (id, uuid, vps_ip, protocol, port, sni) VALUES (?, ?, ?, ?, ?, ?)').run('hy2-other', 'other-auth', '192.0.2.12', 'Hysteria2', 8882, 'addons.mozilla.org');
  db.prepare("INSERT INTO sys_config (key, val) VALUES ('admin_sub_token', 'test-sub')").run();
  db.close();
  const subscribe = async () => {
    const response = await fetch(`${origin}/api/sub?user=admin&token=test-sub&ip=${ip}`);
    assert.equal(response.status, 200);
    return Buffer.from(await response.text(), 'base64').toString('utf8');
  };
  const report = async (hashes, auth = 'agent-secret', reportId = `${ip}:${crypto.randomUUID()}`) => fetch(origin + '/api/report', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ ip, report_id: reportId, hysteria2_cert_hashes: hashes, node_traffic: [] }) });
  assert.equal(await subscribe(), '', 'no unverified share link before first agent report');
  assert.equal((await report([{ id: 'hy2-1', sha256: pin }], 'wrong-secret')).status, 401);
  assert.equal(await subscribe(), '');
  assert.equal((await report([{ id: 'hy2-1', sha256: 'bad' }])).status, 400);
  assert.equal((await report([{ id: 'hy2-other', sha256: pin }])).status, 200);
  const checkOther = new DatabaseSync(path.join(dir, 'test.db'));
  assert.equal(checkOther.prepare('SELECT cert_sha256 FROM nodes WHERE id = ?').get('hy2-other').cert_sha256, null, 'agent cannot pin a node belonging to another VPS');
  checkOther.close();
  const oldReportId = `${ip}:${crypto.randomUUID()}`;
  assert.equal((await report([{ id: 'hy2-1', sha256: pin }], 'agent-secret', oldReportId)).status, 200);
  const link = await subscribe();
  assert.match(link, new RegExp(`pinSHA256=${pin}`));
  assert.doesNotMatch(link, /insecure=1/);
  assert.match(link, /sni=addons.mozilla.org/);
  assert.equal((await report([{ id: 'hy2-1', sha256: 'b'.repeat(64) }])).status, 200);
  assert.match(await subscribe(), /pinSHA256=b{64}/, 'rotated certificate replaces old hash');
  assert.equal((await report([{ id: 'hy2-1', sha256: pin }], 'agent-secret', oldReportId)).status, 200);
  assert.match(await subscribe(), /pinSHA256=b{64}/, 'late duplicate must not restore a stale pin');
  assert.equal((await report([])).status, 200);
  assert.equal(await subscribe(), '', 'missing certificate removes the old pin');
  console.log('PASS: authenticated certificate report, rotation, fail-closed subscription');
} finally {
  if (child && child.exitCode === null) {
    const done = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await done;
  }
  rmSync(dir, { recursive: true, force: true });
}
