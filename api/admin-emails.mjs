import { failure, json, sameOrigin } from '../lib/http.mjs';
import { requireOwner } from '../lib/admin.mjs';
import { db } from '../lib/store.mjs';
import { sendOutbox } from '../lib/outbox.mjs';

export async function GET(request) {
  try {
    await requireOwner(request);
    // Payloads contain customer addresses; expose only operational fields.
    const jobs = await db('shop_email_outbox?select=order_id,kind,state,attempts,resend_id,last_error&order=next_attempt_at.desc&limit=100');
    const events = await db('shop_email_events?order=event_at.desc&limit=100');
    return json(200, { jobs, events });
  } catch (error) { return failure(error); }
}
export async function POST(request) {
  try { sameOrigin(request); await requireOwner(request); return json(200, await sendOutbox()); }
  catch (error) { return failure(error); }
}
