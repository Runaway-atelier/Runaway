import { existsSync } from 'node:fs';
if (existsSync('.env.local')) process.loadEnvFile('.env.local');
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.');
const checks = [
  ['shop_orders', 'id,inventory_reserved,reserved_until,payment_environment'],
  ['shop_email_outbox', 'id'], ['shop_email_events', 'email_id'],
  ['shop_products', 'slug,definition,stock,test_stock,active'], ['shop_settings', 'key,value'],
  ['shop_carts', 'token_hash,items'], ['shop_subscribers', 'email'],
  ['shop_request_limits','key,hits,expires_at'],
];
const results = await Promise.all(checks.map(async ([table, columns]) => {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${table}?select=${columns}&limit=0`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000),
    });
    return { table, ready: response.ok, status: response.status };
  } catch (error) { return { table, ready: false, network: error.cause?.code || error.name }; }
}));
for (const result of results) console.log(`${result.ready ? 'OK' : 'FAIL'} ${result.table}${result.ready ? '' : ` (${result.status || result.network})`}`);
if (results.some(result => !result.ready)) {
  console.log('Storage is not ready. Apply the payments, shared-store and production migrations in the documented order, then rerun this check.');
  process.exitCode = 1;
} else console.log('All eight database tables and required columns are accessible.');
