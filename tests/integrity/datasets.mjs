// KNOWN DATASETS for the integrity audit. Every value is invented and chosen so the right answer is known in advance.
// Deals are written straight into the TEST database (the same JSON the Scan service stores), except the "real scan"
// set, which the Scan service builds itself from fake eBay listings (see scan-flow.mjs).
import { buyerFee } from "./oracle.mjs";

const DAY = 864e5, OUT = 5.99; // postage out 4.99 + packing 1 (what the Scan service uses with the price book's postage)
const MODELS = [["NVIDIA GeForce RTX 3070 8GB", "gpu:rtx 3070|used", 256.99, "27386", "Graphics Cards"], ["MSI GeForce RTX 3060 12GB", "gpu:rtx 3060 12gb|used", 186.99, "27386", "Graphics Cards"],
  ["Apple iPhone 13 128GB Unlocked", "phone:iphone 13 128gb|used", 304.99, "9355", "Mobile & Smart Phones"], ["Sony PlayStation 5 Disc Console", "con:ps5 disc|used", 334.99, "139971", "Video Game Consoles"],
  ["Samsung Galaxy S22 128GB", "phone:galaxy s22 128gb|used", 204.99, "9355", "Mobile & Smart Phones"], ["AMD Radeon RX 6700 XT 12GB", "gpu:rx 6700 xt|used", 221.99, "27386", "Graphics Cards"]];
const r2 = (x) => Math.round(x * 100) / 100;

// one consistent deal (the sums add up exactly as the Scan service would store them)
export function deal(id, i, over = {}) {
  const [name, pkey, med, cat, catName] = MODELS[i % MODELS.length], now = Date.now();
  const auc = i % 4 === 3, price = r2(med * (0.42 + ((i * 37) % 30) / 100)), ship = i % 5 === 4 ? 0 : 4.99;
  const cost = r2(price + ship + buyerFee(price)), profit = r2(med - OUT - cost), lowProfit = r2(med - 20 - OUT - cost);
  const maxPay = r2(med - OUT - 20), maxItem = i % 7 === 0 ? r2(price - 5) : r2(maxPay - ship - buyerFee(maxPay)); // every 7th Buy It Now is above its max item price ("Max offer")
  const d = { id: String(id), kind: "deal", title: `${name} #${id}`, type: auc ? "AUC" : "BIN", price, ship, cost, profit, lowProfit, maxPay, maxItem: r2(maxItem),
    med, low: r2(med - 20), n: 24, src: "book", fill: true, bookN: 24 + (i % 50), score: 40 + ((i * 13) % 60), tags: [], cat, catName, cond: "Used", pkey, matchLabel: pkey.split(":")[1],
    url: `https://www.ebay.co.uk/itm/${id}`, created: now - (i % 1000) * 60000 - (i % 997), bpfOn: true, seller: { biz: false, fb: 120, pct: 99.6 }, sellFee: 0, out: OUT };
  if (auc) { const maxBid = r2(maxPay - ship - buyerFee(maxPay)); Object.assign(d, { maxBid, maxItem: maxBid, end: now + (2 + (i % 600)) * 60000 + i, bids: i % 3, profitAtMax: r2(med - OUT - (maxBid + ship + buyerFee(maxBid))) }); }
  return Object.assign(d, over);
}
export const scale = (n, base = 800000000000) => Array.from({ length: n }, (_, i) => deal(base + i, i));

// unusual and incomplete records, each with what should happen. realWorld = the Scan service can produce data like this today.
export function edge(base = 900000000000) {
  let k = 0; const id = () => base + ++k, E = [];
  const add = (note, d, expect = {}) => E.push({ note, d, expect: { realWorld: true, ...expect } });
  add("no picture", deal(id(), 0, { img: undefined }));
  add("picture address present", deal(id(), 1, { img: "https://i.ebayimg.com/images/g/test/s-l225.jpg" }));
  add("free postage (0)", deal(id(), 2, { ship: 0 }));
  add("collection only, with town", deal(id(), 4, { ship: 0, collect: true, where: "Leeds" }), { chip: "col" });
  add("no seller details", deal(id(), 5, { seller: undefined }));
  add("no condition or category name", deal(id(), 6, { cond: "", catName: "" }));
  add("emoji and symbols in title", deal(id(), 7, { title: "🔥 RTX 3070 — “mint” £££ 100% working ✅ #" + (base + k) }));
  add("HTML-like text in title (must show as text)", deal(id(), 8, { title: "<b>RTX</b> 3060 <script>x()</script> & <img src=x> #" + (base + k) }));
  add("quotes and apostrophes", deal(id(), 9, { title: `Seller's "boxed" RTX 3070 'as new' #${base + k}` }));
  add("very long title (300 characters)", deal(id(), 10, { title: ("Very long title " + "word ".repeat(70)).slice(0, 280) + " #" + (base + k) }));
  add("right-to-left text", deal(id(), 11, { title: "آيفون 13 iPhone 13 128GB #" + (base + k) }));
  add("line break inside title", deal(id(), 12, { title: "RTX 3070\nline two #" + (base + k) }));
  add("price with a large amount (thousands separator)", deal(id(), 13, { price: 1234.5, ship: 9.99, med: 2399.99, cost: 1291.9, profit: 1102.1, maxItem: 2100, maxPay: 2150 }));
  add("tiny amounts and rounding (x.005)", deal(id(), 14, { price: 10.005, ship: 0.995, med: 60.0, profit: 39.995 }));
  add("duplicate listing A (same title and price as B)", deal(id(), 15, { title: "Duplicate test RTX 3060 12GB" }));
  add("duplicate listing B (different listing number)", deal(id(), 15, { title: "Duplicate test RTX 3060 12GB" }));
  add("auction with no bids", deal(id(), 3, { bids: 0 }));
  add("auction where max-bid profit equals today's profit (no range)", deal(id(), 7, { type: "AUC", end: Date.now() + 3 * 3600e3, bids: 2, maxBid: 150, maxItem: 150, profit: 40, profitAtMax: 40 }));
  add("guess (priced from asking prices)", deal(id(), 16, { src: "asking", fill: false, n: 6 }), { chip: "guess" });
  add("loses money (negative profit): must be hidden", deal(id(), 17, { profit: -12.5, lowProfit: -30 }), { hidden: true });
  add("zero profit: must be hidden", deal(id(), 18, { profit: 0 }), { hidden: true });
  add("category not ticked: must be hidden", deal(id(), 19, { cat: "99999", catName: "Other" }), { hidden: true });
  add("expired yesterday: must be hidden", deal(id(), 20), { hidden: true, expired: true });
  add("spares or repairs (spares not switched on): must be hidden from All", deal(id(), 21, { kind: "spares", workMed: 250, tags: [] }), { chip: "spares" });
  add("missing price", deal(id(), 22, { price: null }), { realWorld: false });
  add("missing postage (unknown, not collection)", deal(id(), 23, { ship: null }), { realWorld: false });
  add("missing profit", deal(id(), 24, { profit: null }), { hidden: true, realWorld: false });
  add("missing sold-price figure", deal(id(), 25, { med: null }), { realWorld: false });
  add("missing score", deal(id(), 26, { score: null }), { realWorld: false });
  add("missing title", deal(id(), 27, { title: "" }), { realWorld: false });
  return E;
}
