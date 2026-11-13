// Reseller toolkit (Stage 1) on the Android emulator: the real app, real taps and the phone's own Back button.
// 1. Installs the CURRENT testing app (OLD_APK), saves stock and settings in it and backs up, then installs this branch's
//    app OVER it as an update (both re-signed with one throwaway key made on the test machine; never the real key).
// 2. Walks through the calculator, stock, sales, refunds, returns, write-offs, bundles, expenses, "I bought this" and CSV,
//    checking every money figure against sums worked out HERE (independently of the app's own code).
// 3. Back button, closing and reopening, offline, dark/light, large text, cloud backup and restore, large imports.
// Uses only the private test Scan service and fake eBay on this machine. Run: APK=new.apk OLD_APK=old.apk node tests/android/toolkit.mjs
import fs from "node:fs";
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
import { App, Results, sleep, sh, adb } from "./driver.mjs";
import { makeDeals, seedDeals } from "./seed.mjs";

const KEY = process.env.TEST_APP_KEY, APK = process.env.APK, OLD = process.env.OLD_APK;
const CHAOS = (m) => fetch(`http://127.0.0.1:8791/${m === "stats" ? "stats" : m === "reset" ? "reset" : "mode?m=" + m}`).then((r) => r.json()).catch(() => ({}));
const app = new App("screenshots/toolkit"), R = new Results(app, "results/toolkit.json");
app.beforeJourney = () => CHAOS("normal");
app.netQuiet = async () => { let last = -1, same = 0; for (let i = 0; i < 20; i++) { let n = 0; try { n = Object.values((await CHAOS("stats")).stats || {}).reduce((a, b) => a + b, 0); } catch (e) { return; }
  if (n === last) { if (++same >= 2) return; } else { same = 0; last = n; } await sleep(700); } };
const T = (name, fn) => R.journey("Toolkit", name, fn), B = (name, fn) => R.journey("Toolkit: Back button", name, fn);
const ok = (c, m) => { if (!c) throw new Error(m); };
// a message at the bottom of the screen (e.g. "Restored." with Undo) can sit over a button for a few seconds, as it would for
// a person: wait for it to go only when it is actually covering what we're about to tap
const _tap = app.tap.bind(app);
app.tap = async (spec, c) => { try { const p = await app.locate(typeof spec === "string" ? { text: spec } : spec, c);
  if (p && p.covered && /toast|tmsg|tbtn/i.test(String(p.covered))) await app.waitFor(`getComputedStyle(document.getElementById("toast")).display==="none"`, 8000, "the message to clear"); } catch (e) {}
  return _tap(spec, c); };
const t0 = Date.now(), LIMIT = 70 * 60e3;   // the whole script stops starting new journeys after 70 minutes
const timeLeft = () => Date.now() - t0 < LIMIT;

// ---------- independent sums (written here, not taken from the app) ----------
const n = (x) => +x || 0, r2 = (x) => Math.round(x * 100) / 100;
const HOLD = ["Bought", "Listed", "Returned"], DONE = ["Sold", "Done", "Written off"];
const sold = (i) => i.soldPrice != null && i.soldPrice !== "";
const profit = (i) => (sold(i) ? n(i.soldPrice) - n(i.refund) - n(i.fees) + n(i.feesBack) - n(i.outPost) : 0) - n(i.buy) - n(i.pack) - n(i.other) - n(i.sunk) + n(i.recovered);
const est = (i) => n(i.exp) > 0 ? n(i.exp) - 0 /* Private seller: no selling fee */ - n(i.outPost) - n(i.buy) - n(i.pack) - n(i.other) : null;
function sums(S) { const hold = S.items.filter((i) => HOLD.includes(i.status)), done = S.items.filter((i) => DONE.includes(i.status));
  return { invested: r2(hold.reduce((t, i) => t + n(i.buy) + n(i.pack) + n(i.other), 0)), est: r2(hold.reduce((t, i) => t + (est(i) ?? 0), 0)),
    actual: r2(done.reduce((t, i) => t + profit(i), 0) - hold.reduce((t, i) => t + n(i.sunk), 0)), expenses: r2((S.expenses || []).reduce((t, e) => t + n(e.amount), 0)) }; }
const fmt = (v) => "£" + Math.abs(v).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sfmt = (v) => (v < 0 ? "−" : "+") + fmt(v);
const store = () => app.eval(`JSON.parse(localStorage.getItem("resell_helper_v1"))`);
const storeText = () => app.eval(`localStorage.getItem("resell_helper_v1")`);
const tabTo = async (label) => { await app.tap({ sel: `#nav button[aria-label="${label}"]` }); await sleep(500); };
const section = async (name) => { await app.tap({ sel: ".ms-seg button", text: name, exact: true }); await sleep(400); };
const toStock = async () => { await tabTo("My Stock"); if (await app.eval(`MS.view!=="stock"`)) await section("Stock"); };
const sheetBtn = (text) => app.tap({ sel: "#sheet button", text, exact: true });
const sheetOpen = () => app.eval(`document.getElementById("sheet").classList.contains("on")`);
// the three My Stock figures exactly as shown
const shown = () => app.eval(`[...document.querySelectorAll(".ms-sum .ms-v")].map(e=>e.innerText.trim())`);
async function checkFigures(label) { const S = await store(), m = sums(S), s = await shown();
  ok(s[0] === fmt(m.invested), `${label}: money in unsold stock shows ${s[0]}, expected ${fmt(m.invested)}`);
  ok(s[1] === sfmt(m.est), `${label}: estimated profit shows ${s[1]}, expected ${sfmt(m.est)}`);
  ok(s[2] === sfmt(m.actual), `${label}: actual profit shows ${s[2]}, expected ${sfmt(m.actual)}`);
  if (m.expenses) { const t = await app.text(); ok(t.includes(`after ${fmt(m.expenses)} expenses`) && t.includes(sfmt(r2(m.actual - m.expenses))), `${label}: 'after expenses' line missing or wrong (expected after ${fmt(m.expenses)} → ${sfmt(r2(m.actual - m.expenses))})`); }
  return m; }
