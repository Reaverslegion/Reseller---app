// STAGE 3: data-integrity audit. Compares, record by record:
//   test database  →  what the Scan service sends the app  →  what the app shows on screen  →  the expected results (oracle.mjs)
// Works with any "driver" that can tap and read the app's screen: the Android emulator (tests/android/driver.mjs) or a
// desktop browser during development. Uses ONLY the private test Scan service, its throwaway database and the fake eBay.
import fs from "node:fs";
import * as O from "./oracle.mjs";
import * as DS from "./datasets.mjs";
import * as F from "./scan-flow.mjs";

const AREA = "Deals: app vs database", DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collapse = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
const LOG = []; // every discrepancy, in full (the report table shows the first few of each)

// ---------- reading the screen ----------
const READ = `(()=>{const app=document.getElementById("app"),T=app.innerText,m=T.match(/(\\d[\\d,]*) deals?\\b/);
  const chips={};document.querySelectorAll("#chips button").forEach(b=>{const x=b.innerText.trim().match(/^(.*?)\\s+(\\d+)$/);if(x)chips[x[1]]=+x[2]});
  const cards=[...document.querySelectorAll(".dcard")].map(c=>{const t=c.querySelector('.dbody div[style*="font-weight:700"]');
    return{aria:c.getAttribute("aria-label"),title:t?t.innerText.replace(/^NEW\\s+/,""):"",text:c.innerText,img:!!c.querySelector(".dbody img")}});
  const bad=(T.match(/.{0,40}(\\bundefined\\b|\\bNaN\\b|\\bnull\\b|\\[object Object\\]).{0,40}/)||[])[0]||null;
  return{count:m?+m[1].replace(/,/g,""):0,empty:/No deals right now/.test(T),chips,cards,bad,loading:/Loading deals…/.test(T),err:(app.querySelector(".card.bad")||{}).innerText||"",
    sort:(document.getElementById("ds")||{}).value||"",filter:(document.querySelector("#chips button:not(.s)")||{}).innerText||""}})()`;

// one card's text → its values (the card's own labels say which number is which)
export function parseCard(text) {
  const L = text.split("\n").map((x) => x.trim()).filter(Boolean), at = (re) => L.findIndex((x) => re.test(x));
  const o = { label: L[0] || "" };
  const si = at(/^(High|Medium|Low)$/); o.score = si >= 0 ? L[si + 1] : null;
  const pi = at(/^Est\. (profit|loss)( if you win)?$/); o.profit = pi >= 0 ? L[pi + 2] : null;
  const ci = at(/^(Buy it now|Current bid)$/); if (ci >= 0) { o.priceLabel = L[ci]; o.price = L[ci + 1]; o.note = L[ci + 2]; }
  const xi = L.findIndex((x, i) => i > ci && /^(Max offer|Your max bid|Max item price|Sells for about)$/.test(x)); if (xi >= 0) { o.secondLabel = L[xi]; o.second = L[xi + 1]; }
  const sl = L.find((x) => /^Sells for about £/.test(x)); o.sells = sl ? (sl.match(/^Sells for about (-?£[\d,]+)/) || [])[1] : null;
  const rl = L.find((x) => /\d+% return$/.test(x)); o.ret = rl ? rl.match(/(-?\d+)% return$/)[1] + "%" : null;
  const fl = L.find((x) => /^(From .*›|From sold prices you checked|Guess from)/.test(x)); o.src = fl ? fl.replace(/ ›.*$/, "").replace(/ · estimate$/, "") : null;
  return o;
}
// compare one card with what it should say
function cardProblems(d, shown) {
  const e = O.card(d), p = parseCard(shown.text), out = [];
  const want = (f, exp, got) => { if (exp != null && collapse(exp) !== collapse(got)) out.push({ id: d.id, field: f, expected: exp, shown: got == null ? "(missing)" : got }); };
  if (shown.aria !== String(d.title)) out.push({ id: d.id, field: "title (exact)", expected: d.title, shown: shown.aria });
  want("title on screen", collapse(d.title), collapse(shown.title));
  if (!p.label.startsWith(e.label)) out.push({ id: d.id, field: "type label", expected: e.label + "…", shown: p.label });
  if (d.kind === "spares") return out;
  want("score", e.score, p.score); want("profit", e.profit, p.profit); want("price label", e.priceLabel, p.priceLabel); want("price", e.price, p.price);
  want("postage", e.bids ? e.bids + " · " + e.post : e.post, p.note); want("second box label", e.secondLabel, p.secondLabel); want("second box", e.second, p.second);
  want("sells for", e.sells, p.sells); want("return", e.ret, p.ret); want("price source", e.src, p.src);
  if (!!d.img !== shown.img) out.push({ id: d.id, field: "picture", expected: d.img ? "shown" : "none", shown: shown.img ? "shown" : "none" });
  return out;
}
// which deal a card is (titles in the datasets are unique; duplicates are told apart by order)
function matchCards(cards, deals) {
  const byTitle = new Map(); for (const d of deals) { const k = String(d.title); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(d); }
  const used = new Set(), pairs = [], unknown = [];
  for (const c of cards) { const L = byTitle.get(c.aria) || [], d = L.find((x) => !used.has(x.id)); if (d) { used.add(d.id); pairs.push([d, c]); } else unknown.push(c.aria); }
  return { pairs, unknown, shownIds: new Set(pairs.map((p) => p[0].id)) };
}

