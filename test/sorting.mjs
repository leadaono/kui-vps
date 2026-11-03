import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-order-'));
const file = path.join(dir, 'test.db');
const base = 'http://127.0.0.1:19382';
let child;
const ips = ['192.0.2.3', '192.0.2.1', '192.0.2.2'];
let db = new DatabaseSync(file, { enableDoubleQuotedStringLiterals: true });
const apiSource = fs.readFileSync('vendor/K-UI/functions/api/[[path]].js', 'utf8');
const oldSchema = apiSource.match(/`(CREATE TABLE IF NOT EXISTS servers \([^`]+)`/)[1];
db.exec(oldSchema);
for (const ip of ips) db.prepare('INSERT INTO servers(ip,name) VALUES(?,?)').run(ip, ip);
db.exec("CREATE TABLE probe_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO probe_settings VALUES('cached_nodes_data','[]');");
db.close();
async function start() {
 child = spawn(process.execPath, ['server.js'], { env: {...process.env, PORT:'19382', BIND_HOST:'127.0.0.1', PANEL_ORIGIN:base, DATABASE_PATH:file, ADMIN_PASSWORD:'sort-test-password-1234'}, stdio:['ignore','pipe','pipe'] });
 child.stderr.on('data', d => process.stderr.write(d));
 for (let i=0;i<100;i++) {
  try { if ((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok) return; } catch {}
  if(child.exitCode!==null) throw Error('Server exited');
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error('Startup timeout');
}
async function stop(){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
async function json(url, options={}) {const r=await fetch(base+url,options);assert.equal(r.status,200,await r.clone().text());return r.json();}
try {
 await start();
 const login=await json('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'sort-test-password-1234'})});
 const headers={Authorization:'Bearer '+login.token,'Content-Type':'application/json'};
 let data=await json('/api/data',{headers});
 assert.deepEqual(data.servers.map(s=>s.ip),ips,'old insertion order retained');
 assert.deepEqual(data.servers.map(s=>s.sort_order),[10,20,30]);
 db=new DatabaseSync(file);
 for(const ip of ips) db.prepare('INSERT INTO probe_servers(id,name,server_group,price,is_hidden) VALUES(?,?,?,?,?)').run(ip,ip,'默认分组','keep-price','false');
 db.prepare('UPDATE servers SET agent_token=? WHERE ip=?').run('keep-agent-token',ips[0]);
 db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run('viewer','unused');
 db.prepare('INSERT INTO auth_sessions(token_hash,username,expires_at) VALUES(?,?,?)').run(createHash('sha256').update('viewer-session-token-for-sorting-test').digest('hex'),'viewer',Date.now()+600000);
 db.close();
 const send=orders=>fetch(base+'/api/server_order',{method:'PUT',headers,body:JSON.stringify({orders})});
 const orders=[{ip:ips[0],sort_order:30},{ip:ips[1],sort_order:10},{ip:ips[2],sort_order:10}];
 const cached=await json('/api/probe/public');
 assert.deepEqual(cached.servers.map(s=>s.id),ips);
 assert.equal((await send(orders)).status,200);
 const expected=[ips[1],ips[2],ips[0]];
 assert.deepEqual((await json('/api/data',{headers})).servers.map(s=>s.ip),expected);
 assert.deepEqual((await json('/api/probe/admin/data',{headers})).servers.map(s=>s.id),expected);
 assert.deepEqual((await json('/api/probe/public')).servers.map(s=>s.id),expected,'public cache invalidated immediately');
 assert.equal((await send([{ip:ips[0],sort_order:1},{ip:ips[1],sort_order:-1}])).status,400);
 assert.equal((await send([{ip:ips[0],sort_order:1},{ip:'192.0.2.99',sort_order:2}])).status,404);
 assert.equal((await send([{ip:ips[0],sort_order:1},{ip:ips[0],sort_order:2}])).status,400);
 assert.equal((await send([{ip:ips[0],sort_order:1.5}])).status,400);
 assert.equal((await fetch(base+'/api/server_order',{method:'PUT',headers:{Authorization:'Bearer viewer-session-token-for-sorting-test','Content-Type':'application/json'},body:JSON.stringify({orders})})).status,403);
 assert.equal((await fetch(base+'/api/server_order',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({orders})})).status,401);
 assert.deepEqual((await json('/api/data',{headers})).servers.map(s=>s.sort_order),[10,10,30],'invalid batches did not partially update');
 const ws=new WebSocket(base.replace('http','ws')+'/agent/ws?ip='+ips[0]+'&role=core',{headers:{Authorization:'keep-agent-token'}});
 await new Promise((resolve,reject)=>{ws.once('message',resolve);ws.once('error',reject);setTimeout(()=>reject(Error('Agent timeout')),5000).unref();});
 ws.send(JSON.stringify({type:'status',data:{cpu:42,mem:20,disk:10}}));
 await new Promise(r=>setTimeout(r,100));
 ws.close();
 assert.deepEqual((await json('/api/data',{headers})).servers.map(s=>s.ip),expected,'live status preserves order');
 assert.equal((await json('/api/vps',{method:'POST',headers,body:JSON.stringify({ip:'192.0.2.4',name:'new'})})).success,true);
 assert.equal((await json('/api/data',{headers})).servers.at(-1).ip,'192.0.2.4','new server goes last');
 db=new DatabaseSync(file);
 assert.equal(db.prepare('SELECT price FROM probe_servers WHERE id=?').get(ips[0]).price,'keep-price');
 assert.equal(db.prepare('SELECT agent_token FROM servers WHERE ip=?').get(ips[0]).agent_token,'keep-agent-token');
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
 await stop();await start();
 assert.deepEqual((await json('/api/data',{headers})).servers.slice(0,3).map(s=>s.ip),expected,'sort survives restart');
 console.log('PASS: legacy migration, shared order, ties, cache invalidation, authorization, atomic validation, live updates, new server, restart and metadata preservation');
} finally {if(child&&child.exitCode===null)await stop();fs.rmSync(dir,{recursive:true,force:true});}

