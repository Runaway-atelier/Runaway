import { clean, failure, HttpError, json, readJson, required, sameOrigin, validEmail } from '../lib/http.mjs';
import { db } from '../lib/store.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';

// Receipts are queued by trusted payment settlement, never from browser order data.
export async function POST(request) {
  try {
    sameOrigin(request);
    const body = await readJson(request);
    if (body.type !== 'newsletter') throw new HttpError(400, 'Order receipts are sent automatically after verified payment.');
    if (clean(body.website, 120)) return json(200, { ok: true });
    await rateLimit(request, 'newsletter', 5, 3600);
    const email = clean(body.email, 254).toLowerCase();
    if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
    await db('shop_subscribers?on_conflict=email', { method: 'POST', body: { email }, prefer: 'resolution=ignore-duplicates,return=minimal' });
    const segmentId = clean(process.env.RESEND_NEWSLETTER_SEGMENT_ID, 100);
    const response = await fetch('https://api.resend.com/contacts', {
      method: 'POST', headers: { Authorization: `Bearer ${required('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, unsubscribed: false, ...(segmentId ? { segments: [{ id: segmentId }] } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new HttpError(502, 'Could not join the list. Please try again.');
    await db(`shop_subscribers?email=eq.${encodeURIComponent(email)}`, { method: 'PATCH', body: { provider_synced_at: new Date().toISOString() }, prefer: 'return=minimal' });
    return json(200, { ok: true });
  } catch (error) { return failure(error); }
}
