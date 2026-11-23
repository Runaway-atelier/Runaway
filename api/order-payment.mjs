import { randomBytes } from "node:crypto";

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const catalog = {
  "aether-compression-tee": { name: "Aether Compression Tee", price: 148000, sizes: ["S", "M", "L", "XL", "XXL"], colors: { eclipse: "Black", white: "White" } },
  "apex-training-shorts": { name: "Apex Training Shorts", price: 98000, sizes: ["S", "M", "L", "XL", "XXL"], colors: { void: "Black", white: "White" } },
  "velocity-skull-cap": { name: "Velocity Skull Cap", price: 42000, sizes: ["S/M", "L/XL"], colors: { "all-black": "All Black", "black-gold": "Black / Gold", "black-silver": "Black / Silver", midnight: "Midnight" } },
};

const clean = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const verifyPaystack = async (secret, reference) => {
  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}`, "Cache-Control": "no-cache" },
  });
  if (!response.ok) return null;
  const result = await response.json();
  return result?.status && result?.data ? result.data : null;
};

function validateCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) return null;
  const items = [];
  for (const raw of rawItems) {
    const product = catalog[clean(raw?.slug, 80)];
    const qty = Number(raw?.qty);
    const colorId = clean(raw?.color, 40);
    const size = clean(raw?.size, 20);
    if (!product || Number(raw?.price) !== product.price || !Number.isInteger(qty) || qty < 1 || qty > 20 || !product.sizes.includes(size) || !product.colors[colorId]) return null;
    items.push({ slug: raw.slug, name: product.name, price: product.price, qty, size, color: colorId, colorName: product.colors[colorId] });
  }
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return Number.isSafeInteger(total) ? { items, total } : null;
}

export default async function handler(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json(403, { error: "Request not allowed." });
  if (Number(request.headers.get("content-length") || 0) > 30_000) return json(413, { error: "Request is too large." });

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return json(503, { error: "Paystack is not configured yet." });
  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Invalid request." }); }

  if (body?.action === "verify") {
    const reference = clean(body.reference, 100);
    if (!/^runaway-[a-f0-9]{48}$/i.test(reference)) return json(400, { error: "Payment reference is invalid." });
    try {
      const transaction = await verifyPaystack(secret, reference);
      if (!transaction) return json(502, { error: "Could not verify this payment. Please try again." });
      if (transaction.status !== "success") return json(200, { ok: true, paid: false, status: transaction.status || "pending" });
      const metadata = transaction.metadata || {};
      const cart = validateCart(metadata.items);
      const orderId = clean(metadata.order_id, 20).toUpperCase();
      const customer = metadata.customer || {};
      if (!cart || transaction.currency !== "NGN" || Number(transaction.amount) !== cart.total * 100 || !/^RW-[A-Z0-9]{8,12}$/.test(orderId)) {
        return json(400, { error: "Payment details did not match the order. Contact RUNAWAY support." });
      }
      return json(200, {
        ok: true,
        paid: true,
        order: {
          id: orderId,
          date: transaction.paid_at || new Date().toISOString(),
          customer: {
            name: clean(customer.name, 100), email: clean(customer.email, 254).toLowerCase(),
            phone: clean(customer.phone, 40), address: clean(customer.address, 240),
            city: clean(customer.city, 100), state: clean(customer.state, 80),
          },
          items: cart.items.map((item) => ({ ...item, colorName: item.colorName })),
          total: cart.total,
          status: "Pending",
          fulfillmentStatus: "Pending",
          paymentStatus: "Paid",
          paymentReference: reference,
        },
      });
    } catch {
      return json(502, { error: "Could not verify this payment. Please try again." });
    }
  }

  if (body?.action !== "initialize") return json(400, { error: "Payment action is invalid." });
  const customer = body.customer || {};
  const cleanCustomer = {
    name: clean(customer.name, 100), email: clean(customer.email, 254).toLowerCase(),
    phone: clean(customer.phone, 40), address: clean(customer.address, 240),
    city: clean(customer.city, 100), state: clean(customer.state, 80),
  };
  const cart = validateCart(body.items);
  if (!cart || !cleanCustomer.name || !validEmail(cleanCustomer.email) || !cleanCustomer.phone || !cleanCustomer.address || !cleanCustomer.city || !cleanCustomer.state) {
    return json(400, { error: "Checkout supports core RUNAWAY pieces at the current catalogue prices. Refresh the collection and review your bag." });
  }

  const orderId = `RW-${randomBytes(6).toString("hex").toUpperCase()}`;
  const reference = `runaway-${randomBytes(24).toString("hex")}`;
  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Cache-Control": "no-cache" },
      body: JSON.stringify({
        email: cleanCustomer.email,
        amount: String(cart.total * 100),
        currency: "NGN",
        reference,
        callback_url: `${new URL(request.url).origin}/`,
        metadata: { order_id: orderId, customer: cleanCustomer, items: cart.items },
      }),
    });
    const result = await response.json();
    if (!response.ok || !result?.status || !result?.data?.authorization_url) return json(502, { error: "Paystack could not start checkout. Please try again." });
    return json(200, { ok: true, authorizationUrl: result.data.authorization_url, reference, orderId });
  } catch {
    return json(502, { error: "Paystack is unavailable right now. Please try again." });
  }
}
