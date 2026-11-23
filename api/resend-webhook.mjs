import { failure, HttpError, json, rawBody } from '../lib/http.mjs';
import { resendSignature } from '../lib/signatures.mjs';
import { rpc } from '../lib/store.mjs';

export async function POST(request) {
  try {
    const raw = await rawBody(request, 200000);
    if (!resendSignature(raw, request.headers)) throw new HttpError(401, 'Invalid signature.');
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid event.'); }
    const allowed = ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed'];
    if (allowed.includes(event?.type) && typeof event.data?.email_id === 'string' && Number.isFinite(Date.parse(event.created_at))) {
      await rpc('record_shop_email_event', { p_email_id: event.data.email_id, p_type: event.type, p_at: event.created_at });
    }
    return json(200, { received: true });
  } catch (error) { return failure(error); }
}
