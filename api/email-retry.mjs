import { timingSafeEqual } from 'node:crypto';
import { failure, HttpError, json, required } from '../lib/http.mjs';
import { sendOutbox } from '../lib/outbox.mjs';
import { rpc } from '../lib/store.mjs';

export async function GET(request) {
  try {
    const expected = Buffer.from(`Bearer ${required('CRON_SECRET')}`);
    const actual = Buffer.from(request.headers.get('authorization') || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'Unauthorized.');
    await rpc('maintain_shop', {});
    return json(200, await sendOutbox());
  } catch (error) { return failure(error); }
}