export async function runAudit(drv, R, opt = {}) {
  const S = { ...O.SETTINGS, hidden: [] };
  const check = (name, ok, detail = "", partial = false) => { R.add(AREA, name, ok ? "PASS" : partial ? "PARTIALLY TESTED" : "FAIL", String(detail).slice(0, 300)); return ok; };
  const note = (name, list) => { if (list.length) LOG.push({ check: name, count: list.length, items: list.slice(0, 200) }); };
  const live = async () => (await F.query("SELECT id, data, created, expires FROM deals WHERE expires>?", [Date.now()])).map((r) => ({ ...JSON.parse(r.data), found: r.created }));
  const seed = async (deals, expiredIds = []) => {
    const now = Date.now(), sql = [["DELETE FROM deals"]];
    for (const d of deals) sql.push(["INSERT INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)", [d.id, JSON.stringify(d), d.score || 0, now - 60000, expiredIds.includes(d.id) ? now - DAY : now + 2 * DAY]]);
    for (let i = 0; i < sql.length; i += 200) await F.seedSql(sql.slice(i, i + 200));
  };
  const relaunch = async () => { const t = Date.now(); await drv.relaunch();
    await drv.waitFor(`!!document.querySelector(".dcard")||/No deals right now|Pick what to hunt/.test(document.getElementById("app").innerText)`, 120000, "deals or 'No deals right now'");
    await sleep(1500); return Date.now() - t; };
  const read = () => drv.eval(READ);

  // compare database → Scan service → screen for the deals in the database right now
  async function compareAll(name, { expectAll = true, shot = true } = {}) {
    const db = await live(), api = (await F.call("deals=1")).deals, st = await read();
    if (shot) await drv.shot(name);
    // 1. database → Scan service
    const apiIds = api.map((d) => String(d.id)), apiSet = new Set(apiIds), dbIds = db.map((d) => String(d.id));
    const missingApi = dbIds.filter((id) => !apiSet.has(id)), dupApi = apiIds.filter((id, i) => apiIds.indexOf(id) !== i);
    const changed = api.filter((a) => { const d = db.find((x) => String(x.id) === String(a.id)); return d && ["price", "ship", "profit", "title", "med", "score"].some((k) => JSON.stringify(d[k]) !== JSON.stringify(a[k])); }).map((a) => a.id);
    note(`${name}: in database but not sent to the app`, missingApi); note(`${name}: sent twice`, dupApi); note(`${name}: values changed between database and app`, changed);
    check(`${name} › Scan service sends every deal in the database (${db.length} in database, ${api.length} sent)`, !missingApi.length, missingApi.length ? `${missingApi.length} deals never reach the app, e.g. ${missingApi.slice(0, 3).join(", ")}` : "");
    check(`${name} › Scan service sends no deal twice and changes no values`, !dupApi.length && !changed.length, dupApi.length ? `sent twice: ${dupApi.slice(0, 3)}` : changed.length ? `values differ: ${changed.slice(0, 3)}` : "");
    // 2. what should be on screen (every live deal in the database, by the rules) vs what is
    const should = db.filter((d) => O.visible(d, S) && O.groups(d).includes("all")), { pairs, unknown, shownIds } = matchCards(st.cards, db);
    const missing = should.filter((d) => !shownIds.has(String(d.id))).map((d) => d.id), extra = pairs.filter(([d]) => !should.some((x) => x.id === d.id)).map(([d]) => d.id);
    const dupScreen = st.cards.map((c) => c.aria).filter((t, i, a) => a.indexOf(t) !== i && !db.filter((d) => d.title === t).length > 1);
    note(`${name}: should be on screen but isn't`, missing); note(`${name}: on screen but shouldn't be`, extra.concat(unknown));
    check(`${name} › deal count on screen (expected ${should.length})`, st.count === should.length && st.cards.length === should.length, `count line says ${st.count}, ${st.cards.length} cards shown${st.empty ? ", 'No deals right now'" : ""}`);
    check(`${name} › no missing deals`, !missing.length, missing.length ? `${missing.length} missing, e.g. ${missing.slice(0, 3).join(", ")}` : "");
    check(`${name} › no extra or unknown deals`, !extra.length && !unknown.length, [...extra, ...unknown].slice(0, 3).join(", "));
    check(`${name} › no deal shown twice`, !dupScreen.length, dupScreen.slice(0, 3).join(", "));
    // 3. every value on every card
    const probs = pairs.flatMap(([d, c]) => cardProblems(d, c));
    note(`${name}: card values that differ from the database`, probs);
    const byField = {}; probs.forEach((p) => (byField[p.field] = (byField[p.field] || 0) + 1));
    check(`${name} › every value on every card matches the database (${pairs.length} cards checked)`, !probs.length,
      probs.length ? Object.entries(byField).map(([f, n]) => `${f}: ${n}`).join(", ") + ` · e.g. #${probs[0].id} ${probs[0].field}: expected "${probs[0].expected}", shown "${probs[0].shown}"` : "");
    check(`${name} › nothing on screen says undefined / NaN / null`, !st.bad, st.bad || "");
    if (expectAll === false) return { db, api, st, should, pairs };
    return { db, api, st, should, pairs, missing, probs };
  }

  // ===== 1. empty database =====
  await R.journey(AREA, "Empty database", async (step) => {
    await step("database emptied and app reopened", async () => { await seed([]); await relaunch(); });
    await step("compare", async () => { const st = await read(); await drv.shot("empty database");
      check("Empty database › 'No deals right now', count 0, every filter 0", st.empty && st.cards.length === 0 && Object.values(st.chips).every((n) => n === 0), JSON.stringify(st.chips)); });
  });

  // ===== 2. deals made by the Scan service itself from fake eBay listings (profit, cost, postage end to end) =====
  let genAuction = null;
  await R.journey(AREA, "Deals made by a real scan", async (step) => {
    await step("price book filled with 90 fake sold prices (3 models)", async () => { await seed([]); await F.call("fill=1", { cat: "27386", catName: "Graphics Cards", cond: "used", rows: F.soldRows(3) }); });
    const L = []; let id = 700000000000;
    F.MODELS.forEach((m) => [0.5, 0.62, 0.74, 0.86].forEach((f) => L.push(F.listing({ id: ++id, title: `${m.title.replace(" Graphics Card", "")} used #${id}`, price: Math.round(m.base * f * 100) / 100, ship: 4.99 }))));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB free postage #${id}`, price: 140, ship: 0 }));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB postage calculated by eBay #${id}`, price: 150, calcShip: true }));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB collection only #${id}`, price: 145, noShip: true, pickup: true }));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB business seller #${id}`, price: 160, ship: 4.99, business: true }));
    L.push(F.listing({ id: (genAuction = String(++id)), title: `NVIDIA GeForce RTX 3070 8GB auction #${id}`, price: 120, ship: 6.5, type: "AUC", bids: 3, endsIn: 3 }));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB too dear #${id}`, price: 250, ship: 4.99 }));
    await step("fake eBay has 18 listings; Scan now tapped in the app", async () => { await F.fakeSearch(L); await drv.relaunch();
      await drv.waitText("Scan now", 20000); await drv.tap("Scan now"); await drv.waitText("Checked|new deal|Check had problems|Just scanned", 90000); await sleep(2500); });
    await step("compare database, Scan service and screen", async () => {
      const db = await live(), book = await F.query("SELECT pkey, avg, post FROM prices");
      // the sums, worked out again independently for every deal the scan made
      const sums = [];
      for (const d of db) {
        const b = book.find((x) => x.pkey === d.pkey), fee = d.bpfOn ? O.buyerFee(d.price) : 0, out = (b && b.post != null ? b.post : 5) + 1;
        const cost = Math.round((d.price + d.ship + fee) * 100) / 100, med = b ? Math.round((b.avg + (b.post || 0)) * 100) / 100 : null, profit = Math.round((d.med - out - d.cost) * 100) / 100;
        if (Math.abs(cost - d.cost) > 0.011) sums.push({ id: d.id, field: "cost (price + postage + buyer fee)", expected: cost, stored: d.cost });
        if (Math.abs(profit - d.profit) > 0.011) sums.push({ id: d.id, field: "profit (sells for − postage out − packing − cost)", expected: profit, stored: d.profit });
        if (med != null && Math.abs(med - d.med) > 0.011) sums.push({ id: d.id, field: "sells for (price book + its postage)", expected: med, stored: d.med });
        if (O.isAuction(d)) { const pa = Math.round((d.med - out - (d.maxBid + d.ship + (d.bpfOn ? O.buyerFee(d.maxBid) : 0))) * 100) / 100; if (Math.abs(pa - d.profitAtMax) > 0.011) sums.push({ id: d.id, field: "profit at max bid", expected: pa, stored: d.profitAtMax }); }
        if (d.seller && d.seller.biz && d.bpfOn) sums.push({ id: d.id, field: "buyer fee on a business seller", expected: "no fee", stored: "fee added" });
      }
      note("real scan: sums that don't add up", sums);
      check(`Deals made by a real scan › ${db.length} deals made; profit, cost, sells-for and max-bid sums all correct`, db.length >= 8 && !sums.length, sums.length ? `${sums.length} wrong, e.g. #${sums[0].id} ${sums[0].field}: expected ${sums[0].expected}, stored ${sums[0].stored}` : `${db.length} deals`);
      const calc = db.find((d) => /calculated by eBay/.test(d.title)), tooDear = db.find((d) => /too dear/.test(d.title));
      check("Deals made by a real scan › a listing whose postage eBay calculates (no fixed price) is not treated as free postage",
        !calc || !(calc.ship === 0 && !calc.collect), calc ? `stored postage £${calc.ship}, collection only: ${!!calc.collect} → the card says "free post" and profit leaves postage out` : "listing wasn't made into a deal");
      check("Deals made by a real scan › a listing priced above what makes £20 profit is not a deal", !tooDear, tooDear ? `#${tooDear.id} profit ${tooDear.profit}` : "");
      await compareAll("Deals made by a real scan");
    });
  });

  // ===== 3. a live re-check changes an auction's price: do price and profit stay consistent? =====
  await R.journey(AREA, "Live price change (auction bid goes up)", async (step) => {
    let before;
    await step("the auction's bid rises from £120 to £150 on the fake eBay", async () => {
      before = (await live()).find((d) => d.id === genAuction); if (!before) throw new Error("the auction deal from the real scan isn't there");
      const it = F.listing({ id: genAuction, title: before.title, price: 150, ship: 6.5, type: "AUC", bids: 6, endsIn: 3 });
      await fetch("http://127.0.0.1:8788/__fake/items", { method: "POST", body: JSON.stringify([it]) }); });
    await step("open the deal in the app (it checks the live listing), then go back", async () => {
      await drv.tap({ sel: ".dcard", text: "auction #" + genAuction }); await sleep(6000); await drv.shot("auction after bid rise"); await drv.back(); await sleep(1500); });
    await step("compare", async () => {
      const d = (await live()).find((x) => x.id === genAuction), st = await read(), c = st.cards.find((x) => x.aria === (d || before).title);
      if (!d) { check("Live price change › deal still listed after the bid rose (still under the max bid)", false, "the deal was removed"); return; }
      const out = d.out != null ? d.out : 5.99, expect = Math.round((d.med - (d.sellFee || 0) - out - (d.price + d.ship + (d.bpfOn ? O.buyerFee(d.price) : 0))) * 100) / 100;
      check("Live price change › database has the new bid (£150)", d.price === 150, `stored £${d.price}`);
      check("Live price change › profit at today's bid updated to match the new bid", Math.abs(d.profit - expect) < 0.011, `bid £${d.price}: profit should be ${O.signed(expect)}, stored ${O.signed(d.profit)} (still worked out from the old £${before.price} bid)`);
      const pc = c ? parseCard(c.text).profit : null, want = `${O.signed(d.profitAtMax)} to ${O.signed(expect)}`;
      check("Live price change › card shows profit at the new bid (right after the check)", pc === want, `card "${pc}", correct "${want}"`);
    });
    await step("close and reopen the app", async () => { await relaunch(); await sleep(1500);
      const d = (await live()).find((x) => x.id === genAuction), st = await read(), c = d && st.cards.find((x) => x.aria === d.title);
      const expect = d ? Math.round((d.med - (d.sellFee || 0) - (d.out != null ? d.out : 5.99) - (d.price + d.ship + (d.bpfOn ? O.buyerFee(d.price) : 0))) * 100) / 100 : null;
      const pc = c ? parseCard(c.text).profit : null, want = d ? `${O.signed(d.profitAtMax)} to ${O.signed(expect)}` : "";
      check("Live price change › after reopening, the card still shows profit at the new bid", pc === want, `card "${pc}", correct "${want}"`); await drv.shot("auction after reopen"); });
  });

  // ===== 4. unusual and incomplete records =====
  const E = DS.edge();
  await R.journey(AREA, "Unusual and incomplete records", async (step) => {
    await step(`${E.length} unusual records loaded (1 expired)`, async () => { await seed(E.map((x) => x.d), E.filter((x) => x.expect.expired).map((x) => x.d.id)); await relaunch(); });
    await step("compare", async () => {
      const r = await compareAll("Unusual and incomplete records");
      // record by record: hidden when they should be, in the right filter, and a sensible display for missing values
      for (const { note: n, d, expect: x } of E) {
        const on = r.pairs.find(([p]) => p.id === d.id), tag = x.realWorld ? "" : " (robustness: the Scan service doesn't make records like this today)";
        if (x.hidden || x.expired) { check(`Unusual records › ${n}`, !on, on ? "shown" : ""); continue; }
        if (x.chip) { check(`Unusual records › ${n}: not in All, only under its own filter`, !on, on ? "shown in All" : ""); continue; }
        if (!on) { check(`Unusual records › ${n}: shown`, false, "not on screen"); continue; }
        const c = on[1], p = parseCard(c.text), probs = cardProblems(d, c);
        if (d.price == null) { check(`Unusual records › ${n}: not shown as £0.00${tag}`, p.price !== "£0.00", `price shows "${p.price}"`); continue; }
        if (d.ship == null && !d.collect) { check(`Unusual records › ${n}: not shown as "free post"${tag}`, !/free post$/.test(p.note || ""), `postage shows "${p.note}"`); continue; }
        if (d.med == null) { check(`Unusual records › ${n}: no made-up "sells for"${tag}`, p.sells !== "£0", `sells for shows "${p.sells}"`); continue; }
        if (d.score == null) { check(`Unusual records › ${n}: no "null" score${tag}`, p.score !== "null", `score shows "${p.score}"`); continue; }
        if (d.title === "") { check(`Unusual records › ${n}: card still usable${tag}`, true, "shown with an empty title"); continue; }
        check(`Unusual records › ${n}: shown exactly`, !probs.length, probs.map((q) => `${q.field}: "${q.shown}" (expected "${q.expected}")`).slice(0, 2).join("; "));
      }
      const st = await read(), chips = st.chips, exp = (g) => E.filter(({ d, expect: x }) => !x.expired && O.visible(d, S) && O.groups(d).includes(g)).length;
      check("Unusual records › filter counts (Collection, Guesses) match", (chips["Collection"] || 0) === exp("col") && (chips["Guesses"] || 0) === exp("guess"), `Collection ${chips["Collection"]} (expected ${exp("col")}), Guesses ${chips["Guesses"]} (expected ${exp("guess")})`);
    });
  });

  // ===== 5. filters, search, category and spend limit; 6. sorting =====
  const MIX = [...DS.scale(70, 810000000000), ...E.filter((x) => !x.expect.expired && x.expect.realWorld).map((x) => x.d)];
  await R.journey(AREA, "Filters and search", async (step) => {
    await step(`${MIX.length} mixed deals loaded`, async () => { await seed(MIX); await relaunch(); });
    const vis = () => MIX.filter((d) => O.visible(d, S));
    const setOf = (cards) => new Set(matchCards(cards, MIX).pairs.map(([d]) => d.id));
    const same = (name, got, want) => { const miss = want.filter((id) => !got.has(id)), extra = [...got].filter((id) => !want.includes(id)); note(name + ": missing", miss); note(name + ": extra", extra);
      return check(name, !miss.length && !extra.length, `${want.length} expected, ${got.size} shown${miss.length ? ", missing " + miss.slice(0, 2) : ""}${extra.length ? ", extra " + extra.slice(0, 2) : ""}`); };
    for (const [chip, g] of [["Buy It Now", "bin"], ["Auctions", "auc"], ["Collection", "col"], ["All", "all"]]) {
      await step(`filter: ${chip}`, async () => { await drv.tap({ sel: "#chips button", text: chip }); await sleep(1200); const st = await read();
        const want = vis().filter((d) => O.groups(d).includes(g)).map((d) => d.id);
        check(`Filter ${chip} › count on its button`, st.chips[chip] === want.length, `button says ${st.chips[chip]}, expected ${want.length}`);
        same(`Filter ${chip} › exactly the right deals`, setOf(st.cards), want); });
    }
    await step("search 'rtx 3060'", async () => { await drv.tap({ sel: ".dsrch" }); await sleep(800); await drv.fill({ sel: "#dq" }, "rtx 3060"); await sleep(1500); const st = await read();
      same("Search 'rtx 3060' › exactly the deals whose title contains it", setOf(st.cards), vis().filter((d) => O.groups(d).includes("all") && String(d.title).toLowerCase().includes("rtx 3060")).map((d) => d.id));
      await drv.shot("search rtx 3060"); await drv.tap({ sel: ".dsrch" }); await sleep(800); });
    await step("category: Graphics Cards", async () => { await drv.tap({ sel: "#dc" }); await sleep(1500); await drv.tap({ sel: "#pick button", text: "Graphics Cards" }); await sleep(1500); const st = await read();
      same("Category Graphics Cards › exactly the graphics card deals", setOf(st.cards), vis().filter((d) => O.groups(d).includes("all") && String(d.cat) === "27386").map((d) => d.id));
      await drv.tap({ sel: "#dc" }); await sleep(1500); await drv.tap({ sel: "#pick button", text: "All (" }); await sleep(1500); });
    await step("spend limit £150 (Menu › Most I'll spend)", async () => { await drv.menu(); await sleep(1000);
      await drv.fill({ sel: "#r_maxPrice" }, "150"); await sleep(1500); await drv.dealsTab(); await sleep(2000); S.maxSpend = 150; const st = await read();
      same("Spend limit £150 › exactly the deals costing £150 or less in total", setOf(st.cards), vis().filter((d) => O.groups(d).includes("all")).map((d) => d.id));
      const over = matchCards(st.cards, MIX).pairs.filter(([d]) => (O.isAuction(d) ? d.price + d.ship : d.price + d.ship + O.buyerFee(d.price)) > 150.0001).map(([d]) => d.id);
      check("Spend limit £150 › no deal over the limit is shown", !over.length, over.slice(0, 3).join(", "));
      const mb = matchCards(st.cards, MIX).pairs.filter(([d, c]) => O.isAuction(d) && (() => { const v = parseFloat(String(parseCard(c.text).second).replace(/[£,]/g, "")); return v + d.ship > 150.01; })()).map(([d]) => d.id);
      check("Spend limit £150 › straight after setting it, no max bid shown above the limit", !mb.length, mb.length ? `${mb.length} auctions still show their old, higher max bid until the deals reload, e.g. ${mb.slice(0, 3).join(", ")}` : "");
      await drv.shot("spend limit 150");
      // the app lowers max bids to the limit when it loads deals: check after reopening, and that "profit at your max bid" follows
      await relaunch(); const st3 = await read(), P = matchCards(st3.cards, MIX).pairs.filter(([d]) => O.isAuction(d));
      const overBid = [], wrongLow = [];
      for (const [d, c] of P) { const pc = parseCard(c.text), mb = parseFloat(String(pc.second).replace(/[£,]/g, "")); if (mb + d.ship > 150.01) overBid.push(d.id);
        const cap = Math.floor((150 - (d.ship || 0)) * 100) / 100;
        if (d.maxBid > cap) { const lowExp = Math.round((d.med - (d.sellFee || 0) - 5.99 - (cap + d.ship + O.buyerFee(cap))) * 100) / 100, low = String(pc.profit).split(" to ")[0];
          if (low !== O.signed(lowExp)) wrongLow.push({ id: d.id, field: "profit at your max bid", expected: O.signed(lowExp), shown: low }); } }
      note("Spend limit: profit at max bid not updated", wrongLow);
      check("Spend limit £150 › after reopening, no max bid goes above the limit", !overBid.length, overBid.slice(0, 3).join(", "));
      check("Spend limit £150 › 'profit at your max bid' matches the lowered max bid", !wrongLow.length, wrongLow.length ? `${wrongLow.length} auctions, e.g. #${wrongLow[0].id}: shows ${wrongLow[0].shown}, at the lowered max bid it's ${wrongLow[0].expected}` : "");
      await drv.menu(); await sleep(1000); await drv.fill({ sel: "#r_maxPrice" }, ""); await sleep(1200); S.maxSpend = 0; await drv.dealsTab(); await sleep(1500);
      // the lowered max bids stay until the deals reload (same cause as above): reopen so later checks start clean
      const st4 = await read(), still = matchCards(st4.cards, MIX).pairs.filter(([d, c]) => O.isAuction(d) && parseCard(c.text).second !== O.card(d).second).length;
      check("Spend limit removed › max bids go back to normal without reopening the app", !still, still ? `${still} auctions keep the lowered max bid until the app reloads deals` : "");
      await relaunch(); });
  });
  await R.journey(AREA, "Sorting", async (step) => {
    for (const [label, key] of [["Best score", "score"], ["Most profit", "profit"], ["Best return", "roi"], ["Ending soon", "ending"], ["Newest", "newest"], ["Best now", null]]) {
      await step(`sort: ${label}`, async () => { await drv.tap({ sel: "#ds" }); await sleep(1500); await drv.tap({ sel: "#pick button", text: label }); await sleep(1800);
        const st = await read(), list = matchCards(st.cards, MIX).pairs.map(([d]) => d);
        if (!key) { check(`Sort ${label} › same deals as the list (order is a judgement, so only the set is checked)`, list.length === st.count, `${list.length} cards, count ${st.count}`, false); return; }
        const pr = O.sortProblems(list, key); note(`Sort ${label}: out of order`, pr);
        check(`Sort ${label} › every deal in the right order (${list.length} deals)`, !pr.length, pr.slice(0, 2).join("; ")); });
    }
    await step("sort back to Best now", async () => { await drv.tap({ sel: "#ds" }); await sleep(1500); await drv.tap({ sel: "#pick button", text: "Best now" }); await sleep(1200); });
  });

  // ===== 7. hide a deal; 8. close and reopen; 9. updates in the database; 10. expired deals =====
  await R.journey(AREA, "Hide, reopen, updates and expiry", async (step) => {
    let hid, snap;
    await step("Hide the first deal", async () => { const st = await read(); hid = matchCards(st.cards, MIX).pairs[0][0]; await drv.tap({ sel: ".dcard .dbtn.quiet", text: "Hide" }); await sleep(1500);
      const st2 = await read(), gone = !matchCards(st2.cards, MIX).shownIds.has(hid.id); S.hidden.push(hid.id);
      check("Hide › the hidden deal disappears and the count drops by 1", gone && st2.count === st.count - 1, `count ${st.count} → ${st2.count}`);
      check("Hide › the deal is still in the database (hiding only affects this phone)", (await live()).some((d) => d.id === hid.id), ""); snap = st2; });
    await step("close and reopen the app", async () => { await relaunch(); const st = await read();
      check("Reopen › the hidden deal stays hidden", !matchCards(st.cards, MIX).shownIds.has(hid.id), "");
      // the first line of a card ("listed 5 min ago", "2h 3m left") changes with time, so it's left out
      const k = (c) => c.aria + "|" + c.text.split("\n").slice(1).join("\n"), a = snap.cards.map(k), b = st.cards.map(k), diff = a.filter((x, i) => b[i] !== x).length;
      check("Reopen › exactly the same deals, in the same order, with the same values", a.length === b.length && !diff, `${a.length} before, ${b.length} after, ${diff} cards differ`); });
    const upd = MIX[5], del = MIX[6], exp = MIX[7], ren = MIX[8], add = DS.deal(819999999999, 3, { title: "Added after first load #819999999999" });
    await step("database changed: 1 new price, 1 deleted, 1 expired, 1 renamed, 1 added; app reopened", async () => {
      const nu = { ...upd, price: Math.round((upd.price - 10) * 100) / 100 }; nu.cost = Math.round((nu.price + nu.ship + O.buyerFee(nu.price)) * 100) / 100; nu.profit = Math.round((nu.med - 5.99 - nu.cost) * 100) / 100;
      Object.assign(upd, nu); ren.title = "Renamed deal #" + ren.id;
      await F.seedSql([["UPDATE deals SET data=? WHERE id=?", [JSON.stringify(upd), upd.id]], ["DELETE FROM deals WHERE id=?", [del.id]], ["UPDATE deals SET expires=? WHERE id=?", [Date.now() - 1000, exp.id]],
        ["UPDATE deals SET data=? WHERE id=?", [JSON.stringify(ren), ren.id]], ["INSERT INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)", [add.id, JSON.stringify(add), add.score, Date.now(), Date.now() + DAY]]]);
      MIX.splice(MIX.indexOf(del), 1); MIX.push(add); await relaunch(); });
    await step("compare", async () => { const st = await read(), m = matchCards(st.cards, MIX), c = (d) => m.pairs.find(([x]) => x.id === d.id);
      check("Updates › new price and profit shown", !!c(upd) && !cardProblems(upd, c(upd)[1]).length, c(upd) ? cardProblems(upd, c(upd)[1]).map((p) => p.field + ": " + p.shown).join("; ") : "not shown");
      check("Updates › deleted deal gone", !st.cards.some((x) => x.aria === del.title), "");
      check("Updates › expired deal gone (still in the database, not sent)", !m.shownIds.has(exp.id), "");
      check("Updates › renamed deal shows its new title", m.shownIds.has(ren.id), "");
      check("Updates › added deal shown", m.shownIds.has(add.id), "");
      await compareAll("After updates"); });
  });

  // ===== 11. large datasets: 200, 500, 837, 1,000 and 1,500 deals =====
  for (const n of opt.sizes || [200, 500, 837, 1000, 1500]) {
    await R.journey(AREA, `${n.toLocaleString("en-GB")} deals`, async (step) => {
      let ms = 0;
      await step(`${n} deals loaded into the test database`, async () => { await seed(DS.scale(n, 830000000000 + n * 10000)); ms = await relaunch(); });
      await step("compare", async () => { const r = await compareAll(`${n.toLocaleString("en-GB")} deals`);
        check(`${n.toLocaleString("en-GB")} deals › all deals on one list (the app has no 'load more')`, r.st.cards.length === r.should.length, `${r.st.cards.length} of ${r.should.length} shown`);
        R.add(AREA, `${n.toLocaleString("en-GB")} deals › time to open and show them`, ms < 30000 ? "PASS" : "FAIL", `${(ms / 1000).toFixed(1)} s from opening the app to cards on screen`); });
    });
  }
  fs.mkdirSync("results", { recursive: true });
  fs.writeFileSync("results/integrity-discrepancies.json", JSON.stringify(LOG, null, 1));
  return LOG;
}
