import { waitUntil } from '@vercel/functions';
import { sendOutbox } from './outbox.mjs';

export function startEmailDelivery() {
  waitUntil(sendOutbox().catch(() => { console.error('Email worker interrupted; durable jobs remain queued.'); }));
}
