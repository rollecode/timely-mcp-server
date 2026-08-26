#!/usr/bin/env node
//
// Handles signing in, and lets nothing through to the Timely MCP without it.
// Takes either an OAuth token (claude.ai) or a fixed token (Claude Code).
// RFC 9728, RFC 8414, RFC 7591, PKCE S256, RFC 8707 audience binding. One user.

'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT || 8452);
const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8450';
const ISSUER = (process.env.ISSUER || '').replace(/\/$/, '');
if (!ISSUER) {
  console.error('ISSUER is required, e.g. https://timely-mcp.example.com');
  process.exit(1);
}
// The canonical resource identifier tokens are bound to (RFC 8707). Trailing
// slash omitted deliberately - the spec asks for consistency and clients send
// the form without it.
const RESOURCE = `${ISSUER}/mcp`;

// How long a proxied call may go without a single byte from upstream before it
// is treated as wedged. Inactivity, not total duration, so a slow tool that
// streams progress is never cut.
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS || 120000);
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(os.homedir(), '.config', 'timely-mcp');
const DB_PATH = path.join(CONFIG_DIR, 'oauth.db');
const PASSWORD_HASH_PATH = path.join(CONFIG_DIR, 'password-hash');
const STATIC_TOKEN_PATH = path.join(CONFIG_DIR, 'token');

const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
const AUTH_CODE_TTL_S = 60;

fs.mkdirSync(CONFIG_DIR, { recursive: true });

// --- storage ---------------------------------------------------------------

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    redirect_uris TEXT NOT NULL,
    client_name TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource TEXT,
    scope TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    client_id TEXT NOT NULL,
    audience TEXT,
    scope TEXT,
    expires_at INTEGER NOT NULL
  );