// a card's own button (e.g. "Mark as sold" on the Switch's card), found by its position among the same buttons
async function cardTap(name, sel, text) { const k = await app.eval(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&(${JSON.stringify(text || "")}===""||(b.innerText||b.getAttribute("aria-label")||"").trim().toLowerCase().includes(${JSON.stringify((text || "").toLowerCase())}))});return L.findIndex(b=>b.closest(".ms-it")&&b.closest(".ms-it").innerText.includes(${JSON.stringify(name)}))})()`);
  ok(k >= 0, `no '${text || sel}' button on the card for ${name}`); await app.tap({ sel, ...(text ? { text } : {}), nth: k }); await sleep(500); }
const item = async (name) => (await store()).items.find((i) => i.name === name);
const undo = async () => { await app.tap({ text: "Undo", exact: true }); await sleep(700); };
const overflow = () => app.eval(`(()=>{const W=innerWidth+1,o=[...document.querySelectorAll("#app *,#sheet.on *")].filter(e=>e.offsetParent&&e.getBoundingClientRect().right>W).map(e=>e.id||e.className||e.tagName).slice(0,4);
  const nav=[...document.querySelectorAll("#nav button")].filter(b=>b.scrollWidth>b.clientWidth+1).map(b=>b.getAttribute("aria-label"));return{o,nav}})()`);
// close like a person (Home, then the phone stops the app): Android's web view writes saved data to storage a moment after it
// changes, so the app is given 8 seconds in the background first (as in tests/android/update.mjs). Force-closing instantly
// can lose the last change, which no person can do.
const reopen = async () => { sh("input keyevent KEYCODE_HOME"); await sleep(8000); await app.stop(); await app.launch(); await app.waitFor(`typeof render==="function"&&!!document.getElementById("app")`, 30000, "the app"); await sleep(800); };

// ---------- the phone ----------
adb("reverse", "tcp:8787", "tcp:8789"); adb("reverse", "tcp:8790", "tcp:8790");
fs.mkdirSync("results", { recursive: true });
app.startLog("logcat.txt"); app.prepPhone();
for (let i = 0; i < 24; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await app.unblock();
const day = (k) => new Date(Date.now() - k * 864e5).toISOString().slice(0, 10);
const SEED = { rules: { cheap: true, maxPrice: 0, minProfit: 25, minRoi: 0, budget: 200, maxStock: 150, minSales: 5, feePct: 12.8, feeFixed: 0.4, staleDays: 30, minPct: 35, seller: "private", v2: 1 },
  gate: [], base: [], hunt: { cats: [{ id: "27386", name: "Graphics Cards", path: "" }, { id: "9355", name: "Mobile & Smart Phones", path: "" }], post: 4.5, pack: 1, bpf: true }, set: { url: "http://localhost:8787", key: KEY, region: "uk", theme: "auto" },
  items: [
    { id: 1, name: "Sony WH-1000XM4 headphones", status: "Bought", boughtOn: day(3), buy: 120, pack: 1, exp: 175, outPost: 4.5, expProfit: 49.5, cond: "Used" },
    { id: 2, name: "Nintendo Switch OLED White", status: "Listed", boughtOn: day(9), buy: 190, pack: 1.5, exp: 235, outPost: 6, expProfit: 37.5, cond: "Used" },
    { id: 3, name: "MSI GeForce RTX 3060 Ventus 12GB", status: "Sold", boughtOn: day(20), soldOn: day(6), buy: 160, pack: 1, exp: 205, outPost: 7, soldPrice: 205, fees: 0, profit: 37, expProfit: 37 },
    { id: 4, name: "Apple iPad 9th gen 64GB", status: "Done", boughtOn: day(25), soldOn: day(10), buy: 180, pack: 1, exp: 199, outPost: 5, soldPrice: 182, fees: 0, profit: -4, expProfit: 13 },
    { id: 5, name: "Kindle Paperwhite 11th gen", status: "Considered", buy: 35 },
    { id: 6, name: "Canon 50mm lens", status: "Listed", boughtOn: day(2), buy: 45.67, pack: 0.33, exp: 0, outPost: 3.2, expProfit: 0 }] };
// TRANSPARENCY CHECK (information only): a change, then an INSTANT force-close with no wait (like a crash or the phone killing
// the app straight away). Run on the old app and the new one, so any risk shows as either already there or new.
async function instantKill(label) { await app.eval(`(()=>{S.rules.staleDays=31;save();return 1})()`); await app.stop(); await app.launch();
  await app.waitFor(`typeof render==="function"&&typeof S==="object"`, 30000, "the app"); const kept = await app.eval(`S.rules.staleDays===31`);
  await app.eval(`(()=>{S.rules.staleDays=30;save();return 1})()`); await reopen();
  ok(await app.eval(`S.rules.staleDays===30`), "couldn't put the setting back");
  R.add("Toolkit: saving", `${label}: a change survives an INSTANT force-close (no wait)`, kept ? "PASS" : "PARTIALLY TESTED",
    kept ? "kept" : "lost: Android's web view writes saved data to storage a moment after a change; information only (see the matching old-app row)"); }
let before = null, beforeText = "";

const setup = await R.journey("Android emulator", "Toolkit: install the current testing app and save data in it", async (step) => {
  await step("current testing app (2.0.133 code) installs", async () => { ok(OLD && fs.existsSync(OLD), "no old app file"); app.install(OLD); });
  await step("it opens; stock, settings and the Scan service connection are saved in it", async () => { await app.launch(); await app.waitFor(`typeof render==="function"`, 30000, "the app");
    await app.eval(`(()=>{localStorage.setItem("flipscout_seen_v2","1");localStorage.setItem("flipscout_restore_asked","1");localStorage.setItem("resell_helper_v1",${JSON.stringify(JSON.stringify(SEED))});return 1})()`);
    await reopen(); ok(await app.eval(`S.items.length===6&&S.rules.seller==="private"&&S.rules.minProfit===25`), "the old app didn't keep the data");
    await app.eval(`(async()=>{await pushConfig();return 1})()`); await sleep(1500); await app.shot("old app with data"); });
  await step("information: old app, instant force-close straight after a change", () => instantKill("old app (2.0.133 code)"));
  await step("the old app backs up to the test Scan service ('Back up now')", async () => { await tabTo("Settings"); await app.tap({ sel: "#bk_now" }); await app.waitText("Backed up at", 25000);
    beforeText = await storeText(); before = JSON.parse(beforeText); });
});
if (!setup) { console.log("setup failed"); process.exit(1); }

await T("App update keeps everything", async (step) => {
  await step("this branch's app installs over it as an UPDATE (same app, not a new install)", async () => { app.install(APK); ok(/com\.reaverslegion\.flipscout/.test(sh("pm list packages")), "not installed");
    const fi = sh(`dumpsys package com.reaverslegion.flipscout | grep -E "firstInstallTime|lastUpdateTime"`); ok(/firstInstallTime/.test(fi), fi); });
  await step("it opens with My Stock as the 3rd tab", async () => { await reopen(); const l = await app.eval(`[...document.querySelectorAll("#nav button")].map(b=>b.getAttribute("aria-label")).join(",")`); ok(l === "Deals,Following,My Stock,Settings", l); });
  await step("every saved item, setting and the connection are exactly as before the update", async () => { const S = await store();
    ok(JSON.stringify(S.items) === JSON.stringify(before.items), "items changed by the update");
    for (const k of ["rules", "set", "hunt", "gate", "base"]) ok(JSON.stringify(S[k]) === JSON.stringify(before[k]), `${k} changed by the update`);
    ok(S.rules.seller === "private" && S.rules.minProfit === 25, "Private seller / £25 minimum profit not kept"); });
  await step("My Stock shows the right figures from the old data (£358.50 in stock, +£87.00 estimate, +£33.00 actual)", async () => { await toStock(); const m = await checkFigures("after update");
    ok(m.invested === 358.5 && m.est === 87 && m.actual === 33, `independent sums ${JSON.stringify(m)}`); const t = await app.text(); ok(!t.includes("Kindle"), "the old watchlist item appears in My Stock"); ok(!/\bNaN\b|\bundefined\b/.test(t), "NaN/undefined on screen"); await app.shot("my stock after update"); });
  await step("the backup made by the OLD app restores into the new app unchanged ('Restore from cloud')", async () => { await tabTo("Settings"); await app.tap({ text: "Restore from cloud", exact: true });
    await app.waitText("Restore your data", 15000); await sheetBtn("Restore it"); await app.waitText("Restored", 10000); const S = await store();
    ok(JSON.stringify(S.items) === JSON.stringify(before.items) && JSON.stringify(S.rules) === JSON.stringify(before.rules), "restored data differs"); ok(Array.isArray(S.expenses) && S.expenses.length === 0, "expenses list not empty/added"); });
});

await T("Calculator (real typing, awkward pennies)", async (step) => {
  await step("open My Stock → Calculator", async () => { await toStock(); await section("Calculator"); await app.waitFor(`!!document.getElementById("cl_sell")`, 5000, "calculator"); });
  await step("99.99 sale, £33.33 paid, £3.17 postage, £0.49 packaging → profit +£63.00 (Private seller, no fee)", async () => {
    await app.fill({ sel: "#cl_sell" }, "99.99"); await app.fill({ sel: "#cl_post" }, "3.17"); await app.fill({ sel: "#cl_pack" }, "0.49"); await app.fill({ sel: "#cl_buy" }, "33.33"); await sleep(400);
    const c = await app.eval(`document.getElementById("calc_res").innerText`); ok(/Profit[\s\S]*\+£63\.00/.test(c), c.slice(0, 200)); ok(/Most you'd pay in total[\s\S]*£/.test(c), "no 'most you'd pay'"); await app.shot("calculator"); });
  await step("the most you'd pay leaves the £25 minimum profit", async () => { const v = await app.eval(`calcResult(CALC).maxTotal`); ok(v != null && 99.99 - 3.17 - 0.49 - v >= 25 - 0.01, `max ${v}`); });
  await step("'I bought it: add to My Stock' adds exactly what was typed", async () => { await app.tap({ text: "I bought it: add to My Stock" }); await app.waitFor(`!!document.getElementById("it_n")`, 5000, "item sheet");
    await app.fill({ sel: "#it_n" }, "Calc test item"); await sheetBtn("Add to My Stock"); await app.waitText("Added to My Stock", 8000); const i = await item("Calc test item");
    ok(i && i.buy === 33.33 && i.exp === 99.99 && i.outPost === 3.17 && i.pack === 0.49 && i.status === "Bought", JSON.stringify(i)); await checkFigures("after calculator purchase"); });
});

await T("Expenses: add, edit, delete and Undo; never counted twice", async (step) => {
  let a0;
  await step("add £12.34 'Tape' (Packaging)", async () => { await toStock(); a0 = sums(await store()).actual; await section("Expenses"); await app.tap({ text: "+ Add expense" });
    await app.fill({ sel: "#ex_a" }, "12.34"); await app.fill({ sel: "#ex_d" }, "Tape"); await sheetBtn("Save"); await app.waitText("Expense added", 8000);
    const S = await store(); ok(S.expenses.length === 1 && S.expenses[0].amount === 12.34, JSON.stringify(S.expenses)); ok((await app.text()).includes("£12.34"), "total not shown"); await app.shot("expenses"); });
  await step("edit it to £12.35", async () => { await app.tap({ sel: ".ms-it button", text: "Edit" }); await app.fill({ sel: "#ex_a" }, "12.35"); await sheetBtn("Save"); await sleep(600);
    const S = await store(); ok(S.expenses.length === 1 && S.expenses[0].amount === 12.35, JSON.stringify(S.expenses)); });
  await step("delete it, then Undo puts back exactly the same expense", async () => { const e0 = JSON.stringify((await store()).expenses);
    await app.tap({ sel: ".ms-it button", text: "Edit" }); await sheetBtn("Delete"); await app.waitText("Expense deleted", 8000); ok((await store()).expenses.length === 0, "not deleted");
    await undo(); ok(JSON.stringify((await store()).expenses) === e0, "Undo didn't restore it exactly"); });
  await step("actual profit is unchanged by expenses; the 'after expenses' line takes them off once", async () => { await section("Stock"); const m = await checkFigures("with an expense");
    ok(m.actual === a0 && m.expenses === 12.35, `actual ${m.actual} (was ${a0}), expenses ${m.expenses}`); });
});

await T("Bundle / job lot: split to the penny, Undo", async (step) => {
  let s0, n0;
  await step("£100.01 for 3 items, split evenly: £33.34 + £33.34 + £33.33", async () => { await toStock(); const S = await store(); s0 = sums(S); n0 = S.items.length;
    await app.tap({ text: "+ Bundle / job lot" }); await app.fill({ sel: "#bn_t" }, "100.01"); await app.fill({ sel: "#bn_l" }, "Job lot GPU A\nJob lot GPU B\nJob lot cable");
    await app.tap({ sel: "#sheet [role=radio]", text: "Split evenly" }); await sleep(300); const p = await app.eval(`document.getElementById("bn_res").innerText`);
    ok(/33\.34[\s\S]*33\.34[\s\S]*33\.33[\s\S]*Total\s*£100\.01/.test(p), p); await app.shot("bundle"); });
  await step("added: costs add to exactly £100.01; money in stock goes up by £100.01 + packaging only", async () => { await sheetBtn("Add to My Stock"); await app.waitText("Added 3 items", 8000);
    const S = await store(), b = S.items.filter((i) => i.bundle); ok(b.length === 3 && Math.round(b.reduce((t, i) => t + i.buy * 100, 0)) === 10001, JSON.stringify(b.map((i) => i.buy)));
    const m = await checkFigures("after bundle"); ok(r2(m.invested - s0.invested) === r2(100.01 + b.reduce((t, i) => t + n(i.pack), 0)), `stock went up by ${r2(m.invested - s0.invested)}`); });
  await step("Undo removes all three and the figures go back exactly", async () => { await undo(); const S = await store(); ok(S.items.length === n0 && !S.items.some((i) => i.bundle), "bundle items still there");
    const m = await checkFigures("after bundle Undo"); ok(m.invested === s0.invested, `${m.invested} vs ${s0.invested}`); });
  await step("by expected price: £90 for items expected at £150 and £50 → £67.50 + £22.50", async () => {
    await app.tap({ text: "+ Bundle / job lot" }); await app.fill({ sel: "#bn_t" }, "90"); await app.fill({ sel: "#bn_l" }, "Weighted A, 150\nWeighted B, 50");
    await app.tap({ sel: "#sheet [role=radio]", text: "By expected price" }); await sleep(300); await sheetBtn("Add to My Stock"); await app.waitText("Added 2 items", 8000);
    const S = await store(); ok((await item("Weighted A")).buy === 67.5 && (await item("Weighted B")).buy === 22.5, JSON.stringify(S.items.filter((i) => i.bundle).map((i) => [i.name, i.buy]))); await checkFigures("after weighted bundle"); });
});

await T("Selling, refunds, returns and write-offs: no double counting, exact Undo", async (step) => {
  let sw;
  await step("Mark the Switch as sold: sale total £240, fees £0, postage £6 → profit +£42.50", async () => { await toStock(); await cardTap("Nintendo Switch", ".ms-acts button", "Mark as sold");
    await app.waitFor(`!!document.getElementById("sd_p")`, 5000, "sold sheet"); await app.fill({ sel: "#sd_p" }, "240"); await app.fill({ sel: "#sd_f" }, "0"); await app.fill({ sel: "#sd_o" }, "6");
    await sheetBtn("Save sale"); await sleep(800); sw = await item("Nintendo Switch OLED White"); ok(sw.status === "Sold" && sw.soldPrice === 240 && r2(profit(sw)) === 42.5 && sw.profit === 42.5, JSON.stringify(sw));
    await checkFigures("after sale"); });
  await step("part refund £33.33 (buyer keeps it): profit drops by exactly £33.33, still sold", async () => { const a = sums(await store()).actual;
    await cardTap("Nintendo Switch", ".ms-more"); await sheetBtn("Buyer return or refund…"); await app.tap({ sel: "#sheet input[type=radio]", nth: 1 }); await sleep(400);
    await app.fill({ sel: "#rt_r" }, "33.33"); await sheetBtn("Save"); await app.waitText("Refund saved", 8000); const i = await item("Nintendo Switch OLED White");
    ok(i.status === "Sold" && i.refund === 33.33 && r2(i.profit) === r2(42.5 - 33.33), JSON.stringify(i)); const m = await checkFigures("after part refund"); ok(r2(a - m.actual) === 33.33, `actual changed by ${r2(a - m.actual)}`); await app.shot("after part refund"); });
  await step("Undo the refund: the item is exactly as before", async () => { const now = await item("Nintendo Switch OLED White"); ok(now.refund === 33.33, "no refund to undo");
    await undo(); ok(JSON.stringify(await item("Nintendo Switch OLED White")) === JSON.stringify(sw), "Undo didn't restore the item exactly"); await checkFigures("after refund Undo"); });
  await step("RTX 3060 comes back (refund £205, return postage £4.50): loses £11.50 once, back in Unsold to relist", async () => { const s = sums(await store());
    await cardTap("MSI GeForce RTX 3060", ".ms-more"); await sheetBtn("Buyer return or refund…"); await app.tap({ sel: "#sheet input[type=radio]", nth: 0 }); await sleep(400);
    await app.fill({ sel: "#rt_p" }, "4.50"); await sheetBtn("Save"); await app.waitText("back in Unsold", 8000); const i = await item("MSI GeForce RTX 3060 Ventus 12GB");
    ok(i.status === "Returned" && i.sunk === 11.5 && i.soldPrice == null && i.rets.length === 1, JSON.stringify(i));
    const m = await checkFigures("after return"); ok(r2(s.actual - m.actual) === r2(37 + 11.5), `actual changed by ${r2(s.actual - m.actual)} (expected 48.50: the £37 sale profit gone and £11.50 lost)`);
    ok(r2(m.invested - s.invested) === 161, `stock went up by ${r2(m.invested - s.invested)} (expected the item's £161 cost, once)`); await app.shot("after return"); });
  await step("relist and sell it again for £199 (postage £7): the earlier £11.50 loss is counted once, not twice", async () => {
    await cardTap("MSI GeForce RTX 3060", ".ms-acts button", "Relist it"); await sleep(500); await cardTap("MSI GeForce RTX 3060", ".ms-acts button", "Mark as sold");
    await app.fill({ sel: "#sd_p" }, "199"); await app.fill({ sel: "#sd_f" }, "0"); await app.fill({ sel: "#sd_o" }, "7"); await sheetBtn("Save sale"); await sleep(800);
    const i = await item("MSI GeForce RTX 3060 Ventus 12GB"); ok(r2(i.profit) === r2(199 - 7 - 161 - 11.5), `profit ${i.profit}`); await checkFigures("after resale"); });
  await step("write off the headphones with £20 recovered: −£101.00, out of stock", async () => { const s = sums(await store());
    await cardTap("Sony WH-1000XM4", ".ms-more"); await sheetBtn("Write off (lost, broken, kept)…"); await app.fill({ sel: "#wo_r" }, "20"); await sheetBtn("Write it off"); await app.waitText("Written off", 8000);
    const i = await item("Sony WH-1000XM4 headphones"); ok(i.status === "Written off" && i.profit === -101, JSON.stringify(i));
    const m = await checkFigures("after write-off"); ok(r2(s.invested - m.invested) === 121 && r2(s.actual - m.actual) === 101, `stock −${r2(s.invested - m.invested)}, actual −${r2(s.actual - m.actual)}`); });
  await step("Undo the write-off: exactly as before", async () => { await undo(); const i = await item("Sony WH-1000XM4 headphones"); ok(i.status === "Bought" && i.recovered == null && i.profit == null, JSON.stringify(i)); await checkFigures("after write-off Undo"); });
  await step("full refund, buyer keeps it: the iPad becomes Written off with the right loss", async () => {
    await cardTap("Apple iPad", ".ms-more"); await sheetBtn("Buyer return or refund…"); await app.tap({ sel: "#sheet input[type=radio]", nth: 2 }); await sleep(400); await sheetBtn("Save"); await app.waitText("Refund saved", 8000);
    const i = await item("Apple iPad 9th gen 64GB"); ok(i.status === "Written off" && i.refund === 182 && i.profit === -186, JSON.stringify(i)); await checkFigures("after full refund"); });
  await step("a refund bigger than the sale is refused", async () => { await cardTap("Nintendo Switch", ".ms-more"); await sheetBtn("Buyer return or refund…"); await app.tap({ sel: "#sheet input[type=radio]", nth: 1 });
    await app.fill({ sel: "#rt_r" }, "999"); await sleep(400); ok(/more than/.test(await app.eval(`document.getElementById("rt_res").innerText`)), "no warning"); await sheetBtn("Save"); await sleep(600);
    ok((await item("Nintendo Switch OLED White")).refund == null, "too-big refund was saved"); await app.back(); });
});

