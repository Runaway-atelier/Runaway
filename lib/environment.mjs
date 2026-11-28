import { HttpError, required } from './http.mjs';
export function paymentEnvironment() {
  const key = required('PAYSTACK_SECRET_KEY');
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('sk_live_')) return 'live';
  throw new HttpError(503, 'Payment configuration is unavailable.');
}
export function requireCheckoutEnabled() {
  const environment = paymentEnvironment();
  if (environment === 'live' && process.env.PAYSTACK_LIVE_ENABLED !== 'true') throw new HttpError(503, 'Live checkout is not enabled yet.');
  return environment;
}
