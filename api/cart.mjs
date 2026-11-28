import { createHash, randomBytes } from 'node:crypto';
import { clean, failure, HttpError, json, readJson, sameOrigin } from '../lib/http.mjs';
import { db } from '../lib/store.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';
function identity(request) {
  const supplied = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('runaway_cart='))?.slice(13);
  const token = /^[a-f0-9]{64}$/.test(supplied || '') ? supplied : randomBytes(32).toString('hex');
  return { hash: createHash('sha256').update(token).digest('hex'), headers: { 'Set-Cookie': `runaway_cart=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` } };
}
export async function GET(request) {
  try {
    const { hash, headers } = identity(request);
    const row = (await db(`shop_carts?token_hash=eq.${hash}&limit=1`))[0];
    return json(200, { items: row?.items || [] }, headers);
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  try {
    sameOrigin(request);
    await rateLimit(request, 'cart-save', 120, 60);
    const { hash, headers } = identity(request), body = await readJson(request);
    if (!Array.isArray(body.items) || body.items.length > 30) throw new HttpError(400, 'Invalid bag.');
    const items = body.items.map(item => {
      const slug = clean(item.slug, 100), size = clean(item.size, 30), color = clean(item.color, 60), qty = Number(item.qty);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !size || !color || !Number.isInteger(qty) || qty < 1 || qty > 20) throw new HttpError(400, 'Invalid bag item.');
      return { slug, size, color, qty };
    });
    await db('shop_carts?on_conflict=token_hash', { method: 'POST', body: { token_hash: hash, items, updated_at: new Date().toISOString() }, prefer: 'resolution=merge-duplicates,return=minimal' });
    return json(200, { ok: true }, headers);
  } catch (error) { return failure(error); }
}
