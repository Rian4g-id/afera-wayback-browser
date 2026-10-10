// Rotating proxy support for archive API requests (main process).
// When proxies are enabled the renderer sends every archive request here,
// and each request goes out through the next proxy in the list.
const { app, ipcMain, net, session, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// A proxy that fails this many times in a row is skipped for COOLDOWN_MS
const MAX_FAILS = 2;
const COOLDOWN_MS = 60 * 1000;

// Test button: first a neutral, always-up URL (does the proxy itself work?),
// then Wayback (can the archive be reached through it?)
const TEST_PROXY_URL = 'https://www.gstatic.com/generate_204';
const TEST_WAYBACK_URL = 'https://web.archive.org/cdx/search/cdx?url=example.com&output=json&fl=timestamp&limit=1';
const TEST_TIMEOUT = 20000;
const TEST_CONCURRENCY = 5;

let config = { enabled: false, list: '' };
let proxies = []; // parsed proxies in rotation order
let cursor = 0;

const sessions = new Map(); // proxy key -> Promise<Session> with that proxy set
const activeRequests = new Map(); // request id -> ClientRequest (for abort)
const earlyAborts = new Set(); // ids aborted before their request started

function settingsFile() {
  return path.join(app.getPath('userData'), 'proxy-settings.json');
}

// Parse one line: host:port, host:port:user:pass, user:pass@host:port,
// with an optional scheme prefix (http://, https://, socks4://, socks5://)
function parseProxy(line) {
  let text = line.trim();
  if (!text || text.startsWith('#')) return null;

  let scheme = 'http';
  const schemeMatch = text.match(/^(https?|socks4|socks5):\/\//i);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    text = text.slice(schemeMatch[0].length);
  }

  let hostPort = text;
  let username = '';
  let password = '';
  const at = text.lastIndexOf('@');
  if (at !== -1) {
    const credentials = text.slice(0, at);
    const colon = credentials.indexOf(':');
    username = colon === -1 ? credentials : credentials.slice(0, colon);
    password = colon === -1 ? '' : credentials.slice(colon + 1);
    hostPort = text.slice(at + 1);
  } else {
    const parts = text.split(':');
    if (parts.length === 4) {
      hostPort = `${parts[0]}:${parts[1]}`;
      username = parts[2];
      password = parts[3];
    }
  }

  const match = hostPort.match(/^([^:\s/]+):(\d{1,5})$/);
  if (!match) return undefined; // invalid line
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;

  const host = match[1];
  return {
    scheme, host, port, username, password,
    label: `${host}:${port}`,
    key: `${scheme}://${username}:${password}@${host}:${port}`,
    rules: `${scheme}://${host}:${port}`,
    fails: 0,
    coolUntil: 0
  };
}

function parseProxyList(text) {
  const list = [];
  const invalid = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const proxy = parseProxy(line);
    if (proxy === undefined) invalid.push(line.trim());
    else if (proxy) list.push(proxy);
  }
  return { list, invalid };
}

// One in-memory session per proxy, so requests can use different proxies at once
function getSession(proxy) {
  if (!sessions.has(proxy.key)) {
    const ses = session.fromPartition(`proxy-${sessions.size}`);
    sessions.set(proxy.key, ses.setProxy({ proxyRules: proxy.rules }).then(() => ses));
  }
  return sessions.get(proxy.key);
}

// Next proxy in rotation, skipping ones that are cooling down after failures
function nextProxy() {
  if (proxies.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[(cursor + i) % proxies.length];
    if (proxy.coolUntil <= now) {
      cursor = (cursor + i + 1) % proxies.length;
      return proxy;
    }
  }
  // All cooling down: use the one that recovers first
  return proxies.reduce((a, b) => (a.coolUntil <= b.coolUntil ? a : b));
}

function markResult(proxy, result) {
  const failed = (result.error && !result.aborted) || result.status === 407;
  if (!failed) {
    proxy.fails = 0;
    return;
  }
  proxy.fails++;
  if (proxy.fails >= MAX_FAILS) {
    proxy.fails = 0;
    proxy.coolUntil = Date.now() + COOLDOWN_MS;
  }
}

