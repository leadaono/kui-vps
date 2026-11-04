import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kui-credentials-'));
const file = path.join(dir, 'test.db');
const base = 'http://127.0.0.1:19383';
const ips = ['192.0.2.1', '192.0.2.2'];
const viewer = 'viewer-token-for-credentials-test';
const override = { ip: ips[0], user: 'pilot@user', pass: 'pilot:p@ss/#测试' };
let child, output = '';
let db = new DatabaseSync(file);
db.exec("CREATE TABLE probe_settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO probe_settings VALUES('cached_nodes_data','[]');");
db.close();
async function start(extra = {}) {
 child = spawn(process.execPath, ['server.js'], {env:{...process.env, PORT:'19383', BIND_HOST:'127.0.0.1', PANEL_ORIGIN:base, DATABASE_PATH:file, ADMIN_PASSWORD:'credentials-test-password-1234', PROXY_USER:'shared-user', PROXY_PASS:'shared-password', ...extra},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
 for(let i=0;i<100;i++) {try {if((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{} if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,100));}
 throw Error('Startup timeout');
}
async function stop(){if(child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
async function request(url, options={}, status=200){const r=await fetch(base+url,options);assert.equal(r.status,status,await r.clone().text());return r;}
try {
 await start();
 const login=await (await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'credentials-test-password-1234'})})).json();
 const headers={Authorization:'Bearer '+login.token,'Content-Type':'application/json'};
 const put=body=>({method:'PUT',headers,body:JSON.stringify(body)});
 const config=async ip=>(await request('/api/proxy/config?ip='+ip,{headers:{Authorization:'agent-'+ip}})).json();
 db=new DatabaseSync(file);
 for(const ip of ips){db.prepare('INSERT INTO servers(ip,name,agent_token) VALUES(?,?,?)').run(ip,ip,'agent-'+ip);db.prepare('INSERT INTO proxy_ctrl_servers(ip,details,last_seen) VALUES(?,?,?)').run(ip,JSON.stringify([{active:true,tunnel:'tun_main',country:'US',port:7920,node_ip:'198.51.100.1'}]),Date.now());}
 db.prepare('INSERT INTO users(username,password,sub_token) VALUES(?,?,?)').run('viewer','unused','viewer-sub');
 db.prepare('INSERT INTO auth_sessions(token_hash,username,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(viewer).digest('hex'),'viewer',Date.now()+600000);
 db.prepare("INSERT INTO sys_config(key,val) VALUES('admin_sub_token','admin-sub')").run();db.close();
 assert.equal((await config(ips[0])).proxy.user,'shared-user','existing installations inherit global credentials');
 await request('/api/proxy/credentials',put(override),200);
 assert.equal((await config(ips[0])).proxy.pass,override.pass);
 assert.equal((await config(ips[1])).proxy.pass,'shared-password','other server unchanged');
 const status=await (await request('/api/proxy/credentials?ip='+ips[0],{headers})).json();
 assert.deepEqual(status,{ip:ips[0],source:'server',configured:true},'status never returns secret values');
 const core=await (await request('/api/config?ip='+ips[0],{headers:{Authorization:'agent-'+ips[0]}})).json();
 assert.equal(core.residential_outbound.user,override.user);assert.equal(core.residential_outbound.pass,override.pass);
 const adminCore=await (await request('/api/config?ip='+ips[0],{headers})).json();assert.equal(adminCore.residential_outbound.pass,'','core admin responses keep credentials redacted');
 await request('/api/proxy/config?ip='+ips[1],{headers:{Authorization:'agent-'+ips[0]}},403);
 await request('/api/proxy/credentials',put({...override,pass:''}),400);
 await request('/api/proxy/credentials',put({ip:ips[0],user:'partial'}),400);
 await request('/api/proxy/credentials',put({...override,user:'bad:name'}),400);
 await request('/api/proxy/credentials',put({...override,user:'界'.repeat(86)}),400);
 await request('/api/proxy/credentials',put({...override,pass:'bad\npassword'}),400);
 await request('/api/proxy/credentials',put({...override,ip:'192.0.2.99'}),404);
 await request('/api/proxy/credentials',put({...override,inherit:true}),400);
 for(const auth of ['', 'agent-'+ips[0], 'Bearer '+viewer]) {
  await request('/api/proxy/credentials',{...put(override),headers:{'Content-Type':'application/json',Authorization:auth}},403);
  await request('/api/proxy/credentials?ip='+ips[0],{headers:{Authorization:auth}},403);
 }
 assert.equal((await config(ips[0])).proxy.pass,override.pass,'rejected writes leave override intact');
 const changed=await (await request('/api/proxy/config',{method:'POST',headers,body:JSON.stringify({ip:ips[0],'0':'US',port:7920})})).json();
 assert.equal(changed.proxy.pass,override.pass,'ordinary config saves preserve independent credentials');
 const list=await (await request('/api/proxy/proxies',{headers})).text();
 const pilotLink=new URL(list.split('\n').find(line=>line.includes(ips[0])));
 assert.equal(decodeURIComponent(pilotLink.username),override.user);assert.equal(decodeURIComponent(pilotLink.password),override.pass);
 const sub=Buffer.from(await (await request('/api/sub?user=admin&token=admin-sub')).text(),'base64').toString();
 const credentialBlob=Buffer.from(override.user+':'+override.pass).toString('base64');
 assert.ok(sub.includes(credentialBlob));assert.ok(sub.includes(Buffer.from('shared-user:shared-password').toString('base64')));
 const clash=await (await request('/api/sub?user=admin&token=admin-sub&format=clash')).text();assert.ok(clash.includes(override.pass));assert.ok(clash.includes('shared-password'));
 const ordinary=Buffer.from(await (await request('/api/sub?user=viewer&token=viewer-sub')).text(),'base64').toString();assert.ok(!ordinary.includes(credentialBlob));assert.ok(!ordinary.includes('socks5://'));
 const settings=await (await request('/api/probe/admin/data',{headers})).text();assert.ok(!settings.includes(override.pass));
 await stop();await start();assert.equal((await config(ips[0])).proxy.pass,override.pass,'override survives restart');
 await request('/api/proxy/credentials',put({ip:ips[0],inherit:true}));assert.equal((await config(ips[0])).proxy.pass,'shared-password','explicit rollback restores global fallback');
 await request('/api/proxy/credentials',put(override));
 await request('/api/vps?ip='+ips[0],{method:'DELETE',headers});
 db=new DatabaseSync(file);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM residential_credentials').get().n,0,'deleting a server removes its credentials');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
 assert.ok(!output.includes(override.pass),'server output contains no submitted password');
 console.log('PASS: per-server isolation, defaults, authorization, validation, subscriptions, core config, restart, rollback and deletion');
}finally{if(child&&child.exitCode===null)await stop();fs.rmSync(dir,{recursive:true,force:true});}
