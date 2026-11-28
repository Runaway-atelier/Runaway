import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { POST as checkout } from '../api/order-payment.mjs';
import { POST as webhook } from '../api/paystack-webhook.mjs';
import { POST as resendWebhook } from '../api/resend-webhook.mjs';
import { GET as worker } from '../api/email-retry.mjs';
import { GET as adminOrders, PATCH as updateOrder } from '../api/admin-orders.mjs';
import { POST as login, DELETE as logout } from '../api/admin-session.mjs';
import { POST as emailRoute } from '../api/order-email.mjs';
import { validateCart } from '../lib/catalog.mjs';
import { paystackSignature, resendSignature } from '../lib/signatures.mjs';
import { readJson } from '../lib/http.mjs';
import { sendOutbox } from '../lib/outbox.mjs';
import { settlePayment } from '../lib/payments.mjs';
import { GET as shop } from '../api/shop.mjs';
import { GET as adminCatalog, POST as saveCatalog } from '../api/admin-catalog.mjs';
import { GET as getCart, POST as saveCart } from '../api/cart.mjs';
import { POST as trackOrder } from '../api/order-tracking.mjs';
import { createSessionToken, verifySessionToken, verifySecretKey } from '../lib/admin.mjs';

let database, transactions, sends, resendFails, providerUnavailable, authUser, backgroundTasks, initializeBody, failSentWrite;
const nativeFetch = globalThis.fetch;
const customer = { name: '<img src=x onerror=alert(1)>', email: 'buyer@example.com', phone: '08012345678', address: '1 Test Street', city: 'Lagos', state: 'Lagos' };
const item = { slug: 'aether-compression-tee', size: 'M', color: 'eclipse', price: 148000, qty: 1 };
const request = (path, body, extras = {}) => new Request(`https://shop.example.com${path}`, {
  method: 'POST', headers: { origin: 'https://shop.example.com', 'Content-Type': 'application/json', ...extras }, body: JSON.stringify(body),
});
const result = value => Response.json(value);

async function databaseFetch(url, options) {
  const path = url.pathname.replace('/rest/v1/', '');
  const body = options.body ? JSON.parse(options.body) : null;
  if (path.startsWith('rpc/')) {
    const name = path.slice(4);
    const names = Object.keys(body);
    const params = names.map((key, index) => `${key} => $${index + 1}`).join(',');
    const args = Object.values(body).map(value => typeof value === 'object' ? JSON.stringify(value) : value);
    if (name === 'claim_shop_emails') return result((await database.query('select * from public.claim_shop_emails($1)', [body.p_environment || 'test'])).rows);
    const response = await database.query(`select public.${name}(${params}) as value`, args);
    return result(response.rows[0].value);
  }
  assert.match(path, /^shop_(orders|email_outbox|email_events|products|settings|carts|subscribers)$/);
  const conditions = [], args = [];
  for (const [key, value] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
    assert.match(key, /^[a-z_]+$/);
    if (value === 'is.null') { conditions.push(`${key} is null`); continue; }
    assert.ok(value.startsWith('eq.'));
    args.push(value.slice(3)); conditions.push(`${key} = $${args.length}`);
  }
  const where = conditions.length ? ' where ' + conditions.join(' and ') : '';
  if (options.method === 'POST') {
    const keys = Object.keys(body);
    const conflict = url.searchParams.get('on_conflict');
    if (conflict) assert.match(conflict, /^[a-z_]+$/);
    const resolution = !conflict ? '' : options.headers.Prefer.includes('ignore-duplicates') ? ` on conflict (${conflict}) do nothing` : ` on conflict (${conflict}) do update set ${keys.filter(k => k !== conflict).map(k => `${k}=excluded.${k}`).join(',')}`;
    const inserted = (await database.query(`insert into public.${path} (${keys.join(',')}) values (${keys.map((_, index) => '$' + (index + 1)).join(',')})${resolution} returning *`, Object.values(body).map(value => typeof value === 'object' && value !== null ? JSON.stringify(value) : value))).rows;
    return options.headers.Prefer.includes('return=minimal') ? new Response(null, { status: 201 }) : result(inserted);
  }
  if (options.method === 'PATCH') {
    if (failSentWrite && path === 'shop_email_outbox' && body.state === 'sent') { failSentWrite = false; throw new Error('Database temporarily unavailable'); }
    const assignments = Object.keys(body).map(key => { args.push(typeof body[key] === 'object' && body[key] !== null ? JSON.stringify(body[key]) : body[key]); return `${key} = $${args.length}`; });
    const updated = (await database.query(`update public.${path} set ${assignments.join(',')}${where} returning *`, args)).rows;
    return options.headers.Prefer.includes('return=minimal') ? new Response(null, { status: 204 }) : result(updated);
  }
  let suffix = '';
  if (url.searchParams.has('order')) suffix += ' order by ' + url.searchParams.get('order').split(',').map(part => part.replace('.', ' ')).join(',');
  if (url.searchParams.has('limit')) suffix += ` limit ${Number(url.searchParams.get('limit'))}`;
  if (url.searchParams.has('offset')) suffix += ` offset ${Number(url.searchParams.get('offset'))}`;
  const columns = url.searchParams.get('select') || '*';
  return result((await database.query(`select ${columns} from public.${path}${where}${suffix}`, args)).rows);
}

