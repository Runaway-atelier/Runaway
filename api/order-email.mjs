const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const cleanText = (value, max = 180) => typeof value === "string" ? value.trim().slice(0, max) : "";
const money = (amount) => `₦${amount.toLocaleString("en-NG")}`;

async function sendEmail(apiKey, from, to, subject, html, text, idempotencyKey) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  return response.ok;
}

export default async function handler(request) {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json(403, { error: "Request not allowed." });
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 30_000) return json(413, { error: "Request is too large." });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey) return json(503, { error: "Email is not configured yet." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid request." }); }

  if (body?.type === "newsletter") {
    const email = cleanText(body.email, 254).toLowerCase();
    if (cleanText(body.website, 120)) return json(200, { ok: true });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Enter a valid email address." });

    const segmentId = cleanText(process.env.RESEND_NEWSLETTER_SEGMENT_ID, 100);
    const contactBody = { email, unsubscribed: false };
    if (segmentId) contactBody.segments = [{ id: segmentId }];
    try {
      const response = await fetch("https://api.resend.com/contacts", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(contactBody),
      });
      if (!response.ok) return json(502, { error: "We could not add you to the list. Please try again." });
      return json(200, { ok: true });
    } catch {
      return json(502, { error: "We could not add you to the list. Please try again." });
    }
  }
  if (body?.type && body.type !== "order") return json(400, { error: "Request type is invalid." });
  if (!from) return json(503, { error: "Email is not configured yet." });

  const customer = body?.customer || {};
  const name = cleanText(customer.name, 100);
  const email = cleanText(customer.email, 254).toLowerCase();
  const phone = cleanText(customer.phone, 40);
  const address = cleanText(customer.address, 240);
  const city = cleanText(customer.city, 100);
  const state = cleanText(customer.state, 80);
  const orderId = cleanText(body?.id, 20).toUpperCase();
  const rawItems = body?.items;

  if (!/^RW-[A-Z0-9]{4,12}$/.test(orderId) || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone || !address || !city || !state) {
    return json(400, { error: "Order or customer details are incomplete." });
  }
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) return json(400, { error: "Order items are invalid." });

  const items = [];
  for (const item of rawItems) {
    const itemName = cleanText(item?.name, 120);
    const size = cleanText(item?.size, 24);
    const color = cleanText(item?.colorName, 50);
    const quantity = Number(item?.qty);
    const price = Number(item?.price);
    if (!itemName || !size || !Number.isInteger(quantity) || quantity < 1 || quantity > 99 || !Number.isSafeInteger(price) || price < 1 || price > 100_000_000) {
      return json(400, { error: "Order items are invalid." });
    }
    items.push({ name: itemName, size, color, quantity, price });
  }

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (!Number.isSafeInteger(total)) return json(400, { error: "Order total is invalid." });

  const paymentReference = cleanText(body?.paymentReference, 100);
  const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
  if (!paystackSecret || !/^runaway-[a-z0-9-]{12,90}$/i.test(paymentReference)) {
    return json(400, { error: "A verified payment reference is required." });
  }
  try {
    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(paymentReference)}`, {
      headers: { Authorization: `Bearer ${paystackSecret}`, "Cache-Control": "no-cache" },
    });
    const verifyResult = verifyResponse.ok ? await verifyResponse.json() : null;
    const transaction = verifyResult?.data;
    const paidItems = transaction?.metadata?.items;
    const paidCustomer = transaction?.metadata?.customer || {};
    const customerMatches = paidCustomer.name === name && paidCustomer.email?.toLowerCase() === email && paidCustomer.phone === phone && paidCustomer.address === address && paidCustomer.city === city && paidCustomer.state === state;
    const itemsMatch = Array.isArray(paidItems) && paidItems.length === items.length && paidItems.every((paid, index) => {
      const submitted = items[index];
      return paid.slug === rawItems[index]?.slug && paid.name === submitted.name && paid.size === submitted.size && paid.colorName === submitted.color && Number(paid.qty) === submitted.quantity && Number(paid.price) === submitted.price;
    });
    if (!verifyResult?.status || transaction?.status !== "success" || transaction?.currency !== "NGN" || Number(transaction?.amount) !== total * 100 || transaction?.reference !== paymentReference || transaction?.metadata?.order_id !== orderId || !customerMatches || !itemsMatch) {
      return json(403, { error: "This order does not match a verified payment." });
    }
  } catch {
    return json(502, { error: "We could not verify payment before sending the order email." });
  }

  const rows = items.map((item) => `<tr>
    <td style="padding:12px 8px;border-bottom:1px solid #292929">${escapeHtml(item.name)}<br><span style="color:#aaa;font-size:12px">${escapeHtml(item.color)} · ${escapeHtml(item.size)}</span></td>
    <td style="padding:12px 8px;border-bottom:1px solid #292929;text-align:center">${item.quantity}</td>
    <td style="padding:12px 8px;border-bottom:1px solid #292929;text-align:right">${money(item.price * item.quantity)}</td>
  </tr>`).join("");
  const itemText = items.map((item) => `${item.name} — ${item.color}, size ${item.size} × ${item.quantity}: ${money(item.price * item.quantity)}`).join("\n");
  const deliveryHtml = `${escapeHtml(address)}<br>${escapeHtml(city)}, ${escapeHtml(state)}<br>${escapeHtml(phone)}`;
  const deliveryText = `${address}\n${city}, ${state}\n${phone}`;

  const customerHtml = `<div style="margin:0 auto;max-width:620px;padding:32px 24px;background:#101010;color:#f4efe4;font:15px/1.6 Arial,sans-serif">
    <p style="color:#d4b568;letter-spacing:5px;font-size:13px">RUNAWAY</p>
    <h1 style="font-size:27px;font-weight:500">Your order is in motion.</h1>
    <p>Hi ${escapeHtml(name)}, we’ve received your order <strong style="color:#d4b568">${escapeHtml(orderId)}</strong>.</p>
    <table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Piece</th><th>Qty</th><th align="right">Amount</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="text-align:right;font-size:18px">Total <strong style="color:#d4b568">${money(total)}</strong></p>
    <h2 style="font-size:16px">Delivery details</h2><p>${deliveryHtml}</p>
    <p>Our team will follow up with delivery coordination. Keep your order ID handy if you contact us.</p>
    <p style="margin-top:28px;color:#d4b568">Move your own way.</p>
  </div>`;
  const customerText = `RUNAWAY — Your order is in motion.\n\nHi ${name}, we’ve received order ${orderId}.\n\n${itemText}\n\nTotal: ${money(total)}\n\nDelivery details:\n${deliveryText}\n\nOur team will follow up with delivery coordination. Keep your order ID handy if you contact us.`;

  const notifyEmail = cleanText(process.env.ORDER_NOTIFICATION_EMAIL, 254).toLowerCase();
  const storeHtml = `<div style="font:15px/1.6 Arial,sans-serif;color:#222"><h1>New RUNAWAY order: ${escapeHtml(orderId)}</h1>
    <p><strong>${escapeHtml(name)}</strong> · ${escapeHtml(email)} · ${escapeHtml(phone)}</p>
    <p>${escapeHtml(address)}<br>${escapeHtml(city)}, ${escapeHtml(state)}</p>
    <table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>
    <p><strong>Total: ${money(total)}</strong></p></div>`;
  const storeText = `New RUNAWAY order ${orderId}\n\n${name} · ${email} · ${phone}\n${deliveryText}\n\n${itemText}\n\nTotal: ${money(total)}`;

  try {
    const [customerSent, storeSent] = await Promise.all([
      sendEmail(apiKey, from, email, `Order received — ${orderId}`, customerHtml, customerText, `runaway-customer-${orderId}`),
      notifyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifyEmail)
        ? sendEmail(apiKey, from, notifyEmail, `New order — ${orderId}`, storeHtml, storeText, `runaway-store-${orderId}`)
        : Promise.resolve(false),
    ]);
    if (!customerSent) return json(502, { error: "We could not send the confirmation email.", storeEmailSent: storeSent });
    return json(200, { ok: true, customerEmailSent: true, storeEmailSent: storeSent });
  } catch {
    return json(502, { error: "We could not send the confirmation email." });
  }
}
