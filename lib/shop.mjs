import { clean, HttpError } from './http.mjs';
import { db, rpc } from './store.mjs';
import { paymentEnvironment } from './environment.mjs';

export const publicProduct = row => ({ ...row.definition, slug: row.slug, stock: paymentEnvironment() === 'test' ? row.test_stock : row.stock,
  createdAt: row.created_at, updatedAt: row.updated_at,
  file: `/products/product.html?slug=${encodeURIComponent(row.slug)}` });
export async function readProducts(includeHidden = false) {
  await rpc('release_expired_shop_orders', {});
  const rows = [];
  for (let offset = 0; ; offset += 200) {
    const page = await db(`shop_products?${includeHidden ? '' : 'active=eq.true&'}order=created_at.asc,slug.asc&limit=200&offset=${offset}`);
    rows.push(...page);
    if (page.length < 200) break;
  }
  return rows;
}
export async function readShop(includeHidden = false) {
  const [rows, settings] = await Promise.all([readProducts(includeHidden), db('shop_settings?key=eq.announcement')]);
  return { products: rows.filter(row => row.active).map(publicProduct),
    ...(includeHidden ? { hiddenProducts: rows.filter(row => !row.active).map(publicProduct) } : {}),
    announcement: settings[0]?.value || '', environment: paymentEnvironment() };
}
const text = (value, max = 4000) => clean(value, max).replace(/[<>]/g, '').replaceAll('"', '”').replaceAll("'", '’');
const image = value => {
  if (typeof value !== 'string' || value.length > 1400000) throw new HttpError(400, 'Image is too large. Use an image smaller than 1 MB.');
  if (/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(value)) return value;
  if (/^https:\/\/[^\s"'<>]+$/.test(value)) return value;
  if (/^(?:(?:\.\.\/|\.\/|\/)?public\/images\/)?[a-zA-Z0-9_./ -]+\.(png|jpe?g|webp|avif|gif)$/i.test(value) && !value.includes('..', 3)) {
    return '/public/images/' + value.replace(/^(?:(?:\.\.\/|\.\/|\/)?public\/images\/)/, '');
  }
  throw new HttpError(400, 'Use a valid image URL or upload PNG, JPG, WebP or GIF.');
};
export function productRecord(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid product.');
  const slug = clean(input.slug, 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400, 'Invalid product slug.');
  const name = text(input.name, 150), price = Number(input.price);
  if (!Array.isArray(input.sizes) || !Array.isArray(input.colors) || (input.images !== undefined && !Array.isArray(input.images)) || (input.features !== undefined && !Array.isArray(input.features))) throw new HttpError(400, 'Review product sizes, colours and images.');
  const stock = input.stock === undefined || input.stock === null ? null : Number(input.stock);
  if (!name || !Number.isSafeInteger(price) || price <= 0 || price > 100000000 || (stock !== null && (!Number.isSafeInteger(stock) || stock < 0))) throw new HttpError(400, 'Review product name, price and stock.');
  const sizes = [...new Set((input.sizes || []).map(v => text(v, 30)).filter(Boolean))].slice(0, 30);
  const colors = (input.colors || []).slice(0, 30).map((c, index) => ({ id: text(c.id || c.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `color-${index}`, 60), name: text(c.name, 60),
    swatch: /^#[a-f0-9]{6}$/i.test(c.swatch || c.hex || '') ? c.swatch || c.hex : '#111111',
    ...(c.images?.length ? { images: c.images.slice(0, 15).map(image) } : {}) }));
  if (!sizes.length || !colors.length || colors.some(c => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id) || !c.name)) throw new HttpError(400, 'Choose at least one size and colour with a valid identifier.');
  const definition = { slug, name, price, sizes, colors,
    images: (input.images?.length ? input.images : [input.image || 'logo-runners.png']).slice(0, 15).map(image),
    sku: text(input.sku, 80), lowStockThreshold: Math.max(0, Math.min(1000000, Number(input.lowStockThreshold) || 3)),
    category: text(input.category, 80), tagline: text(input.tagline, 200), description: text(input.description), story: text(input.story),
    fabric: text(input.fabric || input.specs?.fabric), fit: text(input.fit || input.specs?.fit),
    isCustom: Boolean(input.isCustom),
    details: (Array.isArray(input.details) ? input.details : []).slice(0, 30).map(v => text(v, 1000)),
    specs: { fabric: text(input.fabric || input.specs?.fabric), fit: text(input.fit || input.specs?.fit), origin: text(input.specs?.origin, 200), care: text(input.specs?.care, 1000) },
    features: (input.features || []).slice(0, 20).map(f => ({ label: text(f.label, 150), detail: text(f.detail, 300) })),
  };
  return { slug, definition, stock, active: true, updated_at: new Date().toISOString() };
}
