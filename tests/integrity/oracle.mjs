// EXPECTED RESULTS, worked out independently of the app's code: which deals should be on screen, in which filter, in
// what order, and exactly what each card should say. Written from FlipScout's documented rules (deal card layout, eBay
// buyer protection fee, "profit = sells for − selling fee − postage out − packing − (price + postage in + buyer fee)").
// Where the app does something different, the audit reports it as a discrepancy for a person to judge.

export const buyerFee = (p) => 0.1 + Math.min(p, 20) * 0.07 + Math.max(0, Math.min(p, 300) - 20) * 0.04 + Math.max(0, Math.min(p, 4000) - 300) * 0.02;
const money = (n) => Math.abs(+n || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const gbp = (n) => (n < 0 ? "-£" : "£") + money(n);
export const gbp0 = (n) => (n < 0 ? "-£" : "£") + Math.round(Math.abs(+n || 0)).toLocaleString("en-GB");
export const signed = (v) => (v >= 0 ? "+" : "−") + gbp(Math.abs(v));
export const known = (n) => n != null && n !== "" && Number.isFinite(+n);
const cap2 = (x) => Math.floor(x * 100) / 100;
// postage wording (fixed 4 Nov): free, fixed, eBay's estimate, calculated/not stated with the careful allowance, or unknown
export function postText(d) {
  if (d.collect) return "collection only" + (d.where ? " · " + d.where : "");
  if (!known(d.ship)) return "postage unknown";
  if (d.post === "calc") return `postage calculated by eBay · ${gbp(d.ship)} allowed`;
  if (d.post === "unknown") return `postage not stated · ${gbp(d.ship)} allowed`;
  if (d.post === "est") return `+ about ${gbp(d.ship)} post (eBay estimate)`;
  return +d.ship ? "+ " + gbp(d.ship) + " post" : "free post";
}
// the spend limit lowers max bids / max item prices to fit, and "profit at your max" follows (fixed 4 Nov)
export function limited(d, s = SETTINGS) {
  const m = s.maxSpend || 0; if (!(m > 0) || d.kind === "spares") return d;
  const ship = d.ship || 0, fee = (x) => (feeOn(d, s) ? buyerFee(x) : 0), x = { ...d }; let capped = false;
  if (isAuction(d) && d.maxBid != null) { const c = cap2(m - ship); if (d.maxBid > c) { x.maxBid = c; x.maxItem = d.maxItem != null ? Math.min(d.maxItem, c) : c; capped = true; } }
  else if (!isAuction(d) && d.maxItem != null) { let c = cap2(m - ship - fee(m)); while (c > 0 && c + ship + fee(c) > m + 1e-9) c = Math.floor(c * 100 - 1) / 100; if (d.maxItem > c) { x.maxItem = c; capped = true; } }
  if (capped && d.med != null) { const out = d.out != null ? d.out : d.med - (d.sellFee || 0) - d.cost - d.profit, it = isAuction(d) ? x.maxBid : x.maxItem;
    x.profitAtMax = Math.round((d.med - (d.sellFee || 0) - out - (it + ship + fee(it))) * 100) / 100; }
  return x;
}
export const STARTER = ["27386", "139971", "9355", "171485", "177", "164", "80053", "170083", "175669"];

// the settings the app has during the audit (set through the app's own screens)
export const SETTINGS = { cats: STARTER, maxSpend: 0, bpf: true, pack: 1, hidden: [] };

export const isAuction = (d) => /^AUC/i.test(String(d.type || ""));
export const shownProfit = (d) => (isAuction(d) && d.profitAtMax != null ? d.profitAtMax : d.profit);
const feeOn = (d, s) => (d.bpfOn != null ? !!d.bpfOn && s.bpf : s.bpf && !(d.seller && d.seller.biz));
export function returnPct(d, s = SETTINGS) {
  const item = isAuction(d) ? (d.maxItem != null ? d.maxItem : d.maxBid) : d.price;
  if (!known(item) || !known(shownProfit(d))) return null;
  const pay = (item || 0) + (d.ship || 0) + (feeOn(d, s) ? buyerFee(item || 0) : 0) + s.pack;
  return pay > 0 ? Math.round(shownProfit(d) / pay * 100) : null;
}
// can this deal be on screen at all (any filter)?
export function visible(d, s = SETTINGS) {
  if (s.hidden.includes(d.id)) return false;
  const p = shownProfit(d);
  if (!(d.kind === "spares" || (p != null && p > 0))) return false;                 // never list a deal that loses money
  if (s.maxSpend > 0) { const t = isAuction(d) ? d.price + d.ship : d.price + d.ship + (feeOn(d, s) ? buyerFee(d.price) : 0); if (t > s.maxSpend) return false; }
  if (s.cats.length && !s.cats.includes(String(d.cat))) return false;             // category not ticked
  return true;
}
// which filter chip(s) a visible deal belongs to
export function groups(d) {
  const guess = d.kind !== "spares" && d.src === "asking", g = [];
  if (guess) return ["guess"];
  if (d.collect) return ["col"];
  if (d.kind === "spares") return ["spares"];
  g.push("all", isAuction(d) ? "auc" : "bin");
  if ((d.tags || []).includes("Misspelt title")) g.push("mis");
  return g;
}
// what one deal card should say
export function card(d0, s = SETTINGS) {
  const d = limited(d0, s), auc = isAuction(d), mx = d.maxItem != null ? d.maxItem : auc ? d.maxBid : null, under = !auc && mx != null && d.price <= mx;
  const post = postText(d);
  const lo = auc && d.profitAtMax != null ? d.profitAtMax : d.profit, hi = d.profit, range = auc && hi != null && lo != null && hi - lo >= 0.5;
  // Fliptimize card (8 Nov 2026): auctions show profit at your max bid / if it ended now; Buy It Now shows the total cost
  const bidAbove = auc && mx != null && known(d.price) && d.price > mx;
  const profit = bidAbove ? (known(d.profit) ? signed(d.profit) : "—") : auc ? `${known(d.profitAtMax) ? signed(d.profitAtMax) : "—"} / ${known(d.profit) ? signed(d.profit) : "—"}` : known(d.profit) ? signed(d.profit) : "—";
  const src = d.src === "book" ? (d.fill ? (d.bookN ? `From ${Number(d.bookN).toLocaleString("en-GB")} sales` : "Recent sales") : "Sold prices you checked")
    : d.src === "sold" ? `From ${d.n} sale${d.n === 1 ? "" : "s"}` : "No sales yet: asking prices";
  const cost = known(d.cost) ? d.cost : known(d.price) && known(d.ship) ? d.price + d.ship : null;
  return { title: String(d.title), shownTitle: d.title ? String(d.title) : "(No title)", label: d.kind === "spares" ? "Spares or repairs" : auc ? "Auction" : "Buy It Now",
    score: d.kind === "spares" ? null : known(d.score) ? String(d.score) : "Not scored",
    profit: d.kind === "spares" ? null : profit, priceLabel: auc ? "Current bid" : "Cost", price: auc ? (known(d.price) ? gbp(d.price) : "Unknown") : cost != null ? gbp(cost) : null, post,
    bids: auc ? (d.bids ? d.bids + " bid" + (d.bids > 1 ? "s" : "") : "no bids yet") : null,
    secondLabel: auc ? "Bid up to" : null, second: auc ? (mx != null ? gbp(mx) : "—") : null, sells: null, ret: null, src, allow: !d.collect && (d.shipAllow || d.post === "calc" || d.post === "unknown") };
}
// order checks: each sort's key (bigger first), or "ending" (auctions by end time, soonest first, then the rest)
export const SORT_KEYS = {
  score: (d) => d.score, profit: (d) => shownProfit(d), roi: (d) => returnPct(d), newest: (d) => d.created || d.found || 0,
};
export function sortProblems(list, key) {
  const out = [];
  if (key === "ending") {
    const k = (d) => (isAuction(d) && d.end ? d.end : 9e15);
    for (let i = 1; i < list.length; i++) if (k(list[i]) < k(list[i - 1])) out.push(`${list[i - 1].id} before ${list[i].id}`);
    return out;
  }
  const f = SORT_KEYS[key], v = (d) => { const x = f(d); return x == null || Number.isNaN(x) ? -1e9 : x; };
  for (let i = 1; i < list.length; i++) if (v(list[i]) > v(list[i - 1]) + 1e-9) out.push(`${list[i - 1].id} (${v(list[i - 1])}) before ${list[i].id} (${v(list[i])})`);
  return out;
}
