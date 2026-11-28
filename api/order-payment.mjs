import { randomBytes } from 'node:crypto';
import { clean, failure, HttpError, json, readJson, required, sameOrigin, validEmail, validReference } from '../lib/http.mjs';
import { validateCart } from '../lib/catalog.mjs';
import { rpc } from '../lib/store.mjs';
import { readProducts, publicProduct } from '../lib/shop.mjs';
import { settlePayment } from '../lib/payments.mjs';
import { startEmailDelivery } from '../lib/background.mjs';
import { requireCheckoutEnabled } from '../lib/environment.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';

export async function POST(request) {
  try {
    sameOrigin(request);
    const body = await readJson(request);
    required('PAYSTACK_SECRET_KEY');
    if (body.action === 'verify') {
      await rateLimit(request, 'payment-verification', 120, 600);
      const reference = clean(body.reference, 100);
      if (!validReference(reference)) throw new HttpError(400, 'Payment reference is invalid.');
      const result = await settlePayment(reference);
      if (result.paid) startEmailDelivery();
      return json(200, result);
    }
    if (body.action !== 'initialize') throw new HttpError(400, 'Payment action is invalid.');
    const environment = requireCheckoutEnabled();
    await rateLimit(request, 'checkout', 10, 600);
    required('RESEND_API_KEY'); required('RESEND_FROM_EMAIL');
    if (!validEmail(required('ORDER_NOTIFICATION_EMAIL'))) throw new HttpError(503, 'Shop notifications are not configured.');
    const customer = Object.fromEntries(Object.entries({ name: 100, email: 254, phone: 40, address: 240, city: 100, state: 80 })
      .map(([key, max]) => [key, clean(body.customer?.[key], max)]));
    customer.email = customer.email.toLowerCase();
    const cart = validateCart(body.items, (await readProducts()).map(publicProduct));
    if (!cart || !Object.values(customer).every(Boolean) || !validEmail(customer.email)) throw new HttpError(400, 'Review your delivery details and bag. A piece may be unavailable or its price may have changed.');
    const id = `RW-${randomBytes(6).toString('hex').toUpperCase()}`;
    const reference = `runaway-${randomBytes(24).toString('hex')}`;
    // Save before calling Paystack: a provider timeout must not lose the order.
    await rpc('reserve_shop_order', { p_order: { id, reference, customer, items: cart.items, total: cart.total, payment_environment: environment } });
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST', headers: { Authorization: `Bearer ${required('PAYSTACK_SECRET_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: customer.email, amount: String(cart.total * 100), currency: 'NGN', reference,
        callback_url: `${new URL(request.url).origin}/`, metadata: { order_id: id } }),
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok || !result?.status || !result?.data?.authorization_url) throw new HttpError(502, 'Could not start checkout. Please try again.');
    const url = new URL(result.data.authorization_url);
    if (url.protocol !== 'https:' || url.hostname !== 'checkout.paystack.com') throw new Error('Unexpected checkout URL');
    return json(200, { ok: true, authorizationUrl: url.href, reference, orderId: id });
  } catch (error) { return failure(error); }
}
