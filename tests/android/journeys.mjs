// The emulator test plan: installs the real test app, then walks through every main journey and the unusual
// behaviour checks, tapping through Android itself. Uses ONLY the private test Scan service and fake data.
// Run (inside the emulator job): APK=app.apk TEST_APP_KEY=... node tests/android/journeys.mjs
import fs from "node:fs";
import { App, Results, sleep, sh, adb } from "./driver.mjs";
import { makeDeals, seedDeals, query } from "./seed.mjs";

const KEY = process.env.TEST_APP_KEY, APK = process.env.APK || "app-debug.apk";
const CHAOS = (m, ms) => fetch(`http://127.0.0.1:8791/${m === "reset" ? "reset" : m === "stats" ? "stats" : "mode?m=" + m + (ms ? "&ms=" + ms : "")}`).then((r) => r.json());
const app = new App("screenshots"), R = new Results(app);
// "the app has stopped loading": no new request to the test Scan service for 3 seconds
app.netQuiet = async () => { let last = -1, same = 0; for (let i = 0; i < 30; i++) { let n = 0; try { n = Object.values((await CHAOS("stats")).stats).reduce((a, b) => a + b, 0); } catch (e) { return; }
  if (n === last) { if (++same >= 3) return; } else { same = 0; last = n; } await sleep(1000); } };
const J = (name, fn) => R.journey("User journeys", name, fn), U = (name, fn) => R.journey("Unusual behaviour", name, fn);
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const dealsCount = async () => +((await app.text()).match(/(\d+) deals?\b/) || [])[1] || 0;
const menu = () => app.tap({ sel: "#nav button", nth: 2 });
const dealsTab = () => app.tap({ sel: "#nav button", nth: 0 });
// put the 14 fake deals back (a scan may have re-judged them) and reopen the app so it shows them
const freshDeals = async () => { await seedDeals(DEALS); await app.stop(); await app.launch(); await app.waitFor(`!!document.querySelector(".dcard")`, 30000, "deal cards"); };

