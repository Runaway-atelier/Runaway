import { clean, failure, HttpError, json, readJson, sameOrigin } from '../lib/http.mjs';
import { requireOwner } from '../lib/admin.mjs';
import { db, publicOrder } from '../lib/store.mjs';

export async function GET(request) {
  try {
    await requireOwner(request);
    const rows = [];
    // PostgREST defaults to 1000 rows; page explicitly instead of hiding older orders.
    for (let offset = 0; ; offset += 500) {
      const page = await db(`shop_orders?payment_status=eq.Paid&order=created_at.desc,id.desc&limit=500&offset=${offset}`);
      rows.push(...page);
      if (page.length < 500) break;
    }
    return json(200, { orders: rows.map(publicOrder) });
  } catch (error) { return failure(error); }
}
export async function PATCH(request) {
  try {
    sameOrigin(request); await requireOwner(request);
    const body = await readJson(request);
    if (!/^RW-[A-F0-9]{12}$/.test(body.id || '')) throw new HttpError(400, 'Invalid order.');
    const updates = {};
    if (body.fulfillmentStatus !== undefined) {
      if (!['Pending', 'Packing', 'Shipped', 'Delivered', 'Cancelled'].includes(body.fulfillmentStatus)) throw new HttpError(400, 'Invalid fulfillment status.');
      updates.fulfillment_status = body.fulfillmentStatus;
    }
    if (body.carrier !== undefined) updates.courier = clean(body.carrier, 100);
    if (body.trackingNumber !== undefined) updates.tracking_number = clean(body.trackingNumber, 150);
    if (!Object.keys(updates).length) throw new HttpError(400, 'No valid updates. Payment status is managed by Paystack.');
    const rows = await db(`shop_orders?id=eq.${body.id}&payment_status=eq.Paid`, { method: 'PATCH', body: updates });
    if (!rows[0]) throw new HttpError(404, 'Order not found.');
    return json(200, { order: publicOrder(rows[0]) });
  } catch (error) { return failure(error); }
}
