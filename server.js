/**
 * KUI VPS — Node.js self-hosted runtime for a6216abcd/K-UI
 *
 * Replaces the Cloudflare stack on a single VPS process/port:
 *   - Cloudflare Pages static hosting  -> built-in static file server
 *   - functions/api/[[path]].js (Pages Functions) -> direct onRequest() invocation
 *   - D1 (SQLite)                      -> node:sqlite D1-compatible adapter
 *   - Realtime Worker + Durable Objects -> in-process WebSocket hub
 *   - caches.default / env.ASSETS      -> in-memory cache / local file reads
 *
 * Frontend (index.html) and VPS Agent scripts (vps/) are used unmodified.
 */

import http from 'node:http';
import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { onRequest, onRequestScheduled } from './vendor/K-UI/functions/api/[[path]].js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, 'vendor', 'K-UI');
const PORT = Number(process.env.PORT || 3000);
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 16) {
  throw new Error('ADMIN_PASSWORD must contain at least 16 characters');
}
const PANEL_ORIGIN = (process.env.PANEL_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
// Hard ceiling for buffered request bodies (Issue #3). The API layer keeps its
// own smaller per-route limits (256 KB max today); this server-layer cap only
// stops unbounded in-memory buffering. Override with KUI_MAX_BODY_BYTES.
const MAX_BODY_BYTES = (() => {
  const n = Number(process.env.KUI_MAX_BODY_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : 1024 * 1024;
})();

// ==========================================
// 1. Polyfill Cloudflare caches.default
// ==========================================
const memoryCache = new Map();
if (!globalThis.caches) {
  globalThis.caches = {
    default: {
      async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        const item = memoryCache.get(key);
        if (!item || Date.now() > item.expires) {
          memoryCache.delete(key);
          return undefined;
        }
        return new Response(item.body, { status: item.status, headers: item.headers });
      },
      async put(req, res) {
        const key = typeof req === 'string' ? req : req.url;
        const body = await res.clone().arrayBuffer();
        memoryCache.set(key, {
          body,
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          expires: Date.now() + 15000,
        });
      },
    },
  };
}

// ==========================================
// 2. Cloudflare D1 (SQLite) compatible adapter
// ==========================================
const databasePath = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'kui.db');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const sqlite = new DatabaseSync(databasePath, { enableDoubleQuotedStringLiterals: true });
sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

class D1Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values) {
    return new D1Statement(this.db, this.sql, values);
  }
  _normalized() {
    return this.params.map((v) =>
      v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v
    );
  }
  _exec() {
    const stmt = this.db.prepare(this.sql);
    const args = this._normalized();
    if (stmt.columns().length) {
      const rows = stmt.all(...args);
      return { reader: true, rows, info: null };
    }
    return { reader: false, rows: null, info: stmt.run(...args) };
  }
  async first(colName) {
    const { rows } = this._exec();
    const row = rows?.[0] ?? null;
    if (row == null) return null;
    return colName ? row[colName] : row;
  }
  async all() {
    const { rows } = this._exec();
    return { results: rows || [], success: true, meta: {} };
  }
  async run() {
    const { reader, rows, info } = this._exec();
    if (reader) {
      return { results: rows, success: true, meta: { changes: (rows || []).length } };
    }
    return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid || 0) } };
  }
}

const d1Adapter = {
  prepare(sql) {
    return new D1Statement(sqlite, sql);
  },
  async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => {
        const out = s._exec();
        if (out.reader) return { results: out.rows, success: true, meta: {} };
        return { success: true, meta: { changes: out.info.changes } };
      });
      sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  },
};

// ==========================================
// 3. Static file serving (env.ASSETS + web root)
// ==========================================
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'text/plain; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function safeLocalFile(relPath) {
  if (relPath !== 'index.html' && !/^vps\/[a-zA-Z0-9_.-]+$/.test(relPath)) return null;
  const resolved = path.resolve(webRoot, relPath);
  if (!resolved.startsWith(webRoot + path.sep)) {
    return null;
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return null;
  return resolved;
}

function serveStatic(urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const resolved = safeLocalFile(rel);
  if (!resolved) return new Response('Not Found', { status: 404 });
  const ext = path.extname(resolved).toLowerCase();
  return new Response(fs.readFileSync(resolved), {
    status: 200,
    headers: {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    },
  });
}

