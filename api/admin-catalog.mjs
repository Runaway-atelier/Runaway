import { failure, HttpError, json, readJson, sameOrigin, clean } from '../lib/http.mjs';
import { requireOwner } from '../lib/admin.mjs';
import { db, rpc } from '../lib/store.mjs';
import { readShop, productRecord } from '../lib/shop.mjs';
import { paymentEnvironment } from '../lib/environment.mjs';
export async function GET(request) {
  try { await requireOwner(request); return json(200, await readShop(true)); }
  catch (error) { return failure(error); }
}
export async function POST(request) {
  try {
    sameOrigin(request); await requireOwner(request);
    const body = await readJson(request, 2200000);
    if (body.action === 'save') {
      const row = productRecord(body.product);
      const stockField = paymentEnvironment() === 'test' ? 'test_stock' : 'stock';
      if (stockField === 'test_stock') { row.test_stock = row.stock; delete row.stock; }
      let saved;
      if (body.expected !== undefined) {
        const expected = body.expected;
        if (!expected || !Number.isFinite(Date.parse(expected.updatedAt)) ||
            (expected.stock !== null && !Number.isSafeInteger(expected.stock))) throw new HttpError(400, 'Refresh the catalogue before editing this product.');
        // Make the revision strictly advance, even for saves in the same millisecond.
        row.updated_at = new Date(Math.max(Date.now(), Date.parse(expected.updatedAt) + 1)).toISOString();
        let path = `shop_products?slug=eq.${row.slug}&active=eq.true&updated_at=eq.${encodeURIComponent(expected.updatedAt)}`;
        if (row[stockField] === expected.stock) {
          // A description/image edit must never write back an old stock balance.
          delete row[stockField];
        } else {
          path += `&${stockField}=${expected.stock === null ? 'is.null' : `eq.${expected.stock}`}`;
        }
        saved = await db(path, { method: 'PATCH', body: row });
      } else {
        // Create only: a duplicate slug must not silently replace an existing piece.
        saved = await db('shop_products?on_conflict=slug', { method: 'POST', body: row, prefer: 'resolution=ignore-duplicates,return=representation' });
      }
      if (!saved?.length) throw new HttpError(409, 'This product changed since you opened it, or its slug already exists. Refresh the catalogue and review your changes.');
    } else if (body.action === 'hide' || body.action === 'restore') {
      const slug = clean(body.slug, 100);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400, 'Invalid product.');
      await db(`shop_products?slug=eq.${slug}`, { method: 'PATCH', body: { active: body.action === 'restore', updated_at: new Date().toISOString() } });
    } else if (body.action === 'announcement') {
      await db('shop_settings?on_conflict=key', { method: 'POST', body: { key: 'announcement', value: clean(body.value, 500).replace(/[<>]/g, '') }, prefer: 'resolution=merge-duplicates,return=representation' });
    } else if (body.action === 'import') {
      const products = (body.products || []).slice(0, 100).map(productRecord);
      const hidden = (body.hidden || []).filter(s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)).slice(0, 100);
      await rpc('import_shop_browser_data', { p_products: products, p_hidden: hidden, p_announcement: clean(body.announcement, 500).replace(/[<>]/g, '') });
    } else throw new HttpError(400, 'Invalid catalogue action.');
    return json(200, await readShop(true));
  } catch (error) { return failure(error); }
}
