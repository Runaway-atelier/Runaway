# Shared store data

## Activate the database migration

Apply `20261123_payments.sql`, then `20261125_shared_store.sql`, then `20261125180000_production.sql` in the Supabase SQL Editor. Existing installations only need files not yet applied. The migrations keep existing orders and email jobs. See [production launch](production-launch.md) for the test/live stock split and deployment order.

Run `npm run verify:storage` from the project folder. It checks the eight tables and required columns without printing credentials or customer records. Restart `npm run dev` after backend changes. Public deployments also need the updated source deployed; local changes do not update the hosted site.

The new checkout and catalogue APIs require the migration. If it has not been applied, catalogue loading and checkout return an unavailable response rather than accepting orders against stale browser data.

## Data stored in Supabase

| Table | Data |
| --- | --- |
| `shop_orders` | Pending and paid orders, customer contact/address, purchased item snapshots, totals, verified payment references and fulfillment |
| `shop_products` | Product definitions, images uploaded through admin, prices, SKU, stock, sizes, colours and hidden status |
| `shop_settings` | Shared announcement and browser-import marker |
| `shop_carts` | Guest bag items, keyed by a hash of an unguessable browser cookie |
| `shop_subscribers` | Newsletter opt-ins and provider-sync timestamps |
| `shop_email_outbox` | Durable receipt/notification jobs |
| `shop_email_events` | Email delivery events |
| `shop_request_limits` | Short-lived request counters keyed by a hash; no raw IP addresses |

Database policies deny direct access to browser database roles; server APIs use the service-role key. Public endpoints return catalogue data, the current cookie's bag, or limited order tracking data. Owner mutations require the existing owner session.

Guest bags are durable in the database and cached locally for responsiveness. Their HttpOnly cookie identifies the browser for 30 days; a different device does not automatically have the same anonymous identity. Order tracking works across devices with the order ID and checkout email. Browser session flags, pending-payment hints and the bag cache are not the authoritative records. Card details stay with Paystack.

## Preserve older browser data

Sign into the owner dashboard on the browser and address where the old catalogue changes were saved, then use **Import browser data**. This explicitly imports products/stock overrides, hidden slugs and the announcement once per database. Review the prompt: matching shared products will be replaced with that browser's versions. The import is transactional, and a database marker prevents a later stale browser from replacing the shared catalogue. Original browser records are retained as a backup.

Browser storage belongs to an origin. Data saved under `file://`, a different hostname, or another port cannot be read automatically by `http://localhost:3000`. Keep that browser's data until it has been exported/imported; never import browser-only prototype orders as verified payments.

## Stock behavior

Checkout validates product prices and variants from the database, then atomically reserves stock when saving the pending order. Test checkout uses `test_stock`; live checkout uses `stock`. Competing checkout cannot reserve the last unit twice. Paid orders keep the deduction, and repeated callbacks/webhooks do not deduct again.

Unpaid reservations expire after 30 minutes. New checkout and the authenticated email-retry worker release expired reservations. Configure the retry scheduler as described in payment setup. If a provider confirms payment after its stock reservation was released and resold, the payment is still saved; any shortage appears as negative stock in the owner dashboard for reconciliation. Stock quantities are product-level. Hiding/restoring products changes visibility without deleting historical order data.

Newsletter signups are saved before syncing to Resend, so a provider failure leaves the opt-in in the database with an empty sync timestamp. Submitting again retries the provider sync without duplicating the database contact.