// ==========================================
// 4. Cloudflare env / context
// ==========================================
const env = {
  DB: d1Adapter,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  PROXY_USER: process.env.PROXY_USER || 'kui_proxy',
  PROXY_PASS: process.env.PROXY_PASS || 'kui_proxy_change_me',
  REALTIME_URL: process.env.REALTIME_URL || PANEL_ORIGIN,
  CRON_SECRET: process.env.CRON_SECRET || '',
  TG_WEBHOOK_SECRET: process.env.TG_WEBHOOK_SECRET || '',
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',
  ASSETS: {
    async fetch(req) {
      const u = new URL(req instanceof URL ? req.href : typeof req === 'string' ? req : req.url);
      const resolved = safeLocalFile(u.pathname.replace(/^\/+/, ''));
      if (!resolved) return new Response('Asset not found', { status: 404 });
      const ext = path.extname(resolved).toLowerCase();
      return new Response(fs.readFileSync(resolved), {
        status: 200,
        headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
      });
    },
  },
};

function makeContext(request, pathArray) {
  return {
    request,
    env,
    params: { path: pathArray },
    waitUntil(promise) {
      Promise.resolve(promise).catch((e) => console.error('[waitUntil]', e));
    },
  };
}

// ==========================================
// 5. In-process Realtime Hub (replaces Worker + Durable Objects)
// ==========================================
const vpsStateMap = new Map(); // ip -> live state entry
const dashboardSockets = new Set();
const publicSockets = new Set();
const ticketStore = new Map();
let frequencyPolicy = { admin: 5000, public: 10000, idle: 30000 };

function getViewerInterval() {
  if (dashboardSockets.size > 0) return frequencyPolicy.admin;
  if (publicSockets.size > 0) return frequencyPolicy.public;
  return frequencyPolicy.idle;
}

function getOrCreateEntry(ip) {
  if (!vpsStateMap.has(ip)) {
    vpsStateMap.set(ip, {
      ip,
      core: null,
      proxy: null,
      core_connected: false,
      proxy_connected: false,
      core_last_seen: 0,
      proxy_last_seen: 0,
      updated_at: 0,
      bootId: { core: '', proxy: '' },
      lastSeq: { core: -1, proxy: -1 },
      sockets: { core: null, proxy: null },
      core_config_result: null,
      proxy_config_result: null,
    });
  }
  return vpsStateMap.get(ip);
}

function buildSnapshot(entry) {
  const now = Date.now();
  const coreAge = entry.core_last_seen ? now - entry.core_last_seen : null;
  const proxyAge = entry.proxy_last_seen ? now - entry.proxy_last_seen : null;
  return {
    ip: entry.ip,
    core: entry.core,
    proxy: entry.proxy,
    core_connected: entry.core_connected,
    proxy_connected: entry.proxy_connected,
    core_last_seen: entry.core_last_seen,
    proxy_last_seen: entry.proxy_last_seen,
    updated_at: entry.updated_at,
    core_config_result: entry.core_config_result,
    core_egress_result: entry.core_config_result?.component === 'egress' ? entry.core_config_result : null,
    proxy_config_result: entry.proxy_config_result,
    core_state: !entry.core_connected ? 'offline' : coreAge === null || coreAge > 20000 ? 'stale' : 'online',
    proxy_state: !entry.proxy_connected ? 'offline' : proxyAge === null || proxyAge > 20000 ? 'stale' : 'online',
    core_age: coreAge,
    proxy_age: proxyAge,
    boot_id: entry.bootId,
    sequence: entry.lastSeq,
  };
}

function sanitizePublic(snap) {
  if (!snap?.ip || !snap.core) return null;
  return {
    ip: snap.ip,
    core: snap.core,
    core_last_seen: snap.core_last_seen || 0,
    core_state: snap.core_state || 'offline',
    updated_at: snap.updated_at || 0,
  };
}

