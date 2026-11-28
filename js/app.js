/* Home catalogue and quickview; shared chrome lives in site.js. */
(async () => {
await shopReady;
const heroBg = document.querySelector('#heroBg img');
const craftBg = document.getElementById('craftBg');
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) addEventListener('scroll', () => {
  if (heroBg && scrollY < innerHeight * 1.2) heroBg.style.transform = `translateY(${scrollY * 0.22}px) scale(1.05)`;
  const craft = document.getElementById('craft');
  if (craft && craftBg) {
    const rect = craft.getBoundingClientRect();
    if (rect.top < innerHeight && rect.bottom > 0) craftBg.style.transform = `translateY(${rect.top * -0.08}px)`;
  }
}, { passive: true });
const grid = document.getElementById("productGrid");
let activeFilter = "All";


function resolveProductImage(p, idx = 0, color = (p.colors || [])[0]) {
  const images = Array.isArray(color?.images) && color.images.length ? color.images : p.images;
  if (images && images[idx]) {
    const src = images[idx];
    return (src.startsWith("data:") || src.startsWith("http") || src.startsWith("/") || src.startsWith(".")) ? src : IMG + src;
  }
  if (p.image) {
    return (p.image.startsWith("data:") || p.image.startsWith("http") || p.image.startsWith("/") || p.image.startsWith(".")) ? p.image : IMG + p.image;
  }
  return IMG + "logo-runners.png";
}

function productLink(p, color) {
  const path = p.file || ("products/product.html?slug=" + encodeURIComponent(p.slug));
  if (!color?.id) return path;
  return `${path}${path.includes("?") ? "&" : "?"}color=${encodeURIComponent(color.id)}`;
}

function cardHTML(p, color = (p.colors || [])[0]) {
  const mainImg = resolveProductImage(p, 0, color);
  const fileLink = productLink(p, color);
  return `
  <article class="card" data-slug="${p.slug}" data-color="${color?.id || ""}">
    <div class="card-media">
      <a href="${fileLink}" style="display:block;width:100%;height:100%;">
        <img src="${mainImg}" alt="${p.name}${color?.name ? ` in ${color.name}` : ""}" loading="lazy" />
      </a>
      <span class="card-badge">${p.category}</span>
      <button class="card-quick" data-quickview="${p.slug}" data-quickview-color="${color?.id || ""}">Quick view +</button>
    </div>
    <div class="card-row">
      <div><p class="card-cat">${p.tagline || ""}${color?.name ? ` · ${color.name}` : ""}</p><h3 class="card-name"><a href="${fileLink}" style="color:inherit">${p.name}</a></h3></div>
      <p class="card-price">${money(p.price)}</p>
    </div>
  </article>`;
}

function renderGrid() {
  const all = getAllProducts();
  const list = activeFilter === "All" ? all : all.filter((p) => p.category === activeFilter);
  const cards = list.flatMap((p) => {
    const colors = p.colors || [];
    const defaultColor = colors[0];
    const whiteColor = colors.find((color) => color.id === "white");
    return whiteColor && whiteColor !== defaultColor
      ? [cardHTML(p, defaultColor), cardHTML(p, whiteColor)]
      : [cardHTML(p, defaultColor)];
  });
  grid.innerHTML = cards.join("");
  // entrance stagger
  [...grid.children].forEach((c, i) => {
    c.style.opacity = "0"; c.style.transform = "translateY(18px)";
    setTimeout(() => { c.style.opacity = ""; c.style.transform = ""; }, 60 * i + 30);
  });
}
renderGrid();

document.querySelectorAll(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    if (chip.dataset.filter === activeFilter) return;
    document.querySelector(".chip.is-active")?.classList.remove("is-active");
    chip.classList.add("is-active");
    // animate out, then swap
    [...grid.children].forEach((c) => c.classList.add("leaving"));
    setTimeout(() => { activeFilter = chip.dataset.filter; renderGrid(); }, 220);
  })
);

/* ── quickview modal (Apple fluid spatial expansion) ── */
const modal = document.getElementById("qvModal");
let qv = null, qvColor = null, qvSize = null, qvImgIdx = 0;

