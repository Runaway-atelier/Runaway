# Production launch

The local tests and delivered Resend test email are preparation evidence. Public deployment, provider-delivered webhooks, scheduled HTTP responses and browser checkout still need end-to-end verification.

## Database and credentials

Apply these SQL files in this order; existing installations only need files not yet applied:

1. `supabase/migrations/20261123_payments.sql`
2. `supabase/migrations/20261125_shared_store.sql`
3. `supabase/migrations/20261125180000_production.sql`

The third migration adds request limits, payment environment labels and separate test stock. Existing orders from this test-only installation are labelled `test`. Their reserved units are restored to real inventory while remaining deducted from test inventory. Review real available stock before enabling live payments.

Set a dedicated `ADMIN_SECRET_KEY` of at least 32 characters using a password manager. Sample passcodes and database service-role keys cannot sign into the owner console. Signed owner cookies expire after one hour; rotating the dedicated secret invalidates them.

Run `npm run verify:storage`, `npm test`, `npm run build` and `npm run check:launch`. The launch check defaults to test mode and never prints credentials. It checks configuration presence and format, not whether provider secrets match dashboard settings.

## Deploy for public acceptance testing

Use the existing Vercel project with **Framework: Other**, **Build Command: npm run build**, **Output Directory: dist**. Root `api` functions are bundled separately. Only storefront assets are copied into `dist`. Credentials, server modules, scratch emails, database files and tests are excluded from static publication. `.vercelignore` excludes local secrets and scratch files from CLI uploads too.

Configure Vercel server variables from `.env.example`. Keep a Paystack `sk_test_…` key and `PAYSTACK_LIVE_ENABLED=false` during acceptance testing. Changes to local `.env.local` do not update Vercel automatically. Use a plan suitable for a commercial store; Vercel Hobby is restricted to personal, non-commercial projects.

After deployment run `npm run check:launch -- --origin=https://YOUR_PUBLIC_HOST`. It checks catalogue availability, mode, owner authentication, private-file exclusion and retry-endpoint authentication. It does not make a payment.

Register the matching Paystack test webhook at `https://YOUR_PUBLIC_HOST/api/paystack-webhook`, and configure its actual signing secret in Vercel. Use the explicit legacy switch only for accounts still sending legacy signatures. Configure the Resend delivery webhook at `/api/resend-webhook` and its actual signing secret too. Provider endpoints must be reachable without Vercel preview-protection interception. Confirm provider-delivered events, not only locally signed replays.

## Scheduled retries

After confirming the public URL, run:

```sh
npm run prepare:scheduler -- https://YOUR_PUBLIC_HOST
```

Run the generated `scratch/supabase-scheduler.sql` in this project's Supabase SQL Editor. It contains the cron secret, stores the settings in Supabase Vault, and schedules the `runaway-email-retry` job every minute with `pg_cron` and `pg_net`. The deployed `CRON_SECRET` must match. Keep the generated file out of source control.

Inspect Cron history and the corresponding `net._http_response` result. A successful cron invocation only proves an HTTP request was queued; the website's HTTP response must also succeed. Confirm a recoverable receipt failure is retried without a browser. The database HTTP queue temporarily contains the authorization header, so limit database login access to trusted operators.

Each invocation handles two jobs; monitor the backlog before increasing capacity. Ambiguous sends older than 23 hours enter `review`. Never reset their first-attempt timestamp or blindly retry them outside the provider's deduplication window.

## Acceptance and live activation

Test the public storefront with a reachable customer inbox and Paystack's official test cards. Verify success, decline and abandonment; confirmation and bag clearing; paid admin visibility; customer and shop emails; and tracking from a second browser using order ID plus checkout email. Close the browser after payment to test webhook-only settlement. Provider-event replays and repeated callbacks must leave one order and exactly two email jobs. Verify delivery events and the actual retry schedule. Import older browser catalogue changes explicitly.

After acceptance passes, set the Paystack live secret and matching live webhook/signing secret in Vercel, set `PAYSTACK_LIVE_ENABLED=true`, and redeploy. Run `npm run check:launch -- --live --origin=https://YOUR_PUBLIC_HOST` with matching local live settings. Review real stock in the dashboard's LIVE MODE. Test sales do not count as live revenue or change live stock; workers and tracking also select the current environment. Catalogue descriptions and prices remain shared between modes.

A real-money smoke payment requires an agreed amount and buyer confirmation. Key activation alone does not verify a real transaction. Refunds, disputes and courier operations remain manual. Confirm delivery/return/refund/contact information and choose database backup and retention policies before a broad launch.

References: [Vercel build output](https://vercel.com/docs/builds/configure-a-build), [Vercel ignore rules](https://vercel.com/docs/deployments/vercel-ignore), [Supabase scheduling and Vault](https://supabase.com/docs/guides/functions/schedule-functions), [Paystack test payments](https://paystack.com/docs/payments/test-payments/).