async function getAllSnapshots() {
  const servers =
    (
      await env.DB.prepare(
        'SELECT ip, cpu, mem, disk, load, uptime, net_in_speed, net_out_speed, tcp_conn, udp_conn, last_report FROM servers'
      ).all()
    ).results || [];
  const proxies =
    (await env.DB.prepare('SELECT ip, details, last_seen FROM proxy_ctrl_servers').all()).results || [];
  const proxyMap = new Map(proxies.map((r) => [r.ip, r]));

  return servers
    .map((row) => {
      const entry = vpsStateMap.get(row.ip);
      if (entry && (entry.core || entry.proxy)) return buildSnapshot(entry);
      const p = proxyMap.get(row.ip);
      let details = [];
      try {
        details = JSON.parse(p?.details || '[]');
      } catch {}
      return {
        ip: row.ip,
        transport: 'http',
        core: {
          cpu: row.cpu,
          mem: row.mem,
          disk: row.disk,
          load: row.load,
          uptime: row.uptime,
          net_in_speed: row.net_in_speed,
          net_out_speed: row.net_out_speed,
          tcp_conn: row.tcp_conn,
          udp_conn: row.udp_conn,
        },
        core_last_seen: row.last_report || 0,
        core_state: Date.now() - (row.last_report || 0) < 360000
          ? 'online'
          : Date.now() - (row.last_report || 0) < 1200000
            ? 'stale'
            : 'offline',
        proxy: p ? { details } : null,
        proxy_last_seen: p?.last_seen || 0,
        proxy_state: p && Date.now() - p.last_seen < 360000 ? 'online' : 'offline',
        updated_at: Math.max(row.last_report || 0, p?.last_seen || 0),
      };
    })
    .filter(Boolean);
}

function broadcastPatch(entry) {
  const snap = buildSnapshot(entry);
  const dashMsg = JSON.stringify({ type: 'patch', data: snap, ts: Date.now() });
  for (const ws of dashboardSockets) {
    if (ws.readyState === 1) ws.send(dashMsg);
  }
  const pub = sanitizePublic(snap);
  if (pub && publicSockets.size > 0) {
    const pubMsg = JSON.stringify({ type: 'patch', data: pub, ts: Date.now() });
    for (const ws of publicSockets) {
      if (ws.readyState === 1) ws.send(pubMsg);
    }
  }
}

function pushAgentIntervals() {
  const seconds = getViewerInterval() / 1000;
  const msg = JSON.stringify({ type: 'status.interval', seconds });
  for (const entry of vpsStateMap.values()) {
    for (const ws of Object.values(entry.sockets)) {
      if (ws && ws.readyState === 1) ws.send(msg);
    }
  }
}

