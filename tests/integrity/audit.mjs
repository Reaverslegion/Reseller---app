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
  /* cards off the screen are only drawn when scrolled to (for speed); draw them all while reading, as scrolling would */
  const all=[...document.querySelectorAll(".dcard")];all.forEach(c=>c.style.contentVisibility="visible");
  const cards=all.map(c=>{const t=c.querySelector('.tt');
    return{aria:c.getAttribute("aria-label"),title:t?t.innerText.replace(/^NEW\\s+/,""):"",text:c.innerText,img:!!c.querySelector(".top img")}});
  const bad=(T.match(/.{0,40}(\\bundefined\\b|\\bNaN\\b|\\bnull\\b|\\[object Object\\]).{0,40}/)||[])[0]||null;
  all.forEach(c=>c.style.contentVisibility="");
  return{count:m?+m[1].replace(/,/g,""):0,empty:/No deals right now/.test(T),chips,cards,bad,loading:/Loading deals…/.test(T),err:(app.querySelector(".card.bad")||{}).innerText||"",
    sort:(document.getElementById("ds")||{}).value||"",filter:(document.querySelector("#chips button:not(.s)")||{}).innerText||""}})()`;

// one card's text → its values (the card's own labels say which number is which)
export function parseCard(text) {
  // Fliptimize card (8 Nov 2026): read each labelled part of the card
  const T = String(text), L = T.split("\n").map((x) => x.trim()).filter(Boolean), g = (re) => (T.match(re) || [])[1];
  const o = { label: (T.match(/(Spares or repairs|Auction|Buy It Now)/) || [])[1] || "" };
  o.score = /Not scored/.test(T) ? "Not scored" : g(/Score (\d+)/) || null;
  const am = T.match(/at your max bid\s*\n\s*([+−-]£[\d,.]+|—)\s*\n\s*([+−-]£[\d,.]+|—)\s*\n\s*if it ended now/);
  o.profit = am ? am[1] + " / " + am[2] : g(/([+−-]£[\d,.]+|—)\s*\n\s*(?:est\. profit|at current bid)/) || null;
  if (o.label === "Auction") { o.priceLabel = "Current bid"; o.price = g(/(?:now|Now) (£[\d,.]+|Unknown)/) || null; o.second = g(/[Bb]id up to (£[\d,.]+|—)/) || null; o.secondLabel = o.second != null ? "Bid up to" : null; }
  else { o.priceLabel = "Cost"; o.price = g(/Cost (£[\d,.]+)/) || null; o.second = null; o.secondLabel = null; }
  o.note = L.find((x) => /^((\d+ bids?|no bids yet) · )?(free post|\+ |postage |collection only)/.test(x)) || null;
  o.sells = null; o.ret = null;
  o.src = g(/(From [\d,]+ sales?|Sold prices you checked|Recent sales|No sales yet: asking prices)/) || null;
  return o;
}
// compare one card with what it should say
function cardProblems(d, shown) {
  const e = O.card(d), p = parseCard(shown.text), out = [];
  const want = (f, exp, got) => { if (exp != null && collapse(exp) !== collapse(got)) out.push({ id: d.id, field: f, expected: exp, shown: got == null ? "(missing)" : got }); };
  if (shown.aria !== String(d.title)) out.push({ id: d.id, field: "title (exact)", expected: d.title, shown: shown.aria });
  want("title on screen", collapse(e.shownTitle), collapse(shown.title));
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
    const dupScreen = st.cards.map((c) => c.aria).filter((t, i, a) => a.indexOf(t) !== i && !(db.filter((d) => d.title === t).length > 1));
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

  // ===== 2. deals made by the Scan service itself from fake eBay listings (profit, cost and every kind of postage) =====
  let genAuction = null;
  const POSTAGE = [["free postage", { ship: 0 }, "free"], ["fixed postage", { ship: 7.25 }, "fixed"], ["postage estimated by eBay", { ship: 6.5, estShip: true }, "est"],
    ["postage calculated by eBay", { calcShip: true }, "calc"], ["postage not stated", { unknownShip: true }, "unknown"], ["collection only", { noShip: true, pickup: true }, "collect"]];
  await R.journey(AREA, "Deals made by a real scan", async (step) => {
    await step("price book filled with 90 fake sold prices (3 models)", async () => { await seed([]); await F.call("fill=1", { cat: "27386", catName: "Graphics Cards", cond: "used", rows: F.soldRows(3) }); });
    const L = []; let id = 700000000000;
    F.MODELS.forEach((m) => [0.5, 0.62, 0.74, 0.86].forEach((f) => L.push(F.listing({ id: ++id, title: `${m.title.replace(" Graphics Card", "")} used #${id}`, price: Math.round(m.base * f * 100) / 100, ship: 4.99 }))));
    for (const [t, o] of POSTAGE) L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB ${t} #${id}`, price: 140, ...o }));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB business seller #${id}`, price: 160, ship: 4.99, business: true }));
    L.push(F.listing({ id: (genAuction = String(++id)), title: `NVIDIA GeForce RTX 3070 8GB auction #${id}`, price: 120, ship: 6.5, type: "AUC", bids: 3, endsIn: 3 }));
    L.push(F.listing({ id: ++id, title: `NVIDIA GeForce RTX 3070 8GB too dear #${id}`, price: 250, ship: 4.99 }));
    await step(`fake eBay has ${L.length} listings; Scan now tapped in the app`, async () => { await F.fakeSearch(L); await drv.relaunch();
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
      const tooDear = db.find((d) => /too dear/.test(d.title));
      check("Deals made by a real scan › a listing priced above what makes £20 profit is not a deal", !tooDear, tooDear ? `#${tooDear.id} profit ${tooDear.profit}` : "");
      // every kind of postage: stored as what it is, never overstating profit, and said plainly on the card
      const st = await read();
      for (const [t, o, kind] of POSTAGE) {
        const d = db.find((x) => x.title.includes(" " + t + " #")), c = d && st.cards.find((x) => x.aria === d.title), p = c ? parseCard(c.text) : null;
        if (!d) { check(`Postage: ${t} › made into a deal`, false, "not a deal"); continue; }
        const allowance = kind === "calc" || kind === "unknown", shipOk = kind === "free" ? d.ship === 0 : kind === "fixed" ? d.ship === 7.25 : kind === "est" ? d.ship === 6.5 : kind === "collect" ? !!d.collect : d.ship >= 5;
        check(`Postage: ${t} › stored as "${kind}" with ${allowance ? "a careful allowance (at least £5), not £0" : "the right amount"}`, (kind === "collect" ? d.collect : d.post === kind) && shipOk, `stored kind ${d.post}, postage £${d.ship}${d.collect ? ", collection only" : ""}`);
        if (allowance) { const noPost = Math.round((d.med - 5.99 - (d.price + O.buyerFee(d.price))) * 100) / 100;
          check(`Postage: ${t} › profit counts the allowance (not overstated)`, d.profit <= noPost - 5 + 0.011, `profit ${O.signed(d.profit)}; with no postage it would be ${O.signed(noPost)}`); }
        if (kind === "collect") { check(`Postage: ${t} › under the Collection filter, not All`, !c, c ? "shown in All" : ""); continue; }
        const want = O.postText(d), sub = p && p.note;
        check(`Postage: ${t} › card says "${want}"`, sub === want, `card says "${sub}"`);
        if (allowance) check(`Postage: ${t} › card warns that postage isn't known`, !!c && /allowed/.test(c.text) && /Postage to you not known/.test(c.text), "");
      }
      await compareAll("Deals made by a real scan");
    });
  });

  // ===== 3. an auction's bid goes up and down: every money figure follows (stored, on screen, after reopening) =====
  await R.journey(AREA, "Auction bid changes", async (step) => {
    const start = (await live()).find((d) => d.id === genAuction);
    if (!start) { await step("the auction deal from the real scan is there", async () => { throw new Error("missing"); }); return; }
    const right = (d) => { const fee = (x) => (d.bpfOn ? O.buyerFee(x) : 0), out = d.out != null ? d.out : 5.99, sf = d.sellFee || 0, r2 = (x) => Math.round(x * 100) / 100;
      return { cost: r2(d.price + d.ship + fee(d.price)), profit: r2(d.med - sf - out - (d.price + d.ship + fee(d.price))), atMax: r2(d.med - sf - out - (d.maxBid + d.ship + fee(d.maxBid))) }; };
    // bid rises, falls, rises again; then postage changes (the max bid must drop by the same amount); then the bid passes the max bid
    const STEPS = [[150, 6.5, 6], [135, 6.5, 7], [170, 6.5, 9], [170, 9, 9], [Math.ceil(start.maxBid + 5), 9, 12]];
    let maxBid = start.maxBid;
    for (const [bid, ship, bids] of STEPS) {
      const gone = bid >= maxBid;
      await step(`bid £${bid}${ship !== 6.5 ? `, postage £${ship}` : ""}: deal opened in the app (live check), then back`, async () => {
        await fetch("http://127.0.0.1:8788/__fake/items", { method: "POST", body: JSON.stringify([F.listing({ id: genAuction, title: start.title, price: bid, ship, type: "AUC", bids, endsIn: 3 })]) });
        await drv.tap({ sel: ".dcard", text: "auction #" + genAuction }); await sleep(6000); await drv.back(); await sleep(1500);
        const d = (await live()).find((x) => x.id === genAuction), st = await read(), c = d && st.cards.find((x) => x.aria === d.title);
        if (gone) { check(`Bid £${bid} (past the max bid) › deal removed`, !d, d ? "still listed" : ""); return; }
        if (!d) { check(`Bid £${bid} › deal still listed`, false, "removed"); return; }
        if (ship !== 6.5) { check(`Bid £${bid}, postage £${ship} › max bid lowered by the extra postage`, Math.abs(d.maxBid - (start.maxBid - (ship - 6.5))) < 0.011, `max bid £${d.maxBid}, was £${start.maxBid}`); maxBid = d.maxBid; }
        const w = right(d);
        check(`Bid £${bid}${ship !== 6.5 ? `, postage £${ship}` : ""} › stored price, cost, profit and profit at max bid all match the new bid`,
          d.price === bid && d.ship === ship && Math.abs(d.cost - w.cost) < 0.011 && Math.abs(d.profit - w.profit) < 0.011 && Math.abs(d.profitAtMax - w.atMax) < 0.011,
          `price £${d.price}, cost ${d.cost} (right ${w.cost}), profit ${d.profit} (right ${w.profit}), at max ${d.profitAtMax} (right ${w.atMax})`);
        const probs = c ? cardProblems(d, c) : [{ field: "card", shown: "not found" }];
        check(`Bid £${bid}${ship !== 6.5 ? `, postage £${ship}` : ""} › card shows the new figures`, !probs.length, probs.map((q) => `${q.field}: "${q.shown}" (right "${q.expected}")`).slice(0, 2).join("; "));
      });
    }
    await step("close and reopen the app", async () => { await relaunch(); const d = (await live()).find((x) => x.id === genAuction), st = await read();
      const c = d && st.cards.find((x) => x.aria === d.title);
      check("Bid changes › after reopening, nothing shows an old bid's figures", !d ? !st.cards.some((x) => x.aria === start.title) : !!c && !cardProblems(d, c).length, d ? (c ? cardProblems(d, c).map((q) => q.field).join(", ") : "card missing") : "removed, and not shown"); await drv.shot("auction after bid changes"); });
  });

  // ===== 4. unusual and incomplete records =====
  const E = DS.edge();
  await R.journey(AREA, "Unusual and incomplete records", async (step) => {
    await step(`${E.length} unusual records loaded (1 expired)`, async () => { await seed(E.map((x) => x.d), E.filter((x) => x.expect.expired).map((x) => x.d.id)); await relaunch(); });
    await step("compare", async () => {
      const r = await compareAll("Unusual and incomplete records");
      // record by record: hidden when they should be, in the right filter, and missing values said plainly
      for (const { note: n, d, expect: x } of E) {
        const on = r.pairs.find(([p]) => p.id === d.id), tag = x.realWorld ? "" : " (data the Scan service doesn't make today)";
        // (matched against the cards actually on screen by title: the expired one isn't in the live list, so a pair can't exist)
        if (x.hidden || x.expired) { const seen = on || r.st.cards.some((c) => c.aria === d.title); check(`Unusual records › ${n}`, !seen, seen ? "shown" : ""); continue; }
        if (x.chip) { check(`Unusual records › ${n}: not in All, only under its own filter`, !on, on ? "shown in All" : ""); continue; }
        if (!on) { check(`Unusual records › ${n}: shown`, false, "not on screen"); continue; }
        const c = on[1], p = parseCard(c.text), probs = cardProblems(d, c);
        const say = d.price == null ? ` (price says "${p.price}")` : d.ship == null ? ` (postage says "${p.note}")` : d.med == null ? ` (sells for says "${p.sells}")` : d.score == null ? ` (score says "${p.score}")` : d.title === "" ? ` (title says "${c.title}")` : "";
        check(`Unusual records › ${n}: shown exactly${say}${tag}`, !probs.length, probs.map((q) => `${q.field}: "${q.shown}" (expected "${q.expected}")`).slice(0, 2).join("; "));
      }
      const st = await read(), chips = st.chips, exp = (g) => E.filter(({ d, expect: x }) => !x.expired && O.visible(d, S) && O.groups(d).includes(g)).length;
      check("Unusual records › filter counts (Collection, Guesses) match", (chips["Collection"] || 0) === exp("col") && (chips["Guesses"] || 0) === exp("guess"), `Collection ${chips["Collection"]} (expected ${exp("col")}), Guesses ${chips["Guesses"]} (expected ${exp("guess")})`);
      check("Unusual records › nothing on screen says £0.00 for an unknown price, null, undefined or NaN", !/\bnull\b|\bundefined\b|\bNaN\b/.test(st.cards.map((x) => x.text).join("\n")), "");
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
  });

  // ===== spend limit: set, change, remove, reload, reopen — max bids and "profit at your max" must always agree =====
  await R.journey(AREA, "Spend limit and max bids", async (step) => {
    const vis = () => MIX.filter((d) => O.visible(d, S)), setOf = (cards) => new Set(matchCards(cards, MIX).pairs.map(([d]) => d.id));
    // every auction and Buy It Now on screen: max bid / max price within the limit, and every card exactly as worked out for this limit
    const verify = async (name) => { const st = await read(), P = matchCards(st.cards, MIX).pairs, want = vis().filter((d) => O.groups(d).includes("all")).map((d) => d.id), got = setOf(st.cards);
      const miss = want.filter((id) => !got.has(id)), extra = [...got].filter((id) => !want.includes(id));
      check(`${name} › exactly the deals within the limit (${want.length})`, !miss.length && !extra.length, `${got.size} shown${miss.length ? ", missing " + miss.slice(0, 2) : ""}${extra.length ? ", extra " + extra.slice(0, 2) : ""}`);
      const over = [], probs = [];
      for (const [d, c] of P) { const e = O.card(d, S), pc = parseCard(c.text), v = parseFloat(String(pc.second).replace(/[£,]/g, ""));
        if (S.maxSpend > 0 && O.isAuction(d) && v + (d.ship || 0) > S.maxSpend + 0.01) over.push(d.id);
        if (pc.second !== e.second || pc.profit !== e.profit) probs.push({ id: d.id, field: "max bid / profit at max", expected: `${e.second} · ${e.profit}`, shown: `${pc.second} · ${pc.profit}` }); }
      note(`${name}: max bid and profit at max`, probs);
      check(`${name} › no max bid above the limit`, !over.length, over.slice(0, 3).join(", "));
      check(`${name} › every max bid and "profit at your max" agree (${P.length} cards)`, !probs.length, probs.length ? `${probs.length} differ, e.g. #${probs[0].id}: shows ${probs[0].shown}, right ${probs[0].expected}` : ""); };
    const menuLimit = async (v) => { await drv.menu(); await sleep(1000); await drv.fill({ sel: "#r_maxPrice" }, v); await sleep(1200); await drv.dealsTab(); await sleep(1800); };
    const sheetLimit = async (v) => { await drv.tap({ sel: ".tpill", text: "Spend limit" }); await sleep(1200);
      if (v === "") await drv.tap({ text: "No limit", exact: true }); else { await drv.fill({ sel: "#sp_in" }, v); await drv.tap({ text: "Save", exact: true }); } await sleep(1800); };
    await step("set £150 in Menu", async () => { await menuLimit("150"); S.maxSpend = 150; await verify("Limit set to £150 (Menu), straight away"); await drv.shot("limit 150"); });
    await step("change to £200 from the Deals screen", async () => { await sheetLimit("200"); S.maxSpend = 200; await verify("Limit changed to £200 (Deals screen), straight away"); });
    await step("change back to £150", async () => { await sheetLimit("150"); S.maxSpend = 150; await verify("Limit changed back to £150, straight away"); });
    await step("close and reopen with the £150 limit", async () => { await relaunch(); await verify("Limit £150 after reopening"); });
    await step("remove the limit (No limit)", async () => { await sheetLimit(""); S.maxSpend = 0; await verify("Limit removed, straight away"); });
    await step("close and reopen with no limit", async () => { await relaunch(); await verify("No limit after reopening"); });
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

  // ===== 11. every size: 13, 200, 201, 500, 837, 1,000 and 1,500 deals (the old hidden cap was 200) =====
  for (const n of opt.sizes || [13, 200, 201, 500, 837, 1000, 1500]) {
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
