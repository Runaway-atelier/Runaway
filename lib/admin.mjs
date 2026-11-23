import { createHmac, timingSafeEqual } from 'node:crypto';
import { clean, HttpError, required } from './http.mjs';

export function getOwnerSecret() {
  return process.env.ADMIN_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export function verifySecretKey(input) {
  if (typeof input !== 'string' || !input) return false;
  const candidates = [process.env.ADMIN_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
  if (!candidates.length) return false;
  const inputBuf = Buffer.from(input);
  return candidates.some(secret => {
    const secBuf = Buffer.from(secret);
    return inputBuf.length === secBuf.length && timingSafeEqual(inputBuf, secBuf);
  });
}

export function createSessionToken() {
  const secret = getOwnerSecret();
  if (!secret) throw new Error('Owner secret is not configured.');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac('sha256', secret).update(timestamp).digest('hex');
  return `${timestamp}.${signature}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [timestamp, signature] = parts;
  if (!/^\d+$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (now < ts || now - ts > 7 * 86400) return false;
  const secrets = [process.env.ADMIN_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
  const sigBuf = Buffer.from(signature, 'hex');
  return secrets.some(secret => {
    const expected = createHmac('sha256', secret).update(timestamp).digest();
    return expected.length === sigBuf.length && timingSafeEqual(expected, sigBuf);
  });
}

export function sessionCookie(request, token, age) {
  return `runaway_owner=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export async function authRequest(path, { token, body } = {}) {
  const response = await fetch(`${required('SUPABASE_URL').replace(/\/$/, '')}/auth/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: required('SUPABASE_SERVICE_ROLE_KEY'), ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 401, response.status === 429 ? 'Too many attempts. Try again later.' : 'Please sign in with your owner account.');
  return response.json();
}

export function isOwner(user) {
  return Boolean(user?.email_confirmed_at && user.email?.toLowerCase() === required('ADMIN_EMAIL').trim().toLowerCase());
}

export async function requireOwner(request) {
  const token = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith('runaway_owner='))?.slice(14);
  if (!token) throw new HttpError(401, 'Please sign in with your owner account.');
  const cleaned = clean(token, 8000);
  if (verifySessionToken(cleaned)) {
    return { email: process.env.ADMIN_EMAIL || 'owner@runaway.com', role: 'owner' };
  }
  const user = await authRequest('user', { token: cleaned });
  if (!isOwner(user)) throw new HttpError(403, 'Owner access required.');
  return user;
}
