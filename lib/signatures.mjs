import { createHmac, timingSafeEqual } from 'node:crypto';

const equalHex = (expected, value) => /^[a-f0-9]{128}$/.test(value) && timingSafeEqual(expected, Buffer.from(value, 'hex'));
export function paystackSignature(raw, headers, now = Math.floor(Date.now() / 1000)) {
  const modern = headers.get('paystack-signature');
  if (modern !== null) {
    const secrets = [process.env.PAYSTACK_WEBHOOK_SECRET, process.env.PAYSTACK_PREVIOUS_WEBHOOK_SECRET].filter(Boolean);
    const fields = modern.split(',').map(part => { const i = part.indexOf('='); return [part.slice(0, i).trim(), part.slice(i + 1).trim()]; });
    const times = fields.filter(([key]) => key === 't');
    if (times.length !== 1 || !/^\d+$/.test(times[0][1])) return false;
    const timestamp = times[0][1];
    if (Math.abs(now - Number(timestamp)) > 300) return false;
    return secrets.some(secret => {
      const expected = createHmac('sha512', secret).update(`${timestamp}.`).update(raw).digest();
      return fields.some(([key, value]) => key === 'v1' && /^whk_[^:]+:/.test(value) && equalHex(expected, value.slice(value.indexOf(':') + 1)));
    });
  }
  // Explicit migration switch; never fall back if a modern header was invalid.
  if (process.env.PAYSTACK_ALLOW_LEGACY_WEBHOOKS !== 'true' || !process.env.PAYSTACK_SECRET_KEY) return false;
  return equalHex(createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(raw).digest(), headers.get('x-paystack-signature') || '');
}
export function resendSignature(raw, headers, now = Math.floor(Date.now() / 1000)) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const id = headers.get('svix-id'); const timestamp = headers.get('svix-timestamp');
  if (!secret?.startsWith('whsec_') || !id || !/^\d+$/.test(timestamp || '') || Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.`).update(raw).digest();
  return (headers.get('svix-signature') || '').split(' ').some(entry => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const signature = Buffer.from(value, 'base64');
    return signature.length === expected.length && timingSafeEqual(expected, signature);
  });
}
