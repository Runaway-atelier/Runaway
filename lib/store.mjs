import { required } from './http.mjs';

export async function db(path, { method = 'GET', body, prefer = 'return=representation' } = {}) {
  const response = await fetch(`${required('SUPABASE_URL').replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: { apikey: required('SUPABASE_SERVICE_ROLE_KEY'), Authorization: `Bearer ${required('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json', Prefer: prefer },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
export const rpc = (name, body) => db(`rpc/${name}`, { method: 'POST', body });
export async function findOrder(reference) {
  return (await db(`shop_orders?reference=eq.${encodeURIComponent(reference)}&limit=1`))[0] || null;
}
export function publicOrder(row) {
  return {
    id: row.id, date: row.paid_at || row.created_at, customer: row.customer, items: row.items,
    total: row.total, paymentReference: row.reference, paymentStatus: row.payment_status,
    status: row.fulfillment_status === 'Cancelled' ? 'Cancelled' : ['Shipped', 'Delivered'].includes(row.fulfillment_status) ? 'Fulfilled' : 'Pending',
    fulfillmentStatus: row.fulfillment_status, carrier: row.courier, trackingNumber: row.tracking_number,
  };
}