async function isAdminRequest(webReq) {
  try {
    const authReq = new Request(`${PANEL_ORIGIN}/api/realtime_auth`, {
      method: 'POST',
      headers: { Authorization: webReq.headers.get('Authorization') || '' },
    });
    const res = await onRequest(makeContext(authReq, ['realtime_auth']));
    if (!res.ok) return false;
    const data = await res.json();
    return data.admin === true;
  } catch {
    return false;
  }
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ==========================================
// 6. HTTP server
// ==========================================
const server = http.createServer(async (req, res) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
    const fullUrl = new URL(req.url || '/', `${proto}://${host}`);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
      else if (v !== undefined) headers.set(k, v);
    }
    const peer = req.socket.remoteAddress || '';
    const trustedProxy = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
    // The client IP feeds the login throttle, so it must be what the trusted
    // local proxy (Caddy) actually observed — never the first
    // X-Forwarded-For segment, which is claimed by the requester and can be
    // rotated per request to bypass rate limits (Issue #2). Preference:
    //   1. CF-Connecting-IP as overwritten by Caddy via
    //      `header_up CF-Connecting-IP {remote_host}` (see install-panel.sh);
    //   2. the LAST X-Forwarded-For segment (the one the nearest trusted
    //      proxy appended);
    //   3. the direct peer address.
    // Forwarding headers from an untrusted peer are ignored entirely.
    let clientIp = peer;
    if (trustedProxy) {
      const fromCaddy = String(req.headers['cf-connecting-ip'] || '').trim();
      const xffParts = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const fromXffTail = xffParts.length ? xffParts[xffParts.length - 1] : '';
      if (isIP(fromCaddy)) clientIp = fromCaddy;
      else if (isIP(fromXffTail)) clientIp = fromXffTail;
    }
    headers.set('CF-Connecting-IP', clientIp);

    const chunks = [];
    let bodyTooLarge = false;
    if (!['GET', 'HEAD'].includes(req.method)) {
      // Count actual bytes (Content-Length can lie or be absent). Once over
      // the cap, release the buffer and drain-and-discard the rest, then
      // answer 413: memory stays bounded and well-behaved clients reliably
      // receive the response (Issue #3).
      let bodyBytes = 0;
      for await (const chunk of req) {
        if (bodyTooLarge) continue;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          bodyTooLarge = true;
          chunks.length = 0;
          continue;
        }
        chunks.push(chunk);
      }
    }
    if (bodyTooLarge) {
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Payload Too Large' }));
      return;
    }
    const webReq = new Request(fullUrl.toString(), {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    webReq.cf = { country: process.env.DEFAULT_CC || 'US' };

    let webRes;
    const p = fullUrl.pathname;

    if (p === '/health') {
      webRes = jsonRes({ ok: true, service: 'kui-realtime', version: 1 });
    } else if (p === '/dashboard/ticket' && req.method === 'POST') {
      if (!(await isAdminRequest(webReq))) webRes = jsonRes({ error: 'Forbidden' }, 403);
      else {
        const ticket = crypto.randomUUID();
        ticketStore.set(ticket, Date.now() + 60000);
        webRes = jsonRes({ ticket, expires_in: 60 });
      }
    } else if (p === '/dashboard/snapshot') {
      if (!(await isAdminRequest(webReq))) webRes = jsonRes({ error: 'Forbidden' }, 403);
      else webRes = jsonRes(await getAllSnapshots());
    } else if (p === '/notify' && req.method === 'POST') {
      if (!(await isAdminRequest(webReq))) webRes = jsonRes({ error: 'Forbidden' }, 403);
      else {
        const body = await webReq.json().catch(() => ({}));
        const targets = body.ip ? [body.ip] : [...vpsStateMap.keys()];
        const refreshMsg = JSON.stringify({ type: 'config.refresh', ts: Date.now() });
        for (const ip of targets) {
          const entry = vpsStateMap.get(ip);
          if (!entry) continue;
          for (const ws of Object.values(entry.sockets)) {
            if (ws && ws.readyState === 1) ws.send(refreshMsg);
          }
        }
        webRes = jsonRes({ success: true, notified: targets.length });
      }
    } else if (p === '/public-policy' && req.method === 'POST') {
      if (!(await isAdminRequest(webReq))) webRes = jsonRes({ error: 'Forbidden' }, 403);
      else {
        const body = await webReq.json().catch(() => ({}));
        if (!body.public) {
          for (const ws of publicSockets) {
            try { ws.close(1008, 'private dashboard'); } catch {}
          }
          publicSockets.clear();
        }
        webRes = jsonRes({ success: true });
      }
    } else if (p === '/frequency-policy' && req.method === 'POST') {
      if (!(await isAdminRequest(webReq))) webRes = jsonRes({ error: 'Forbidden' }, 403);
      else {
        const b = await webReq.json().catch(() => ({}));
        const admin = Number(b.admin) || 5;
        const pub = Number(b.public) || 10;
        const idle = Number(b.idle) || 30;
        frequencyPolicy = { admin: admin * 1000, public: pub * 1000, idle: idle * 1000 };
        pushAgentIntervals();
        webRes = jsonRes({ success: true });
      }
    } else if (p.startsWith('/api/')) {
      const pathArray = p.slice(5).split('/').filter(Boolean);
      webRes = await onRequest(makeContext(webReq, pathArray));
    } else {
      webRes = serveStatic(p);
    }

    res.statusCode = webRes.status;
    webRes.headers.forEach((val, key) => res.setHeader(key, val));
    res.end(Buffer.from(await webRes.arrayBuffer()));
  } catch (err) {
    console.error('[http error]', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

// ==========================================
// 7. WebSocket upgrade routes
//    /agent/ws, /dashboard/ws, /public/ws
// ==========================================
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    const fullUrl = new URL(req.url || '/', `ws://${req.headers.host || 'localhost'}`);
    const p = fullUrl.pathname;

    const reject = (codeStr) => {
      socket.write(`HTTP/1.1 ${codeStr}\r\n\r\n`);
      socket.destroy();
    };

    if (p === '/agent/ws') {
      const ip = fullUrl.searchParams.get('ip') || '';
      const role = fullUrl.searchParams.get('role') || '';
      const auth = req.headers['authorization'] || '';
      if (!['core', 'proxy'].includes(role)) return reject('400 Bad Request');
      const srv = await env.DB.prepare('SELECT agent_token FROM servers WHERE ip = ?').bind(ip).first();
      if (!srv?.agent_token || srv.agent_token !== auth) return reject('401 Unauthorized');
      wss.handleUpgrade(req, socket, head, (ws) => {
        const entry = getOrCreateEntry(ip);
        if (entry.sockets[role]) {
          try { entry.sockets[role].close(1000, 'replaced'); } catch {}
        }
        entry.sockets[role] = ws;
        entry[`${role}_connected`] = true;
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        ws.send(JSON.stringify({ type: 'hello.ok', ts: Date.now(), role }));
        ws.send(JSON.stringify({ type: 'status.interval', seconds: getViewerInterval() / 1000 }));
        broadcastPatch(entry);

        ws.on('message', (raw) => {
          const text = raw.toString();
          if (text === 'ping') return ws.send('pong');
          try {
            const envlp = JSON.parse(text);
            if (envlp.type === 'hello') {
              // capabilities ack only
            } else if (envlp.type === 'config.result') {
              entry[`${role}_config_result`] = envlp.data;
              entry.updated_at = Date.now();
              broadcastPatch(entry);
            } else if (envlp.type === 'status') {
              entry[role] = envlp.data;
              entry[`${role}_last_seen`] = Date.now();
              entry.updated_at = Date.now();
              broadcastPatch(entry);
            }
          } catch {}
        });

        ws.on('close', () => {
          if (entry.sockets[role] === ws) {
            entry.sockets[role] = null;
            entry[`${role}_connected`] = false;
            broadcastPatch(entry);
          }
        });
      });
    } else if (p === '/dashboard/ws') {
      const ticket = fullUrl.searchParams.get('ticket') || '';
      const exp = ticketStore.get(ticket);
      ticketStore.delete(ticket);
      if (!exp || exp < Date.now()) return reject('401 Unauthorized');
      wss.handleUpgrade(req, socket, head, async (ws) => {
        dashboardSockets.add(ws);
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        pushAgentIntervals();
        ws.send(JSON.stringify({ type: 'snapshot', data: await getAllSnapshots(), ts: Date.now() }));
        ws.on('message',async (raw) => {
          const msg = raw.toString();
          if (msg === 'ping') return ws.send('pong');
          try {
            const parsed = JSON.parse(msg);
            if (parsed.type === 'resync') {
              ws.send(JSON.stringify({ type: 'snapshot', data: await getAllSnapshots() , ts: Date.now() }));
            } else if (parsed.type === 'activity') {
              pushAgentIntervals();
            }
          } catch {}
        });
        ws.on('close', () => {
          dashboardSockets.delete(ws);
          pushAgentIntervals();
        });
      });
    } else if (p === '/public/ws') {
      const setting = await env.DB
        .prepare("SELECT value FROM probe_settings WHERE key = 'is_public'")
        .first();
      if (setting && setting.value !== 'true') return reject('403 Forbidden');
      wss.handleUpgrade(req, socket, head, async (ws) => {
        publicSockets.add(ws);
        ws.isAlive = true;
        ws.on('pong', () => (ws.isAlive = true));
        pushAgentIntervals();
        const snaps = (await getAllSnapshots()).map(sanitizePublic).filter(Boolean);
        ws.send(JSON.stringify({ type: 'snapshot', data: snaps, ts: Date.now() }));
        ws.on('message', (raw) => {
          if (raw.toString() === 'ping') ws.send('pong');
        });
        ws.on('close', () => {
          publicSockets.delete(ws);
          pushAgentIntervals();
        });
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

// Periodic dead-connection sweep + offline cron (mirrors Cloudflare Scheduled)
setInterval(() => {
  for (const set of [dashboardSockets, publicSockets]) {
    for (const ws of set) {
      if (!ws.isAlive) {
        try { ws.terminate(); } catch {}
        set.delete(ws);
      } else {
        ws.isAlive = false;
        try { ws.ping(); } catch {}
      }
    }
  }
}, 30000);

setInterval(() => {
  const fakeCtx = { env, waitUntil: () => {} };
  onRequestScheduled(fakeCtx).catch((e) => console.error('[cron failed]', e));
}, 300000);

server.listen(PORT, process.env.BIND_HOST || '127.0.0.1', () => {
  console.log(`[kui-vps] Panel + Realtime listening on ${process.env.BIND_HOST || '127.0.0.1'}:${PORT}`);
  console.log(`[kui-vps] PANEL_ORIGIN=${PANEL_ORIGIN}`);
});
