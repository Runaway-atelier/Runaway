import { clean, failure, HttpError, json, readJson, sameOrigin } from '../lib/http.mjs';
import { authRequest, createSessionToken, isOwner, requireOwner, sessionCookie, verifySecretKey } from '../lib/admin.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';

export async function GET(request) {
  try { await requireOwner(request); return json(200, { ok: true }); } catch (error) { return failure(error); }
}

export async function POST(request) {
  try {
    sameOrigin(request);
    await rateLimit(request, 'owner-login', 8, 900);
    const body = await readJson(request);

    // 1. Secret Key / Passcode authentication (No Supabase user email verification needed)
    const secret = typeof body.secretKey === 'string' ? body.secretKey.trim()
      : typeof body.passcode === 'string' ? body.passcode.trim()
      : (typeof body.password === 'string' && !body.email) ? body.password.trim() : null;

    if (secret) {
      if (!verifySecretKey(secret)) {
        throw new HttpError(401, 'Invalid owner secret key.');
      }
      const token = createSessionToken();
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, token, 3600) });
    }

    // 2. Fallback: Supabase Auth email+password (if email provided)
    if (body.email) {
      const result = await authRequest('token?grant_type=password', {
        body: { email: clean(body.email, 254), password: typeof body.password === 'string' ? body.password.slice(0, 1024) : '' }
      });
      if (!isOwner(result.user)) throw new HttpError(403, 'Owner access required.');
      return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, result.access_token, Math.min(result.expires_in || 3600, 3600)) });
    }

    throw new HttpError(400, 'Please enter your owner secret key.');
  } catch (error) { return failure(error); }
}

export async function DELETE(request) {
  try { sameOrigin(request); return json(200, { ok: true }, { 'Set-Cookie': sessionCookie(request, '', 0) }); } catch (error) { return failure(error); }
}
