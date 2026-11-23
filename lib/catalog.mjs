import { clean } from './http.mjs';
const catalog = {
  "aether-compression-tee": { name: "Aether Compression Tee", price: 148000, sizes: ["S", "M", "L", "XL", "XXL"], colors: { eclipse: "Black", white: "White" } },
  "apex-training-shorts": { name: "Apex Training Shorts", price: 98000, sizes: ["S", "M", "L", "XL", "XXL"], colors: { void: "Black", white: "White" } },
  "velocity-skull-cap": { name: "Velocity Skull Cap", price: 42000, sizes: ["S/M", "L/XL"], colors: { "all-black": "All Black", "black-gold": "Black / Gold", "black-silver": "Black / Silver", midnight: "Midnight" } },
};

export function validateCart(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) return null;
  const items = [];
  for (const raw of rawItems) {
    const slug = clean(raw?.slug, 80);
    const product = Object.hasOwn(catalog, slug) ? catalog[slug] : null;
    const qty = Number(raw?.qty);
    const colorId = clean(raw?.color, 40);
    const size = clean(raw?.size, 20);
    if (!product || Number(raw?.price) !== product.price || !Number.isInteger(qty) || qty < 1 || qty > 20 || !product.sizes.includes(size) || !Object.hasOwn(product.colors, colorId)) return null;
    items.push({ slug: raw.slug, name: product.name, price: product.price, qty, size, color: colorId, colorName: product.colors[colorId] });
  }
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return Number.isSafeInteger(total) ? { items, total } : null;
}

