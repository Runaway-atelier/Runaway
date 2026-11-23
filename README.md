# RUNAWAY — Luxury Athleticism Storefront & Owner Console

A high-performance luxury storefront and administrative operations console crafted in **pure vanilla HTML5, CSS3, and modern JavaScript (ES6+)** with zero runtime dependencies.

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
│   ├── login.html                  # Secure owner login portal (Passcode: runaway2026)
│   ├── dashboard.html              # Real-time revenue metrics, order table & inventory overview
│   ├── admin.css                   # Refined dark-luxury administrative styling
│   └── admin.js                    # Status transitions (Pending/Fulfilled/Cancelled), demo data seeder
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
- **Universal Order Tracking**: Customers can check live fulfillment status (*"Processing at Lagos Atelier"* vs. *"Dispatched via RUNAWAY Courier"*) by Order ID, Email, or Phone.

### 2. Owner Operations Portal (`admin/`)
- **Authentication Guard**: Session-based authentication (`sessionStorage.runaway_owner_session`) protecting the console.
- **Default Owner Passcode**: `runaway2026` (or `admin`).
- **Owner KPIs**: Revenue and average order value count orders marked paid; order, fulfillment, and payment data is currently saved in this browser only.
- **Order Management & Packing Slips**: Search and filter orders, manage payment and fulfillment states, add courier and tracking details, print slips, and export order data to CSV.
- **Catalogue CRUD & Preview**: In-dashboard modal previewing, custom piece uploading, full specifications/pricing editing, deletion with confirmation, and **"Restore Core Kit ↺"** recovery tool.
- **Inventory Fields**: Assign a SKU, product-level quantity, and low-stock threshold to each piece. Counts are not tracked by size or color yet.
- **Announcement Control**: Preview the storefront marquee text before saving it.

The owner console still uses browser storage. Orders, inventory edits, and announcements do not sync across devices. A shared database is not enabled; configure owner authentication and a private data service before storing customer records centrally.

---

## ✉️ Order Emails (Resend)

The Vercel function at `/api/order-email` sends an order confirmation to the buyer, a new-order notice to the shop inbox, and saves newsletter signups as Resend contacts. The Resend key is read only by the server function.

1. Verify a sending domain in Resend and create a sending API key.
2. Add these variables in Vercel Project Settings → Environment Variables:
   - `RESEND_API_KEY` — the Resend sending key.
   - `RESEND_FROM_EMAIL` — a sender on your verified domain, for example `RUNAWAY <orders@yourdomain.com>`.
   - `ORDER_NOTIFICATION_EMAIL` — optional shop inbox for new-order alerts.
   - `RESEND_NEWSLETTER_SEGMENT_ID` — optional Resend segment ID for newsletter signups.
3. Add the same values to `.env.local` for local work with `npx vercel dev`. Keep `.env.local` private; `.env.example` shows the variable names.

The storefront still keeps its order list in the customer's browser. Resend sends the confirmation and shop notification, but this email integration does not create a shared order database for the admin dashboard.

## 💳 Checkout Payments (Paystack)

Checkout starts a Paystack hosted payment session from `/api/order-payment`. The server calculates the amount from the core catalogue, and verifies the returned transaction and amount before marking an order paid or sending the Resend receipt. The Paystack secret stays on the server. Custom products created in browser storage are not eligible for checkout yet.

1. Add `PAYSTACK_SECRET_KEY` to Vercel Environment Variables, starting with a Paystack test secret (`sk_test_…`). Set the same variable in `.env.local` when using `npx vercel dev`.
2. Complete a test checkout, then switch to a live secret key only after confirming your Paystack account and checkout settings.

Payment verification currently returns the paid order to the buyer's browser, where the admin order list is stored. This prototype does not yet have a shared order database or webhook-backed recovery if the customer closes the browser before returning from Paystack.

## 🚀 Running the Project

### Local Development

You can run the project using the Vercel development server or any static HTTP server:

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
- **Owner Operations**: `http://localhost:3000/admin/login` (Passcode: `runaway2026`)

---

## ⚡ Deploying to Vercel

### Method 1: GitHub Integration (Recommended — 1-Click Automated CI/CD)

1. Go to [vercel.com/new](https://vercel.com/new) and log in with your GitHub account.
2. Under **"Import Git Repository"**, select **`Runaway-atelier/Runaway`**.
3. Configure Project Settings:
   - **Framework Preset**: `Other`
   - **Root Directory**: `./` (default)
   - **Build Command**: *(leave empty)*
   - **Output Directory**: `./` (default)
4. Click **Deploy**.

> **Note**: Once linked, every time you run `git push origin main`, Vercel will automatically trigger a new deployment and update your live site within seconds.

### Method 2: Deploy via Vercel CLI

```bash
# First-time deploy (Preview)
npx vercel

# Production deploy
npx vercel --prod
```

