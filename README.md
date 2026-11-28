# RUNAWAY — Luxury Athleticism Storefront & Owner Console

A high-performance luxury storefront and administrative operations console crafted in **pure vanilla HTML5, CSS3, and modern JavaScript (ES6+)** with no frontend framework. Server integrations use Vercel Functions and Supabase.

---

## 📁 Architecture & Clean Directory Structure

```
runaway/
├── index.html                      # Storefront Home (hero, lookbook, quickview, bag)
├── collection.html                 # Full Catalogue (interactive filters, quick-add)
├── about.html                      # Brand heritage, philosophy, animated metrics
│
├── css/
│   └── styles.css                  # Unified luxury design system, CSS variables & animations
│
├── js/
│   ├── data.js                     # Central product catalogue & dynamic relative path resolver
│   ├── site.js                     # Core UI engine, cart drawer, checkout & localStorage persistence
│   ├── app.js                      # Homepage quick-view modal & catalogue bindings
│   └── product.js                  # Modular product-detail page renderer & cross-sell logic
│
├── products/                       # Dedicated Product Detail Pages (PDP)
│   ├── aether-compression-tee.html # Raglan compression tee
│   ├── apex-training-shorts.html   # 4-way stretch training shorts
│   └── velocity-skull-cap.html     # Second-skin cap (4 colorways)
│
├── admin/                          # Owner Operations & House Management Console
│   ├── login.html                  # Supabase-authenticated owner login portal
│   ├── dashboard.html              # Real-time revenue metrics, order table & inventory overview
│   ├── admin.css                   # Refined dark-luxury administrative styling
│   └── admin.js                    # Shared paid orders, fulfillment updates and packing slips
│
├── public/                         # Static Assets & Photography
│   ├── favicon.svg                 # Gold dual-runner SVG icon
│   └── images/                     # 13 high-resolution studio & editorial images
│
└── README.md
```

---

## 🏛️ Features & Architecture Highlights

### 1. Storefront Experience
- **Zero Runtime Frameworks**: Lightweight, instant loads, resilient without build steps.
- **Luxury Aesthetic**: Grounded in `#070707` midnight black, elevated `#101010`, warm gold accents (`#c9a84c`), with *Cinzel* display typography and *Outfit* body type.
- **Interactive Catalogue**: Live search filter (`#collectionSearch`), sorting by Price (Low/High) or Name, and dynamic category chips.
- **Dynamic Cart Drawer**: Direct manipulation side bag drawer with fluid physics, size/color selectors, instant subtotal calculation, and Nigerian courier checkout.
- **Nigerian Courier Checkout**: Captures full delivery coordinates (Phone, Street Address, City, State dropdown) with instant order ID generation (`RW-XXXX`).
- **Order Tracking**: Customers can look up current fulfillment from any device using their order ID and checkout email. Contact and address data are excluded from tracking responses.

### 2. Owner Operations Portal (`admin/`)
- **Owner Authentication**: Supabase Auth validates the configured owner on every order API request; access tokens stay in an HttpOnly cookie.
- **Owner Account**: Sign in with the confirmed Supabase Auth user matching `ADMIN_EMAIL`.
- **Owner KPIs**: Revenue and average order value count orders marked paid; paid orders and fulfillment data are stored in the shared database.
- **Order Management & Packing Slips**: Search and filter orders, view verified payments and manage fulfillment states, add courier and tracking details, print slips, and export order data to CSV.
- **Catalogue CRUD & Preview**: In-dashboard modal previewing, custom piece uploading, full specifications/pricing editing, deletion with confirmation, and **"Restore Core Kit ↺"** recovery tool.
- **Inventory Fields**: Shared product catalogue, SKU, available quantity and low-stock threshold. Checkout reserves product-level stock; quantities are not separated by size or colour yet.
- **Announcement Control**: Preview the storefront marquee text before saving it.

Orders, fulfillment, products, stock and announcements sync through the private database. Guest bags and newsletter signups are also saved in Supabase. Customer order tracking reads current fulfillment using an order ID and checkout email. Payment status is set by verified Paystack transactions.

Apply the payments, shared-store and production migrations in the order listed in [production launch](docs/production-launch.md). Run `npm run verify:storage`, then restart the development server. See [storage setup](docs/storage-setup.md) for browser-data import. Production deployment serves only the copied storefront assets in `dist`.

---

## Payments and notifications

Paystack checkout now saves pending orders in a private Supabase database. Verified payment webhooks atomically mark orders paid and queue customer receipts and shop notifications through Resend. Durable email jobs support retries, concurrency protection and delivery tracking.

See [payment setup](docs/payment-setup.md) for the database migration, server variables, owner account, webhook URLs, retry scheduling and test-mode launch checks. Configuration is required before checkout accepts payments.

## 🚀 Running the Project

### Local Development

You can run the project using the Vercel development server or any static HTTP server:

For local checkout and payment testing, run `npm run dev` and open
`http://localhost:3000/collection`. This serves the storefront and API routes together
and reads server credentials from `.env.local`. Keep the terminal running.
Opening an HTML file directly (`file://`) or using a static-only server cannot run
the payment API. Local checkout supports redirects and verification; provider
webhooks require a publicly reachable deployment or tunnel.

```bash
# Option A: Run via Vercel dev server (simulates clean URLs & headers)
npx vercel dev

# Option B: Run via standard static HTTP server
npx serve .
# or
python -m http.server 8080

# Option C: Open directly via file protocol
# Double click index.html or admin/login.html
```

- **Customer Storefront**: `http://localhost:3000/` (or `http://localhost:8080/index.html`)
- **Owner Operations**: `http://localhost:3000/admin/login` (sign in with your configured owner account)

---

## ⚡ Deploying to Vercel

### Method 1: GitHub Integration (Recommended — 1-Click Automated CI/CD)

1. Go to [vercel.com/new](https://vercel.com/new) and log in with your GitHub account.
2. Under **"Import Git Repository"**, select **`Runaway-atelier/Runaway`**.
3. Configure Project Settings:
   - **Framework Preset**: `Other`
   - **Root Directory**: `./` (default)
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
4. Click **Deploy**.

> **Note**: Once linked, every time you run `git push origin main`, Vercel will automatically trigger a new deployment and update your live site within seconds.

### Method 2: Deploy via Vercel CLI

```bash
# First-time deploy (Preview)
npx vercel

# Production deploy
npx vercel --prod
```

