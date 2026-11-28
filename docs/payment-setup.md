# Activate Paystack and Resend

The code is ready for configuration; running it locally does not create service accounts, register webhooks, or activate live payments.

## 1. Create the private order database

1. Create a Supabase project.
2. Run [`20261123_payments.sql`](../supabase/migrations/20261123_payments.sql), then [`20261125_shared_store.sql`](../supabase/migrations/20261125_shared_store.sql), then [`20261125180000_production.sql`](../supabase/migrations/20261125180000_production.sql). The migrations are transactional and create eight private tables plus server-only functions. Existing installations only need migrations not yet applied. Run `npm run verify:storage` afterward. See [production launch](production-launch.md) before deploying or switching to live payments.
3. Copy the project URL and **legacy service-role key** into server environment variables `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Do not use an anonymous key for this backend. Do not put either secret key into frontend JavaScript.
4. In Supabase Authentication, create and confirm your owner user. Set `ADMIN_EMAIL` to that user's email. Use that email and password at `/admin/login`; the old public passcodes have been removed. Public signup is unnecessary and can be disabled.

Anonymous and signed-in browser roles have no access to orders, email jobs or payment functions. Owner API requests are checked with Supabase Auth before the server reads or updates any order.

## 2. Configure Resend

1. Add and verify a domain you own in Resend. Install the DNS records Resend supplies. A dedicated sending subdomain can isolate transactional email reputation.
2. Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL`, such as `RUNAWAY <orders@updates.yourdomain.com>`.
3. Set `ORDER_NOTIFICATION_EMAIL` to your shop inbox. Both the sender and shop inbox are required before checkout starts.
4. Register `https://YOUR_DOMAIN/api/resend-webhook` in Resend and copy its signing secret into `RESEND_WEBHOOK_SECRET`.
5. Subscribe to `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`.

Resend acceptance and delivery are tracked separately. Verified status events are stored in `shop_email_events`, even if they arrive before the sending worker saves the email ID. The owner-only `/api/admin-emails` endpoint provides recent job and event status. A delivery failure does not change a successful payment or automatically send another receipt to a bouncing address.

Newsletter subscriptions continue through `/api/order-email`. Contact management requires a Resend key with permissions for contacts; a sending-only key is insufficient. `RESEND_NEWSLETTER_SEGMENT_ID` is optional. Customer checkout does not subscribe someone to marketing.

## 3. Configure Paystack

1. Start with a Paystack **test** secret in `PAYSTACK_SECRET_KEY`.
2. Register `https://YOUR_DOMAIN/api/paystack-webhook` for `charge.success` in the matching test environment. Use the exact endpoint: Paystack does not follow redirects. Preview deployment protection must not block provider webhooks.
3. Generate a webhook signing secret in Paystack and set the whole `whsec_...` value as `PAYSTACK_WEBHOOK_SECRET`.
4. If your account still sends only `x-paystack-signature`, explicitly set `PAYSTACK_ALLOW_LEGACY_WEBHOOKS=true`. This verifies the legacy HMAC with the Paystack API secret. Once modern signatures are enabled, turn this switch off. An invalid modern header never falls back to legacy validation.
5. During signing-secret rotation, optionally set `PAYSTACK_PREVIOUS_WEBHOOK_SECRET` during the overlap, then remove it.

The server calculates prices in naira from the shared database catalogue and sends kobo to Paystack. It atomically saves the order and reserves stock before initialization, and sends only its order ID in Paystack metadata. Settlement checks provider status, reference, amount, NGN currency, customer email, order ID and test/live environment against the saved order. Callback and webhook use the same atomic settlement function.

Payment references are unguessable bearer links: someone possessing a reference can retrieve that order's confirmation. Do not publish references or include them in analytics. A missing browser session does not prevent a valid return link from recovering its order.

## 4. Configure background retries

