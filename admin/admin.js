/* ══════════════════════════════════════════════
   RUNAWAY — Owner Dashboard Engine
   ══════════════════════════════════════════════ */
"use strict";

// Validate the server cookie; browser storage may be disabled or empty in a new tab.
const ownerSessionReady = fetch('/api/admin-session', { signal: AbortSignal.timeout(15000) }).then(response => {
  if (response.status === 401 || response.status === 403) { window.location.replace('login.html'); return false; }
  if (!response.ok) throw new Error('Unable to verify your owner session. Refresh to try again.');
  return true;
}).catch(() => {
  const status = document.getElementById('ordersSyncStatus');
  if (status) status.textContent = 'Unable to verify your owner session. Refresh to try again.';
  return false;
});

// 2. Helpers
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

const formatMoney = (amount) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(amount) && amount > 0 ? amount : 0);

const formatDate = (isoStr) => {
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_) {
    return isoStr;
  }
};

const slugify = (text) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");

// 3. State Management
let currentFilter = "all";
let searchQuery = "";
let orders = [];
let customProducts = [];
let deletedSlugs = [];
let currentUploadImage = "../public/images/tee-front.jpg";
let editingProductSnapshot = null;

let catalogueReady = false;
function applySharedCatalogue(data) {
  customProducts = [...data.products, ...data.hiddenProducts];
  deletedSlugs = data.hiddenProducts.map(p => p.slug);
  catalogueReady = true;
  if ($('announceInput')) $('announceInput').value = data.announcement || '';
  if ($('announcePreview')) $('announcePreview').textContent = data.announcement || 'Your announcement will appear here.';
  renderInventory(); renderTopSellers();
}
async function loadSharedCatalogue() { applySharedCatalogue(await ownerFetch('/api/admin-catalog')); }
async function catalogueAction(body) {
  if (!catalogueReady) throw new Error('Wait until the shared catalogue has loaded.');
  const data = await ownerFetch('/api/admin-catalog', { method: 'POST', body: JSON.stringify(body) });
  applySharedCatalogue(data);
}
function productForSave(product) {
  const { image, ...data } = product;
  return { ...data, images: product.images?.length ? product.images : image ? [image] : [] };
}
async function saveCustomProducts(product, expected) {
  try { await catalogueAction({ action: 'save', product: productForSave(product), ...(expected ? { expected } : {}) }); return true; }
  catch (error) { await loadSharedCatalogue().catch(() => {}); alert(error.message); return false; }
}

function getCombinedProducts() {
  const hidden = new Set(deletedSlugs);
  return catalogueReady ? customProducts.filter(p => !hidden.has(p.slug)) : [];
}

async function ownerFetch(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (response.status === 401 || response.status === 403) {
    try { sessionStorage.removeItem('runaway_owner_session'); } catch {}
    window.location.replace('login.html');
  }
  if (!response.ok) throw new Error(data.error || 'Could not load shared orders.');
  return data;
}
async function loadSharedOrders() {
  const data = await ownerFetch('/api/admin-orders');
  orders = data.orders;
  refresh(); renderTopSellers();
  const note = $('ordersSyncStatus');
  if (note) note.textContent = `${data.environment === 'test' ? 'TEST MODE — simulated orders and test stock.' : 'LIVE MODE — real orders and stock.'} Last refreshed ` + new Date().toLocaleTimeString();
}
async function updateSharedOrder(id, changes) {
  const data = await ownerFetch('/api/admin-orders', { method: 'PATCH', body: JSON.stringify({ id, ...changes }) });
  orders = orders.map(order => order.id === id ? data.order : order);
  refresh(); renderTopSellers();
}

// 4. Render Metrics
function renderMetrics() {
  const totalRevenueEl = $("statRevenue");
  const totalOrdersEl = $("statOrders");
  const aovEl = $("statAOV");
  const pendingOrdersEl = $("statPending");

  const validOrders = orders.filter((o) => o.status !== "Cancelled" && o.paymentStatus === "Paid");
  const totalRevenue = validOrders.reduce((sum, o) => sum + (o.total || 0), 0);
  const totalCount = orders.length;
  const aov = validOrders.length > 0 ? Math.round(totalRevenue / validOrders.length) : 0;
  const pendingCount = orders.filter((o) => o.status === "Pending").length;

  if (totalRevenueEl) totalRevenueEl.textContent = formatMoney(totalRevenue);
  if (totalOrdersEl) totalOrdersEl.textContent = totalCount;
  if (aovEl) aovEl.textContent = formatMoney(aov);
  if (pendingOrdersEl) pendingOrdersEl.textContent = pendingCount;
}

