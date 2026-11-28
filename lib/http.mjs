export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
export class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}
export function sameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw new HttpError(403, 'Request not allowed.');
}
export async function rawBody(request, limit = 30000) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function readJson(request, limit = 30000) {
  const raw = await rawBody(request, limit);
  try {
    const body = JSON.parse(raw.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'Invalid request.'); }
}
export function failure(error) {
  if (error instanceof HttpError) return json(error.status, { error: error.message }, error.headers);
  // Never log provider bodies, credentials, payment references or customer data.
  console.error('Integration request failed:', error.name);
  return json(503, { error: 'Service temporarily unavailable. Please try again.' });
}
export const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validReference = value => /^runaway-[a-f0-9]{48}$/.test(value);
export function required(name) {
  const value = process.env[name];
  if (!value) throw new HttpError(503, 'The shop is still being configured. Please try again later.');
  return value;
}
