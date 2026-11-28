import { createHmac } from 'node:crypto';
import { HttpError, required } from './http.mjs';
import { rpc } from './store.mjs';
export async function rateLimit(request, scope, limit, seconds) {
  // Vercel overwrites x-forwarded-for. A missing address shares a conservative bucket.
  const address = (request.headers.get('x-forwarded-for') || 'unknown').split(',')[0].trim().slice(0, 100);
  const key = createHmac('sha256', required('CRON_SECRET')).update(`${scope}:${address}`).digest('hex');
  const result = await rpc('consume_shop_request', { p_key: key, p_limit: limit, p_seconds: seconds });
  if (!result.allowed) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.', { 'Retry-After': String(result.retry_after || seconds) });
}