function headerValue(response, name) {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// GET url through one proxy. Never rejects: resolves with
// { status, retryAfter, text } or { error, timedOut?, aborted? }, plus the proxy label.
async function requestViaProxy(proxy, url, timeout, id) {
  let ses;
  try {
    ses = await getSession(proxy);
  } catch (error) {
    sessions.delete(proxy.key); // try setting it up again next time
    return { proxy: proxy.label, error: `proxy setup failed: ${error.message}` };
  }

  if (id != null && earlyAborts.delete(id)) {
    return { proxy: proxy.label, error: 'aborted', aborted: true };
  }

  return new Promise((resolve) => {
    let settled = false;
    let loginAsked = false;
    let authTried = false;
    const request = net.request({ url, session: ses, useSessionCookies: false });

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (id != null) activeRequests.delete(id);
      // A failure after the proxy asked for a login is most likely wrong/missing credentials
      if (result.error && !result.aborted && loginAsked) {
        result.error += proxy.username
          ? ' - proxy may have rejected the username/password'
          : ' - proxy requires a username/password';
      }
      resolve({ proxy: proxy.label, ...result });
    };

    const timer = setTimeout(() => {
      done({ error: `timed out after ${timeout / 1000}s`, timedOut: true });
      request.abort();
    }, timeout);
    if (id != null) activeRequests.set(id, request);

    // Proxy asks for credentials: answer once, then give up (avoids a retry loop on wrong ones)
    request.on('login', (authInfo, callback) => {
      if (authInfo.isProxy) loginAsked = true;
      if (authInfo.isProxy && proxy.username && !authTried) {
        authTried = true;
        callback(proxy.username, proxy.password);
      } else {
        callback();
      }
    });

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done({
        status: response.statusCode,
        retryAfter: headerValue(response, 'retry-after'),
        text: Buffer.concat(chunks).toString('utf8')
      }));
      response.on('aborted', () => done({ error: 'aborted', aborted: true }));
      response.on('error', (error) => done({ error: error.message || 'response error' }));
    });
    request.on('abort', () => done({ error: 'aborted', aborted: true }));
    request.on('error', (error) => done({ error: error.message || 'request failed' }));
    request.end();
  });
}

function applyConfig() {
  proxies = parseProxyList(config.list).list;
  cursor = 0;
}

function publicConfig() {
  return { enabled: config.enabled, list: config.list, count: proxies.length };
}

// Proxy list may hold passwords: encrypt it with the OS key store when available
function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    let list = saved.list || '';
    if (saved.encrypted && safeStorage.isEncryptionAvailable()) {
      list = safeStorage.decryptString(Buffer.from(saved.encrypted, 'base64'));
    }
    config = { enabled: !!saved.enabled, list };
  } catch (error) {
    config = { enabled: false, list: '' };
  }
  applyConfig();
}

function saveConfig() {
  const data = { enabled: config.enabled };
  if (safeStorage.isEncryptionAvailable()) {
    data.encrypted = safeStorage.encryptString(config.list).toString('base64');
  } else {
    data.list = config.list;
  }
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
}

async function testProxies(list) {
  const { list: parsed, invalid } = parseProxyList(list);
  const results = new Array(parsed.length);
  let next = 0;

  async function worker() {
    while (next < parsed.length) {
      const index = next++;
      const proxy = parsed[index];
      const started = Date.now();
      const label = proxy.label;

      const check = await requestViaProxy(proxy, TEST_PROXY_URL, TEST_TIMEOUT, null);
      if (check.error || check.status === 407) {
        const detail = check.error || 'proxy rejected the username/password (407)';
        results[index] = { proxy: label, ok: false, ms: Date.now() - started, detail };
        continue;
      }

      const wayback = await requestViaProxy(proxy, TEST_WAYBACK_URL, TEST_TIMEOUT, null);
      results[index] = {
        proxy: label,
        ok: true,
        ms: Date.now() - started,
        detail: wayback.error
          ? `proxy works, but Wayback is unreachable through it (${wayback.error})`
          : `proxy works, Wayback answered HTTP ${wayback.status}`
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(TEST_CONCURRENCY, parsed.length) }, worker));
  return { results, invalid };
}

// Call once the app is ready
function setupArchiveProxy() {
  loadConfig();

  ipcMain.handle('proxy-get-config', () => publicConfig());

  ipcMain.handle('proxy-save-config', (event, { enabled, list }) => {
    config = { enabled: !!enabled, list: String(list || '') };
    applyConfig();
    saveConfig();
    return { ...publicConfig(), invalid: parseProxyList(config.list).invalid };
  });

  ipcMain.handle('proxy-test', (event, { list }) => testProxies(list));

  // Request ids come from the page and restart after a reload: key them by page too
  ipcMain.handle('proxy-fetch', async (event, { id, url, timeout }) => {
    const proxy = nextProxy();
    if (!proxy) return { error: 'no proxies configured', proxy: '-' };
    const result = await requestViaProxy(proxy, url, timeout, `${event.sender.id}:${id}`);
    markResult(proxy, result);
    return result;
  });

  ipcMain.on('proxy-fetch-abort', (event, id) => {
    const key = `${event.sender.id}:${id}`;
    const request = activeRequests.get(key);
    if (request) request.abort();
    else {
      // Still waiting for its proxy session (or already finished: forget it after a while)
      earlyAborts.add(key);
      setTimeout(() => earlyAborts.delete(key), 30000);
    }
  });
}

module.exports = { setupArchiveProxy };
