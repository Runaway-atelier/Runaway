import { failure, HttpError, json, rawBody, validReference } from '../lib/http.mjs';
import { paystackSignature } from '../lib/signatures.mjs';
import { settlePayment } from '../lib/payments.mjs';
import { startEmailDelivery } from '../lib/background.mjs';

export async function POST(request) {
  try {
    const raw = await rawBody(request, 200000);
    if (!paystackSignature(raw, request.headers)) throw new HttpError(401, 'Invalid signature.');
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Invalid event.'); }
    if (event?.event !== 'charge.success') return json(200, { received: true });
    const reference = event.data?.reference;
    // Ignore payments from other apps sharing this Paystack account.
    if (!validReference(reference)) return json(200, { received: true });
    // Acknowledge only after payment and the email jobs are durably committed.
    // No email network calls are made in this webhook.
    const result = await settlePayment(reference);
    if (!result.paid) throw new HttpError(503, 'Payment is still processing.');
    startEmailDelivery();
    return json(200, { received: true });
  } catch (error) { return failure(error); }
}