`);

const now = () => Math.floor(Date.now() / 1000);

// Tokens are stored hashed: a leaked database should not hand over live
// credentials the way a plaintext table would.
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const newSecret = () => crypto.randomBytes(32).toString('base64url');

function purgeExpired() {
  const t = now();
  db.prepare('DELETE FROM codes WHERE expires_at < ?').run(t);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(t);
}
setInterval(purgeExpired, 10 * 60 * 1000).unref();
purgeExpired();

// --- password --------------------------------------------------------------

function readPasswordHash() {
  try {
    return fs.readFileSync(PASSWORD_HASH_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function verifyPassword(candidate) {
  const stored = readPasswordHash();
  if (!stored) return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(candidate, salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readStaticToken() {
  try {
    return fs.readFileSync(STATIC_TOKEN_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- app -------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '256kb' }));

// Discovery and token endpoints are fetched cross-origin by browser-based MCP
// clients; the diary data itself is never served to a browser origin.
function cors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// --- discovery -------------------------------------------------------------

const resourceMetadata = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  bearer_methods_supported: ['header'],
  scopes_supported: ['timely'],
  // RFC 9728 section 2. A client with somewhere to show a name gets one.
  resource_name: 'Timely',
  resource_documentation: ISSUER,
};

app.get('/.well-known/oauth-protected-resource', cors, (_req, res) => res.json(resourceMetadata));

// Some clients probe the path-suffixed form from RFC 9728 section 3.
app.get('/.well-known/oauth-protected-resource/mcp', cors, (_req, res) => res.json(resourceMetadata));

const asMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  scopes_supported: ['timely'],
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  service_documentation: ISSUER,
};

app.get('/.well-known/oauth-authorization-server', cors, (_req, res) => res.json(asMetadata));
app.get('/.well-known/oauth-authorization-server/mcp', cors, (_req, res) => res.json(asMetadata));

// --- dynamic client registration (RFC 7591) --------------------------------

app.post('/register', cors, (req, res) => {
  const body = req.body || {};
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
  }
  for (const uri of redirectUris) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `not a URI: ${uri}` });
    }
    // OAuth 2.1: redirect URIs must be HTTPS, with localhost the only exception.
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (parsed.protocol !== 'https:' && !isLocalhost) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris must use https, or localhost' });
    }
  }

  const clientId = crypto.randomUUID();
  const authMethod = body.token_endpoint_auth_method || 'client_secret_post';
  let clientSecret = null;
  if (authMethod !== 'none') clientSecret = newSecret();

  db.prepare(
    'INSERT INTO clients (client_id, client_secret_hash, redirect_uris, client_name, created_at) VALUES (?,?,?,?,?)'
  ).run(
    clientId,
    clientSecret ? hashToken(clientSecret) : null,
    JSON.stringify(redirectUris),
    typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : null,
    now()
  );

  const out = {
    client_id: clientId,
    client_id_issued_at: now(),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: authMethod,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
  if (clientSecret) {
    out.client_secret = clientSecret;
    out.client_secret_expires_at = 0;
  }
  res.status(201).json(out);
});

// --- authorization ---------------------------------------------------------

function getClient(clientId) {
  return db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loginPage({ params, error }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Timely MCP</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon.png">
<style>
  /* Timely's own palette, taken from timely.com. */
  :root{color-scheme:light dark;--fg:#150827;--muted:#6a6377;--line:#e5e0f0;
        --bg:#fcf9ff;--accent:#7c5cfc}
  @media (prefers-color-scheme:dark){
    :root{--fg:#fcf9ff;--muted:#9a93a8;--line:#2a1d3d;--bg:#150827;--accent:#7c5cfc}
  }
  *{box-sizing:border-box}
  body{font:15px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
  form{width:100%;max-width:20rem}
  img{display:block;width:40px;height:40px;margin-bottom:1.25rem}
  h1{font-size:1rem;font-weight:600;margin:0 0 .25rem}
  p{color:var(--muted);margin:0 0 1.5rem}
  label{display:block;font-size:.8125rem;color:var(--muted);margin-bottom:.375rem}
  input{width:100%;padding:.5rem .625rem;border:1px solid var(--line);border-radius:6px;
        background:transparent;color:inherit;font:inherit}
  input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
  button{width:100%;margin-top:1rem;padding:.5rem;border:1px solid var(--accent);border-radius:6px;
         background:var(--accent);color:#fff;font:inherit;cursor:pointer}
  button:hover{opacity:.85}
  .err{color:#c0392b;margin:0 0 1rem}
  @media (prefers-color-scheme:dark){.err{color:#ff7a6b}}
</style></head><body>
  <form method="POST" action="/authorize">
      ${hidden}
      <img src="/icon.png" alt="">
      <h1>Timely</h1>
      <p>Sign in to give this app access to your Timely time tracking.</p>
      ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
      <label for="password">Password</label>
      <input id="password" type="password" name="password" autofocus autocomplete="current-password" required>
      <button type="submit">Continue</button>
  </form>
</body></html>`;
}

function validateAuthRequest(q) {
  if (q.response_type !== 'code') return 'response_type must be code';
  if (!q.client_id) return 'client_id is required';
  const client = getClient(q.client_id);
  if (!client) return 'unknown client_id';
  if (!q.redirect_uri) return 'redirect_uri is required';
  const allowed = JSON.parse(client.redirect_uris);
  // Exact match only - prefix matching is how open-redirect bugs happen.
  if (!allowed.includes(q.redirect_uri)) return 'redirect_uri does not match a registered value';
  if (q.code_challenge_method !== 'S256') return 'code_challenge_method must be S256';
  if (!q.code_challenge) return 'code_challenge is required';
  return null;
}

app.get('/authorize', (req, res) => {
  const err = validateAuthRequest(req.query);
  // A bad client_id or redirect_uri must render here, never redirect - bouncing
  // an unvalidated redirect_uri back is the open-redirect the spec warns about.
  if (err) return res.status(400).type('html').send(loginPage({ params: {}, error: err }));
  res.type('html').send(loginPage({ params: req.query, error: null }));
});

