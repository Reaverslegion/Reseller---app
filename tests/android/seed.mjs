// Fake data for the emulator tests, loaded into the PRIVATE TEST Scan service (never the live one) and the fake eBay.
// Everything here is invented: made-up listing numbers, titles and prices.
const SVC = "http://127.0.0.1:8787", EBAY = "http://127.0.0.1:8788", KEY = process.env.TEST_APP_KEY;
const DAY = 864e5;
async function post(url, body) {
  if (!/^http:\/\/127\.0\.0\.1:/.test(url)) throw new Error("refusing to send test data anywhere but this test machine");
  const r = await fetch(url, { method: "POST", headers: { "X-FlipScout-Key": KEY, "content-type": "text/plain" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(`seed failed: ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
  return d;
}
export const query = async (q, args = []) => (await post(SVC + "/?__testquery=1", { q, args })).rows;
export const runSql = (sql, kv) => post(SVC + "/?__testseed=1", { sql, kv });

const GPU = [["NVIDIA GeForce RTX 3070 8GB Founders Edition", "gpu:rtx 3070", 255], ["MSI GeForce RTX 3060 Ventus 12GB", "gpu:rtx 3060", 185],
  ["Sapphire Pulse Radeon RX 6700 XT 12GB", "gpu:rx 6700 xt", 220], ["ASUS Dual GeForce RTX 4060 8GB OC", "gpu:rtx 4060", 230],
  ["Gigabyte GTX 1660 Super OC 6GB", "gpu:gtx 1660 super", 95], ["XFX Radeon RX 580 GTS 8GB", "gpu:rx 580", 55]];
const PHONE = [["Apple iPhone 13 128GB Midnight Unlocked", "phone:iphone 13 128gb", 300], ["Samsung Galaxy S22 128GB Phantom Black Unlocked", "phone:galaxy s22 128gb", 200]];

// n deals: a realistic mix (Buy It Now and auctions, graphics cards and phones), plus the "missing information" cases
// a real deal can have: no picture, postage unknown, collection only, no condition, no listed time.
export function makeDeals(n, idBase = 410000000000) {
  const now = Date.now(), out = [];
  for (let i = 0; i < n; i++) {
    const phone = i % 5 === 4, [title, pkey, med] = (phone ? PHONE : GPU)[i % (phone ? PHONE.length : GPU.length)];
    const auc = i % 4 === 3, price = Math.round(med * (0.55 + (i % 7) * 0.03) * 100) / 100, ship = i % 6 === 5 ? 0 : 4.99;
    const cost = Math.round((price + ship + 0.1 + Math.min(price, 20) * 0.07 + Math.max(0, Math.min(price, 300) - 20) * 0.04) * 100) / 100;
    const profit = Math.round((med - 6 - cost) * 100) / 100, id = String(idBase + i);
    const d = { id, kind: "deal", title: `${title} (test ${i + 1})`, type: auc ? "AUC" : "BIN", price, ship, cost, profit,
      lowProfit: Math.round((profit - 15) * 100) / 100, med, low: med - 20, n: 24, src: "book", fill: true, bookN: 24, score: 55 + (i * 7) % 40,
      tags: i % 3 === 0 ? ["Price from category check"] : [], cat: phone ? "9355" : "27386", catName: phone ? "Mobile & Smart Phones" : "Graphics Cards",
      cond: "Used", pkey, matchLabel: pkey.split(":")[1].toUpperCase(), url: `https://www.ebay.co.uk/itm/${id}`, created: now - (i % 9) * 3600e3,
      maxPay: Math.round((cost + profit - 20) * 100) / 100, maxItem: Math.round((price + profit - 25) * 100) / 100, profitAtMax: 20, bpfOn: true,
      img: i % 2 ? null : undefined, seller: { biz: false, fb: 98 + (i % 3), n: 50 + i } };
    if (auc) Object.assign(d, { end: now + (1 + (i % 5)) * 3600e3, bids: i % 4, maxBid: Math.round((price + profit - 25) * 100) / 100 });
    if (i === 1) { delete d.created; delete d.cond; }                 // missing: listed time and condition
    if (i === 2) { d.collect = true; d.ship = 0; d.where = "Leeds"; } // collection only (shown under its own chip)
    if (i === 5) { delete d.seller; }                                  // missing: seller details
    out.push(d);
  }
  return out;
}
const fakeItem = (d) => ({ itemId: `v1|${d.id}|0`, legacyItemId: d.id, title: d.title, itemWebUrl: d.url,
  price: { value: String(d.type === "AUC" ? d.price : d.price), currency: "GBP" }, buyingOptions: [d.type === "AUC" ? "AUCTION" : "FIXED_PRICE"],
  ...(d.type === "AUC" ? { currentBidPrice: { value: String(d.price), currency: "GBP" }, bidCount: d.bids || 0, itemEndDate: new Date(d.end).toISOString() } : {}),
  shippingOptions: [{ shippingCost: { value: String(d.ship || 0), currency: "GBP" } }], estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
  condition: "Used", description: "<p>Fully working, tested. Comes boxed.</p>", seller: { username: "test_seller", feedbackPercentage: "99.5", feedbackScore: 120 } });

// replace all deals with these, register them as "for sale" on the fake eBay, and give each model 24 sold prices
export async function seedDeals(deals) {
  const now = Date.now(), sql = [["DELETE FROM deals"]];
  for (const d of deals) sql.push(["INSERT INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)", [d.id, JSON.stringify(d), d.score, now - 60000, now + 2 * DAY]]);
  for (const [, pkey, med] of [...GPU, ...PHONE]) {
    const sales = Array.from({ length: 24 }, (_, j) => [String(520000000000 + j + med * 100), Math.round((med + (j % 9) - 4) * 100) / 100, j % 3 ? 4.99 : 0, now - (j + 1) * DAY / 2]);
    sql.push(["INSERT OR REPLACE INTO fillsales (pkey,data,at) VALUES (?,?,?)", [pkey, JSON.stringify(sales), now]]);
    sql.push(["INSERT OR REPLACE INTO prices (pkey,label,q,avg,st,post,trend,at) VALUES (?,?,?,?,?,?,?,?)", [pkey, pkey.split(":")[1].toUpperCase(), pkey.split(":")[1], med, 60, 4.99, "steady", now]]);
    // half the sales have saved titles, half don't (the sales list must cope with both)
    sales.filter((_, j) => j % 2 === 0).forEach((s) => sql.push(["INSERT OR REPLACE INTO fillseen (id,cat,price,at,title,cond,pkey) VALUES (?,?,?,?,?,?,?)",
      [s[0], pkey.startsWith("phone") ? "9355" : "27386", s[1], s[3], `Sold test item for ${pkey.split(":")[1]}`, "used", pkey]]));
  }
  for (let i = 0; i < sql.length; i += 150) await runSql(sql.slice(i, i + 150));
  await fetch(EBAY + "/__fake/items", { method: "DELETE" });
  await fetch(EBAY + "/__fake/items", { method: "POST", body: JSON.stringify(deals.map(fakeItem)) });
  return deals.length;
}
export const clearDeals = () => runSql([["DELETE FROM deals"]]);