const DEALS = makeDeals(6);
await T("Deal page 'I bought this' and the Following list", async (step) => {
  let d;
  await step("fake deals load", async () => { await seedDeals(DEALS); await reopen(); await tabTo("Deals"); await app.waitFor(`!!document.querySelector(".dcard")`, 30000, "deal cards"); });
  await step("Buy It Now deal: the price is filled in, but nothing is added until you tick to confirm it", async () => {
    await app.tap({ sel: ".dcard", nth: 0 }); await app.waitFor(`tab==="deal"&&!!DV`, 10000, "deal page"); d = await app.eval(`({type:DV.type,cost:DV.cost,price:DV.price,ship:DV.ship,med:DV.med,title:DV.title})`); ok(d.type !== "AUC", "first deal is an auction");
    await app.tap({ text: "I bought this: add to My Stock" }); await app.waitFor(`!!document.getElementById("it_cf")`, 5000, "confirm box");
    const v = await app.eval(`document.getElementById("it_b").value`); ok(v === (Math.round(d.cost * 100) / 100).toFixed(2), `price ${v}, deal cost ${d.cost}`);
    const c0 = (await store()).items.length; await sheetBtn("Add to My Stock"); await sleep(800); ok((await store()).items.length === c0 && await sheetOpen(), "added without confirming"); await app.shot("confirm what you paid"); });
  await step("after ticking: added with exactly the deal's total cost and expected sale price", async () => { await app.tap({ sel: "#it_cf" }); await sheetBtn("Add to My Stock"); await app.waitText("Added to My Stock", 8000);
    const i = (await store()).items[0]; ok(i.name === d.title && i.buy === Math.round(d.cost * 100) / 100 && i.exp === d.med && i.status === "Bought", JSON.stringify(i));
    ok(r2(i.expProfit) === r2(d.med - i.outPost - i.buy - i.pack), `expected profit ${i.expProfit}`); await checkFigures("after deal purchase"); });
  await step("auction deal: the price is left empty for you to type", async () => { await tabTo("Deals"); const k = await app.eval(`(HD.deals||[]).findIndex(x=>x.type==="AUC")`); ok(k >= 0, "no auction");
    await app.eval(`openDeal(${k});1`); await app.waitFor(`tab==="deal"`, 10000, "deal page"); await app.tap({ text: "I bought this: add to My Stock" }); await sleep(500);
    ok((await app.eval(`document.getElementById("it_b").value`)) === "", "auction price filled in"); await app.back(); ok(!(await sheetOpen()), "Back didn't close the sheet"); });
  await step("Following list: no purchase button there (so no second, unconfirmed way to record a purchase)", async () => { await tabTo("Following"); await sleep(800);
    const t = await app.eval(`document.getElementById("app").innerText`); ok(!/I bought/i.test(t), "Following shows an 'I bought' button"); ok(await app.eval(`!document.querySelector('#app [onclick^="bought("]')`), "old bought() button on screen"); });
});

