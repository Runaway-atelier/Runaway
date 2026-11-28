import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { localRequestURL } from '../scripts/local-origin.mjs';
import { sameOrigin } from '../lib/http.mjs';
import { adminUI } from './helpers/admin-ui.mjs';
const source = await readFile(new URL('../admin/login.js', import.meta.url), 'utf8');
const secret = 'a'.repeat(64);
function loginUI(value, { protocol = 'http:', storageBlocked = false, status = 200 } = {}) {
  let submitted, redirected;
  const form = { addEventListener(event, handler) { this.submit = handler; }, animate() {} };
  const ids = { loginForm: form, loginBtn: { disabled: false }, loginErr: { textContent: '' }, secretKey: { value, focus() {} } };
  const context = vm.createContext({ AbortSignal, Date,
    document: { getElementById: id => ids[id] }, window: { location: { protocol, replace(url) { redirected = url; } } },
    sessionStorage: { setItem() { if (storageBlocked) throw new Error('Storage blocked'); } },
    fetch: async (url, options) => { submitted = JSON.parse(options.body); return Response.json(status === 200 ? { ok: true } : { error: 'Invalid owner secret key.' }, { status }); },
  });
  vm.runInContext(source, context);
  return { ids, get submitted() { return submitted; }, get redirected() { return redirected; }, submit: () => form.submit({ preventDefault() {} }) };
}
test('login accepts the full env assignment or quoted value without changing the passcode', async () => {
  for (const value of [secret, `  ADMIN_SECRET_KEY='${secret}'  `, `"${secret}"`]) {
    const ui = loginUI(value); await ui.submit();
    assert.equal(ui.submitted.secretKey, secret);
    assert.equal(ui.redirected, 'dashboard.html');
  }
});
test('a successful login still opens the dashboard when session storage is blocked', async () => {
  const ui = loginUI(secret, { storageBlocked: true }); await ui.submit();
  assert.equal(ui.redirected, 'dashboard.html');
  assert.equal(ui.ids.loginErr.textContent, '');
});
test('old short passcodes get an actionable error before making a login attempt', async () => {
  const ui = loginUI('runaway2026!'); await ui.submit();
  assert.equal(ui.submitted, undefined);
  assert.match(ui.ids.loginErr.textContent, /old sample passcode/);
  assert.equal(ui.ids.loginBtn.disabled, false);
});
test('a file URL explains which local login page to open', async () => {
  const ui = loginUI(secret, { protocol: 'file:' }); await ui.submit();
  assert.equal(ui.submitted, undefined);
  assert.match(ui.ids.loginErr.textContent, /http:\/\/localhost:3000\/admin\/login/);
});
test('a rejected credential cannot navigate to the dashboard', async () => {
  const ui = loginUI(secret, { status: 401 }); await ui.submit();
  assert.equal(ui.redirected, undefined);
  assert.match(ui.ids.loginErr.textContent, /Invalid owner secret key/);
});
test('both loopback hosts keep their real request origin and still reject cross-origin requests', () => {
  for (const host of ['localhost:3000', '127.0.0.1:3000']) {
    const url = localRequestURL('/api/admin-session', host, 3000);
    assert.equal(url.origin, `http://${host}`);
    assert.doesNotThrow(() => sameOrigin(new Request(url, { headers: { origin: `http://${host}` } })));
    assert.throws(() => sameOrigin(new Request(url, { headers: { origin: 'https://other.example' } })), error => error.status === 403);
  }
  assert.equal(localRequestURL('/api/admin-session', 'attacker.example:3000', 3000), null);
  assert.equal(localRequestURL('//attacker.example/api/admin-session', 'localhost:3000', 3000), null);
});
test('dashboard authentication checks the server cookie even when browser storage is unavailable', async () => {
  const ui = adminUI([], { storageBlocked: true });
  assert.equal(await ui.run('ownerSessionReady'), true);
  assert.equal(ui.redirected, undefined);
  assert.equal(ui.run("getAdminStorefrontUrl({file:'/products/product.html?slug=test'})"), '/products/product.html?slug=test');
});
