import { failure, json } from '../lib/http.mjs';
import { readShop } from '../lib/shop.mjs';
export async function GET() {
  try { return json(200, await readShop()); }
  catch (error) { return failure(error); }
}
