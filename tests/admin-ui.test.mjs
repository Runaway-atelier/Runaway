import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adminUI } from './helpers/admin-ui.mjs';
import { readJson } from '../lib/http.mjs';
const seed = JSON.parse(await readFile(new URL('../lib/catalog-seed.json', import.meta.url), 'utf8'));
const cap = { ...seed.find(p => p.slug === 'velocity-skull-cap'), stock: 10, updatedAt: '2026-11-25T00:00:00.000Z' };

test('editing a cap description preserves its original combined sizes and save snapshot', async () => {
  const ui = adminUI([cap]);
  ui.run("openEditProduct('velocity-skull-cap')");
  assert.deepEqual(ui.sizes.filter(c => c.checked).map(c => c.value), ['S/M', 'L/XL']);
  ui.ids.pDesc.value = 'Updated description';
  await ui.submit();
  assert.deepEqual(ui.requests[0].body.product.sizes, ['S/M', 'L/XL']);
  assert.deepEqual(ui.requests[0].body.expected, { stock: 10, updatedAt: cap.updatedAt });
});
test('editing preserves a custom size and rejects an empty size selection', async () => {
  const ui = adminUI([{ ...cap, sizes: ['One Size'] }]);
  ui.run("openEditProduct('velocity-skull-cap')");
  assert.ok(ui.sizes.some(c => c.value === 'One Size' && c.checked));
  for (const c of ui.sizes) c.checked = false;
  await ui.submit();
  assert.equal(ui.requests.length, 0);
  assert.ok(ui.alerts.some(message => message.includes('at least one available size')));
});
test('a valid 1 MB image fits the product API request limit during creation and editing', async () => {
  const image = 'data:image/png;base64,' + Buffer.alloc(1000000).toString('base64');
  for (const edit of [false, true]) {
    const ui = adminUI([cap]);
    ui.run(edit ? "openEditProduct('velocity-skull-cap')" : 'openProductModal()');
    ui.context.uploadFixture = image;
    ui.run('currentUploadImage = uploadFixture;');
    ui.ids.pName.value = 'Image Test Piece'; ui.ids.pPrice.value = '42000';
    await ui.submit();
    const request = ui.requests[0];
    assert.ok(request, ui.alerts.join('; '));
    assert.equal(request.body.product.image, undefined);
    assert.equal(request.body.product.images[0], image);
    assert.ok(request.bytes < 2200000);
    assert.equal((await readJson(new Request('https://shop.example.com/api/admin-catalog', { method: 'POST', body: JSON.stringify(request.body) }), 2200000)).product.images[0], image);
  }
});
test('CSV export protects formula-like customer and courier fields and escapes quotes', async () => {
  const ui = adminUI([]);
  ui.context.ordersFixture = [{ id: 'RW-000000000001', date: '2026-11-25', total: 1, items: [],
    customer: { name: '=1+1', email: '@SUM(1)', phone: '+23412345678', address: '  -1+2', city: 'Lagos, "Island"', state: '＝1+1' },
    carrier: '\t=1+1', trackingNumber: 'Safe tracking' }];
  ui.run('orders = ordersFixture; exportOrdersToCSV();');
  const csv = await ui.exportedBlob.text();
  for (const value of ['=1+1', '@SUM(1)', '+23412345678', '  -1+2', '＝1+1']) assert.ok(csv.includes('"\t' + value + '"'));
  assert.ok(csv.includes('"Lagos, ""Island"""'));
  assert.ok(csv.includes('"Safe tracking"'));
  assert.ok(!csv.includes(',"=1+1",'));
});
