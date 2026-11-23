import { clean, failure, HttpError, json, readJson, sameOrigin } from '../lib/http.mjs';
import { authRequest, isOwner, requireOwner, sessionCookie } from '../lib/admin.mjs';

export async function GET(request) {
  try { await requireOwner(request); return json(200, { ok: true }); } catch (error) { return failure(error); }
}
export async function POST(request) {
  try {
    sameOrigin(request);
    const body = await readJson(request);
    const result = await authRequest('token?grant_type=password', { body: { email: clean(body.email, 254), password: typeof body.password === 'string' ? body.password.slice(0, 1024) : '' } });
    if (!isOwner(result.user)) throw new HttpError(403, 'Owner access required.');
    // Never return the access/refresh token to browser JavaScript.
    return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, result.access_token, Math.min(result.expires_in || 3600, 3600)) });
  } catch (error) { return failure(error); }
}
export async function DELETE(request) {
  try { sameOrigin(request); return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) }); } catch (error) { return failure(error); }
}
