import { HttpError, required } from './http.mjs';
import { findOrder, publicOrder, rpc } from './store.mjs';
import { orderMessages } from './email.mjs';

export async function verifyTransaction(reference) {
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${required('PAYSTACK_SECRET_KEY')}` }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Payment provider unavailable');
  const result = await response.json();
  if (!result.status || !result.data) throw new Error('Payment verification unavailable');
  return result.data;
}
export async function settlePayment(reference) {
  const row = await findOrder(reference);
  if (!row) throw new HttpError(404, 'Order not found.');
  const transaction = await verifyTransaction(reference);
  if (transaction.status !== 'success') return { ok: true, paid: false, status: transaction.status || 'pending' };
  if (transaction.reference !== reference || transaction.currency !== 'NGN' || Number(transaction.amount) !== row.total * 100 ||
      transaction.metadata?.order_id !== row.id || transaction.customer?.email?.toLowerCase() !== row.customer.email ||
      !transaction.id || transaction.domain !== (required('PAYSTACK_SECRET_KEY').startsWith('sk_live_') ? 'live' : 'test')) {
    throw new HttpError(409, 'Payment details do not match the order. Contact RUNAWAY support.');
  }
  const paidAt = transaction.paid_at && Number.isFinite(Date.parse(transaction.paid_at)) ? transaction.paid_at : new Date().toISOString();
  const updated = await rpc('settle_shop_order', {
    p_reference: reference, p_transaction_id: String(transaction.id), p_paid_at: paidAt,
    p_amount: Number(transaction.amount), p_messages: orderMessages(publicOrder(row)),
  });
  return { ok: true, paid: true, order: publicOrder(updated), emailQueued: true };
}
