// Makes the TEST Scan service create deals the real way: a Fill of fake sold prices builds the price book, then a scan
// reads fake eBay listings and judges them. Used to check profit, cost and postage maths end to end.
// Only talks to 127.0.0.1 (the private test Scan service and the fake eBay).
const SVC = process.env.TEST_SVC || "http://127.0.0.1:8787", EBAY = "http://127.0.0.1:8788", KEY = () => process.env.TEST_APP_KEY;
const DAY = 864e5;
export async function call(q, body) {
  const r = await fetch(`${SVC}/?${q}`, { method: body === undefined ? "GET" : "POST", headers: { "X-FlipScout-Key": KEY(), "content-type": "text/plain" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({})); if (!r.ok || d.error) throw new Error(`${q}: ${r.status} ${JSON.stringify(d).slice(0, 200)}`); return d;
}
export const query = async (q, args = []) => (await call("__testquery=1", { q, args })).rows;
export const seedSql = (sql, kv) => call("__testseed=1", { sql, kv });
export const fakeSearch = (items) => fetch(EBAY + "/__fake/search", { method: "POST", body: JSON.stringify(items) }).then((r) => r.json());

// the models used, with what they "sell for" in the fake sold pages
export const MODELS = [
  { title: "NVIDIA GeForce RTX 3070 8GB GDDR6 Graphics Card", base: 255 },
  { title: "NVIDIA GeForce RTX 3060 12GB Graphics Card", base: 185 },
  { title: "AMD Radeon RX 6700 XT 12GB Graphics Card", base: 220 },
];
// 30 sold items per model over the last 10 days, prices spread around `base`, postage 4.99 or free
export function soldRows(seed = 1) {
  const rows = [], now = Date.now();
  MODELS.forEach((m, k) => { for (let i = 0; i < 30; i++) rows.push({ id: String(600000000000 + seed * 10000 + k * 100 + i), n: m.title, p: Math.round((m.base + ((i * 7) % 21) - 10) * 100) / 100, s: i % 3 ? 4.99 : 0, d: now - (1 + (i % 10)) * DAY, c: "used" }); });
  return rows;
}
// a fake eBay search result (Browse API item summary) for a listing
export function listing({ id, title, price, ship, type = "BIN", bids = 0, endsIn = 3, cat = "27386", noShip = false, calcShip = false, estShip = false, unknownShip = false, pickup = false, business = false, created = Date.now() - 5 * 60000 }) {
  const it = { itemId: `v1|${id}|0`, legacyItemId: String(id), title, categoryId: cat, categories: [{ categoryId: cat }], condition: "Used", conditionId: "3000",
    itemWebUrl: `https://www.ebay.co.uk/itm/${id}`, buyingOptions: [type === "AUC" ? "AUCTION" : "FIXED_PRICE"], itemLocation: { country: "GB" },
    seller: { username: "seller" + id, feedbackPercentage: "99.6", feedbackScore: 250, sellerAccountType: business ? "BUSINESS" : "INDIVIDUAL" },
    itemCreationDate: new Date(created).toISOString(), estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }] };
  if (type === "AUC") { it.currentBidPrice = { value: String(price), currency: "GBP" }; it.bidCount = bids; it.itemEndDate = new Date(Date.now() + endsIn * 3600e3).toISOString(); it.price = { value: String(price), currency: "GBP" }; }
  else it.price = { value: String(price), currency: "GBP" };
  if (pickup) it.pickupOptions = [{ pickupLocationType: "STORE" }];
  if (calcShip) it.shippingOptions = [{ shippingCostType: "CALCULATED" }];
  else if (estShip) it.shippingOptions = [{ shippingCostType: "CALCULATED", shippingCost: { value: String(ship), currency: "GBP" } }];
  else if (unknownShip) it.shippingOptions = [{ shippingServiceCode: "Other" }];
  else if (!noShip) it.shippingOptions = [{ shippingCostType: "FIXED", shippingCost: { value: String(ship), currency: "GBP" } }];
  return it;
}
// settings exactly as the app sends them (Graphics Cards only, private seller, buyer fee on, £20 minimum profit)
export const CONFIG = { cats: [{ id: "27386", name: "Graphics Cards" }], types: { bin: true, auction: true, misspelt: true, spares: false }, alerts: false, interval: 0, paused: false,
  region: "uk", rules: { cheap: true, maxSpend: 0, minProfit: 20, minRoi: 0, seller: "private", feePct: 12.8, feeFixed: 0.4, post: 5, pack: 1, bpf: true, alertScore: 70, minScore: 40 } };

// independent sums (eBay UK's published rules, written out again here rather than taken from the app)
export const buyerFee = (p) => 0.1 + Math.min(p, 20) * 0.07 + Math.max(0, Math.min(p, 300) - 20) * 0.04 + Math.max(0, Math.min(p, 4000) - 300) * 0.02;
export const sellFee = (x, r) => (r.seller === "private" ? 0 : x * r.feePct / 100 + (x > 10 ? r.feeFixed : Math.min(r.feeFixed, 0.3)));