app.post('/authorize', (req, res) => {
  const p = req.body || {};
  const err = validateAuthRequest(p);
  if (err) return res.status(400).type('html').send(loginPage({ params: {}, error: err }));

  if (!verifyPassword(String(p.password || ''))) {
    const { password, ...rest } = p;
    return res.status(401).type('html').send(loginPage({ params: rest, error: 'Wrong password.' }));
  }

  const code = newSecret();
  db.prepare(
    'INSERT INTO codes (code, client_id, redirect_uri, code_challenge, resource, scope, expires_at) VALUES (?,?,?,?,?,?,?)'
  ).run(
    hashToken(code),
    p.client_id,
    p.redirect_uri,
    p.code_challenge,
    p.resource || RESOURCE,
    p.scope || 'timely',
    now() + AUTH_CODE_TTL_S
  );

  const target = new URL(p.redirect_uri);
  target.searchParams.set('code', code);
  if (p.state) target.searchParams.set('state', p.state);
  res.redirect(302, target.toString());
});

// --- token -----------------------------------------------------------------

function authenticateClient(req) {
  const body = req.body || {};
  let clientId = body.client_id;
  let clientSecret = body.client_secret;

  const auth = req.get('authorization');
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx !== -1) {
      clientId = decodeURIComponent(decoded.slice(0, idx));
      clientSecret = decodeURIComponent(decoded.slice(idx + 1));
    }
  }

  if (!clientId) return { error: 'invalid_client' };
  const client = getClient(clientId);
  if (!client) return { error: 'invalid_client' };

  if (client.client_secret_hash) {
    if (!clientSecret) return { error: 'invalid_client' };
    if (!timingSafeEqualStr(hashToken(clientSecret), client.client_secret_hash)) {
      return { error: 'invalid_client' };
    }
  }
  return { client };
}

function issueTokens(clientId, audience, scope) {
  const accessToken = newSecret();
  const refreshToken = newSecret();
  const t = now();
  const insert = db.prepare(
    'INSERT INTO tokens (token_hash, kind, client_id, audience, scope, expires_at) VALUES (?,?,?,?,?,?)'
  );
  insert.run(hashToken(accessToken), 'access', clientId, audience, scope, t + ACCESS_TOKEN_TTL_S);
  insert.run(hashToken(refreshToken), 'refresh', clientId, audience, scope, t + REFRESH_TOKEN_TTL_S);
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope,
  };
}