before(async () => {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://database.example.com', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', ADMIN_EMAIL: 'owner@example.com',
    PAYSTACK_SECRET_KEY: 'sk_test_fixture', PAYSTACK_WEBHOOK_SECRET: 'whsec_paystack_fixture', PAYSTACK_ALLOW_LEGACY_WEBHOOKS: 'false',
    RESEND_API_KEY: 'test-resend-key', RESEND_FROM_EMAIL: 'RUNAWAY <orders@example.com>', ORDER_NOTIFICATION_EMAIL: 'shop@example.com',
    RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.from('resend-test-secret').toString('base64'), CRON_SECRET: 'fixture-cron-secret',
  });
  database = new PGlite();
  await database.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await database.exec(await readFile(new URL('../supabase/migrations/20261123_payments.sql', import.meta.url), 'utf8'));
  await database.exec(await readFile(new URL('../supabase/migrations/20261125_shared_store.sql', import.meta.url), 'utf8'));
  await database.exec(await readFile(new URL('../supabase/migrations/20261125180000_production.sql', import.meta.url), 'utf8'));
  await database.exec('create temp table seed_products as select * from public.shop_products');
  // Vercel's documented waitUntil helper uses the request context internally.
  globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: promise => backgroundTasks.push(promise) }) };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'database.example.com') {
      if (url.pathname.startsWith('/rest/v1/')) return databaseFetch(url, options);
      if (url.pathname === '/auth/v1/user') return authUser ? result(authUser) : result({}, { status: 401 });
      if (url.pathname === '/auth/v1/token') return result({ access_token: 'fixture-token', expires_in: 3600, user: authUser });
    }
    if (url.hostname === 'api.paystack.co') {
      if (providerUnavailable) throw new Error('Provider unavailable');
      if (url.pathname === '/transaction/initialize') {
        initializeBody = JSON.parse(options.body);
        return result({ status: true, data: { authorization_url: 'https://checkout.paystack.com/fixture' } });
      }
      return result({ status: true, data: transactions.get(url.pathname.split('/').pop()) });
    }
    if (url.hostname === 'api.resend.com' && url.pathname === '/emails') {
      const payload = JSON.parse(options.body); const key = options.headers['Idempotency-Key'];
      if (resendFails && payload.to[0] === 'shop@example.com') return new Response('{}', { status: 503 });
      if (sends.has(key)) assert.deepEqual(payload, sends.get(key).payload, 'retries must use frozen payloads');
      else sends.set(key, { id: `email-${sends.size + 1}`, payload });
      return result({ id: sends.get(key).id });
    }
    if (url.hostname === 'api.resend.com' && url.pathname === '/contacts') return result({ id: 'contact-fixture' });
    throw new Error('Unexpected network call: ' + url.origin + url.pathname);
  };
});
after(async () => { globalThis.fetch = nativeFetch; delete globalThis[Symbol.for('@vercel/request-context')]; await database.close(); });
beforeEach(async () => {
  process.env.ADMIN_SECRET_KEY = 'fixture-owner-secret-at-least-32-characters';
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture';
  delete process.env.PAYSTACK_LIVE_ENABLED;
  await database.exec('truncate public.shop_orders, public.shop_email_outbox, public.shop_email_events cascade');
  await database.exec("truncate public.shop_products, public.shop_carts, public.shop_subscribers, public.shop_settings, public.shop_request_limits; insert into public.shop_products select * from seed_products; insert into public.shop_settings(key,value) values ('announcement','');");
  transactions = new Map(); sends = new Map(); backgroundTasks = []; resendFails = false; providerUnavailable = false; failSentWrite = false;
  authUser = { id: 'owner-id', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
});

async function beginPayment() {
  const response = await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [item] }));
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  transactions.set(data.reference, { id: '12345', reference: data.reference, currency: 'NGN', amount: 14800000, status: 'success', domain: 'test', paid_at: '2026-11-23T10:00:00Z', metadata: { order_id: data.orderId }, customer: { email: customer.email } });
  return data;
}
function signedEvent(reference, overrides = {}) {
  const raw = JSON.stringify({ event: 'charge.success', data: { reference }, ...overrides });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
  return new Request('https://shop.example.com/api/paystack-webhook', { method: 'POST', headers: { 'Paystack-Signature': `t=${timestamp},v1=whk_test:${signature}` }, body: raw });
}
const drain = async () => { await Promise.all(backgroundTasks); backgroundTasks = []; };
const count = async table => Number((await database.query(`select count(*) as n from public.${table}`)).rows[0].n);

