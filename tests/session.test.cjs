const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../Anitsu-Downloader.user.js'), 'utf8');
function harness(cookie) {
  const requests = [];
  const logs = [];
  const document = { cookie, getElementById() { return null; } };
  const config = source.slice(source.indexOf('const SUPABASE_AUTH_URL'), source.indexOf('// ─── Estado interno'));
  const session = source.slice(source.indexOf('const AUTH_COOKIE_NAME'), source.indexOf('// ─── Utilitários'));
  const context = vm.createContext({ document, URL, TextEncoder, TextDecoder, Uint8Array, atob, btoa, Date, Map,
    location: { protocol: 'https:', hostname: 'nuvem.anitsu.moe' },
    SESSION_COOKIE_DAYS: 30, SESSION_REFRESH_TIMEOUT_MS: 12000,
    sessionRefreshPromise: null, sessionRefreshing: false,
    log(message) { logs.push(message); }, clearApiCache() {}, updateSessionIndicator() {},
    GM_xmlhttpRequest(options) { requests.push(options); }
  });
  vm.runInContext(config + session + '\nglobalThis.auth = { getAuthData, refreshSession, writeAuthData, AUTH_COOKIE_NAME };', context);
  return { context, document, requests, logs, auth: context.auth };
}
const data = { access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const encoded = 'base64-' + Buffer.from(JSON.stringify(data)).toString('base64url');
test('reads current unchunked auth cookie, ignoring legacy cookie', () => {
  const h = harness(`sb-qzrxxwizigfdcpmwkztq-auth-token=invalid; sb-auth-auth-token=${encoded}`);
  assert.equal(h.auth.AUTH_COOKIE_NAME, 'sb-auth-auth-token');
  assert.equal(h.auth.getAuthData().refresh_token, data.refresh_token);
});
test('reads current chunked auth cookie', () => {
  const split = Math.floor(encoded.length / 2);
  const h = harness(`sb-auth-auth-token.1=${encoded.slice(split)}; sb-auth-auth-token.0=${encoded.slice(0, split)}`);
  assert.equal(h.auth.getAuthData().access_token, data.access_token);
});
test('refresh uses current server and persists rotated token', async () => {
  const h = harness(`sb-auth-auth-token=${encoded}`);
  const promise = h.auth.refreshSession();
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(request.url, 'https://auth.anitsu.moe/auth/v1/token?grant_type=refresh_token');
  assert.equal(JSON.parse(request.data).refresh_token, data.refresh_token);
  const publicKey = JSON.parse(Buffer.from(request.headers.apikey.split('.')[1], 'base64url'));
  assert.equal(publicKey.role, 'anon');
  request.onload({ status: 200, responseText: JSON.stringify({ ...data, refresh_token: 'rotated-token' }) });
  assert.equal(await promise, true);
  assert.equal(h.auth.getAuthData().refresh_token, 'rotated-token');
});
test('missing cookies do not start a refresh request', async () => {
  const h = harness('');
  assert.equal(await h.auth.refreshSession(), false);
  assert.equal(h.requests.length, 0);
});