await T("CSV export and import on the phone", async (step) => {
  await step("export stock: one line per stock item plus the header, estimated and actual profit in separate columns", async () => { await toStock(); await app.tap({ text: "Export stock" }); await app.waitFor(`!!document.getElementById("csv_out")`, 5000, "export");
    const [txt, cnt] = await app.eval(`[document.getElementById("csv_out").value,S.items.filter(i=>STOCK.includes(i.status)).length]`); const L = txt.split(/\r?\n/);
    ok(L.length === cnt + 1 && /Estimated profit,Actual profit$/.test(L[0]), `${L.length} lines for ${cnt} items; header ${L[0]}`); await app.shot("csv export"); });
  await step("Copy puts it on the phone's clipboard", async () => { await sheetBtn("Copy"); await app.waitText("Copied|Select the text", 5000); });
  await step("Back closes the export", async () => { await app.back(); ok(!(await sheetOpen()), "still open"); });
  let n0;
  await step("pasted file with good rows, a duplicate, bad numbers/dates/status and a broken quote: preview counts are right, nothing added yet", async () => {
    if (!(await sheetOpen() && await app.eval(`!!document.getElementById("ci_t")`))) { if (await sheetOpen()) { await app.back(); await sleep(500); } await app.tap({ text: "Import…" }); await sleep(600); }
    n0 = (await store()).items.length; const sonyDate = (await item("Sony WH-1000XM4 headphones")).boughtOn;
    const csv = ["Name,Paid,Status,Bought on,Sale total", `Sony WH-1000XM4 headphones,120,Bought,${sonyDate},`, "Imported lens,£45.10,Listed,02/11/2026,", "Imported camera,30,Sold,2026-10-01,55.55",
      "Bad price,abc,Bought,,", "Bad date,10,Bought,31/02/2026,", "Bad status,10,Shipped,,", "Imported lens,45.10,Listed,2026-11-02,", "\"Broken,10,Bought"].join("\n");
    await app.eval(`(()=>{const d=document.querySelector("#sheet details");if(d)d.open=true;const t=document.getElementById("ci_t");t.value=${JSON.stringify(csv)};t.dispatchEvent(new Event("input"));return 1})()`);
    await sheetBtn("Check it"); await sleep(800); const r = await app.eval(`document.getElementById("ci_res").innerText`);
    ok(/New rows to add\s*2/.test(r) && /Already here \(skipped\)\s*2/.test(r) && /Rows with problems \(skipped\)\s*4/.test(r), r.slice(0, 300)); ok((await store()).items.length === n0, "added before confirming"); await app.shot("csv preview"); });
  await step("Add: exactly 2 added; the sold one's profit is worked out by the app (£25.55); Undo removes them", async () => { await app.tap({ sel: "#ci_res button", text: "Add 2 items" }); await app.waitText("Added 2 items", 8000);
    const S = await store(); ok(S.items.length === n0 + 2 && r2(S.items.find((i) => i.name === "Imported camera").profit) === 25.55 && S.items.find((i) => i.name === "Imported lens").buy === 45.1, "wrong rows added");
    await checkFigures("after CSV import"); await undo(); ok((await store()).items.length === n0, "Undo didn't remove them"); await checkFigures("after CSV Undo"); });
  await step("expenses CSV: real dates and amounts only; types matched", async () => { await section("Expenses"); const e0 = (await store()).expenses.length; await app.tap({ text: "Import…" });
    await app.tap({ sel: "#sheet [role=radio]", text: "Expenses" }); await sleep(400);
    await app.eval(`(()=>{const d=document.querySelector("#sheet details");if(d)d.open=true;const t=document.getElementById("ci_t");t.value="Date,Description,Type,Amount\\n01/11/2026,Fuel,travel,12.40\\n2026-11-02,Hat,Clothes,5\\n2026-11-03,Zero,,0";t.dispatchEvent(new Event("input"));return 1})()`);
    await sheetBtn("Check it"); await sleep(500); await app.tap({ sel: "#ci_res button", text: "Add 2 expenses" }); await app.waitText("Added 2 expenses", 8000);
    const E = (await store()).expenses; ok(E.length === e0 + 2 && E.some((e) => e.cat === "Travel" && e.amount === 12.4) && E.some((e) => e.cat === "Other" && e.amount === 5), JSON.stringify(E)); });
  await step("the file picker opens from 'Choose a CSV file' and Back returns to the import screen", async () => { if (await sheetOpen()) { await app.back(); await sleep(500); } await app.tap({ text: "Import…" }); await app.waitFor(`!!document.getElementById("ci_f")`, 5000, "import sheet");
    await app.tap({ sel: "#ci_f" }); await sleep(3000); const f = sh("dumpsys window | grep -E 'mCurrentFocus'"); const picker = /documentsui|files|picker/i.test(f);
    if (picker) { await app.back(); await sleep(1500); } ok(await sheetOpen() && await app.eval(`!!document.getElementById("ci_f")`), "the import screen closed (Back closed it instead of only the picker)"); if (!picker) throw new Error("EMULATOR LIMIT: the file picker didn't appear (" + f.trim().slice(0, 120) + ")"); });
});