test('checkout saves pending order first, charges kobo, and sends no customer details in metadata', async () => {
  const data = await beginPayment();
  assert.equal(initializeBody.amount, '14800000'); assert.deepEqual(initializeBody.metadata, { order_id: data.orderId });
  assert.equal(await count('shop_orders'), 1); assert.equal(await count('shop_email_outbox'), 0);
});
test('webhook completes paid order and sends both emails without a browser return; replay creates no duplicates', async () => {
  const { reference } = await beginPayment();
  assert.equal((await webhook(signedEvent(reference))).status, 200); await drain();
  assert.equal(await count('shop_email_outbox'), 2); assert.equal(sends.size, 2);
  assert.ok([...sends.values()][0].payload.html.includes('&lt;img'));
  assert.equal((await webhook(signedEvent(reference))).status, 200); await drain();
  const response = await checkout(request('/api/order-payment', { action: 'verify', reference })); await drain();
  assert.equal((await response.json()).paid, true); assert.equal(sends.size, 2);
  assert.equal((await database.query('select payment_status from public.shop_orders')).rows[0].payment_status, 'Paid');
});
test('simultaneous settlement and workers retain exactly two jobs', async () => {
  const { reference } = await beginPayment();
  await Promise.all([webhook(signedEvent(reference)), checkout(request('/api/order-payment', { action: 'verify', reference }))]); await drain();
  await Promise.all([sendOutbox(), sendOutbox()]);
  assert.equal(await count('shop_email_outbox'), 2); assert.equal(sends.size, 2);
});
test('a payment sends its notifications even when an older order is waiting', async () => {
  const older = await beginPayment();
  await settlePayment(older.reference);
  await database.exec("update public.shop_email_outbox set next_attempt_at=now()-interval '1 hour'");
  const current = await beginPayment();
  transactions.get(current.reference).id = 'current-transaction';
  assert.equal((await webhook(signedEvent(current.reference))).status, 200);
  await drain();
  assert.equal(sends.size, 4);
  assert.equal(Number((await database.query("select count(*) as n from public.shop_email_outbox where state='sent'")).rows[0].n), 4);
  await sendOutbox();
  assert.equal(sends.size, 4, 'another worker must not duplicate accepted messages');
});
test('a worker bounds backlog processing and leaves remaining jobs for the scheduler', async () => {
  for (let i = 0; i < 4; i++) {
    const order = await beginPayment();
    transactions.get(order.reference).id = `backlog-${i}`;
    await settlePayment(order.reference);
  }
  assert.deepEqual(await sendOutbox(), { processed: 6, sent: 6 });
  assert.deepEqual(await sendOutbox(), { processed: 2, sent: 2 });
  assert.equal(sends.size, 8);
});
test('wrong amount, currency, reference, order, customer or environment cannot settle', async () => {
  const { reference } = await beginPayment(); const original = transactions.get(reference);
  for (const change of [{ amount: 1 }, { currency: 'USD' }, { reference: 'other' }, { metadata: { order_id: 'wrong' } }, { customer: { email: 'other@example.com' } }, { domain: 'live' }]) {
    transactions.set(reference, { ...original, ...change });
    assert.equal((await checkout(request('/api/order-payment', { action: 'verify', reference }))).status, 409);
  }
  assert.equal(await count('shop_email_outbox'), 0);
});
test('pending payments, invalid carts, unknown references and malformed bodies do not send receipts', async () => {
  const { reference } = await beginPayment(); transactions.get(reference).status = 'pending';
  assert.equal((await (await checkout(request('/api/order-payment', { action: 'verify', reference }))).json()).paid, false);
  for (const bad of [{ ...item, price: 1 }, { ...item, qty: -1 }, { ...item, slug: '__proto__' }, { ...item, color: 'toString' }]) assert.equal(validateCart([bad]), null);
  assert.equal((await checkout(request('/api/order-payment', { action: 'verify', reference: 'runaway-' + 'b'.repeat(48) }))).status, 404);
  assert.equal((await checkout(request('/api/order-payment', null))).status, 400);
  assert.equal((await checkout(request('/api/order-payment', { action: 'verify', reference }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await emailRoute(request('/api/order-email', { type: 'order', customer }))).status, 400);
  assert.equal(await count('shop_email_outbox'), 0);
});
test('shop email failure is retried independently and persisted payload survives configuration changes', async () => {
  const { reference } = await beginPayment(); resendFails = true;
  await webhook(signedEvent(reference)); await drain(); assert.equal(sends.size, 1);
  await database.exec("update public.shop_email_outbox set next_attempt_at = now() - interval '1 minute' where state='pending'");
  resendFails = false;
  const oldFrom = process.env.RESEND_FROM_EMAIL; process.env.RESEND_FROM_EMAIL = 'changed@example.com';
  try { await sendOutbox(); } finally { process.env.RESEND_FROM_EMAIL = oldFrom; }
  assert.equal(sends.size, 2); assert.ok([...sends.values()].every(email => email.payload.from === oldFrom));
});
test('worker recovers expired leases but quarantines ambiguous sends after the safe retry window', async () => {
  const { reference } = await beginPayment();
  await webhook(signedEvent(reference)); await drain();
  await database.exec("update public.shop_email_outbox set state='sending', locked_until=now()-interval '1 minute', first_attempt_at=now()-interval '2 hours'");
  await sendOutbox(); assert.equal(sends.size, 2);
  await database.exec("update public.shop_email_outbox set state='pending', first_attempt_at=now()-interval '25 hours'");
  await sendOutbox();
  assert.equal(Number((await database.query("select count(*) as n from public.shop_email_outbox where state='review'")).rows[0].n), 2);
});
test('a crash after Resend accepts an email reuses the same idempotency key on recovery', async () => {
  const { reference } = await beginPayment(); failSentWrite = true;
  await webhook(signedEvent(reference)); await drain();
  assert.equal(sends.size, 1);
  await database.exec("update public.shop_email_outbox set locked_until=now()-interval '1 minute' where state='sending'");
  await sendOutbox(); assert.equal(sends.size, 2);
  assert.equal(Number((await database.query("select count(*) as n from public.shop_email_outbox where state='sent'")).rows[0].n), 2);
});
test('a payment provider outage returns a retryable response without marking the order paid', async () => {
  const { reference } = await beginPayment(); providerUnavailable = true;
  assert.equal((await webhook(signedEvent(reference))).status, 503);
  assert.equal(await count('shop_email_outbox'), 0);
  providerUnavailable = false;
  assert.equal((await webhook(signedEvent(reference))).status, 200); await drain();
  assert.equal(sends.size, 2);
});
test('settlement is atomic if a receipt cannot be queued', async () => {
  const { reference } = await beginPayment();
  await assert.rejects(database.query('select public.settle_shop_order($1,$2,now(),$3,$4)', [reference, '123', 14800000, JSON.stringify([{ kind: 'customer', payload: { from: 'test', to: ['buyer'] } }, { kind: 'store', payload: {} }])]));
  assert.equal((await database.query('select payment_status from public.shop_orders')).rows[0].payment_status, 'Unpaid');
  assert.equal(await count('shop_email_outbox'), 0);
});
test('database roles cannot access orders or invoke settlement', async () => {
  await database.exec('set role anon');
  try {
    await assert.rejects(database.query('select * from public.shop_orders'));
    await assert.rejects(database.query('select * from public.claim_shop_emails()'));
  } finally { await database.exec('reset role'); }
});
test('invalid, stale and downgraded webhook signatures are rejected', async () => {
  const raw = Buffer.from('{}'); const now = Math.floor(Date.now() / 1000);
  const sign = time => createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET).update(`${time}.`).update(raw).digest('hex');
  assert.equal(paystackSignature(raw, new Headers({ 'paystack-signature': `t=${now},v1=whk_bad:${'0'.repeat(128)},v1=whk_good:${sign(now)}` })), true);
  assert.equal(paystackSignature(raw, new Headers({ 'paystack-signature': `t=${now-301},v1=whk_good:${sign(now-301)}` })), false);
  const legacy = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  assert.equal(paystackSignature(raw, new Headers({ 'x-paystack-signature': legacy })), false);
  process.env.PAYSTACK_ALLOW_LEGACY_WEBHOOKS = 'true';
  try {
    assert.equal(paystackSignature(raw, new Headers({ 'x-paystack-signature': legacy })), true);
    assert.equal(paystackSignature(raw, new Headers({ 'paystack-signature': 'invalid', 'x-paystack-signature': legacy })), false);
  } finally { process.env.PAYSTACK_ALLOW_LEGACY_WEBHOOKS = 'false'; }
  assert.equal((await webhook(new Request('https://shop.example.com/api/paystack-webhook', { method: 'POST', body: '{}' }))).status, 401);
});
test('Resend event signatures and event timestamps prevent forged or reordered status changes', async () => {
  const now = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify({ type: 'email.delivered', created_at: '2026-11-23T12:00:00Z', data: { email_id: 'email-1' } });
  const signature = createHmac('sha256', Buffer.from('resend-test-secret')).update(`evt1.${now}.${raw}`).digest('base64');
  const headers = new Headers({ 'svix-id': 'evt1', 'svix-timestamp': String(now), 'svix-signature': `v1,${signature}` });
  assert.equal(resendSignature(Buffer.from(raw), headers), true);
  assert.equal(resendSignature(Buffer.from(raw + ' '), headers), false);
  assert.equal((await resendWebhook(new Request('https://shop.example.com/api/resend-webhook', { method: 'POST', headers, body: raw }))).status, 200);
  await database.query("select public.record_shop_email_event('email-1','email.sent','2026-11-23T11:00:00Z')");
  assert.equal((await database.query('select event_type from public.shop_email_events')).rows[0].event_type, 'email.delivered');
});
test('admin requires a confirmed owner, session cookie and preserves provider payment status', async () => {
  const { reference } = await beginPayment(); await webhook(signedEvent(reference)); await drain();
  const auth = { cookie: 'runaway_owner=fixture-token' };
  assert.equal((await adminOrders(new Request('https://shop.example.com/api/admin-orders'))).status, 401);
  authUser.email = 'stranger@example.com';
  assert.equal((await adminOrders(new Request('https://shop.example.com/api/admin-orders', { headers: auth }))).status, 403);
  authUser.email = 'owner@example.com';
  const response = await adminOrders(new Request('https://shop.example.com/api/admin-orders', { headers: auth }));
  const { orders } = await response.json(); assert.equal(orders.length, 1); assert.equal(orders[0].total, 148000);
  const patch = data => new Request('https://shop.example.com/api/admin-orders', { method: 'PATCH', headers: { ...auth, origin: 'https://shop.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await updateOrder(patch({ id: orders[0].id, paymentStatus: 'Unpaid' }))).status, 400);
  assert.equal((await updateOrder(patch({ id: orders[0].id, fulfillmentStatus: 'Shipped', carrier: 'DHL' }))).status, 200);
  const signedIn = await login(request('/api/admin-session', { email: 'owner@example.com', password: 'fixture' }));
  assert.match(signedIn.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(signedIn.headers.get('set-cookie'), /Secure/);
  assert.deepEqual(await signedIn.json(), { ok: true });
  const signedOut = await logout(new Request('https://shop.example.com/api/admin-session', { method: 'DELETE', headers: { origin: 'https://shop.example.com' } }));
  assert.match(signedOut.headers.get('set-cookie'), /Max-Age=0/);
});
test('admin supports secret key login without supabase auth', async () => {
  process.env.ADMIN_SECRET_KEY = 'fixture-owner-secret-at-least-32-characters';
  const invalid = await login(request('/api/admin-session', { secretKey: 'wrong-passcode' }));
  assert.equal(invalid.status, 401);

  const signedIn = await login(request('/api/admin-session', { secretKey: 'fixture-owner-secret-at-least-32-characters' }));
  assert.equal(signedIn.status, 200);
  const cookieHeader = signedIn.headers.get('set-cookie');
  assert.match(cookieHeader, /runaway_owner=/);

  const cookieVal = cookieHeader.split(';')[0];
  const response = await adminOrders(new Request('https://shop.example.com/api/admin-orders', { headers: { cookie: cookieVal } }));
  assert.equal(response.status, 200);
});
test('retry worker requires its secret and request size is bounded even without content-length', async () => {
  assert.equal((await worker(new Request('https://shop.example.com/api/email-retry'))).status, 401);
  assert.equal((await worker(new Request('https://shop.example.com/api/email-retry', { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }))).status, 200);
  await assert.rejects(readJson(new Request('https://shop.example.com/api', { method: 'POST', body: JSON.stringify({ x: 'a'.repeat(30001) }) })), error => error.status === 413);
});

const ownerCookie = () => ({ cookie: 'runaway_owner=fixture-token' });
const catalogueWrite = body => saveCatalog(request('/api/admin-catalog', body, ownerCookie()));

test('owner catalogue edits and announcement are stored and readable from a different browser', async () => {
  const seeded = (await (await shop()).json()).products;
  assert.equal(seeded.length, 3);
  const piece = { ...seeded[0], slug: 'new-training-top', name: 'New Training Top', price: 12000, stock: 5, details: ['Technical stretch'], specs: { origin: 'Nigeria', care: 'Wash cold' } };
  assert.equal((await catalogueWrite({ action: 'save', product: piece })).status, 200);
  assert.equal((await catalogueWrite({ action: 'announcement', value: 'New collection available' })).status, 200);
  const fresh = await (await shop()).json();
  assert.equal(fresh.products.find(p => p.slug === piece.slug).stock, 5);
  assert.deepEqual(fresh.products.find(p => p.slug === piece.slug).details, ['Technical stretch']);
  assert.equal(fresh.products.find(p => p.slug === piece.slug).specs.care, 'Wash cold');
  assert.equal(fresh.products.find(p => p.slug === piece.slug).images.length, seeded[0].images.length);
  assert.equal(fresh.announcement, 'New collection available');
  const response = await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [{ ...item, slug: piece.slug, price: 12000 }] }));
  assert.equal(response.status, 200);
  assert.equal(initializeBody.amount, '1200000');
  assert.equal((await database.query('select test_stock as stock from public.shop_products where slug=$1', [piece.slug])).rows[0].stock, 4);
});
test('catalogue mutations require an owner and reject unsafe product data', async () => {
  assert.equal((await adminCatalog(new Request('https://shop.example.com/api/admin-catalog'))).status, 401);
  assert.equal((await saveCatalog(request('/api/admin-catalog', { action: 'announcement', value: 'bad' }))).status, 401);
  const product = (await (await shop()).json()).products[0];
  for (const change of [{ price: -1 }, { stock: -2 }, { images: ['javascript:alert(1)'] }, { sizes: [] }, { colors: [{ id: 'bad"onload', name: 'Bad' }] }]) {
    assert.equal((await catalogueWrite({ action: 'save', product: { ...product, ...change } })).status, 400);
  }
  assert.equal((await saveCatalog(request('/api/admin-catalog', { action: 'announcement', value: 'bad' }, { ...ownerCookie(), origin: 'https://evil.example' }))).status, 403);
});
test('hidden products disappear from all storefronts and cannot be purchased until restored', async () => {
  assert.equal((await catalogueWrite({ action: 'hide', slug: item.slug })).status, 200);
  assert.ok(!(await (await shop()).json()).products.some(p => p.slug === item.slug));
  assert.equal((await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [item] }))).status, 400);
  assert.equal((await catalogueWrite({ action: 'restore', slug: item.slug })).status, 200);
  await beginPayment();
});
test('reservation prevents competing checkout and settlement replay does not deduct stock twice', async () => {
  await database.query('update public.shop_products set test_stock=1 where slug=$1', [item.slug]);
  const { reference } = await beginPayment();
  assert.equal((await database.query('select test_stock as stock from public.shop_products where slug=$1', [item.slug])).rows[0].stock, 0);
  assert.equal((await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [item] }))).status, 400);
  await webhook(signedEvent(reference)); await drain();
  await webhook(signedEvent(reference)); await drain();
  assert.equal((await database.query('select test_stock as stock from public.shop_products where slug=$1', [item.slug])).rows[0].stock, 0);
});
test('database rejects stale concurrent reservations atomically', async () => {
  await database.query('update public.shop_products set test_stock=1 where slug=$1', [item.slug]);
  const make = n => ({ id: `RW-${String(n).padStart(12, '0')}`, reference: 'reservation-' + n, customer, items: [item], total: 148000 });
  await database.query('select public.reserve_shop_order($1::jsonb)', [JSON.stringify(make(1))]);
  await assert.rejects(database.query('select public.reserve_shop_order($1::jsonb)', [JSON.stringify(make(2))]));
  assert.equal(await count('shop_orders'), 1);
});
test('expired reservations release once, while late successful payment is still recorded', async () => {
  await database.query('update public.shop_products set test_stock=2 where slug=$1', [item.slug]);
  const { reference } = await beginPayment();
  await database.exec("update public.shop_orders set reserved_until=now()-interval '1 minute'");
  await database.exec('select public.release_expired_shop_orders(); select public.release_expired_shop_orders();');
  assert.equal((await database.query('select test_stock as stock from public.shop_products where slug=$1', [item.slug])).rows[0].stock, 2);
  await webhook(signedEvent(reference)); await drain();
  await webhook(signedEvent(reference)); await drain();
  assert.equal((await database.query('select test_stock as stock from public.shop_products where slug=$1', [item.slug])).rows[0].stock, 1);
});
test('cart persists privately behind an HttpOnly cookie and stores no trusted client prices', async () => {
  const fresh = await getCart(new Request('https://shop.example.com/api/cart'));
  const cookie = fresh.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const headers = { cookie: cookie.split(';')[0] };
  assert.equal((await saveCart(request('/api/cart', { items: [{ ...item, price: 1 }] }, headers))).status, 200);
  const restored = await (await getCart(new Request('https://shop.example.com/api/cart', { headers }))).json();
  assert.deepEqual(restored.items, [{ slug: item.slug, size: 'M', color: 'eclipse', qty: 1 }]);
  const otherBrowser = await (await getCart(new Request('https://shop.example.com/api/cart'))).json();
  assert.deepEqual(otherBrowser.items, []);
  assert.equal((await saveCart(request('/api/cart', { items: [{ ...item, qty: -1 }] }, headers))).status, 400);
  assert.equal((await saveCart(request('/api/cart', { items: [] }, headers))).status, 200);
  assert.deepEqual((await (await getCart(new Request('https://shop.example.com/api/cart', { headers }))).json()).items, []);
});
test('tracking reads live fulfillment from any browser but requires both order ID and email', async () => {
  const { reference, orderId } = await beginPayment();
  assert.equal((await trackOrder(request('/api/order-tracking', { orderId, email: customer.email }))).status, 404);
  await webhook(signedEvent(reference)); await drain();
  await updateOrder(new Request('https://shop.example.com/api/admin-orders', { method: 'PATCH', headers: { ...ownerCookie(), origin: 'https://shop.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: orderId, fulfillmentStatus: 'Shipped', carrier: 'DHL', trackingNumber: 'TRACK-123' }) }));
  assert.equal((await trackOrder(request('/api/order-tracking', { orderId, email: 'wrong@example.com' }))).status, 404);
  const response = await trackOrder(request('/api/order-tracking', { orderId: orderId.toLowerCase(), email: customer.email.toUpperCase() }));
  const data = await response.json();
  assert.equal(data.order.fulfillmentStatus, 'Shipped');
  assert.equal(data.order.trackingNumber, 'TRACK-123');
  assert.equal(data.order.customer, undefined);
  assert.equal(data.order.paymentReference, undefined);
});
test('legacy browser import is atomic and a later browser cannot overwrite shared data', async () => {
  const product = (await (await shop()).json()).products[0];
  assert.equal((await catalogueWrite({ action: 'import', products: [{ ...product, price: 22000, stock: 4 }], hidden: ['apex-training-shorts'], announcement: 'Imported banner' })).status, 200);
  assert.equal((await catalogueWrite({ action: 'import', products: [{ ...product, price: 1 }], hidden: [], announcement: 'Stale banner' })).status, 200);
  const data = await (await shop()).json();
  assert.equal(data.products.find(p => p.slug === product.slug).price, 22000);
  assert.equal(data.announcement, 'Imported banner');
  assert.ok(!data.products.some(p => p.slug === 'apex-training-shorts'));
});
test('newsletter contacts persist in the database and repeat signup does not duplicate rows', async () => {
  for (let n = 0; n < 2; n++) assert.equal((await emailRoute(request('/api/order-email', { type: 'newsletter', email: 'news@example.com' }))).status, 200);
  assert.equal(await count('shop_subscribers'), 1);
  assert.ok((await database.query('select provider_synced_at from public.shop_subscribers')).rows[0].provider_synced_at);
});
test('browser database roles cannot read shared records or invoke inventory functions directly', async () => {
  await database.exec('set role authenticated');
  try {
    for (const table of ['shop_products', 'shop_settings', 'shop_carts', 'shop_subscribers', 'shop_request_limits']) await assert.rejects(database.query('select * from public.' + table));
    await assert.rejects(database.query('select public.release_expired_shop_orders()'));
    await assert.rejects(database.query("select public.reserve_shop_order('{}'::jsonb)"));
    await assert.rejects(database.query('select public.consume_shop_request($1,1,60)', ['a'.repeat(64)]));
  } finally { await database.exec('reset role'); }
});

test('sample passcodes and database service keys cannot authenticate an owner', async () => {
  assert.equal(verifySecretKey(process.env.SUPABASE_SERVICE_ROLE_KEY), false);
  process.env.ADMIN_SECRET_KEY = 'runaway2026!';
  assert.equal(verifySecretKey('runaway2026!'), false);
  assert.equal((await login(request('/api/admin-session', { secretKey: 'runaway2026!' }))).status, 401);
});
test('owner sessions have unique signatures and expire after one hour', async () => {
  const first = createSessionToken(), second = createSessionToken();
  assert.notEqual(first, second);
  assert.equal(verifySessionToken(first), true);
  const timestamp = Math.floor(Date.now() / 1000) - 3601, nonce = 'a'.repeat(48);
  const signature = createHmac('sha256', process.env.ADMIN_SECRET_KEY).update(`${timestamp}.${nonce}`).digest('hex');
  assert.equal(verifySessionToken(`${timestamp}.${nonce}.${signature}`), false);
  const response = await login(request('/api/admin-session', { secretKey: process.env.ADMIN_SECRET_KEY }));
  assert.match(response.headers.get('set-cookie'), /Max-Age=3600/);
});
test('login throttling is shared in the database and expires without blocking other clients', async () => {
  const headers = { 'x-forwarded-for': '203.0.113.10' };
  for (let n = 0; n < 8; n++) assert.equal((await login(request('/api/admin-session', { secretKey: 'incorrect' }, headers))).status, 401);
  const blocked = await login(request('/api/admin-session', { secretKey: 'incorrect' }, headers));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await login(request('/api/admin-session', { secretKey: process.env.ADMIN_SECRET_KEY }, { 'x-forwarded-for': '203.0.113.11' }))).status, 200);
  await database.exec("update public.shop_request_limits set expires_at=now()-interval '1 second'");
  assert.equal((await login(request('/api/admin-session', { secretKey: process.env.ADMIN_SECRET_KEY }, headers))).status, 200);
});
test('repeated checkout attempts are bounded before orders or provider requests are created', async () => {
  for (let n = 0; n < 10; n++) assert.equal((await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [] }))).status, 400);
  assert.equal((await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [item] }))).status, 429);
  assert.equal(await count('shop_orders'), 0);
});
test('test payments use separate stock and are absent from live revenue, tracking and workers', async () => {
  await database.query('update public.shop_products set stock=10,test_stock=3 where slug=$1', [item.slug]);
  const { reference, orderId } = await beginPayment();
  await webhook(signedEvent(reference)); await drain();
  const row = (await database.query('select stock,test_stock from public.shop_products where slug=$1', [item.slug])).rows[0];
  assert.equal(row.stock, 10); assert.equal(row.test_stock, 2);
  const testJobs = await database.query("select id from public.shop_email_outbox where order_id=$1", [orderId]);
  await database.exec("update public.shop_email_outbox set state='pending',next_attempt_at=now()-interval '1 minute'");
  process.env.PAYSTACK_SECRET_KEY = 'sk_live_fixture';
  assert.equal((await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [item] }))).status, 503);
  assert.equal((await (await adminOrders(new Request('https://shop.example.com/api/admin-orders', { headers: ownerCookie() }))).json()).orders.length, 0);
  assert.equal((await trackOrder(request('/api/order-tracking', { orderId, email: customer.email }))).status, 404);
  assert.equal((await sendOutbox()).processed, 0);
  assert.equal(testJobs.rows.length, 2);
  process.env.PAYSTACK_LIVE_ENABLED = 'true';
  const response = await checkout(request('/api/order-payment', { action: 'initialize', customer, items: [item] }));
  assert.equal(response.status, 200);
  const live = await response.json();
  transactions.set(live.reference, { id: 'live-transaction', reference: live.reference, currency: 'NGN', amount: 14800000, status: 'success', domain: 'live', metadata: { order_id: live.orderId }, customer: { email: customer.email } });
  assert.equal((await webhook(signedEvent(live.reference))).status, 200); await drain();
  const stock = (await database.query('select stock,test_stock from public.shop_products where slug=$1', [item.slug])).rows[0];
  assert.equal(stock.stock, 9); assert.equal(stock.test_stock, 2);
  const visible = await (await adminOrders(new Request('https://shop.example.com/api/admin-orders', { headers: ownerCookie() }))).json();
  assert.equal(visible.orders.length, 1); assert.equal(visible.orders[0].id, live.orderId);
});
test('editing test stock leaves real inventory unchanged', async () => {
  await database.query('update public.shop_products set stock=20,test_stock=2 where slug=$1', [item.slug]);
  const piece = (await (await shop()).json()).products.find(p => p.slug === item.slug);
  assert.equal(piece.stock, 2);
  assert.equal((await catalogueWrite({ action: 'save', product: { ...piece, stock: 7 }, expected: { updatedAt: piece.updatedAt, stock: piece.stock } })).status, 200);
  const row = (await database.query('select stock,test_stock from public.shop_products where slug=$1', [item.slug])).rows[0];
  assert.equal(row.stock, 20); assert.equal(row.test_stock, 7);
});

