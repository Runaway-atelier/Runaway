import { clean, failure, HttpError, json, readJson, sameOrigin, validEmail } from '../lib/http.mjs';
import { db } from '../lib/store.mjs';
import { paymentEnvironment } from '../lib/environment.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';
export async function POST(request) {
  try {
    sameOrigin(request);
    await rateLimit(request, 'order-tracking', 20, 600);
    const body = await readJson(request);
    const id = clean(body.orderId, 20).toUpperCase(), email = clean(body.email, 254).toLowerCase();
    if (!/^RW-[A-F0-9]{12}$/.test(id) || !validEmail(email)) throw new HttpError(400, 'Enter your order ID and checkout email.');
    const row = (await db(`shop_orders?id=eq.${id}&payment_status=eq.Paid&payment_environment=eq.${paymentEnvironment()}&limit=1`))[0];
    if (!row || row.customer?.email !== email) throw new HttpError(404, 'No matching paid order found. Check your order ID and email.');
    // Return fulfillment data only; never expose addresses, phone numbers or payment bearer links.
    return json(200, { order: { id: row.id, date: row.paid_at || row.created_at, items: row.items, total: row.total,
      paymentStatus: row.payment_status, fulfillmentStatus: row.fulfillment_status, carrier: row.courier, trackingNumber: row.tracking_number } });
  } catch (error) { return failure(error); }
}