function openQuickview(slug, triggerEl, colorId) {
  qv = getAllProducts().find((x) => x.slug === slug);
  if (!qv) return;

  if (triggerEl) {
    const card = triggerEl.closest(".card") || triggerEl;
    const rect = card.getBoundingClientRect();
    const originX = ((rect.left + rect.width / 2) / window.innerWidth) * 100;
    const originY = ((rect.top + rect.height / 2) / window.innerHeight) * 100;
    const modalCard = modal.querySelector(".modal-card");
    if (modalCard) {
      modalCard.style.setProperty("--origin-x", `${originX.toFixed(1)}%`);
      modalCard.style.setProperty("--origin-y", `${originY.toFixed(1)}%`);
    }
  }

  qvColor = (qv.colors || []).find((color) => color.id === colorId) || (qv.colors && qv.colors[0]) || { id: "default", name: "Standard", swatch: "#111" };
  qvSize = (qv.sizes && qv.sizes.length === 1) ? qv.sizes[0] : null;
  qvImgIdx = 0;

  document.getElementById("qvCat").textContent = qv.category || "Kit";
  document.getElementById("qvName").textContent = qv.name;
  document.getElementById("qvTag").textContent = qv.tagline || "";
  document.getElementById("qvPrice").textContent = money(qv.price);
  document.getElementById("qvDesc").textContent = qv.description || "";
  document.getElementById("qvMeta").textContent = `Fabric — ${qv.fabric || qv.specs?.fabric || "Performance knit"} · Fit — ${qv.fit || qv.specs?.fit || "Athletic"}`;
  document.getElementById("qvHint").textContent = "";

  const qvFull = document.getElementById("qvFull");
  const fullLink = productLink(qv, qvColor);
  if (qvFull) {
    qvFull.href = fullLink;
    qvFull.style.display = "";
  }

  paintQV();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  document.body.classList.add("staged");
}
function paintQV() {
  const img = document.getElementById("qvImg");
  const mainImg = resolveProductImage(qv, qvImgIdx, qvColor);
  img.src = mainImg;
  img.alt = qv.name;
  const images = Array.isArray(qvColor?.images) && qvColor.images.length ? qvColor.images : (Array.isArray(qv.images) && qv.images.length ? qv.images : [qv.image || "logo-runners.png"]);
  document.getElementById("qvThumbs").innerHTML = images.map((s, i) =>
    `<button class="${i === qvImgIdx ? "active" : ""}" data-thumb="${i}" aria-label="View image ${i + 1}"><img src="${resolveProductImage(qv, i, qvColor)}" alt="" loading="lazy" /></button>`
  ).join("");
  document.getElementById("qvColorName").textContent = qvColor.name;
  document.getElementById("qvColors").innerHTML = (qv.colors || []).map((c) =>
    `<button class="${(c.id || c.name) === (qvColor.id || qvColor.name) ? "active" : ""}" data-color="${c.id || c.name}" aria-label="${c.name}" title="${c.name}"><i style="background:${c.swatch || c.hex || "#0c0c0c"}"></i></button>`
  ).join("");
  document.getElementById("qvSizes").innerHTML = (qv.sizes || ["S", "M", "L"]).map((s) =>
    `<button class="${s === qvSize ? "active" : ""}" data-size="${s}">${s}</button>`
  ).join("");
}
function closeQuickview() {
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (!document.querySelector(".drawer-root.open")) {
    document.body.classList.remove("staged");
  }
}

document.addEventListener("click", (e) => {
  const qvBtn = e.target.closest("[data-quickview]");
  if (qvBtn) { openQuickview(qvBtn.dataset.quickview, qvBtn, qvBtn.dataset.quickviewColor); return; }
  if (e.target.closest("[data-close-qv]")) { closeQuickview(); return; }
  const th = e.target.closest("[data-thumb]");
  if (th && qv) { qvImgIdx = +th.dataset.thumb; paintQV(); return; }
  const sw = e.target.closest("[data-color]");
  if (sw && qv) { qvColor = qv.colors.find((c) => c.id === sw.dataset.color); paintQV(); return; }
  const sz = e.target.closest("[data-size]");
  if (sz && qv) { qvSize = sz.dataset.size; document.getElementById("qvHint").textContent = ""; paintQV(); return; }
});
addEventListener("keydown", (e) => { if (e.key === "Escape") { closeQuickview(); closeDrawer(); } });

document.getElementById("qvAdd")?.addEventListener("click", () => {
  if (!qvSize) { document.getElementById("qvHint").textContent = "Choose a size."; return; }
  const mainImg = resolveProductImage(qv, 0, qvColor);
  const added = Cart.add({
    slug: qv.slug,
    name: qv.name,
    price: qv.price,
    size: qvSize,
    color: qvColor.id || qvColor.name,
    colorName: qvColor.name,
    image: mainImg
  });
  if (!added) return;
  closeQuickview();
  paintBag();
  openDrawer();
  toast(`${qv.name} — added to bag`);
});



})();