test('description-only saves preserve a stock balance changed since the form opened', async () => {
  await database.query('update public.shop_products set test_stock=10 where slug=$1', [item.slug]);
  const piece = (await (await shop()).json()).products.find(p => p.slug === item.slug);
  await database.query('update public.shop_products set test_stock=7 where slug=$1', [item.slug]);
  const response = await catalogueWrite({ action: 'save', product: { ...piece, description: 'New description' }, expected: { updatedAt: piece.updatedAt, stock: piece.stock } });
  assert.equal(response.status, 200);
  const current = (await database.query('select test_stock,definition from public.shop_products where slug=$1', [item.slug])).rows[0];
  assert.equal(current.test_stock, 7);
  assert.equal(current.definition.description, 'New description');
});

test('stale metadata edits and duplicate creates cannot overwrite an existing product', async () => {
  const piece = (await (await shop()).json()).products.find(p => p.slug === item.slug);
  const expected = { updatedAt: piece.updatedAt, stock: piece.stock };
  assert.equal((await catalogueWrite({ action: 'save', product: { ...piece, name: 'First owner edit' }, expected })).status, 200);
  assert.equal((await catalogueWrite({ action: 'save', product: { ...piece, name: 'Stale second edit' }, expected })).status, 409);
  assert.equal((await catalogueWrite({ action: 'save', product: { ...piece, name: 'Duplicate create' } })).status, 409);
  assert.equal((await (await shop()).json()).products.find(p => p.slug === item.slug).name, 'First owner edit');
});