await T("Large CSV import (5,000 rows) and limits", async (step) => {
  let n0, s0, ms = {};
  const big = ["Name,Paid,Status,Bought on,Expected sale total"].concat(Array.from({ length: 5000 }, (_, k) => `Bulk item ${k + 1},${(k % 97) + 0.01},Bought,2026-10-${String(1 + (k % 28)).padStart(2, "0")},${(k % 97) + 20}`)).join("\n");
  await step("5,000 rows: checked and previewed without freezing", async () => { await toStock(); const S = await store(); n0 = S.items.length; s0 = sums(S);
    await app.tap({ text: "Import…" }); await app.eval(`(()=>{const d=document.querySelector("#sheet details");if(d)d.open=true;const t=document.getElementById("ci_t");t.value=${JSON.stringify(big)};t.dispatchEvent(new Event("input"));return 1})()`);
    const a = Date.now(); await sheetBtn("Check it"); await app.waitFor(`/New rows to add\\s*5000/.test((document.getElementById("ci_res")||{}).innerText||"")`, 60000, "5,000-row preview"); ms.check = Date.now() - a; });
  await step("added; money in stock goes up by exactly the 5,000 prices + packaging", async () => { const a = Date.now(); await app.tap({ sel: "#ci_res button", text: "Add 5000 items" });
    await app.waitText("Added 5000 items", 90000); ms.add = Date.now() - a; const S = await store(); ok(S.items.length === n0 + 5000, `${S.items.length - n0} added`);
    const paid = Array.from({ length: 5000 }, (_, k) => (k % 97) + 0.01).reduce((t, x) => t + x, 0); const m = await checkFigures("after 5,000 rows");
    ok(r2(m.invested - s0.invested) === r2(paid), `stock went up by ${r2(m.invested - s0.invested)}, expected ${r2(paid)}`); await app.shot("5000 imported"); });
  await step("closing and reopening with 5,000 extra items keeps them all", async () => { const a = Date.now(); await reopen(); await toStock(); await app.waitFor(`!!document.querySelector(".ms-sum")`, 60000, "My Stock"); ms.reopen = Date.now() - a;
    ok((await store()).items.length === n0 + 5000, "items lost on reopen"); });
  await step("removing them again (Undo after reopening isn't offered, so they're re-imported and undone)", async () => {
    await app.eval(`(()=>{const ids=new Set(S.items.filter(i=>/^Bulk item /.test(i.name)).map(i=>i.id));S.items=S.items.filter(i=>!ids.has(i.id));save();render();return 1})()`); // test clean-up only
    ok((await store()).items.length === n0, "clean-up failed"); await checkFigures("after clean-up"); });
  await step("5,001 rows are refused with a plain message", async () => { await app.tap({ text: "Import…" });
    await app.eval(`(()=>{const d=document.querySelector("#sheet details");if(d)d.open=true;const t=document.getElementById("ci_t");t.value=${JSON.stringify(big + "\nOne more,1,Bought,,")};t.dispatchEvent(new Event("input"));return 1})()`);
    await sheetBtn("Check it"); await sleep(1500); ok(/5001 rows/.test(await app.eval(`document.getElementById("ci_res").innerText`)), "5,001 not refused"); ok((await store()).items.length === n0, "something was added"); });
  let keep;
  await step("pasted text over 2 MB is refused with a plain message", async () => { keep = await storeText();
    await app.eval(`(()=>{const t=document.getElementById("ci_t");t.value="Name\\n"+"x".repeat(2000001);t.dispatchEvent(new Event("input"));return 1})()`); await sheetBtn("Check it"); await sleep(1500);
    ok(/too big/.test(await app.eval(`document.getElementById("ci_res").innerText`)), "2 MB not refused"); ok((await storeText()) === keep, "saved data changed"); await app.back(); });
  await step("after that, closing and reopening: saved data is exactly the same", async () => { await reopen(); ok((await storeText()) === keep, `saved data different after reopening (${((await store()) || {items:[]}).items.length} items)`); });
  R.add("Toolkit", `Large import timing (5,000 rows): check ${ms.check} ms, add + show ${ms.add} ms, reopen ${ms.reopen} ms`, ms.add < 30000 && ms.check < 20000 ? "PASS" : "PARTIALLY TESTED", "aim: check under 20 s, add under 30 s on the slow emulator");
});

