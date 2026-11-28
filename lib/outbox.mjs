import { db, rpc } from './store.mjs';
import { required } from './http.mjs';
import { paymentEnvironment } from './environment.mjs';

export async function sendOutbox() {
  const key = required('RESEND_API_KEY');
  // Atomic database leases keep concurrent callback, scheduler and worker requests apart.
  const jobs = await rpc('claim_shop_emails', { p_environment: paymentEnvironment() });
  let sent = 0;
  for (const job of jobs) {
    let result;
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `runaway-${job.kind}-${job.order_id}` },
        body: JSON.stringify(job.payload), signal: AbortSignal.timeout(8000),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.id) throw new Error(`Email provider HTTP ${response.status}`);
      result = { state: 'sent', resend_id: body.id, last_error: null, locked_until: null };
    } catch {
      result = { state: 'pending', last_error: 'Email send was not confirmed; retry scheduled.', locked_until: null,
        next_attempt_at: new Date(Date.now() + Math.min(60 * 60, 30 * 2 ** Math.min(job.attempts, 7)) * 1000).toISOString() };
    }
    // If persistence fails after Resend accepted, leave the lease for the next worker.
    // It reuses the frozen payload and idempotency key within the 24-hour window.
    await db(`shop_email_outbox?id=eq.${job.id}&lease_token=eq.${job.lease_token}&state=eq.sending`, { method: 'PATCH', body: result });
    if (result.state === 'sent') sent++;
  }
  return { processed: jobs.length, sent };
}
