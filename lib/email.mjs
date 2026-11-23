const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char]));
const money = (amount) => `₦${amount.toLocaleString("en-NG")}`;

export function orderMessages(order) {
  const { id: orderId, customer: { name, email, phone, address, city, state }, total } = order;
  const items = order.items.map(item => ({ ...item, quantity: item.qty, color: item.colorName }));
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


  const storeHtml = `<div style="font:15px/1.6 Arial,sans-serif;color:#222"><h1>New RUNAWAY order: ${escapeHtml(orderId)}</h1>
    <p><strong>${escapeHtml(name)}</strong> · ${escapeHtml(email)} · ${escapeHtml(phone)}</p>
    <p>${escapeHtml(address)}<br>${escapeHtml(city)}, ${escapeHtml(state)}</p>
    <table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>
    <p><strong>Total: ${money(total)}</strong></p></div>`;
  const storeText = `New RUNAWAY order ${orderId}\n\n${name} · ${email} · ${phone}\n${deliveryText}\n\n${itemText}\n\nTotal: ${money(total)}`;

  const from = process.env.RESEND_FROM_EMAIL;
  const notifyEmail = process.env.ORDER_NOTIFICATION_EMAIL;
  return [
    { kind: 'customer', payload: { from, to: [email], subject: `Order received — ${orderId}`, html: customerHtml, text: customerText } },
    { kind: 'store', payload: { from, to: [notifyEmail], subject: `New order — ${orderId}`, html: storeHtml, text: storeText } },
  ];
}