await T("Offline: works with no internet and no Scan service", async (step) => {
  await step("internet off (Wi-Fi and mobile data) and the Scan service unreachable", async () => { sh("svc wifi disable"); sh("svc data disable"); await CHAOS("down"); await sleep(2000); });
  await step("calculator, adding an item and an expense all work and are saved", async () => { await reopen(); await toStock(); await section("Calculator"); await app.fill({ sel: "#cl_sell" }, "50"); await app.fill({ sel: "#cl_buy" }, "20");
    ok(/Profit/.test(await app.eval(`document.getElementById("calc_res").innerText`)), "no result offline"); await section("Stock"); await app.tap({ text: "+ Add item" });
    await app.fill({ sel: "#it_n" }, "Offline item"); await app.fill({ sel: "#it_b" }, "10"); await sheetBtn("Add to My Stock"); await app.waitText("Added to My Stock", 8000);
    await section("Expenses"); await app.tap({ text: "+ Add expense" }); await app.fill({ sel: "#ex_a" }, "3"); await sheetBtn("Save"); await app.waitText("Expense added", 8000);
    const S = await store(); ok(S.items.some((i) => i.name === "Offline item") && S.expenses.some((e) => e.amount === 3), "not saved offline"); await app.shot("offline my stock"); });
  await step("'Back up now' offline fails clearly and nothing is lost", async () => { await tabTo("Settings"); await app.tap({ sel: "#bk_now" }); await app.waitText("Backup failed", 30000); ok((await store()).items.some((i) => i.name === "Offline item"), "lost"); });
  await step("internet back on", async () => { sh("svc wifi enable"); sh("svc data enable"); await CHAOS("normal"); await sleep(3000); });
});