app.post('/token', cors, (req, res) => {
  const body = req.body || {};
  const auth = authenticateClient(req);
  if (auth.error) return res.status(401).json({ error: auth.error });
  const clientId = auth.client.client_id;

  if (body.grant_type === 'authorization_code') {
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const row = db.prepare('SELECT * FROM codes WHERE code = ?').get(hashToken(body.code));
    // Delete on first sight: an authorization code is single-use whether or not
    // the rest of this request turns out to be valid.
    if (row) db.prepare('DELETE FROM codes WHERE code = ?').run(hashToken(body.code));
    if (!row || row.expires_at < now()) return res.status(400).json({ error: 'invalid_grant' });
    if (row.client_id !== clientId) return res.status(400).json({ error: 'invalid_grant' });
    if (row.redirect_uri !== body.redirect_uri) return res.status(400).json({ error: 'invalid_grant' });

    const challenge = crypto.createHash('sha256').update(body.code_verifier).digest('base64url');
    if (!timingSafeEqualStr(challenge, row.code_challenge)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    }
    return res.json(issueTokens(clientId, row.resource || RESOURCE, row.scope || 'timely'));
  }

  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) return res.status(400).json({ error: 'invalid_request' });
    const h = hashToken(body.refresh_token);
    const row = db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'refresh'").get(h);
    if (!row || row.expires_at < now() || row.client_id !== clientId) {
      return res.status(400).json({ error: 'invalid_grant' });
    }
    // Rotation: the presented refresh token dies here, per OAuth 2.1 for public clients.
    db.prepare('DELETE FROM tokens WHERE token_hash = ?').run(h);
    return res.json(issueTokens(clientId, row.audience || RESOURCE, row.scope || 'timely'));
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

// --- resource guard + proxy ------------------------------------------------

function unauthorized(res, description) {
  res.set(
    'WWW-Authenticate',
    `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"` +
      (description ? `, error="invalid_token", error_description="${description}"` : '')
  );
  return res.status(401).json({ error: 'invalid_token', error_description: description || 'authorization required' });
}

function authorizeRequest(req, res, next) {
  const header = req.get('authorization') || '';
  if (!header.startsWith('Bearer ')) return unauthorized(res);
  const presented = header.slice(7).trim();

  // Path 1: the pre-existing static token, so Claude Code keeps working.
  const staticToken = readStaticToken();
  if (staticToken && timingSafeEqualStr(presented, staticToken)) return next();

  // Path 2: an OAuth access token issued by this server.
  const row = db.prepare("SELECT * FROM tokens WHERE token_hash = ? AND kind = 'access'").get(hashToken(presented));
  if (!row) return unauthorized(res, 'unknown token');
  if (row.expires_at < now()) return unauthorized(res, 'token expired');
  // RFC 8707 audience binding: a token minted for something else is not valid here.
  if (row.audience && row.audience !== RESOURCE) return unauthorized(res, 'token audience mismatch');
  next();
}

// Clients may send a protocol version newer than the upstream SDK accepts, so
// the version it negotiated at initialize is enforced instead.
const sessionProtocol = new Map();
const MAX_TRACKED_SESSIONS = 500;

function rememberProtocol(sessionId, version) {
  if (!sessionId || !version) return;
  if (sessionProtocol.size >= MAX_TRACKED_SESSIONS) {
    sessionProtocol.delete(sessionProtocol.keys().next().value);
  }
  sessionProtocol.set(sessionId, version);
}

// The upstream spawns one stdio child per session, and that child can stop
// answering while its process stays alive. Nothing below this layer notices, so
// without a stall timer the call hangs until the client gives up, and because
// the session outlives it, every later call on the same session hangs too.
class StallError extends Error {}

// Aborting the fetch signal does not reliably reject a read that is already
// parked, so the deadline is raced against the read rather than delegated to it.
function withDeadline(promise, ms) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => reject(new StallError()), ms);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (err) => {
        clearTimeout(handle);
        reject(err);
      }
    );
  });
}

