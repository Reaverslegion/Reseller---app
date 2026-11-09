// A fake eBay (and fake Google push service) for the private test Scan service and the test app.
//  - port 8788: fake eBay API. The test copy of worker.js has every eBay/Google address pointed here, so tests never
//    reach the real eBay, never use the real eBay call allowance and never send a phone alert.
//  - port 8790: fake eBay SOLD-LISTINGS web pages, for the app's Fill (the test app's Fill opens these instead of ebay.co.uk).
// Every request is logged to fake-ebay.log. Listings the tests want "for sale" are added with POST /__fake/items.
// Run: node tests/e2e/fake-ebay.mjs
import http from "node:http";
import fs from "node:fs";

const LOG = process.env.FAKE_EBAY_LOG || "fake-ebay.log";
const PORT = +(process.env.FAKE_EBAY_PORT || 8788), SOLD_PORT = +(process.env.FAKE_SOLD_PORT || 8790);
const items = new Map();
let mode = "normal"; // misbehaviour switch for tests (see /__fake/mode)
let search = []; // listings the fake eBay search returns (set by tests with POST /__fake/search)
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const log = (o) => fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + "\n");

// a small category tree containing the app's starter categories
const TREE = { rootCategoryNode: { childCategoryTreeNodes: [
  { category: { categoryId: "58058", categoryName: "Computers/Tablets & Networking" }, childCategoryTreeNodes: [
    { category: { categoryId: "175673", categoryName: "Computer Components & Parts" }, childCategoryTreeNodes: [
      { category: { categoryId: "27386", categoryName: "Graphics Cards" } }, { category: { categoryId: "164", categoryName: "CPUs/Processors" } },
      { category: { categoryId: "170083", categoryName: "Memory (RAM)" } }] },
    { category: { categoryId: "175669", categoryName: "Solid State Drives" } }, { category: { categoryId: "177", categoryName: "PC Laptops & Netbooks" } },
    { category: { categoryId: "171485", categoryName: "Tablets & eBook Readers" } }, { category: { categoryId: "80053", categoryName: "Monitors" } }] },
  { category: { categoryId: "15032", categoryName: "Mobile Phones & Communication" }, childCategoryTreeNodes: [{ category: { categoryId: "9355", categoryName: "Mobile & Smart Phones" } }] },
  { category: { categoryId: "1249", categoryName: "Video Games & Consoles" }, childCategoryTreeNodes: [{ category: { categoryId: "139971", categoryName: "Video Game Consoles" } }] },
] } };