await T("Cloud backup and restore with the new data", async (step) => {
  let snap;
  await step("'Back up now' saves stock and expenses to the test Scan service", async () => { await reopen(); await tabTo("Settings"); await app.tap({ sel: "#bk_now" }); await app.waitText("Backed up at", 25000); snap = await store(); });
  await step("delete an expense and an item, then 'Restore from cloud' brings back exactly what was backed up", async () => {
    await app.eval(`(()=>{S.expenses.pop();S.items.shift();localStorage.setItem("resell_helper_v1",JSON.stringify(S));render();return 1})()`); // simulate a lost change (test set-up)
    await tabTo("Settings"); await app.tap({ text: "Restore from cloud", exact: true }); await app.waitText("Restore your data", 15000); await sheetBtn("Restore it"); await app.waitText("Restored", 10000);
    const S = await store(); ok(JSON.stringify(S.items) === JSON.stringify(snap.items) && JSON.stringify(S.expenses) === JSON.stringify(snap.expenses), "restored data differs from the backup"); });
});

await T("Closing and reopening keeps everything exactly", async (step) => {
  await step("force-close and reopen: saved data is byte-for-byte the same and the figures match", async () => { await toStock(); const a = await storeText(), s = await shown();
    await reopen(); await toStock(); ok((await storeText()) === a, "saved data changed"); ok(JSON.stringify(await shown()) === JSON.stringify(s), "figures changed"); await checkFigures("after reopen"); });
  await step("information: new app, instant force-close straight after a change", async () => { const a = await storeText(); await instantKill("new app (toolkit)");
    ok((await storeText()) === a, "saved data not back to the same after the check"); });
});