// Terminating the session upstream kills the wedged child with it, so the next
// call gets a clean "no valid session" and the client re-initializes.
async function terminateUpstreamSession(sessionId) {
  if (!sessionId) return;
  sessionProtocol.delete(sessionId);
  try {
    await fetch(`${UPSTREAM}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });
  } catch {
    // The session is being abandoned either way.
  }
}

// The MCP keeps the response open and sends as it goes, so this passes the
// data straight through instead of collecting it first. express.json() has
// already read the request body, so it has to be written out again here.
app.all('/mcp{/*path}', cors, authorizeRequest, async (req, res) => {
  const url = `${UPSTREAM}/mcp`;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (['host', 'connection', 'content-length', 'authorization'].includes(key)) continue;
    headers[key] = v;
  }

  const rpcMethod =
    req.body && typeof req.body === 'object' ? req.body.method : undefined;
  const isInitialize = rpcMethod === 'initialize';
  const clientSessionId = req.get('mcp-session-id');

  if (isInitialize) {
    // Negotiation happens in the body; the header would be rejected first.
    delete headers['mcp-protocol-version'];
  } else {
    const negotiated = clientSessionId ? sessionProtocol.get(clientSessionId) : undefined;
    if (negotiated) headers['mcp-protocol-version'] = negotiated;
    else delete headers['mcp-protocol-version'];
  }

  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    headers['content-type'] = headers['content-type'] || 'application/json';
  }

  // The GET stream is idle by design and must never be cut; only calls that are
  // waiting on the child are watched.
  const watched = !['GET', 'HEAD', 'DELETE'].includes(req.method);
  const deadline = watched ? CALL_TIMEOUT_MS : 0;
  const abort = new AbortController();

  try {
    const upstream = await withDeadline(
      fetch(url, {
        method: req.method,
        headers,
        body,
        duplex: 'half',
        signal: abort.signal,
      }),
      deadline
    );

    // The upstream answers an unknown or terminated session with 400, but the
    // spec reserves 404 for that case, and only 404 obliges the client to start
    // a new session. With 400 it reports a dead connection and stays stuck.
    if (upstream.status === 400 && clientSessionId) {
      const text = await upstream.text();
      if (text.includes('No valid session ID provided')) {
        sessionProtocol.delete(clientSessionId);
        return res.status(404).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? null,
          error: { code: -32001, message: 'Session not found, start a new one' },
        });
      }
      return res.status(400).type('application/json').send(text);
    }

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) return;
      res.set(key, value);
    });
    if (!upstream.body) return res.end();

    const newSessionId = upstream.headers.get('mcp-session-id') || clientSessionId;

    // Small enough to buffer; everything else streams.
    if (isInitialize) {
      const text = await withDeadline(upstream.text(), deadline);
      const match = text.match(/"protocolVersion"\s*:\s*"([^"]+)"/);
      if (match) rememberProtocol(newSessionId, match[1]);
      res.end(text);
      return;
    }
    const reader = upstream.body.getReader();
    for (;;) {
      // The deadline covers each read, so it measures silence rather than the
      // total time a legitimately slow, chatty call is allowed to take.
      const { done, value } = await withDeadline(reader.read(), deadline);
      if (done) break;
      res.write(Buffer.from(value));
      if (typeof res.flush === 'function') res.flush();
    }
    res.end();
  } catch (err) {
    if (err instanceof StallError) {
      abort.abort();
      await terminateUpstreamSession(clientSessionId);
      console.error(`upstream silent for ${CALL_TIMEOUT_MS}ms, session terminated: ${clientSessionId || 'none'}`);
      if (!res.headersSent) {
        // 404 rather than an error body, because that is what obliges the
        // client to open a new session instead of reporting a dead one.
        res.status(404).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? null,
          error: { code: -32001, message: 'Session not found, start a new one' },
        });
        return;
      }
      return res.end();
    }
    if (!res.headersSent) res.status(502).json({ error: 'upstream_unavailable' });
    else res.end();
  }
});

// Without these the browser falls back to the parent domain's icon.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// Clients that show an icon for the connector look for it at the site root, not
// at /favicon.ico. With the root answering 404 JSON there is no markup to read
// an icon from, so they fall back to the registrable domain's favicon - which is
// a different site entirely. Serving real markup here is what fixes that.
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Timely MCP</title>
<meta name="description" content="MCP server for Timely time tracking.">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/icon.png" type="image/png">
<link rel="apple-touch-icon" href="/icon.png">
<style>
  :root{color-scheme:light dark;--fg:#150827;--muted:#6a6377;--bg:#fcf9ff}
  @media (prefers-color-scheme:dark){:root{--fg:#fcf9ff;--muted:#9a93a8;--bg:#150827}}
  body{font:15px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:1.5rem}
  main{max-width:20rem}
  img{display:block;width:40px;height:40px;margin-bottom:1.25rem}
  h1{font-size:1rem;font-weight:600;margin:0 0 .25rem}
  p{color:var(--muted);margin:0}
</style></head><body>
  <main>
    <img src="/icon.png" alt="">
    <h1>Timely</h1>
    <p>MCP endpoint. Add it as a connector to use it.</p>
  </main>
</body></html>`);
});

// A CDN will happily cache a 404 for an asset path for an hour, so a file added
// after the first request stays missing long after it exists.
app.use((_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(404).json({ error: 'not_found' });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`timely-mcp auth server on 127.0.0.1:${PORT}`);
  console.log(`  issuer:   ${ISSUER}`);
  console.log(`  resource: ${RESOURCE}`);
  console.log(`  upstream: ${UPSTREAM}`);
  console.log(`  call timeout: ${CALL_TIMEOUT_MS}ms`);
  if (!readPasswordHash()) console.warn('  WARNING: no password hash set - /authorize will reject everything');
});
