import { clean } from './http.mjs';
import seed from './catalog-seed.json' with { type: 'json' };
const catalog = Object.fromEntries(seed.map(p => [p.slug, { ...p, colors: Object.fromEntries(p.colors.map(c => [c.id, c.name])) }]));

export function validateCart(rawItems, products) {
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 30) return null;
  const items = [];
  for (const raw of rawItems) {
    const slug = clean(raw?.slug, 80);
    const shared = products?.find(p => p.slug === slug);
    const product = products ? (shared ? { ...shared, colors: Object.fromEntries(shared.colors.map(c => [c.id, c.name])) } : null) : Object.hasOwn(catalog, slug) ? catalog[slug] : null;
    const qty = Number(raw?.qty);
    const colorId = clean(raw?.color, 40);
    const size = clean(raw?.size, 20);
    if (!product || Number(raw?.price) !== product.price || !Number.isInteger(qty) || qty < 1 || qty > 20 || !product.sizes.includes(size) || !Object.hasOwn(product.colors, colorId) || (product.stock != null && product.stock < qty)) return null;
    items.push({ slug: raw.slug, name: product.name, price: product.price, qty, size, color: colorId, colorName: product.colors[colorId] });
  }
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return Number.isSafeInteger(total) ? { items, total } : null;
}