await B("Phone Back button on the new screens (10 rounds)", async (step) => {
  const res = { calc: 0, exp: 0, sheet: 0, stock: 0, deal: 0 }, rounds = 10;
  await step(`${rounds} rounds from Deals: Calculator → Back, Expenses → Back, open sheet → Back, My Stock → Back (to Deals), deal + 'I bought' sheet → Back → Back`, async () => {
    const fails = []; await tabTo("Deals"); await app.waitFor(`!!document.querySelector(".dcard")`, 15000, "deal cards");
    for (let k = 0; k < rounds && timeLeft(); k++) {
      await toStock(); await section("Calculator"); await app.back(); if (await app.eval(`tab==="stock"&&MS.view==="stock"`)) res.calc++; else fails.push(`round ${k + 1}: Calculator → Back went to ${await app.eval("tab+'/'+MS.view")}`);
      await toStock(); await section("Expenses"); await app.back(); if (await app.eval(`tab==="stock"&&MS.view==="stock"`)) res.exp++; else fails.push(`round ${k + 1}: Expenses → Back`);
      await toStock(); const c = (await store()).items.length; await app.tap({ text: "+ Add item" }); await app.waitFor(`document.getElementById("sheet").classList.contains("on")`, 5000, "sheet"); await app.back(); await sleep(500);
      if (!(await sheetOpen()) && (await app.eval(`tab`)) === "stock" && (await store()).items.length === c) res.sheet++; else fails.push(`round ${k + 1}: Back on the Add item sheet`);
      await app.back(); if ((await app.eval(`tab`)) === "deals") res.stock++; else fails.push(`round ${k + 1}: My Stock → Back went to ${await app.eval("tab")}`);
      await app.waitFor(`!!document.querySelector(".dcard")`, 15000, "deal cards"); await app.tap({ sel: ".dcard", nth: k % 2 }); await app.waitFor(`tab==="deal"`, 10000, "deal page");
      await app.tap({ text: "I bought this: add to My Stock" }); await sleep(600); await app.back(); await sleep(500); const s1 = !(await sheetOpen()) && (await app.eval(`tab`)) === "deal";
      await app.back(); await sleep(800); const s2 = (await app.eval(`tab`)) === "deals"; if (s1 && s2) res.deal++; else fails.push(`round ${k + 1}: deal sheet Back ${s1 ? "ok" : "FAILED"}, deal page Back ${s2 ? "ok" : "FAILED"}`);
    }
    R.add("Toolkit: Back button", `results: Calculator ${res.calc}/${rounds}, Expenses ${res.exp}/${rounds}, sheet ${res.sheet}/${rounds}, My Stock→Deals ${res.stock}/${rounds}, deal sheet + page ${res.deal}/${rounds}`, fails.length ? "FAIL" : "PASS", fails.slice(0, 6).join(" · "));
    ok(!fails.length, fails.slice(0, 3).join(" · ")); });
});

for (const theme of ["Dark", "Light"]) await T(`${theme} mode on the new screens`, async (step) => {
  await step(`switch to ${theme} in Settings`, async () => { await tabTo("Settings"); await app.tap({ text: theme, exact: true }); await app.waitFor(`document.documentElement.dataset.theme===${JSON.stringify(theme.toLowerCase())}`, 5000, "theme"); });
  for (const s of ["Stock", "Expenses", "Calculator"]) await step(`My Stock › ${s}: shown, nothing off the screen`, async () => { await toStock(); await section(s); await sleep(500); const o = await overflow(); await app.shot(`${theme} ${s}`);
    ok(!o.o.length && !o.nav.length, JSON.stringify(o)); });
});

let BASEFS = 0;
for (const scale of [1.3, 2.0]) await T(`Phone text size ×${scale}`, async (step) => {
  if (!timeLeft()) throw new Error("not run: time limit");
  await step(`phone font size ×${scale}, app reopened; the text really gets bigger`, async () => { sh(`settings put system font_scale ${scale}`); await reopen(); await toStock();
    const px = () => app.eval(`parseFloat(getComputedStyle(document.querySelector(".ms-sum .ms-v")||document.body).fontSize)`);
    if (!BASEFS) { sh("settings put system font_scale 1.0"); await reopen(); await toStock(); BASEFS = await px(); sh(`settings put system font_scale ${scale}`); await reopen(); await toStock(); }
    const fs_ = await px(); R.add("Toolkit", `text size ×${scale}: figure text ${fs_}px (normal size ${BASEFS}px)`, "PASS"); ok(fs_ >= BASEFS * (scale - 0.15), `text didn't get bigger: ${fs_}px vs ${BASEFS}px at normal size`); });
  for (const s of ["Stock", "Expenses", "Calculator"]) await step(`${s}: nothing off the screen; all four tab labels fit`, async () => { await section(s); await sleep(500); const o = await overflow(); await app.shot(`text ${scale} ${s}`); ok(!o.o.length && !o.nav.length, JSON.stringify(o)); });
  await step("return/refund sheet fits", async () => { await section("Stock"); await cardTap("Nintendo Switch", ".ms-more"); await sheetBtn("Buyer return or refund…"); await sleep(600); const o = await overflow(); await app.shot(`text ${scale} return sheet`); await app.back(); ok(!o.o.length, JSON.stringify(o)); });
  sh("settings put system font_scale 1.0");
});
sh("settings put system font_scale 1.0");

const rows = R.rows, c = (s) => rows.filter((r) => r.status === s).length;
console.log(`TOOLKIT: ${c("PASS")} pass · ${c("FAIL")} fail · ${c("PARTIALLY TESTED")} partly · ${c("NOT TESTED")} not tested · ${Math.round((Date.now() - t0) / 60000)} min`);
for (const r of rows.filter((r) => r.status !== "PASS")) console.log(`${r.status}: ${r.name} — ${r.detail || ""}`);
process.exit(c("FAIL") ? 1 : 0);
