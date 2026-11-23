import { clean, HttpError, required } from './http.mjs';

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
  const user = await authRequest('user', { token: clean(token, 8000) });
  if (!isOwner(user)) throw new HttpError(403, 'Owner access required.');
  return user;
}