http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d)).on("end", async () => {
    const u = new URL(req.url, "http://x");
    log({ port: PORT, method: req.method, path: u.pathname, query: u.search });
    if (u.pathname === "/__fake/items" && req.method === "POST") { for (const it of JSON.parse(body || "[]")) items.set(String(it.legacyItemId), it); return send(res, 200, { ok: true, n: items.size }); }
    if (u.pathname === "/__fake/items" && req.method === "DELETE") { items.clear(); return send(res, 200, { ok: true }); }
    // TEST CONTROL: make the fake eBay misbehave for its Browse API answers (POST /__fake/mode {"mode": "429"|"500"|"garbage"|"slow"|"stall"|"normal"})
    if (u.pathname === "/__fake/mode" && req.method === "POST") { mode = (JSON.parse(body || "{}").mode) || "normal"; return send(res, 200, { mode }); }
    if (mode !== "normal" && u.pathname.includes("/buy/browse/")) {
      if (mode === "429") { res.writeHead(429, { "content-type": "application/json", "retry-after": "60" }); return res.end(JSON.stringify({ errors: [{ errorId: 2001, message: "Too many requests (fake eBay)" }] })); }
      if (mode === "500") return send(res, 500, { errors: [{ errorId: 10001, message: "System error (fake eBay)" }] });
      if (mode === "garbage") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{\"itemSummaries\": [{\"title\": "); }
      if (mode === "slow") await new Promise((r) => setTimeout(r, 500)); // answers normally, half a second late (long scans)
      if (mode === "stall") await new Promise((r) => setTimeout(r, 120000)); // a stuck connection: no answer for 2 minutes
    }
    if (u.pathname.includes("/oauth2/token") || u.pathname.includes("/identity/v1/oauth2")) return send(res, 200, { access_token: "fake-token", expires_in: 7200, token_type: "Bearer" });
    if (u.pathname === "/__fake/search" && req.method === "POST") { search = JSON.parse(body || "[]"); for (const it of search) items.set(String(it.legacyItemId), it); return send(res, 200, { ok: true, n: search.length }); }
    if (u.pathname.includes("/buy/browse/v1/item_summary/search")) {
      // a small imitation of eBay's search: category, buying format and price range filters, offset and limit
      const q = u.searchParams, cat = q.get("category_ids"), f = q.get("filter") || "", off = +(q.get("offset") || 0), lim = +(q.get("limit") || 50);
      const pr = f.match(/price:\[([\d.]*)\.\.([\d.]*)\]/), auc = /buyingOptions:\{AUCTION\}/.test(f), bin = /buyingOptions:\{FIXED_PRICE\}/.test(f);
      let L = search.filter((it) => (!cat || String(it.categoryId || (it.categories || [{}])[0].categoryId) === cat)
        && (!auc || (it.buyingOptions || []).includes("AUCTION")) && (!bin || (it.buyingOptions || []).includes("FIXED_PRICE"))
        && (!pr || ((+((it.currentBidPrice || it.price || {}).value || 0) >= +(pr[1] || 0)) && (!pr[2] || +((it.currentBidPrice || it.price || {}).value || 0) <= +pr[2]))));
      return send(res, 200, { total: L.length, offset: off, limit: lim, itemSummaries: L.slice(off, off + lim) });
    }
    if (u.pathname.includes("/buy/browse/v1/item/get_item_by_legacy_id")) {
      const id = u.searchParams.get("legacy_item_id");
      return items.has(id) ? send(res, 200, items.get(id)) : send(res, 404, { errors: [{ errorId: 11001, message: "not found (fake eBay)" }] });
    }
    if (u.pathname.includes("/buy/browse/v1/item")) {
      const ids = String(u.searchParams.get("item_ids") || "").split(",").map((x) => (x.split("|")[1] || x));
      return send(res, 200, { items: ids.filter((id) => items.has(id)).map((id) => items.get(id)) });
    }
    if (u.pathname.includes("/commerce/taxonomy/v1/category_tree")) return send(res, 200, TREE);
    if (u.pathname.includes("/commerce/taxonomy")) return send(res, 200, { categorySuggestions: [] });
    if (u.pathname.includes("/ws/api.dll")) { res.writeHead(200, { "content-type": "text/xml" }); return res.end("<GetItemResponse><Ack>Failure</Ack></GetItemResponse>"); }
    if (u.pathname.includes("fcm") || u.pathname.includes("/token")) return send(res, 200, { access_token: "fake", name: "fake-message" });
    send(res, 404, { error: "fake eBay: unknown path" });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`fake eBay API on ${PORT}`));

// ---- fake sold-listings pages (what Fill reads). Pages 1-5 have 24 sold graphics cards each; page 6+ is eBay's "no results" page.
const MODELS = [["NVIDIA GeForce RTX 3070 8GB GDDR6 Graphics Card", 255], ["NVIDIA GeForce RTX 3060 12GB Graphics Card", 185], ["AMD Radeon RX 6700 XT 12GB Graphics Card", 220],
  ["NVIDIA GeForce RTX 4060 8GB Graphics Card", 230], ["NVIDIA GeForce GTX 1660 Super 6GB Graphics Card", 95], ["AMD Radeon RX 580 8GB Graphics Card", 55]];
const DAY = 864e5, MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function soldPage(pg) {
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const [title, base] = MODELS[i % MODELS.length], id = String(300000000000 + pg * 1000 + i);
    const price = (base + ((i * 7 + pg * 3) % 21) - 10).toFixed(2), d = new Date(Date.now() - (pg * 2 + (i % 2) + 1) * DAY);
    const sold = `Sold ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    rows.push(`<li class="s-item"><a href="https://www.ebay.co.uk/itm/${id}"><h3 class="s-item__title">${title}</h3></a>
      <div><span class="s-item__caption">${sold}</span></div><div>Pre-owned</div><div><span class="s-item__price">£${price}</span></div>
      <div>${i % 3 ? "+£4.99 postage" : "Free postage"}</div></li>`);
  }
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Sold graphics cards | eBay (FAKE TEST PAGE)</title></head>
  <body style="font-family:sans-serif"><h1 style="font-size:16px">FAKE eBay sold listings for testing, page ${pg}</h1><ul class="srp-results">${rows.join("")}</ul></body></html>`;
}
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  log({ port: SOLD_PORT, method: req.method, path: u.pathname, query: u.search });
  if (!u.pathname.startsWith("/sch/")) { res.writeHead(404); return res.end("not found"); }
  const pg = +(u.searchParams.get("_pgn") || 1);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(pg <= 5 ? soldPage(pg) : `<!doctype html><html><body><h1>Sorry, we couldn't find that page (FAKE TEST PAGE)</h1></body></html>`);
}).listen(SOLD_PORT, "127.0.0.1", () => console.log(`fake eBay sold pages on ${SOLD_PORT}`));
