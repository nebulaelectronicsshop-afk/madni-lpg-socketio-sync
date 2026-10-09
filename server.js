'use strict';

const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 10000);
const WORKER_URL = String(
  process.env.MADNI_WORKER_URL ||
  'https://madni-lpg-api.nebulaelectronicsshop.workers.dev'
).replace(/\/+$/, '');
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || 'null,http://localhost:3000')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
);
const ALLOW_CLIENT_TENANT_CLAIM = String(process.env.ALLOW_CLIENT_TENANT_CLAIM || 'false').toLowerCase() === 'true';
const ANNOUNCE_LIMIT = 120;
const ANNOUNCE_WINDOW_MS = 60_000;

const app = express();
app.disable('x-powered-by');
app.get('/', (_req, res) => res.status(200).json({
  service: 'MADNI LPG Socket.IO sync notifier',
  health: '/health',
  note: 'This service broadcasts sync hints only. Business data stays in the authenticated MADNI Cloudflare Worker.'
}));
app.get('/health', (_req, res) => res.status(200).json({
  ok: true,
  service: 'madni-lpg-socketio',
  socketIo: true,
  workerConfigured: Boolean(WORKER_URL),
  timestamp: new Date().toISOString()
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      // Health checks and non-browser clients may not send an Origin header.
      if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by MADNI Socket.IO server.'), false);
    },
    methods: ['GET', 'POST'],
    credentials: false
  },
  allowRequest(req, callback) {
    const origin = req.headers.origin;
    if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback('Origin is not allowed by MADNI Socket.IO server.', false);
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxHttpBufferSize: 16 * 1024
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function isAuthVerified(payload) {
  const p = asObject(payload) || {};
  const d = asObject(p.data) || {};
  return p.ok === true || d.ok === true;
}

// Only accept an owner/tenant identity returned by an authenticated Worker call.
// This avoids using an untrusted room name supplied by the browser.
function extractVerifiedTenant(payload) {
  const roots = [];
  const seen = new Set();
  function add(value, depth) {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item) => add(item, depth + 1));
      return;
    }
    const obj = asObject(value);
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    roots.push(obj);
    for (const key of ['data', 'user', 'context', 'result', 'shop', 'session', 'auth', 'records']) {
      if (obj[key] && typeof obj[key] === 'object') add(obj[key], depth + 1);
    }
  }
  add(payload, 0);

  const ownerKeys = ['shop_owner_id', 'shopOwnerId', 'tenant_id', 'tenantId', 'owner_id', 'ownerId'];
  for (const obj of roots) {
    for (const key of ownerKeys) {
      const value = obj[key];
      if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
  }

  // Some Worker responses expose the shop owner as user.id. Only use that
  // shape when the response does not separately identify an auth_user_id.
  const allAuthIds = new Set();
  for (const obj of roots) {
    if (obj.auth_user_id != null) allAuthIds.add(String(obj.auth_user_id));
    if (obj.authUserId != null) allAuthIds.add(String(obj.authUserId));
  }
  for (const obj of roots) {
    if (obj.id != null && obj.email != null && !allAuthIds.has(String(obj.id))) {
      return String(obj.id).trim();
    }
  }
  return '';
}

