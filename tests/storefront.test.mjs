import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/site.js', import.meta.url), 'utf8');
function storefront(search, fetch) {
  const element = () => ({ style: {}, value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null });
  const ids = Object.fromEntries(['drawerRoot', 'drawerBody', 'drawerFoot', 'drawerTitle', 'bagCount', 'backBtn', 'placeBtn', 'coErr', 'doneBtn', 'coName', 'coEmail', 'coPhone', 'coAddress', 'coCity', 'coState'].map(id => [id, element()]));
  const storage = { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); }, removeItem() { throw new Error('Storage blocked'); } };
  let redirected;
  const location = { search, pathname: '/', hash: '', assign: url => { redirected = url; } };
  const context = vm.createContext({
    URLSearchParams, AbortSignal, console, fetch, localStorage: storage, sessionStorage: storage,
    document: { getElementById: id => ids[id] || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: element() },
    window: { location, addEventListener() {} }, location, history: { replaceState() {} },
    addEventListener() {}, setTimeout() {}, matchMedia: () => ({ matches: true }),
    IntersectionObserver: class { observe() {} }, money: amount => String(amount),
  });
  vm.runInContext(source, context);
  return { context, ids, get redirected() { return redirected; } };
}
test('a paid return renders confirmation without browser storage or a pending session', async () => {
  const order = { id: 'RW-123456ABCDEF', customer: { name: '<script>bad</script>', email: 'buyer@example.com', phone: '08012345678', address: 'Street', city: 'Lagos', state: 'Lagos' }, items: [], total: 148000 };
  const ui = storefront('?reference=runaway-' + 'a'.repeat(48), async () => Response.json({ ok: true, paid: true, order, emailQueued: true }));
  await vm.runInContext('handlePaymentReturn()', ui.context);
  assert.match(ui.ids.drawerBody.innerHTML, /Order Received/);
  assert.match(ui.ids.drawerBody.innerHTML, /receipt is queued/);
  assert.match(ui.ids.drawerBody.innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.ids.drawerBody.innerHTML, /confirmation was sent/);
});
test('payment return errors render URL input as text rather than markup', async () => {
  const ui = storefront('?reference=' + encodeURIComponent('<img src=x onerror=alert(1)>'), async () => Response.json({ error: 'Invalid reference.' }, { status: 400 }));
  await vm.runInContext('handlePaymentReturn()', ui.context);
  assert.match(ui.ids.drawerBody.innerHTML, /&lt;img/);
  assert.doesNotMatch(ui.ids.drawerBody.innerHTML, /<img src=x/);
});
test('checkout still redirects to Paystack when session storage is blocked', async () => {
  const ui = storefront('', async () => Response.json({ ok: true, authorizationUrl: 'https://checkout.paystack.com/test', reference: 'ref', orderId: 'id' }));
  const values = { coName: 'Buyer', coEmail: 'buyer@example.com', coPhone: '08012345678', coAddress: 'Street', coCity: 'Lagos', coState: 'Lagos' };
  for (const [id, value] of Object.entries(values)) ui.ids[id].value = value;
  ui.ids.placeBtn.querySelector = () => ({ textContent: '' });
  vm.runInContext('step = "checkout"; paintBag();', ui.context);
  await ui.ids.placeBtn.onclick();
  assert.equal(ui.redirected, 'https://checkout.paystack.com/test');
});
