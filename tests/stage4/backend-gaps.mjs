// Master audit gap tests (G6, G8) on the PRIVATE TEST Scan service + fake eBay only:
//  - listings eBay sends in another currency, or with no price, never become deals
//  - two manual scans and the background job at the same moment: no server error, no duplicates, same deals as one scan
//  - eBay throttling (429), eBay errors (500) and broken answers: the scan reports a problem, nothing crashes, and the
//    deals you already have are NOT wiped
// Run: TEST_APP_KEY=... node tests/stage4/backend-gaps.mjs
import fs from "node:fs";
import * as F from "../integrity/scan-flow.mjs";
const URL_ = "http://127.0.0.1:8787", EBAY = "http://127.0.0.1:8788", rows = [], AREA = "Back end (gap tests)";
const add = (name, ok, detail = "", status) => { const s = status || (ok ? "PASS" : "FAIL"); rows.push({ area: AREA, name, status: s, detail: String(detail).slice(0, 300) }); console.log(s.padEnd(17), name, detail ? "— " + String(detail).slice(0, 220) : ""); };
const raw = (q) => fetch(`${URL_}/?${q}`, { headers: { "X-FlipScout-Key": process.env.TEST_APP_KEY } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const mode = (m) => fetch(`${EBAY}/__fake/mode`, { method: "POST", body: JSON.stringify({ mode: m }) });
const deals = async () => (await F.query("SELECT id, data FROM deals")).map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // a price book (90 fake sold prices) and 16 listings, two of them unusual
  await mode("normal");
  await F.seedSql([["DELETE FROM deals"], ["DELETE FROM listings"]], { config: F.CONFIG, keyver: 3, fix1: true, rate: { h: 0, n: {} } });
  await F.call("fill=1", { cat: "27386", catName: "Graphics Cards", cond: "used", rows: F.soldRows(7) });
  const L = []; let id = 760000000000;
  F.MODELS.forEach((m) => [0.5, 0.6, 0.7, 0.8].forEach((f) => L.push(F.listing({ id: ++id, title: `${m.title.replace(" Graphics Card", "")} used #${id}`, price: Math.round(m.base * f * 100) / 100, ship: 4.99 }))));
  const eur = F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB euro listing #${id}`, price: 90, ship: 4.99 }); eur.price.currency = "EUR"; eur.shippingOptions[0].shippingCost.currency = "EUR";
  const nop = F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB no price #${id}`, price: 90, ship: 4.99 }); delete nop.price;
  const usd = F.listing({ id: ++id, title: `AMD Radeon RX 6700 XT 12GB dollar listing #${id}`, price: 80, ship: 4.99 }); usd.price = { value: "80", currency: "USD", convertedFromCurrency: "USD" };
  L.push(eur, nop, usd); await F.fakeSearch(L);

  // 1. one scan, as the reference
  await F.seedSql([], { lastRun: 0, lastManual: 0 }); const one = await raw("run=1"); const base = await deals();
  add(`a scan of ${L.length} listings works (${base.length} deals)`, one.status < 400 && base.length >= 6, `answered ${one.status}`);
  const bad = base.filter((d) => [eur, nop, usd].some((x) => x.legacyItemId === String(d.id)));
  add("listings in another currency, or with no price, never become deals", !bad.length, bad.map((d) => `${d.title}: price ${d.price}`).join("; ") || "none became deals");
  const nan = base.filter((d) => ["price", "ship", "cost", "profit", "med"].some((k) => d[k] != null && !Number.isFinite(+d[k])));
  add("no deal has a missing or not-a-number money figure", !nan.length, nan.map((d) => d.id).join(", "));

  // 2. two manual scans and the background job at the same moment
  await F.seedSql([["DELETE FROM deals"], ["DELETE FROM listings"]], { lastRun: 0, lastManual: 0, rate: { h: 0, n: {} } });
  const q0 = (await F.query("SELECT v FROM kv WHERE k='quota'"))[0];
  const all = await Promise.all([raw("run=1"), raw("run=1"), fetch(`${URL_}/__scheduled`).then((r) => ({ status: r.status }))]);
  add("…a second manual scan at the same moment is politely refused (429 'Just scanned'), not run twice", all.filter((r) => r.status === 429).length >= 1, all.map((r) => r.status).join(", "));
  await sleep(3000);
  const after = await deals(), ids = after.map((d) => d.id), dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  const lst = (await F.query("SELECT COUNT(*) n, COUNT(DISTINCT id) u FROM listings"))[0], q1 = (await F.query("SELECT v FROM kv WHERE k='quota'"))[0];
  add("two scans and the background job at once: no server error", all.every((r) => r.status < 500), all.map((r) => r.status).join(", "));
  add("…and no duplicate deals or listings", !dup.length && lst.n === lst.u, `${after.length} deals, ${lst.n} listings (${lst.u} different)`);
  const same = after.length === base.length && base.every((d) => after.some((x) => x.id === d.id && Math.abs(x.profit - d.profit) < 0.011));
  add("…and the same deals with the same profits as a single scan", same, `single scan ${base.length}, at once ${after.length}`);
  add("eBay call counter after simultaneous scans (shown for review: each scan's calls should be counted)", true, `before ${q0 ? q0.v : "none"} · after ${q1 ? q1.v : "none"}`, "PARTIALLY TESTED");

  // 3. eBay misbehaving: deals you already have must stay
  for (const m of ["429", "500", "garbage"]) {
    const before = await deals(); await F.seedSql([], { lastRun: 0, lastManual: 0 }); await mode(m); // (a scan within a minute of the last is refused on purpose)
    const r = await raw("run=1"); await mode("normal");
    const now = await deals(), lost = before.filter((d) => !now.some((x) => x.id === d.id));
    const said = JSON.stringify(r.body).slice(0, 160);
    if (/Just scanned/.test(said)) { add(`eBay ${m}: test could run`, false, "the scan was refused by the 'just scanned' lock, so eBay's error was never reached"); continue; }
    add(`eBay answers ${m === "garbage" ? "with broken data" : "with error " + m}: no crash, existing deals kept (${before.length})`, r.status < 500 && !lost.length,
      `scan answered ${r.status}${lost.length ? `, ${lost.length} deals lost` : ""} · ${said}`);
    add(`eBay ${m}: the scan says there was a problem (not "no new deals")`, /error|problem|fail|429|500|eBay/i.test(said) && !(r.body.errors && !r.body.errors.length), said);
  }
} catch (e) { add("back-end gap tests ran to the end", false, e.message); }
finally { await mode("normal").catch(() => {}); }
fs.mkdirSync("results", { recursive: true });
fs.writeFileSync("results/backend-gaps.json", JSON.stringify(rows, null, 1));
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
