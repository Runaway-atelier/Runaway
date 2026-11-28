import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../js/site.js', import.meta.url), 'utf8');
function storefront(search, fetch, extras = {}) {
  const element = () => ({ style: {}, value: '', innerHTML: '', textContent: '', classList: { add() {}, remove() {} }, addEventListener() {}, setAttribute() {}, querySelector: () => null });
  const ids = Object.fromEntries(['drawerRoot', 'drawerBody', 'drawerFoot', 'drawerTitle', 'bagCount', 'backBtn', 'placeBtn', 'coErr', 'doneBtn', 'coName', 'coEmail', 'coPhone', 'coAddress', 'coCity', 'coState', 'coBtn'].map(id => [id, element()]));
  const storage = { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Storage blocked'); }, removeItem() { throw new Error('Storage blocked'); } };
  let redirected;
  const location = { protocol: 'https:', search, pathname: '/', hash: '', assign: url => { redirected = url; } };
  const context = vm.createContext({
    URLSearchParams, AbortSignal, console, fetch, localStorage: storage, sessionStorage: storage,
    document: { getElementById: id => ids[id] || null, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: element() },
    window: { location, addEventListener() {} }, location, history: { replaceState() {} },
    addEventListener() {}, setTimeout() {}, matchMedia: () => ({ matches: true }),
    IntersectionObserver: class { observe() {} }, money: amount => String(amount),
    ...extras,
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

test('a paid return clears the saved database bag after hydration without restoring old items', async () => {
  const product = { slug: 'test-top', name: 'Test Top', price: 1000, sizes: ['M'], colors: [{ id: 'black', name: 'Black' }], images: ['top.jpg'] };
  const cartWrites = [];
  const order = { id: 'RW-123456ABCDEF', customer: { name: 'Buyer', email: 'buyer@example.com' }, items: [], total: 1000 };
  const ui = storefront('?reference=runaway-' + 'a'.repeat(48), async (url, options) => {
    if (url === '/api/cart' && !options?.method) return Response.json({ items: [{ slug: product.slug, size: 'M', color: 'black', qty: 1 }] });
    if (url === '/api/cart') { cartWrites.push(JSON.parse(options.body)); return Response.json({ ok: true }); }
    return Response.json({ ok: true, paid: true, order });
  }, { shopReady: Promise.resolve({ products: [product] }), getProduct: slug => slug === product.slug ? product : null });
  await vm.runInContext('handlePaymentReturn()', ui.context);
  await vm.runInContext('Cart.syncQueue', ui.context);
  assert.equal(vm.runInContext('Cart.count()', ui.context), 0);
  assert.deepEqual(cartWrites.at(-1), { items: [] });
  assert.match(ui.ids.drawerBody.innerHTML, /Order Received/);
});

test('shared catalogue is authoritative over old browser catalogue data', async () => {
  const dataSource = await readFile(new URL('../js/data.js', import.meta.url), 'utf8');
  const shared = { products: [{ slug: 'database-piece', name: 'Shared piece' }], announcement: 'Shared banner' };
  const context = vm.createContext({ window: { location: { protocol: 'https:', pathname: '/collection' }, localStorage: { getItem: () => '[{"slug":"stale-piece"}]' } },
    AbortSignal, fetch: async () => Response.json(shared), console });
  vm.runInContext(dataSource, context);
  await vm.runInContext('shopReady', context);
  assert.equal(vm.runInContext('getAllProducts().length', context), 1);
  assert.equal(vm.runInContext('getAllProducts()[0].slug', context), 'database-piece');
});

test('a cart edit made before the catalogue resolves survives database hydration', async () => {
  let resolveShop;
  const shopReady = new Promise(resolve => { resolveShop = resolve; });
  const product = { slug: 'test-top', name: 'Test Top', price: 1000, sizes: ['M'], colors: [{ id: 'black', name: 'Black' }], images: ['top.jpg'] };
  const item = { key: 'test-top__M__black', slug: product.slug, name: product.name, price: product.price, size: 'M', color: 'black', qty: 1 };
  const writes = [];
  const ui = storefront('', async (url, options) => {
    if (!options?.method) return Response.json({ items: [{ slug: product.slug, size: 'M', color: 'black', qty: 1 }] });
    writes.push(JSON.parse(options.body)); return Response.json({ ok: true });
  }, { shopReady, getProduct: () => product, localStorage: { getItem: () => JSON.stringify([item]), setItem() {} } });
  ui.context.cartItemFixture = item;
  vm.runInContext('Cart.add(cartItemFixture, 1)', ui.context);
  assert.equal(vm.runInContext('Cart.items[0].qty', ui.context), 2);
  resolveShop({ products: [product] });
  await vm.runInContext('Cart.hydration', ui.context);
  await vm.runInContext('Cart.syncQueue', ui.context);
  assert.equal(vm.runInContext('Cart.items[0].qty', ui.context), 2);
  assert.equal(writes.at(-1).items[0].qty, 2);
});

test('catalogue failure keeps the local cart rather than clearing it', async () => {
  const item = { key: 'test-top__M__black', slug: 'test-top', name: 'Test Top', price: 1000, size: 'M', color: 'black', qty: 2 };
  let requests = 0;
  const ui = storefront('', async () => { requests++; throw new Error('Should not hydrate without a catalogue'); }, {
    shopReady: Promise.resolve(null), localStorage: { getItem: () => JSON.stringify([item]), setItem() {} },
  });
  await vm.runInContext('Cart.hydration', ui.context);
  assert.equal(vm.runInContext('Cart.items[0].qty', ui.context), 2);
  assert.equal(requests, 0);
});

test('cart thumbnails preserve root-relative paths for saved products', () => {
  const ui = storefront('', async () => Response.json({}));
  ui.context.itemFixture = { key: 'tee__M__black', slug: 'tee', name: 'Tee', price: 1000, size: 'M', color: 'black', colorName: 'Black', qty: 1, image: '/public/images/tee-front.jpg' };
  vm.runInContext('Cart.items = [itemFixture]; paintBag();', ui.context);
  assert.match(ui.ids.drawerBody.innerHTML, /src="\/public\/images\/tee-front\.jpg"/);
  assert.doesNotMatch(ui.ids.drawerBody.innerHTML, /public\/images\/\/public\/images/);
});
