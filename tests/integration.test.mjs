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
    if (name === 'claim_shop_emails') return result((await database.query('select * from public.claim_shop_emails()')).rows);
    const response = await database.query(`select public.${name}(${params}) as value`, args);
    return result(response.rows[0].value);
  }
  assert.match(path, /^shop_(orders|email_outbox|email_events)$/);
  const conditions = [], args = [];
  for (const [key, value] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
    assert.match(key, /^[a-z_]+$/);
    assert.ok(value.startsWith('eq.'));
    args.push(value.slice(3)); conditions.push(`${key} = $${args.length}`);
  }
  const where = conditions.length ? ' where ' + conditions.join(' and ') : '';
  if (options.method === 'POST') {
    const keys = Object.keys(body);
    return result((await database.query(`insert into public.${path} (${keys.join(',')}) values (${keys.map((_, index) => '$' + (index + 1)).join(',')}) returning *`, Object.values(body).map(value => typeof value === 'object' ? JSON.stringify(value) : value))).rows);
  }
  if (options.method === 'PATCH') {
    if (failSentWrite && path === 'shop_email_outbox' && body.state === 'sent') { failSentWrite = false; throw new Error('Database temporarily unavailable'); }
    const assignments = Object.keys(body).map(key => { args.push(body[key]); return `${key} = $${args.length}`; });
    return result((await database.query(`update public.${path} set ${assignments.join(',')}${where} returning *`, args)).rows);
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
    throw new Error('Unexpected network call: ' + url.origin + url.pathname);
  };
});
after(async () => { globalThis.fetch = nativeFetch; delete globalThis[Symbol.for('@vercel/request-context')]; await database.close(); });
beforeEach(async () => {
  await database.exec('truncate public.shop_orders, public.shop_email_outbox, public.shop_email_events cascade');
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
  process.env.ADMIN_SECRET_KEY = 'runaway2026!';
  const invalid = await login(request('/api/admin-session', { secretKey: 'wrong-passcode' }));
  assert.equal(invalid.status, 401);

  const signedIn = await login(request('/api/admin-session', { secretKey: 'runaway2026!' }));
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