// the phone's "localhost" is connected to this machine: 8787 = the test Scan service, through the bad-network switch;
// 8790 = fake eBay sold pages for Fill. Nothing else is reachable from the app in these tests.
adb("reverse", "tcp:8787", "tcp:8789");
adb("reverse", "tcp:8790", "tcp:8790");
fs.mkdirSync("results", { recursive: true });
app.startLog("logcat.txt");
// let the new virtual phone finish starting up (Google services update themselves after boot and slow everything down)
app.prepPhone();
for (let i = 0; i < 24; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await app.unblock();

const setup = await R.journey("Android emulator", "Install and launch the real app", async (step) => {
  await step("APK installs on the emulator", async () => { app.install(APK); ok(/com\.reaverslegion\.flipscout/.test(sh("pm list packages")), "package not installed"); });
  await step("app opens and shows its first screen", async () => { await app.launch(); await app.waitFor(`typeof render==="function"&&!!document.getElementById("app")`, 30000, "the app"); await app.shot("first launch"); });
});
if (!setup) { finish(); process.exit(1); }

await J("First-time welcome guide", async (step) => {
  await step("welcome guide is shown on first launch", () => app.waitText("Your 24/7 bargain hunter", 15000));
  await step("Next moves through the guide", async () => { for (let i = 0; i < 3; i++) await app.tap({ text: "Next", exact: true }); await app.waitText("How do you sell on eBay"); await app.shot("welcome guide last page"); });
  await step("choosing Private seller marks it", async () => { await app.tap("Private seller"); await app.waitFor(`!!document.querySelector("#onb .choice.on")&&/Private/.test(document.querySelector("#onb .choice.on").innerText)`, 5000, "Private seller ticked"); });
  await step("Start using FlipScout closes the guide", async () => { await app.tap("Start using FlipScout"); await app.waitFor(`getComputedStyle(document.getElementById("onb")).display==="none"`, 5000, "guide closed"); await app.waitText("Connect your Scan service"); await app.shot("deals not connected"); });
});

await U("Wrong key is handled clearly", async (step) => {
  await step("Connect now opens the connection box", async () => { await app.tap("Connect now"); await app.waitFor(`!!document.getElementById("s_url")`, 8000, "address box"); });
  await step("typing a setup code with a WRONG key saves it", async () => {
    await app.fill({ sel: "#s_url" }, "http://localhost:8787#wrongkey0000000000");
    await app.waitFor(`(()=>{try{const s=JSON.parse(localStorage.getItem("resell_helper_v1")).set;return s.url==="http://localhost:8787"&&s.key==="wrongkey0000000000"}catch(e){return false}})()`, 8000, "the address and key saved on the phone"); await app.shot("wrong key saved"); });
  await step("Deals asks to pick categories", async () => { await dealsTab(); await app.waitText("Pick what to hunt"); });
  await step("Start with popular categories shows a clear 'wrong key' message, not a crash", async () => {
    await app.tap("Start with popular categories"); await app.waitText("wrong key", 20000); await app.shot("wrong key message"); });
  await step("the wrong key can be corrected from Menu (without hidden admin tools)", async () => { await menu(); await sleep(1000);
    const t = await app.text(); ok(/Service address|setup code|Connect your Scan service/i.test(t) && !!(await app.eval(`!!document.getElementById("s_url")`)),
      "APP FINDING: once a key is saved, Menu has no way to change it (the connection box only appears in hidden admin tools), so a user with a wrong key is stuck"); });
});

await J("Connect to the Scan service", async (step) => {
  await step("turn on admin tools (tap the version 7 times): with a key saved, the connection box is only in admin tools", async () => { await menu();
    const p = await app.locate({ text: "FlipScout version", sel: "div[onclick]" }); for (let i = 0; i < 7; i++) { await app.tapXY(p.x, p.y); await sleep(150); }
    await app.waitText("Admin tools on", 6000); });
  await step("open admin tools and the connection box", async () => { await app.tap("Open admin tools"); await app.waitText("Admin tools", 8000); await app.netQuiet();
    if (!(await app.eval(`!!document.getElementById("s_url")&&document.getElementById("s_url").offsetParent!==null`))) await app.tap({ sel: "#adv summary" });
    await app.waitFor(`!!document.getElementById("s_url")&&document.getElementById("s_url").offsetParent!==null`, 6000, "address box"); });
  await step("replace the setup code with the right one", async () => {
    await app.fill({ sel: "#s_url" }, `http://localhost:8787#${KEY}`);
    await app.waitFor(`(()=>{try{const s=JSON.parse(localStorage.getItem("resell_helper_v1")).set;return s.url==="http://localhost:8787"&&s.key.length===48}catch(e){return false}})()`, 8000, "the new address and key saved on the phone"); });
  await step("Deals opens with no error", async () => { await dealsTab(); await sleep(3000); const t = await app.eval(`document.getElementById("app").innerText`); ok(!/wrong key|no connection|error/i.test(t), "error on screen: " + t.slice(0, 120)); });
  await step("categories are picked (Start with popular categories)", async () => {
    if (/Pick what to hunt/.test(await app.text())) { await app.tap("Start with popular categories"); await app.waitText("Added \\d+ popular categor|already have these", 15000); }
    await app.waitFor(`/No deals right now|\\d+ deals?/.test(document.getElementById("app").innerText)`, 25000, "the deals screen (no categories prompt)"); await app.shot("connected"); });
});

await U("Empty data: no deals yet", async (step) => {
  await step("an empty database shows 'No deals right now', not a blank or broken screen", async () => { await app.waitText("No deals right now", 20000); await app.shot("no deals yet"); });
  await step("nothing on screen says undefined / NaN / null", async () => { const t = await app.text(); ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(t), "found: " + (t.match(/.{0,30}(undefined|NaN|null).{0,30}/) || [])[0]); });
});

const DEALS = makeDeals(14);
await J("Deals list", async (step) => {
  await step("fake deals loaded into the TEST database", async () => { ok((await seedDeals(DEALS)) === 14, "seed failed"); ok((await query("SELECT COUNT(*) n FROM deals"))[0].n === 14, "test database doesn't have 14 deals"); });
  await step("closing and reopening the app keeps the connection and shows the deals", async () => { await app.stop(); await app.launch();
    await app.waitFor(`/\\d+ deals?/.test(document.getElementById("app").innerText)`, 30000, "the deals count"); await app.shot("deals list"); });
  await step("deal cards show titles, prices and profit", async () => { const t = await app.text(); ok(/\(test \d+\)/.test(t), "no deal titles"); ok(/Profit after fees/.test(t), "no profit line"); ok(/£\d/.test(t), "no prices"); });
  await step("nothing on screen says undefined / NaN / null (deals with missing details)", async () => { const t = await app.text(); ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(t), "found: " + (t.match(/.{0,30}(undefined|NaN|null).{0,30}/) || [])[0]); });
  await step("sort menu opens and sorting by Most profit works", async () => { await app.tap({ sel: "#ds" }); await app.waitFor(`document.getElementById("pick").style.display==="block"`, 5000, "sort choices"); await app.shot("sort choices");
    await app.tap({ text: "Most profit" }); await app.waitFor(`/Most profit/.test(document.getElementById("ds").selectedOptions[0].text)`, 5000, "sorted by profit"); });
});