async function workerRequest(path, token, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const options = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${WORKER_URL}${path}`, options);
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function validateSocketIdentity(token, claimedTenant) {
  if (!WORKER_URL) throw new Error('MADNI_WORKER_URL is not configured.');
  if (!token || token.length < 12) throw new Error('Missing cloud access token. Sign in to MADNI LPG again.');
  if (!claimedTenant || claimedTenant.length > 200) throw new Error('Missing or invalid shopOwnerId.');

  const verify = await workerRequest('/auth/verify', token);
  if (!verify.ok || !isAuthVerified(verify.data)) {
    throw new Error('Cloudflare Worker rejected the cloud session. Sign in again.');
  }

  let verifiedTenant = extractVerifiedTenant(verify.data);

  // Older Worker builds sometimes return only {ok:true} from /auth/verify.
  // Try the authenticated shop-context RPC and then the tenant-scoped pull.
  if (!verifiedTenant) {
    try {
      const context = await workerRequest('/rpc/madni_shop_context', token, {});
      if (context.ok) verifiedTenant = extractVerifiedTenant(context.data);
    } catch (_e) {
      // Continue to the next verification path.
    }
  }
  if (!verifiedTenant) {
    try {
      const pull = await workerRequest('/sync/pull', token, { since: 0, limit: 1 });
      if (pull.ok) {
        const records = Array.isArray(pull.data.records) ? pull.data.records : [];
        verifiedTenant = extractVerifiedTenant({ records, shop_owner_id: pull.data.shop_owner_id });
      }
    } catch (_e) {
      // Fail closed below unless explicit compatibility mode is enabled.
    }
  }

  if (!verifiedTenant && ALLOW_CLIENT_TENANT_CLAIM) {
    // Compatibility fallback for legacy Worker responses. This is less secure
    // because a verified user could claim another tenant's *notification room*.
    // No business rows pass over Socket.IO, but production should leave this off.
    console.warn('[MADNI SOCKET] Compatibility tenant-claim mode used; update Worker /auth/verify to return shop_owner_id.');
    verifiedTenant = claimedTenant;
  }

  if (!verifiedTenant) {
    throw new Error('Worker authentication succeeded but did not return shop_owner_id. Update /auth/verify (preferred) or madni_shop_context to include the authenticated shop_owner_id.');
  }
  if (verifiedTenant !== claimedTenant) {
    throw new Error('Authenticated shop identity does not match this device. Sign out and sign in to the correct shop.');
  }
  return verifiedTenant;
}

io.use(async (socket, next) => {
  try {
    const auth = asObject(socket.handshake.auth) || {};
    const token = String(auth.token || '');
    const claimedTenant = String(auth.shopOwnerId || '');
    const tenantId = await validateSocketIdentity(token, claimedTenant);
    socket.data.tenantId = tenantId;
    socket.data.deviceId = String(auth.deviceId || '').slice(0, 120);
    next();
  } catch (error) {
    // Do not log or return the access token.
    console.warn('[MADNI SOCKET] Connection rejected:', String(error && error.message || error));
    next(new Error(String(error && error.message || 'Socket authentication failed').slice(0, 240)));
  }
});

io.on('connection', (socket) => {
  const tenantId = socket.data.tenantId;
  const room = `shop:${tenantId}`;
  socket.join(room);
  socket.data.announceWindowStartedAt = Date.now();
  socket.data.announceCount = 0;
  socket.emit('cloud:ready', { tenantId, deviceId: socket.data.deviceId, timestamp: Date.now() });
  console.info(`[MADNI SOCKET] Connected device ${socket.data.deviceId || '(unnamed)'} to tenant room.`);

  socket.on('cloud:announce', (message) => {
    // Payload is deliberately reduced to a wake-up hint. Never accept or relay records,
    // invoices, balances, access tokens, or caller-specified tenant IDs.
    const now = Date.now();
    if (now - Number(socket.data.announceWindowStartedAt || 0) >= ANNOUNCE_WINDOW_MS) {
      socket.data.announceWindowStartedAt = now;
      socket.data.announceCount = 0;
    }
    socket.data.announceCount = Number(socket.data.announceCount || 0) + 1;
    if (socket.data.announceCount > ANNOUNCE_LIMIT) return;

    const suppliedDeviceId = asObject(message) && message.deviceId != null ? String(message.deviceId).slice(0, 120) : '';
    const deviceId = socket.data.deviceId || suppliedDeviceId;
    io.to(room).except(socket.id).emit('cloud:changed', {
      tenantId,
      deviceId,
      timestamp: now
    });
  });

  socket.on('disconnect', (reason) => {
    console.info(`[MADNI SOCKET] Disconnected device ${socket.data.deviceId || '(unnamed)'} (${String(reason || 'closed')}).`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.info(`[MADNI SOCKET] Listening on 0.0.0.0:${PORT}`);
  console.info(`[MADNI SOCKET] Worker URL configured: ${WORKER_URL}`);
  console.info(`[MADNI SOCKET] Allowed browser origins: ${Array.from(ALLOWED_ORIGINS).join(', ') || '(none)'}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
