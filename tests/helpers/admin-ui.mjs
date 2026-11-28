import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../../admin/admin.js', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../../admin/dashboard.html', import.meta.url), 'utf8');
const initialSizes = dashboard.match(/id="productSizes">([\s\S]*?)<\/div>/)[1];

export function adminUI(products, { storageBlocked = false } = {}) {
  const alerts = [], requests = [];
  let sizeControls = [], blob, redirected;
  const control = () => {
    let value = '';
    return { get value() { return value; }, set value(input) { value = String(input); },
      handlers: {}, addEventListener(event, handler) { this.handlers[event] = handler; },
      classList: { add() {}, remove() {} }, setAttribute() {}, querySelector: () => null };
  };
  const ids = Object.fromEntries(['productForm', 'productSizes', 'pEditingSlug', 'pName', 'pCategory', 'pPrice', 'pSku', 'pStock', 'pLowStock', 'pTagline', 'pDesc', 'pColorName', 'pColorHex', 'pColorHexText', 'pFabric', 'pFit'].map(id => [id, control()]));
  Object.defineProperty(ids.productSizes, 'innerHTML', { set(html) {
    sizeControls = [...html.matchAll(/<input\b[^>]*name="sizes"[^>]*>/g)].map(([tag]) => ({ value: tag.match(/value="([^"]*)"/)[1], checked: /\bchecked(?:\s|[/>])/.test(tag) }));
  } });
  ids.productSizes.innerHTML = initialSizes;
  ids.productForm.reset = () => {
    for (const [id, field] of Object.entries(ids)) if (id.startsWith('p')) field.value = '';
    Object.assign(ids.pCategory, { value: 'Tops' }); Object.assign(ids.pStock, { value: '0' });
    Object.assign(ids.pLowStock, { value: '3' }); Object.assign(ids.pColorName, { value: 'Eclipse' });
    Object.assign(ids.pColorHex, { value: '#0c0c0c' });
  };
  const shared = { products: structuredClone(products), hiddenProducts: [], announcement: '' };
  const context = vm.createContext({ console, Intl, Date, Blob, AbortSignal,
    sessionStorage: { getItem() { if (storageBlocked) throw new Error('Storage blocked'); return 'active'; }, removeItem() {} }, localStorage: { getItem: () => null },
    document: { getElementById: id => ids[id] || null,
      querySelectorAll: selector => selector.startsWith('input[name="sizes"]') ? sizeControls.filter(c => !selector.includes(':checked') || c.checked) : [],
      addEventListener() {}, createElement: () => ({ setAttribute() {}, click() {} }), body: { appendChild() {}, removeChild() {} } },
    window: { location: { replace(url) { redirected = url; } }, addEventListener() {} },
    URL: { createObjectURL(value) { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    PRODUCTS: products, alert: message => alerts.push(message), confirm: () => true, setTimeout() {},
    fetch: async (url, options = {}) => {
      if (options.body) requests.push({ url, body: JSON.parse(options.body), bytes: Buffer.byteLength(options.body) });
      return Response.json(shared);
    },
  });
  vm.runInContext(source, context);
  context.sharedFixture = shared;
  vm.runInContext('applySharedCatalogue(sharedFixture); setupProductUpload();', context);
  return { context, ids, requests, alerts,
    get sizes() { return sizeControls; }, get exportedBlob() { return blob; },
    get redirected() { return redirected; },
    run(code) { return vm.runInContext(code, context); },
    submit() { return ids.productForm.handlers.submit({ preventDefault() {} }); },
  };
}