await J("Deal details", async (step) => {
  let before;
  await step("tapping a deal opens its page", async () => { await CHAOS("reset"); before = await app.eval(`location.hash+document.getElementById("app").innerText.slice(0,40)`);
    await app.tap({ sel: ".dcard", nth: 0, wait: 1500 }); await app.waitFor(`document.getElementById("gear").style.visibility==="visible"`, 8000, "the deal page"); await app.shot("deal page"); });
  await step("the deal page checks the listing is still for sale (with the test service)", async () => { await sleep(2500); ok(((await CHAOS("stats")).stats.check || 0) >= 1, "no live check was made"); });
  await step("the on-screen Back button returns to the list", async () => { await app.tap({ sel: "#gear" }); await app.waitFor(`document.getElementById("gear").style.visibility==="hidden"&&!!document.querySelector(".dcard")`, 6000, "the deals list"); });
  await step("the phone's own Back button also returns to the list", async () => { await app.tap({ sel: ".dcard", nth: 1, wait: 1500 }); await app.waitFor(`document.getElementById("gear").style.visibility==="visible"`, 8000, "deal page");
    await app.back(); await app.waitFor(`!!document.querySelector(".dcard")`, 6000, "the deals list"); ok(app.alive(), "Back closed the app"); });
});

await J("Sales list (From N sales ›)", async (step) => {
  await step("'From 24 sales ›' opens the sales behind the price", async () => { await app.tap({ text: "From 24 sales" }); await app.waitText("Sales behind this price"); await app.waitText("Sells for about", 15000); await app.shot("sales list"); });
  await step("it lists the sales with prices and dates", async () => { const n = await app.eval(`document.querySelectorAll("#sheet a.li").length`); ok(n >= 20, `only ${n} sales listed (24 expected)`); });
  await step("sales without a saved title are shown sensibly", async () => { await app.waitText("title not saved", 3000); });
  await step("Close shuts the list", async () => { await app.tap({ text: "Close", exact: true }); await app.waitFor(`!document.getElementById("sheet").classList.contains("on")`, 5000, "list closed"); });
});

await J("Menu and settings", async (step) => {
  await step("Menu opens", async () => { await menu(); await app.waitText("How do you sell on eBay"); await app.shot("menu"); });
  await step("switching to Business seller is saved to the test Scan service", async () => { await app.tap("Business seller"); await app.waitText("Business seller fees on", 5000); await sleep(2500);
    const c = await query("SELECT v FROM kv WHERE k='config'"); ok(c[0] && /"seller":"business"/.test(c[0].v), "the Scan service didn't get the change"); });
  await step("switching back to Private seller", async () => { await app.tap("Private seller"); await app.waitText("Private seller: no final value fee", 5000); });
  await step("Dark theme applies", async () => { await app.tap({ text: "Dark", exact: true }); await app.waitFor(`document.documentElement.dataset.theme==="dark"`, 4000, "dark theme"); await app.shot("dark theme"); await app.tap({ text: "Auto", exact: true }); });
});

await J("Refresh (Scan now)", async (step) => {
  await step("Deals shows Scan now for admin", async () => { await dealsTab(); await app.waitText("Scan now", 8000); });
  await step("while scanning the button says Checking… and can't be pressed again (5 fast taps = 1 scan)", async () => {
    await CHAOS("reset"); await CHAOS("slow", 7000); const p = await app.locate({ text: "Scan now" });
    for (let i = 0; i < 5; i++) { await app.tapXY(p.x, p.y); await sleep(120); }
    await app.waitText("Checking…", 4000); await app.shot("checking"); await sleep(9000); await CHAOS("normal");
    const st = (await CHAOS("stats")).stats; ok((st.run || 0) === 1, `${st.run || 0} scans were started by 5 taps`); });
  await step("when the scan finishes a result message appears and the list reloads", async () => { await app.waitText("Checked|new deal|Check had problems|Just scanned", 30000); await app.waitFor(`!/Checking…/.test(document.getElementById("app").innerText)`, 15000, "Scan now back to normal"); await app.shot("after scan"); });
});