test('intentional stock edits compare the original balance atomically, including untracked stock', async () => {
  for (const original of [10, null]) {
    await database.query('update public.shop_products set test_stock=$1 where slug=$2', [original, item.slug]);
    const piece = (await (await shop()).json()).products.find(p => p.slug === item.slug);
    await database.query('update public.shop_products set test_stock=7 where slug=$1', [item.slug]);
    assert.equal((await catalogueWrite({ action: 'save', product: { ...piece, stock: 5 }, expected: { updatedAt: piece.updatedAt, stock: piece.stock } })).status, 409);
    assert.equal((await database.query('select test_stock from public.shop_products where slug=$1', [item.slug])).rows[0].test_stock, 7);
  }
  await database.query('update public.shop_products set test_stock=null where slug=$1', [item.slug]);
  const piece = (await (await shop()).json()).products.find(p => p.slug === item.slug);
  assert.equal((await catalogueWrite({ action: 'save', product: { ...piece, stock: 5 }, expected: { updatedAt: piece.updatedAt, stock: null } })).status, 200);
  assert.equal((await database.query('select test_stock from public.shop_products where slug=$1', [item.slug])).rows[0].test_stock, 5);
});

test('the catalogue API saves a canonical 1 MB image without a duplicate image alias', async () => {
  const piece = (await (await shop()).json()).products[0];
  const image = 'data:image/png;base64,' + Buffer.alloc(1000000).toString('base64');
  const response = await catalogueWrite({ action: 'save', product: { ...piece, slug: 'large-image-piece', images: [image] } });
  assert.equal(response.status, 200);
  const stored = (await database.query("select definition from public.shop_products where slug='large-image-piece'")).rows[0].definition;
  assert.equal(stored.images[0], image);
  assert.equal(stored.image, undefined);
});