New successful payments trigger immediate background delivery using Vercel `waitUntil`. Each order has one customer job and one shop job. Jobs persist across process restarts, have database leases, and retry independently with exponential backoff. Completed jobs are not resent.

For recovery when a provider or worker fails, configure a scheduler to call:

```text
GET https://YOUR_DOMAIN/api/email-retry
Authorization: Bearer YOUR_CRON_SECRET
```

Generate `CRON_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and store it only in server/scheduler settings. Run every minute (up to six jobs per invocation, claimed in pairs with a time limit); increase worker capacity deliberately as order volume grows.

For **Vercel Pro**, add this top-level property to `vercel.json`; Vercel sends `CRON_SECRET` automatically:

```json
"crons": [{ "path": "/api/email-retry", "schedule": "* * * * *" }]
```

Vercel Hobby supports daily cron only, which is too infrequent for receipt retries. Use an external scheduler with the authorization header on that plan. The repository intentionally does not enable a schedule that would fail Hobby deployment. Until scheduling is configured, immediate sends work and owners can use **Retry notifications** in the dashboard, but unattended retry is not active.

Email content and recipients are frozen when the order is paid, and retries reuse the same Resend idempotency key. Resend deduplicates for 24 hours; ambiguous jobs stop automatic attempts after 23 hours and enter `review`. Check Resend's logs before manually reconciling these jobs. Never reset `first_attempt_at` or blindly requeue an ambiguous job after the deduplication window.

## 5. Deploy and validate

Copy the variable names from [`.env.example`](../.env.example) into Vercel environment settings and redeploy after configuring them. For local API work, use an ignored `.env.local` and `npx vercel dev`; static file servers cannot execute payment functions. Use a publicly reachable test deployment for provider webhook testing.

```sh
npm ci
npm test
npx vercel dev
```

The automated suite runs the real migration and PostgreSQL functions using PGlite, and simulates the Paystack, Resend and Supabase Auth HTTP boundaries. It makes no real charges or email sends. It does not replace a test-mode checkout on your deployed project.

Before switching to live keys, verify:

- Successful and declined test payments; declined or pending payments never create receipts.
- Closing the buyer's browser after payment still produces a shared paid order and two notifications.
- Replaying a payment webhook and opening the callback repeatedly does not add jobs or duplicate emails.
- The shop dashboard on a different device can see paid orders and save packing, carrier and tracking updates.
- An invalid signature gets rejected; a temporary provider/database failure is retried without losing the order.
- Customer confirmation and shop notification reach their intended inboxes; failure of one does not resend the other.
- The scheduler drains failed jobs after their next-attempt time and delivery events are recorded.

Then configure live Paystack keys and the **live** webhook/signing secret. Confirm test/live environment settings separately.

## Scope and operations

Orders, fulfillment, catalogue edits, stock, announcements, guest bags and newsletter signups are stored in Supabase. Custom products are eligible for checkout at their saved prices. Checkout reserves product-level stock for 30 minutes; new checkout and the retry worker release expired unpaid reservations. Customer tracking reads current database fulfillment using order ID plus checkout email. Refunds, disputes and shipment notification emails are not automated. Older prototype orders are not silently imported or reconstructed from browser data. See [storage setup](storage-setup.md) for browser-data import and stock reconciliation.

Owner sessions expire after at most an hour and require signing in again. The service-role key is used only by server functions; protect server configuration and disable unused public Auth signup. Configure retention for abandoned pending orders and customer data according to shop policy. Review `shop_email_outbox` for `review` jobs and `shop_email_events` for delivery problems.

Official references: [Paystack checkout](https://paystack.com/docs/payments/accept-payments/), [webhook signatures](https://paystack.com/docs/payments/webhooks/), [test payments](https://paystack.com/docs/payments/test-payments/), [Resend domains](https://resend.com/docs/dashboard/domains/introduction), [email idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests), [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api), [Vercel background tasks](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package), [cron plan limits](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing).