await J("Fill prices for a category (fake eBay sold pages)", async (step) => {
  let iab;
  await step("admin tools open with the category list", async () => { await menu(); await app.tap("Open admin tools"); await app.waitText("Fill prices for a whole category", 10000); await app.shot("admin tools"); });
  await step("Fill opens the sold-listings browser", async () => { await app.tap({ text: "Fill", exact: true, nth: 0, wait: 3000 });
    iab = await app.connect((t) => /:8790\//.test(t.url), false); await app.waitFor(`!!document.getElementById("fs_bar")`, 25000, "FlipScout's bar on the sold page", iab); await sleep(4000); await app.shot("fill page 1"); });
  await step("the bar counts the sold prices read on page 1", async () => { await app.waitFor(`/24 sold|read 24|24 /.test(document.getElementById("fs_bar").innerText)`, 15000, "24 sold read", iab); });
  await step("Next page reads page 2 as well", async () => { await app.tap({ sel: "#fs_next", wait: 4000 }, iab); await iab.close();
    iab = await app.connect((t) => /:8790\/.*_pgn=2/.test(t.url), false); await app.waitFor(`!!document.getElementById("fs_bar")&&/48/.test(document.getElementById("fs_bar").innerText)`, 25000, "48 sold read", iab); await app.shot("fill page 2"); });
  await step("Save all closes the browser and saves the prices", async () => { await app.tap({ sel: "#fs_save", wait: 3000 }, iab); iab.close();
    await app.waitText("Saved \\d+ prices", 40000); await app.shot("fill saved"); });
  await step("the TEST database has the 48 sold items", async () => { const n = (await query("SELECT COUNT(*) n FROM fillseen WHERE id LIKE '3000000%'"))[0].n; ok(n === 48, `${n} of 48 sold items saved`); });
  await step("Done closes the summary", async () => { await app.tap({ text: "Done", exact: true }); await app.waitFor(`!document.getElementById("sheet").classList.contains("on")`, 5000, "summary closed"); });
});

await J("Page… (choose a page to fill from)", async (step) => {
  let iab;
  await step("Page… appears after a fill and opens the page chooser", async () => { await app.tap({ text: "Page…", nth: 0 }); await app.waitText("Go to page", 6000); await app.shot("page chooser"); });
  await step("an impossible page (0) is refused with a clear message", async () => { await app.fill({ sel: "#fpg" }, "0");
    await app.tap({ text: "Open page", exact: true }); await app.waitText("Pick a page from 1 to 100", 5000); });
  await step("page 7 (which the fake eBay can't show) opens and FlipScout says so", async () => { await app.fill({ sel: "#fpg" }, "7");
    await app.tap({ text: "Open page", exact: true, wait: 3000 }); iab = await app.connect((t) => /:8790\/.*_pgn=7/.test(t.url), false);
    await app.waitFor(`!!document.getElementById("fs_bar")&&/couldn't show page 7/i.test(document.getElementById("fs_bar").innerText)`, 30000, "the 'couldn't show page 7' message", iab); await app.shot("page 7 not available"); });
  await step("closing the browser returns to the app safely", async () => { iab.close(); const b = app.nativeButton("Done"); ok(b, "no Done button on the browser"); await app.tapXY(b.x, b.y); await sleep(2000);
    await app.waitText("No sold prices read|Fill prices for a whole category", 8000); });
});

await J("Following tab", async (step) => {
  await step("Following opens without errors", async () => { await app.tap({ sel: "#nav button", nth: 1 }); await sleep(1500); const t = await app.eval(`document.getElementById("app").innerText`); ok(t.length > 10, "blank screen"); ok(!/\bundefined\b|\bNaN\b/.test(t), "undefined/NaN on screen"); await app.shot("following"); });
});

await U("Lost connection while deals are showing", async (step) => {
  await step("with the Scan service unreachable, Scan now shows a calm message and keeps the deals", async () => { await seedDeals(DEALS); await dealsTab();
    await CHAOS("down"); await app.tap("Scan now"); await app.waitText("Couldn't refresh just now|no connection", 20000); ok(!!(await app.eval(`document.querySelector(".dcard")`)) || /No deals/.test(await app.text()), "deals disappeared"); await app.shot("offline"); await CHAOS("normal"); });
  await step("when the connection comes back, Scan now works again", async () => { await sleep(46000); await app.tap("Scan now"); await app.waitText("Checked|new deal|Check had problems|Just scanned", 40000); });
});

await U("Server errors and dropped connections", async (step) => {
  await step("fake deals reloaded", freshDeals);
  await step("a Scan service error while opening the sales list shows a clear message", async () => { await CHAOS("error"); await app.tap({ text: "From 24 sales" }); await app.waitText("Couldn't load", 15000); await app.shot("server error"); await CHAOS("normal"); await app.tap({ text: "Close", exact: true }); });
  await step("a connection cut half-way through an answer doesn't crash the app", async () => { await CHAOS("cut"); await app.tap({ text: "From 24 sales" }); await sleep(6000); await CHAOS("normal"); await app.shot("cut connection");
    ok(app.alive(), "app died"); await app.eval(`closeSheet(),1`).catch(() => {}); });
  await step("a very slow answer shows Loading and then the sales", async () => { await CHAOS("slow", 6000); await app.tap({ text: "From 24 sales" }); await app.waitText("Loading sales", 3000); await app.waitText("Sells for about", 20000); await CHAOS("normal"); await app.tap({ text: "Close", exact: true }); });
});

await U("Repeated and rapid taps", async (step) => {
  await step("fake deals reloaded", freshDeals);
  await step("double-tapping a deal opens it once (one Back returns to the list)", async () => { const p = await app.locate({ sel: ".dcard", nth: 0 }); await app.tapXY(p.x, p.y); await sleep(80); await app.tapXY(p.x, p.y);
    await app.waitFor(`document.getElementById("gear").style.visibility==="visible"`, 8000, "deal page"); await app.back(); await sleep(800);
    ok(await app.eval(`document.getElementById("gear").style.visibility==="hidden"&&!!document.querySelector(".dcard")`), "after one Back it was still on a deal page (opened twice)"); });
  await step("switching tabs quickly 12 times leaves the app working", async () => { for (let i = 0; i < 12; i++) await app.tap({ sel: "#nav button", nth: i % 3, wait: 120 }); await dealsTab(); await app.waitFor(`!!document.querySelector(".dcard")`, 10000, "deals list"); });
});

await U("Leaving and coming back", async (step) => {
  await step("going to the home screen and back keeps the app where it was", async () => { await app.home(); await app.resume(); ok(app.alive(), "app restarted or died"); await app.waitFor(`!!document.querySelector(".dcard")`, 10000, "deals list"); await app.shot("resumed"); });
  await step("rotating the phone doesn't lose anything", async () => { sh("settings put system accelerometer_rotation 0"); sh("settings put system user_rotation 1"); await sleep(2500); app.cal = null; await app.shot("landscape");
    sh("settings put system user_rotation 0"); await sleep(2000); app.cal = null; ok(app.alive(), "app died on rotation"); await app.connect().catch(() => {}); await app.waitFor(`!!document.querySelector(".dcard")`, 10000, "deals list after rotation"); });
});

finish();

function finish() {
  try { app.logcat && app.logcat.kill(); } catch (e) {}
  fs.writeFileSync("results/android.json", JSON.stringify(R.rows, null, 1));
  const c = (s) => R.rows.filter((r) => r.status === s).length;
  if (app.events.length) console.log("Screen-link events:\n" + app.events.join("\n"));
  if (app.unblocked) R.add("Android emulator", "the virtual phone itself froze and was un-stuck", "PARTIALLY TESTED", `${app.unblocked} system "isn't responding" pop-up(s) closed during the run (emulator slowness, not FlipScout)`);
  fs.writeFileSync("results/android.json", JSON.stringify(R.rows, null, 1));
  console.log(`\nEmulator tests: ${c("PASS")} passed, ${c("FAIL")} failed, ${c("NOT TESTED")} not run`);
  for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