// 5. Render Orders Table (with live search & status tabs)
function renderOrders() {
  const tbody = $("ordersTableBody");
  if (!tbody) return;

  const query = searchQuery.trim().toLowerCase();

  const filtered = orders.filter((o) => {
    // 1. Status Filter
    if (currentFilter !== "all" && (o.status || "").toLowerCase() !== currentFilter.toLowerCase()) {
      return false;
    }
    // 2. Search Query Filter
    if (query) {
      const matchId = (o.id || "").toLowerCase().includes(query);
      const matchName = (o.customer?.name || "").toLowerCase().includes(query);
      const matchEmail = (o.customer?.email || "").toLowerCase().includes(query);
      const matchItems = (o.items || []).some((it) => (it.name || "").toLowerCase().includes(query));
      if (!matchId && !matchName && !matchEmail && !matchItems) {
        return false;
      }
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="table-empty">
            <p class="muted">No orders found matching criteria${query ? ` for "${escapeHtml(query)}"` : ""}.</p>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((o) => {
    const statusClass = (o.status || "Pending").toLowerCase();
    const itemsSummary = (o.items || [])
      .map((it) => `${Number(it.qty)}x ${escapeHtml(it.name)} (${escapeHtml(it.size || "M")}${it.colorName ? " · " + escapeHtml(it.colorName) : ""})`)
      .join("<br />");

    const toggleActionText = o.status === "Fulfilled" ? "Mark Pending" : "Mark Fulfilled";
    const toggleTargetStatus = o.status === "Fulfilled" ? "Pending" : "Fulfilled";

    return `
      <tr>
        <td>
          <button class="order-link" data-action="view-slip" data-id="${o.id}" title="View order packing slip">
            ${o.id}
          </button>
        </td>
        <td>
          <div style="font-weight: 500;">${escapeHtml(o.customer?.name || "Anonymous Runner")}</div>
          <div class="subtle" style="font-size: .75rem;">${escapeHtml(o.customer?.email || "—")}</div>
        </td>
        <td style="font-size: .8rem; line-height: 1.4;">${itemsSummary || "—"}</td>
        <td class="tabular"><strong class="gold">${formatMoney(o.total)}</strong></td>
        <td class="subtle tabular" style="font-size: .78rem;">${formatDate(o.date)}</td>
        <td>
          <span class="badge badge-${statusClass}">${o.status || "Pending"}</span>
          <small class="order-status-meta">${o.paymentStatus || "Unpaid"} · ${o.fulfillmentStatus || (o.status === "Fulfilled" ? "Shipped" : o.status || "Pending")}</small>
        </td>
        <td>
          <div class="actions-cell">
            <button class="btn btn-ghost btn-sm" data-action="view-slip" data-id="${o.id}" title="View Slip">
              <span>Slip</span>
            </button>
            <button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${o.id}" data-target="${toggleTargetStatus}">
              <span>${toggleActionText}</span>
            </button>
          </div>
        </td>
      </tr>`;
  }).join("");
}

function getAdminStorefrontUrl(p) {
  if (p.file?.startsWith('/') && !p.file.startsWith('//')) return p.file;
  if (p.file) {
    // Normalize relative prefix so it always points exactly 1 level up from admin/
    const clean = p.file.replace(/^(\.\.\/|\.\/)/, "");
    return `../${clean}`;
  }
  return `../products/product.html?slug=${encodeURIComponent(p.slug)}`;
}

// 6. Render Inventory Overview (Core + Custom Uploaded Pieces)
function renderInventory() {
  const container = $("inventoryGrid");
  if (!container) return;

  const allPieces = getCombinedProducts();

  if (allPieces.length === 0) {
    container.innerHTML = `<p class="muted" style="padding: 1.5rem;">No catalogue pieces found.</p>`;
    return;
  }

  container.innerHTML = allPieces.map((p) => {
    let mainImg = p.image || (p.images && p.images[0]) || "../public/images/logo-runners.png";
    if (typeof mainImg === "string" && !mainImg.startsWith("data:") && !mainImg.startsWith("http") && !mainImg.startsWith("..") && !mainImg.startsWith("/")) {
      mainImg = `../public/images/${mainImg}`;
    }

    const colorsList = (p.colors || []).map((c) => c.name).join(", ") || "Single colorway";
    const sizesList = (p.sizes || []).join(" · ") || "All sizes";
    const isCustom = Boolean(p.isCustom);
    const storefrontUrl = getAdminStorefrontUrl(p);
    const stockTracked = p.stock !== undefined && p.stock !== null && Number.isFinite(Number(p.stock));
    const stockCount = stockTracked ? Number(p.stock) : null;

    return `
      <div class="inv-card">
        <img class="inv-img" src="${mainImg}" alt="${p.name}" />
        <div class="inv-info">
          ${isCustom ? '<span class="inv-badge-custom">Custom Piece</span>' : '<span class="inv-badge-core">Core Piece</span>'}
          <span class="inv-cat">${p.category}</span>
          <h4 class="inv-name">${p.name}</h4>
          <span class="inv-price tabular">${formatMoney(p.price)}</span>
          <p class="inventory-stock ${stockTracked && stockCount <= Number(p.lowStockThreshold ?? 3) ? "is-low" : ""}">${stockTracked ? stockCount < 0 ? `${Math.abs(stockCount)} short · Reconcile paid orders` : `${stockCount} available${stockCount <= Number(p.lowStockThreshold ?? 3) ? " · Low stock" : ""}` : "Stock not set"}</p>
          <p class="subtle inventory-sku">SKU: ${escapeHtml(p.sku || "Not set")}</p>
          <p class="subtle" style="font-size: .72rem; margin-top: .3rem;">${sizesList}</p>
          <p class="subtle" style="font-size: .72rem;">Colors: ${colorsList}</p>
          <div class="inv-actions">
            <button class="btn btn-ghost btn-sm" data-action="preview-piece" data-slug="${p.slug}" title="Inspect piece specifications">
              <span>Preview</span>
            </button>
            <button class="btn btn-ghost btn-sm btn-edit" data-action="edit-piece" data-slug="${p.slug}" title="Edit piece specifications & price">
              <span>Edit ✏️</span>
            </button>
            <a href="${storefrontUrl}" target="_blank" class="btn btn-ghost btn-sm" title="Open customer page">
              <span>Storefront ↗</span>
            </a>
            <button class="btn btn-danger btn-sm" data-action="delete-piece" data-slug="${p.slug}" title="Remove piece from catalogue">
              <span>Delete ✕</span>
            </button>
          </div>
        </div>
      </div>`;
  }).join("");
}

// 7. Render Top Selling Pieces (Analytics)
function renderTopSellers() {
  const container = $("topSellersGrid");
  if (!container) return;

  const validOrders = orders.filter((o) => o.status !== "Cancelled" && o.paymentStatus === "Paid");
  const salesMap = {};

  validOrders.forEach((o) => {
    (o.items || []).forEach((it) => {
      const name = it.name || "Unknown Item";
      if (!salesMap[name]) {
        salesMap[name] = { name, units: 0, revenue: 0, sampleImg: null };
      }
      salesMap[name].units += (it.qty || 1);
      salesMap[name].revenue += ((it.price || 0) * (it.qty || 1));
    });
  });

  const ranked = Object.values(salesMap).sort((a, b) => b.units - a.units || b.revenue - a.revenue);

  if (ranked.length === 0) {
    container.innerHTML = '<p class="muted analytics-empty">No sales recorded yet. Products will appear here after orders come in.</p>';
    return;
  }

  // Find image for ranked pieces from catalogue
  const allPieces = getCombinedProducts();
  container.innerHTML = ranked.slice(0, 4).map((item, idx) => {
    const matched = allPieces.find((p) => p.name.toLowerCase() === item.name.toLowerCase());
    let mainImg = matched ? (matched.image || (matched.images && matched.images[0])) : "../public/images/logo-runners.png";
    if (typeof mainImg === "string" && !mainImg.startsWith("data:") && !mainImg.startsWith("http") && !mainImg.startsWith("..") && !mainImg.startsWith("/")) {
      mainImg = `../public/images/${mainImg}`;
    }

    return `
      <div class="seller-card">
        <span class="seller-rank">#${idx + 1}</span>
        <img class="seller-img" src="${mainImg}" alt="${item.name}" />
        <div class="seller-info">
          <h4 class="seller-name">${item.name}</h4>
          <span class="seller-stat">${item.units} units sold</span>
          <span class="seller-rev tabular">${formatMoney(item.revenue)}</span>
        </div>
      </div>`;
  }).join("");
}

// 8. Order Packing Slip Modal
function openOrderDetail(orderId) {
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;

  const modal = $("orderDetailModal");
  const slipId = $("slipOrderId");
  const slipDate = $("slipDate");
  const slipBody = $("slipBody");

  if (!modal || !slipBody) return;

  slipId.textContent = `Packing Slip — ${order.id}`;
  slipDate.textContent = `Placed on ${formatDate(order.date)}`;

  const itemsRows = (order.items || []).map((it) => {
    const lineTotal = (it.price || 0) * (it.qty || 1);
    return `
      <tr>
        <td>
          <strong>${escapeHtml(it.name)}</strong>
          <div class="subtle" style="font-size: .72rem;">${it.colorName ? escapeHtml(it.colorName) + " · " : ""}Size: ${escapeHtml(it.size || "M")}</div>
        </td>
        <td style="text-align: center;">${it.qty || 1}</td>
        <td class="tabular" style="text-align: right;">${formatMoney(it.price)}</td>
        <td class="tabular gold" style="text-align: right;">${formatMoney(lineTotal)}</td>
      </tr>`;
  }).join("");

  order.paymentStatus ||= "Unpaid";
  order.fulfillmentStatus ||= order.status === "Fulfilled" ? "Shipped" : order.status || "Pending";

  slipBody.innerHTML = `
    <div class="slip-meta-grid" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
      <div>
        <span class="slip-field-label">Customer Details</span>
        <div class="slip-field-val">${escapeHtml(order.customer?.name || "Anonymous Runner")}</div>
        <div class="subtle" style="font-size: .75rem;">${escapeHtml(order.customer?.email || "—")}</div>
        <div class="subtle" style="font-size: .75rem; margin-top: .2rem;">Phone: ${escapeHtml(order.customer?.phone || "No phone provided")}</div>
      </div>
      <div>
        <span class="slip-field-label">Delivery Coordinates</span>
        <div class="slip-field-val" style="font-size:.85rem;line-height:1.35;">${escapeHtml(order.customer?.address || "Address on file")}</div>
        <div class="subtle" style="font-size: .75rem; margin-top: .2rem;">${order.customer?.city ? escapeHtml(order.customer.city) + ", " : ""}${escapeHtml(order.customer?.state || "Lagos, Nigeria")}</div>
      </div>
      <div>
        <span class="slip-field-label">Dispatch Status</span>
        <div class="slip-field-val">
          <span class="badge badge-${(order.status || "Pending").toLowerCase()}">${order.fulfillmentStatus}</span>
        </div>
        <div class="order-operations-grid">
          <label>Payment
            <select disabled aria-label="Verified payment status" data-order-field="paymentStatus" data-order-id="${order.id}">
              ${["Unpaid", "Paid", "Refunded"].map((status) => `<option ${((order.paymentStatus || "Unpaid") === status) ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </label>
          <label>Fulfillment
            <select data-order-field="fulfillmentStatus" data-order-id="${order.id}">
              ${["Pending", "Packing", "Shipped", "Delivered", "Cancelled"].map((status) => `<option ${((order.fulfillmentStatus || (order.status === "Fulfilled" ? "Shipped" : order.status || "Pending")) === status) ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </label>
          <label>Carrier<input data-order-field="carrier" data-order-id="${escapeHtml(order.id)}" value="${escapeHtml(order.carrier || "")}" placeholder="Courier" /></label>
          <label>Tracking number<input data-order-field="trackingNumber" data-order-id="${escapeHtml(order.id)}" value="${escapeHtml(order.trackingNumber || "")}" placeholder="Tracking reference" /></label>
        </div>
      </div>
    </div>

    <div>
      <h4 style="font-size: .85rem; letter-spacing: .12em; text-transform: uppercase; margin-bottom: .6rem; color: var(--gold);">
        Dispatched Pieces
      </h4>
      <table class="slip-items-table">
        <thead>
          <tr>
            <th>Piece Description</th>
            <th style="text-align: center;">Qty</th>
            <th style="text-align: right;">Unit Price</th>
            <th style="text-align: right;">Line Total</th>
          </tr>
        </thead>
        <tbody>
          ${itemsRows}
        </tbody>
      </table>
    </div>

    <div class="slip-total-box">
      <span class="slip-sub">Nationwide Courier Delivery: <strong class="gold">FREE (₦0)</strong></span>
      <span class="slip-sub">Total Dispatched Value</span>
      <span class="slip-grand tabular">${formatMoney(order.total)}</span>
    </div>
  `;

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeOrderDetail() {
  const modal = $("orderDetailModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

// 8b. Piece Preview Modal (In-Dashboard Inspection)
function openPiecePreview(slug) {
  const p = getCombinedProducts().find((item) => item.slug === slug);
  if (!p) return;

  const modal = $("viewPieceModal");
  const vpName = $("vpName");
  const vpCategory = $("vpCategory");
  const vpLink = $("vpStorefrontLink");
  const vpBody = $("vpBody");

  if (!modal || !vpBody) return;

  const storefrontUrl = getAdminStorefrontUrl(p);

  if (vpName) vpName.textContent = p.name;
  if (vpCategory) vpCategory.textContent = `${p.category} · ${p.isCustom ? "Custom Activewear Piece" : "Core Collection"}`;
  if (vpLink) vpLink.href = storefrontUrl;

  const images = Array.isArray(p.images) && p.images.length ? p.images : [p.image || "logo-runners.png"];

  const resolvePieceImg = (src) => {
    if (!src) return "../public/images/logo-runners.png";
    if (src.startsWith("data:") || src.startsWith("http") || src.startsWith("/") || src.startsWith("..")) return src;
    return `../public/images/${src}`;
  };

  const colors = Array.isArray(p.colors) && p.colors.length ? p.colors : [{ name: "Core", hex: "#0c0c0c" }];
  const sizes = Array.isArray(p.sizes) && p.sizes.length ? p.sizes : ["S", "M", "L"];

  const thumbButtons = images.length > 1 ? `
    <div class="piece-thumb-strip" id="vpThumbs">
      ${images.map((img, i) => `
        <button type="button" class="piece-thumb-btn ${i === 0 ? 'active' : ''}" data-idx="${i}">
          <img src="${resolvePieceImg(img)}" alt="" />
        </button>
      `).join("")}
    </div>` : '';

  vpBody.innerHTML = `
    <div class="piece-preview-grid">
      <div class="piece-preview-media">
        <img id="vpMainImg" src="${resolvePieceImg(images[0])}" alt="${p.name}" />
        ${thumbButtons}
      </div>

      <div class="piece-preview-info">
        <div>
          <span class="subtle" style="font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;">${p.tagline || ""}</span>
          <div style="margin-top:.4rem;display:flex;align-items:baseline;justify-content:space-between;">
            <span class="gold tabular" style="font-size:1.6rem;font-family:var(--display);">${formatMoney(p.price)}</span>
            ${p.isCustom ? '<span class="inv-badge-custom">Custom Piece</span>' : '<span class="subtle" style="font-size:.72rem;">Core Piece</span>'}
          </div>
        </div>

        <p class="muted" style="font-size:.84rem;line-height:1.5;">${p.description || p.story || "Engineered for high-heat, high-speed endurance."}</p>

        <div>
          <span class="form-label">Available Colorways</span>
          <div class="piece-colors-row">
            ${colors.map((c) => `
              <span class="piece-color-chip">
                <span class="piece-color-dot" style="background:${c.hex || c.swatch || '#0c0c0c'};"></span>
                ${c.name}
              </span>
            `).join("")}
          </div>
        </div>

        <div>
          <span class="form-label">Sizing</span>
          <div class="piece-sizes-row">
            ${sizes.map((s) => `<span class="piece-size-pill">${s}</span>`).join("")}
          </div>
        </div>

        <div class="piece-preview-specs">
          <div class="spec-item">
            <dt>Fabric Blend</dt>
            <dd>${p.fabric || p.specs?.fabric || "4-way technical stretch woven"}</dd>
          </div>
          <div class="spec-item">
            <dt>Tailored Fit</dt>
            <dd>${p.fit || p.specs?.fit || "Athletic compression"}</dd>
          </div>
          <div class="spec-item">
            <dt>Origin</dt>
            <dd>${p.specs?.origin || "Crafted in Nigeria"}</dd>
          </div>
          <div class="spec-item">
            <dt>Care</dt>
            <dd>${p.specs?.care || "Cold wash, hang dry"}</dd>
          </div>
        </div>

        <div class="piece-modal-actions">
          <button class="btn btn-gold btn-sm" data-action="edit-piece" data-slug="${p.slug}" title="Edit this piece">
            <span>Edit Piece ✏️</span>
          </button>
          <a href="${storefrontUrl}" target="_blank" class="btn btn-ghost btn-sm" title="View customer product page">
            <span>View Full PDP ↗</span>
          </a>
          <button class="btn btn-danger btn-sm" data-action="delete-piece" data-slug="${p.slug}" title="Remove piece from catalogue">
            <span>Delete Piece ✕</span>
          </button>
        </div>
      </div>
    </div>
  `;

  // Wire thumbnail switching
  vpBody.querySelectorAll(".piece-thumb-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      vpBody.querySelectorAll(".piece-thumb-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const idx = +btn.dataset.idx;
      const mainEl = $("vpMainImg");
      if (mainEl && images[idx]) {
        mainEl.src = resolvePieceImg(images[idx]);
      }
    });
  });

  // Wire edit action inside preview modal
  const editBtn = vpBody.querySelector('[data-action="edit-piece"]');
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      openEditProduct(p.slug);
    });
  }

  // Wire delete action inside preview modal
  const delBtn = vpBody.querySelector('[data-action="delete-piece"]');
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      deleteProduct(p.slug);
    });
  }

  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closePiecePreview() {
  const modal = $("viewPieceModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

// 9. CSV Export Feature
function csvCell(value) {
  let text = String(value ?? '');
  // Keep formula-like input as text when this human-facing export is opened in Excel.
  if (/^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(text) || /^[\t\r\n]/.test(text)) text = '\t' + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function exportOrdersToCSV() {
  if (orders.length === 0) {
    alert("No orders available to export.");
    return;
  }

  const headers = ["Order ID", "Date", "Customer Name", "Customer Email", "Customer Phone", "Street Address", "City", "State", "Fulfillment", "Payment", "Carrier", "Tracking Number", "Total NGN", "Items Count", "Items Detail"];
  const rows = orders.map((o) => {
    const itemsDetail = (o.items || [])
      .map((it) => `${it.qty}x ${it.name} (${it.size || "M"}${it.colorName ? " " + it.colorName : ""})`)
      .join("; ");

    return [
      o.id || '', o.date || '', o.customer?.name || '', o.customer?.email || '',
      o.customer?.phone || '', o.customer?.address || '', o.customer?.city || '', o.customer?.state || '',
      o.fulfillmentStatus || (o.status === 'Fulfilled' ? 'Shipped' : o.status || 'Pending'),
      o.paymentStatus || 'Unpaid', o.carrier || '', o.trackingNumber || '', o.total || 0,
      (o.items || []).length, itemsDetail,
    ].map(csvCell).join(",");
  });

  const csvContent = [headers.map(csvCell).join(","), ...rows].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().slice(0, 10);
  link.setAttribute("href", url);
  link.setAttribute("download", `runaway_orders_${timestamp}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// 10. Product CRUD Operations (Upload, Edit, Delete)
async function deleteProduct(slug) {
  const all = getCombinedProducts();
  const p = all.find((item) => item.slug === slug) || 
    (typeof PRODUCTS !== "undefined" ? PRODUCTS.find((item) => item.slug === slug) : null) ||
    customProducts.find((item) => item.slug === slug);
  const name = p ? p.name : slug;

  if (!confirm(`Are you sure you want to remove "${name}" from your catalogue?`)) {
    return;
  }

  try { await catalogueAction({ action: 'hide', slug }); }
  catch (error) { alert(error.message); return; }

  closePiecePreview();
  renderInventory();
  renderTopSellers();
}

async function restoreCoreCatalogue() {
  if (deletedSlugs.length === 0) {
    alert("Core catalogue is already intact. No hidden pieces to restore.");
    return;
  }
  if (!confirm(`Restore ${deletedSlugs.length} hidden catalogue piece(s) back to your storefront inventory?`)) {
    return;
  }
  try { for (const slug of [...deletedSlugs]) await catalogueAction({ action: 'restore', slug }); }
  catch (error) { alert(error.message); return; }
  renderInventory();
  renderTopSellers();
  alert("Core catalogue restored! All standard collection pieces are now visible.");
}

function renderProductSizes(selected = ['S', 'M', 'L']) {
  const container = $('productSizes');
  if (!container) return;
  const sizes = [...new Set(['XS', 'S', 'M', 'L', 'XL', 'XXL', 'S/M', 'L/XL', ...selected])];
  container.innerHTML = sizes.map(size => `<label><input type="checkbox" name="sizes" value="${escapeHtml(size)}" ${selected.includes(size) ? 'checked' : ''} /> ${escapeHtml(size)}</label>`).join('');
}
function openEditProduct(slug) {
  const p = getCombinedProducts().find((item) => item.slug === slug);
  if (!p) return;
  editingProductSnapshot = { updatedAt: p.updatedAt, stock: p.stock ?? null };

  closePiecePreview();

  const modal = $("productModal");
  const modalTitle = $("productModalTitle");
  const modalSub = $("productModalSub");
  const saveBtn = $("saveProductBtn");
  const pEditingSlug = $("pEditingSlug");
  const imgPreview = $("imgPreview");
  const previewLabel = $("previewLabel");

  if (modalTitle) modalTitle.textContent = "Edit Collection Piece";
  if (modalSub) modalSub.textContent = `Modify specifications, pricing, and imagery for "${p.name}".`;
  if (saveBtn) {
    const span = saveBtn.querySelector("span");
    if (span) span.textContent = "Save Changes";
  }
  if (pEditingSlug) pEditingSlug.value = p.slug;

  if ($("pName")) $("pName").value = p.name || "";
  if ($("pCategory")) $("pCategory").value = p.category || "Tops";
  if ($("pPrice")) $("pPrice").value = p.price || "";
  if ($("pSku")) $("pSku").value = p.sku || "";
  if ($("pStock")) $("pStock").value = p.stock == null ? '' : Math.max(0, Number(p.stock));
  if ($("pLowStock")) $("pLowStock").value = Number(p.lowStockThreshold ?? 3);
  if ($("pTagline")) $("pTagline").value = p.tagline || "";
  if ($("pDesc")) $("pDesc").value = p.description || p.story || "";

  // Colorway
  const firstColor = (p.colors && p.colors[0]) || { name: "Eclipse", hex: "#0c0c0c", swatch: "#0c0c0c" };
  const colorName = firstColor.name || "Eclipse";
  const colorHex = firstColor.hex || firstColor.swatch || "#0c0c0c";
  if ($("pColorName")) $("pColorName").value = colorName;
  if ($("pColorHex")) $("pColorHex").value = colorHex;
  if ($("pColorHexText")) $("pColorHexText").value = colorHex;

  // Sizes
  renderProductSizes(p.sizes || []);

  // Specs
  if ($("pFabric")) $("pFabric").value = p.fabric || p.specs?.fabric || "";
  if ($("pFit")) $("pFit").value = p.fit || p.specs?.fit || "";

  // Media
  const currentImg = p.image || (p.images && p.images[0]) || "../public/images/tee-front.jpg";
  currentUploadImage = currentImg;
  const resolvePieceImg = (src) => {
    if (!src) return "../public/images/logo-runners.png";
    if (src.startsWith("data:") || src.startsWith("http") || src.startsWith("/") || src.startsWith("..")) return src;
    return `../public/images/${src}`;
  };
  if (imgPreview) imgPreview.src = resolvePieceImg(currentImg);
  if (previewLabel) previewLabel.textContent = "Current Image";
  document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));

  if (modal) {
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }
}

function resetProductFormForCreate() {
  editingProductSnapshot = null;
  const form = $("productForm");
  const modalTitle = $("productModalTitle");
  const modalSub = $("productModalSub");
  const saveBtn = $("saveProductBtn");
  const pEditingSlug = $("pEditingSlug");
  const imgPreview = $("imgPreview");
  const previewLabel = $("previewLabel");

  if (form) form.reset();
  if (pEditingSlug) pEditingSlug.value = "";
  if (modalTitle) modalTitle.textContent = "Upload Collection Piece";
  if (modalSub) modalSub.textContent = "Publish a new performance piece to the storefront catalogue.";
  if (saveBtn) {
    const span = saveBtn.querySelector("span");
    if (span) span.textContent = "Publish Piece ↗";
  }

  currentUploadImage = "../public/images/tee-front.jpg";
  if (imgPreview) imgPreview.src = currentUploadImage;
  if (previewLabel) previewLabel.textContent = "Default Preview";
  document.querySelectorAll(".preset-btn").forEach((b, i) => b.classList.toggle("active", i === 0));

  // Reset checkboxes to default S, M, L
  renderProductSizes();
}

function openProductModal() {
  resetProductFormForCreate();
  const modal = $("productModal");
  if (!modal) return;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");
}

function closeProductModal() {
  const modal = $("productModal");
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.setAttribute("aria-hidden", "true");
}

function setupProductUpload() {
  const dropZone = $("dropZone");
  const fileInput = $("pieceImgFile");
  const imgPreview = $("imgPreview");
  const previewLabel = $("previewLabel");
  const productForm = $("productForm");
  const colorHex = $("pColorHex");
  const colorHexText = $("pColorHexText");

  // Sync color pickers
  if (colorHex && colorHexText) {
    colorHex.addEventListener("input", (e) => {
      colorHexText.value = e.target.value;
    });
    colorHexText.addEventListener("input", (e) => {
      if (/^#[0-9A-Fa-f]{6}$/.test(e.target.value)) {
        colorHex.value = e.target.value;
      }
    });
  }

  // Presets click
  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const presetFile = btn.dataset.preset;
      currentUploadImage = `../public/images/${presetFile}`;
      if (imgPreview) imgPreview.src = currentUploadImage;
      if (previewLabel) previewLabel.textContent = `Preset: ${btn.textContent}`;
    });
  });

  // Dropzone file handling
  if (dropZone && fileInput) {
    dropZone.addEventListener("click", () => fileInput.click());

    dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropZone.classList.add("is-dragover");
    });

    ["dragleave", "dragend"].forEach((evt) => {
      dropZone.addEventListener(evt, () => dropZone.classList.remove("is-dragover"));
    });

    dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropZone.classList.remove("is-dragover");
      if (e.dataTransfer?.files?.[0]) {
        processUploadedImage(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target?.files?.[0]) {
        processUploadedImage(e.target.files[0]);
      }
    });
  }

  function processUploadedImage(file) {
    if (file.size > 1000000) { alert('Use an image smaller than 1 MB.'); return; }
    if (!file.type.startsWith("image/")) {
      alert("Please upload a valid image file (PNG, JPG, WebP).");
      return;
    }
    const reader = new FileReader();
    reader.onload = (evt) => {
      currentUploadImage = evt.target.result;
      if (imgPreview) imgPreview.src = currentUploadImage;
      if (previewLabel) previewLabel.textContent = file.name;
      document.querySelectorAll(".preset-btn").forEach((b) => b.classList.remove("active"));
    };
    reader.readAsDataURL(file);
  }

  // Form submit (Handles both Create and Edit)
  if (productForm) {
    productForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!catalogueReady) { alert('The shared catalogue is not available yet.'); return; }

      const editingSlug = $("pEditingSlug")?.value?.trim();
      const name = $("pName")?.value?.trim();
      const category = $("pCategory")?.value;
      const price = Number($("pPrice")?.value);
      const sku = $("pSku")?.value?.trim().toUpperCase() || "";
      const stockValue = $('pStock')?.value?.trim() || '';
      const stock = stockValue === '' ? null : Math.max(0, Number.parseInt(stockValue, 10) || 0);
      const lowStockThreshold = Math.max(0, Number.parseInt($("pLowStock")?.value || "3", 10) || 0);
      const tagline = $("pTagline")?.value?.trim();
      const desc = $("pDesc")?.value?.trim();
      const colorName = $("pColorName")?.value?.trim() || "Eclipse";
      const colorHexVal = $("pColorHex")?.value || "#0c0c0c";
      const fabric = $("pFabric")?.value?.trim();
      const fit = $("pFit")?.value?.trim();

      // Gather sizes
      const checkedSizes = Array.from(document.querySelectorAll('input[name="sizes"]:checked'))
        .map((el) => el.value);

      if (!name || !price) {
        alert("Please provide piece name and price.");
        return;
      }
      if (!checkedSizes.length) { alert('Choose at least one available size.'); return; }

      if (editingSlug) {
        // ── EDIT MODE ──
        let target = customProducts.find((p) => p.slug === editingSlug);
        if (!target) {
          // Editing a core product: instantiate an override custom piece with same slug
          const baseCore = typeof PRODUCTS !== "undefined" ? PRODUCTS.find((p) => p.slug === editingSlug) : null;
          target = {
            id: `override-${Date.now()}`,
            slug: editingSlug,
            file: baseCore?.file,
            createdAt: new Date().toISOString()
          };
          customProducts.unshift(target);
        }

        target.name = name;
        target.category = category || "Tops";
        target.price = price;
        target.sku = sku;
        target.stock = stock;
        target.lowStockThreshold = lowStockThreshold;
        target.tagline = tagline || target.tagline || "Engineered Performance Kit Piece";
        target.description = desc || target.description || "Engineered stretch fabric cut for high-heat, high-speed night runs.";
        delete target.image;
        target.images = [currentUploadImage, ...(target.images || []).slice(1)];
        target.colors = [{ ...(target.colors?.[0] || {}), id: target.colors?.[0]?.id || slugify(colorName), name: colorName, swatch: colorHexVal }, ...(target.colors || []).slice(1)];
        target.sizes = checkedSizes;
        target.fabric = fabric || target.fabric || "4-way technical stretch woven shell";
        target.fit = fit || target.fit || "Athletic tailored cut. True to size.";
        target.details = [
          target.fabric,
          target.fit,
          "Moisture-wicking yarn with quick-dry finish",
          "Signature gold reflective accents"
        ];
        target.specs = {
          fabric: target.fabric,
          fit: target.fit,
          origin: target.specs?.origin || "Crafted in Nigeria",
          care: target.specs?.care || "Machine wash cold 30°C. Do not tumble dry."
        };
        target.isCustom = true;
        if (!await saveCustomProducts(target, editingProductSnapshot)) return;
        closeProductModal();
        renderInventory();
        renderTopSellers();

        alert(`"${name}" updated successfully!`);
      } else {
        // ── CREATE MODE ──
        const slug = `${slugify(name)}-${Date.now().toString().slice(-4)}`;

        const newPiece = {
          id: `custom-${Date.now()}`,
          slug,
          name,
          category: category || "Tops",
          price,
          sku,
          stock,
          lowStockThreshold,
          tagline: tagline || "Engineered Performance Kit Piece",
          description: desc || "Engineered stretch fabric cut for high-heat, high-speed night runs.",
          images: [currentUploadImage],
          colors: [{ id: slugify(colorName), name: colorName, swatch: colorHexVal }],
          sizes: checkedSizes,
          details: [
            fabric || "4-way technical stretch woven shell",
            fit || "Athletic tailored cut. True to size.",
            "Moisture-wicking yarn with quick-dry finish",
            "Signature gold reflective accents"
          ],
          specs: {
            fabric: fabric || "Technical stretch nylon/elastane",
            fit: fit || "Athletic tailored fit",
            origin: "Crafted in Nigeria",
            care: "Machine wash cold 30°C. Do not tumble dry."
          },
          isCustom: true,
          createdAt: new Date().toISOString()
        };

        customProducts.unshift(newPiece);
        if (!await saveCustomProducts(newPiece)) return;

        closeProductModal();
        renderInventory();
        renderTopSellers();

        alert(`"${name}" has been published to the storefront catalogue!`);
      }
    });
  }

  // Modal close buttons
  $("openUploadBtn")?.addEventListener("click", openProductModal);
  $("closeProductBtn")?.addEventListener("click", closeProductModal);
  $("closeProductBackdrop")?.addEventListener("click", closeProductModal);
  $("cancelProductBtn")?.addEventListener("click", closeProductModal);

  // Packing slip close buttons & print
  $("closeDetailBtn")?.addEventListener("click", closeOrderDetail);
  $("closeDetailBackdrop")?.addEventListener("click", closeOrderDetail);
  $("printSlipBtn")?.addEventListener("click", () => window.print());

  // Piece preview close buttons
  $("closeViewPieceBtn")?.addEventListener("click", closePiecePreview);
  $("closeViewPieceBackdrop")?.addEventListener("click", closePiecePreview);

  // Keyboard escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeProductModal();
      closeOrderDetail();
      closePiecePreview();
    }
  });
}

// 11. Announcement Banner Controller
function setupAnnouncementControl() {
  const form = $("announceForm");
  const input = $("announceInput");
  const status = $("announceStatus");
  const clearBtn = $("clearAnnounceBtn");
  const preview = $("announcePreview");

  if (!form || !input) return;

  const updatePreview = () => {
    if (preview) preview.textContent = input.value.trim() || "Your announcement will appear here.";
  };
  input.addEventListener("input", updatePreview);
  updatePreview();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = input.value.trim();
    if (val) {
      try { await catalogueAction({ action: 'announcement', value: val }); }
      catch (error) { if (status) status.textContent = error.message; return; }
      updatePreview();
      if (status) {
        status.textContent = "Storefront marquee banner updated successfully.";
        setTimeout(() => { if (status) status.textContent = ""; }, 3000);
      }
    }
  });

  clearBtn?.addEventListener("click", async () => {
    try { await catalogueAction({ action: 'announcement', value: '' }); }
    catch (error) { if (status) status.textContent = error.message; return; }
    input.value = "";
    updatePreview();
    if (status) {
      status.textContent = "Reset to default storefront announcement.";
      setTimeout(() => { if (status) status.textContent = ""; }, 3000);
    }
  });
}

// 13. Event Delegation & Listeners
function setupEvents() {
  // Instant tactile feedback on pointer-down
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".btn, button, .tab-btn");
    if (btn) {
      btn.classList.add("is-pressed");
      const clean = () => {
        btn.classList.remove("is-pressed");
        window.removeEventListener("pointerup", clean);
        window.removeEventListener("pointercancel", clean);
      };
      window.addEventListener("pointerup", clean, { once: true });
      window.addEventListener("pointercancel", clean, { once: true });
    }
  }, { passive: true });

  // Filter tabs
  document.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-filter]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      renderOrders();
    });
  });

  // Search input live filtering
  $("orderSearch")?.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderOrders();
  });

  // Export CSV
  $("exportCsvBtn")?.addEventListener("click", exportOrdersToCSV);

  $("slipBody")?.addEventListener("change", async (e) => {
    const field = e.target.closest("[data-order-field]");
    if (!field) return;
    const order = orders.find((item) => item.id === field.dataset.orderId);
    if (!order) return;
    const key = field.dataset.orderField;
    field.disabled = true;
    try { await updateSharedOrder(order.id, { [key]: field.value.trim() }); }
    catch (error) { alert(error.message); }
    openOrderDetail(order.id);
  });

  // Table action clicks (fulfillment status and packing slip)
  $("ordersTableBody")?.addEventListener("click", async (e) => {
    const toggleBtn = e.target.closest('[data-action="toggle"]');
    const slipBtn = e.target.closest('[data-action="view-slip"]');

    if (slipBtn) {
      const id = slipBtn.dataset.id;
      openOrderDetail(id);
      return;
    }

    if (toggleBtn) {
      const id = toggleBtn.dataset.id;
      const targetStatus = toggleBtn.dataset.target;
      const order = orders.find((o) => o.id === id);
      if (order) {
        toggleBtn.disabled = true;
        try { await updateSharedOrder(id, { fulfillmentStatus: targetStatus === "Fulfilled" ? "Shipped" : "Pending" }); }
        catch (error) { alert(error.message); toggleBtn.disabled = false; }
      }
      return;
    }


  });

  // Inventory grid actions (Preview Piece, Edit Piece, & Delete Piece)
  $("inventoryGrid")?.addEventListener("click", (e) => {
    const previewBtn = e.target.closest('[data-action="preview-piece"]');
    if (previewBtn) {
      const slug = previewBtn.dataset.slug;
      openPiecePreview(slug);
      return;
    }

    const editBtn = e.target.closest('[data-action="edit-piece"]');
    if (editBtn) {
      const slug = editBtn.dataset.slug;
      openEditProduct(slug);
      return;
    }

    const deleteBtn = e.target.closest('[data-action="delete-piece"], [data-action="delete-custom"]');
    if (deleteBtn) {
      const slug = deleteBtn.dataset.slug;
      deleteProduct(slug);
      return;
    }
  });

  // Action buttons
  $("restoreCoreBtn")?.addEventListener("click", restoreCoreCatalogue);

  // Logout button
  $("logoutBtn")?.addEventListener("click", async () => {
    try { await ownerFetch('/api/admin-session', { method: 'DELETE' }); }
    catch (error) { alert(error.message); return; }
    try {
      sessionStorage.removeItem("runaway_owner_session");
      sessionStorage.removeItem("runaway_owner_login_time");
    } catch {}
    window.location.replace("login.html");
  });
}

function refresh() {
  renderMetrics();
  renderOrders();
}

// Initialize
document.addEventListener("DOMContentLoaded", async () => {
  if (!await ownerSessionReady) return;
  orders = [];
  setupEvents();
  setupProductUpload();
  setupAnnouncementControl();
  $('importBrowserBtn')?.addEventListener('click', async () => {
    const button = $('importBrowserBtn');
    try {
      const products = JSON.parse(localStorage.getItem('runaway_custom_products') || '[]');
      const hidden = JSON.parse(localStorage.getItem('runaway_deleted_slugs') || '[]');
      const announcement = localStorage.getItem('runaway_announcement') || '';
      if (!products.length && !hidden.length && !announcement) { alert('No older catalogue data was found on this browser address.'); return; }
      if (!confirm('Import the older products, hidden pieces and announcement from this browser? Matching products will be replaced with the browser versions. This import runs once per database.')) return;
      button.disabled = true;
      await catalogueAction({ action: 'import', products: products.map(productForSave), hidden, announcement });
      alert('Shared catalogue loaded. Browser imports run once; existing browser data has been kept as a backup.');
    } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  });
  renderMetrics();
  renderOrders();
  renderInventory();
  renderTopSellers();
  $('refreshOrdersBtn')?.addEventListener('click', () => loadSharedOrders().catch(error => { $('ordersSyncStatus').textContent = error.message; }));
  $('retryEmailsBtn')?.addEventListener('click', async () => {
    const button = $('retryEmailsBtn'); button.disabled = true;
    try {
      const result = await ownerFetch('/api/admin-emails', { method: 'POST' });
      $('ordersSyncStatus').textContent = `${result.sent} notification(s) accepted; ${result.processed} job(s) processed.`;
    } catch (error) { $('ordersSyncStatus').textContent = error.message; }
    finally { button.disabled = false; }
  });
  try { await Promise.all([loadSharedOrders(), loadSharedCatalogue()]); }
  catch (error) { $('ordersSyncStatus').textContent = error.message; }
});

window.addEventListener('focus', () => { if (catalogueReady) loadSharedCatalogue().catch(() => {}); });

