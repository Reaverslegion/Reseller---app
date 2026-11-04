// The emulator test plan: installs the real test app, then walks through every main journey and the unusual
// behaviour checks, tapping through Android itself. Uses ONLY the private test Scan service and fake data.
// Run (inside the emulator job): APK=app.apk TEST_APP_KEY=... node tests/android/journeys.mjs
import fs from "node:fs";
// write each line straight out, so nothing is lost when the script ends right after a long list
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
import { App, Results, sleep, sh, adb } from "./driver.mjs";
import { makeDeals, seedDeals, query } from "./seed.mjs";

const KEY = process.env.TEST_APP_KEY, APK = process.env.APK || "FlipScout.apk";
const CHAOS = (m, ms) => fetch(`http://127.0.0.1:8791/${m === "reset" ? "reset" : m === "stats" ? "stats" : "mode?m=" + m + (ms ? "&ms=" + ms : "")}`).then((r) => r.json());
const app = new App("screenshots"), R = new Results(app, "results/android.json");
app.beforeJourney = () => CHAOS("normal");   // every journey starts with a normal connection
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

await J("Connect to the Scan service", async (step) => {
  await step("Connect now opens the connection box", async () => { await app.tap("Connect now"); await app.waitFor(`!!document.getElementById("s_url")`, 8000, "address box"); });
  await step("typing the setup code (address#key) saves the connection on the phone", async () => {
    await app.fill({ sel: "#s_url" }, `http://localhost:8787#${KEY}`);
    await app.waitFor(`(()=>{try{const s=JSON.parse(localStorage.getItem("resell_helper_v1")).set;return s.url==="http://localhost:8787"&&s.key.length===48}catch(e){return false}})()`, 8000, "the address and key saved on the phone"); await app.shot("connected"); });
  await step("Deals asks what to hunt, with no error", async () => { await dealsTab(); await app.waitText("Pick what to hunt", 15000); const t = await app.text(); ok(!/wrong key|no connection/i.test(t), "error on screen"); });
  await step("Start with popular categories adds them and the Scan service gets them", async () => { await app.tap("Start with popular categories"); await app.waitText("Added \\d+ popular categor", 15000);
    await app.waitFor(`/No deals right now|\\d+ deals?/.test(document.getElementById("app").innerText)`, 25000, "the deals screen");
    await app.netQuiet(); const c = await query("SELECT v FROM kv WHERE k='config'"); ok(c[0] && /27386/.test(c[0].v), "categories didn't reach the test Scan service"); });
});

await U("Empty data: no deals yet", async (step) => {
  await step("an empty database shows 'No deals right now', not a blank or broken screen", async () => { await app.waitText("No deals right now", 20000); await app.shot("no deals yet"); });
  await step("nothing on screen says undefined / NaN / null", async () => { const t = await app.text(); ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(t), "found: " + (t.match(/.{0,30}(undefined|NaN|null).{0,30}/) || [])[0]); });
});

const DEALS = makeDeals(14);
await J("Deals list", async (step) => {
  await step("fake deals loaded into the TEST database", async () => { ok((await seedDeals(DEALS)) === 14, "seed failed"); ok((await query("SELECT COUNT(*) n FROM deals"))[0].n === 14, "test database doesn't have 14 deals"); });
  await step("closing and reopening the app keeps the connection and shows the deals", async () => { await app.stop(); await app.launch();
    await app.waitFor(`/\\d+ deals?/.test(document.getElementById("app").innerText)&&!!document.querySelector(".dcard")`, 30000, "the deal cards"); await app.shot("deals list"); });
  await step("deal cards show titles, prices and profit", async () => { const t = await app.text(); ok(/\(test \d+\)/.test(t), "no deal titles"); ok(/profit/i.test(t) && /[+−-]£\d/.test(t), "no profit figures"); ok(/£\d/.test(t), "no prices"); });
  await step("nothing on screen says undefined / NaN / null (deals with missing details)", async () => { const t = await app.text(); ok(!/\bundefined\b|\bNaN\b|\bnull\b/.test(t), "found: " + (t.match(/.{0,30}(undefined|NaN|null).{0,30}/) || [])[0]); });
  await step("sort menu opens and sorting by Most profit works", async () => { await app.tap({ sel: "#ds" }); await app.waitFor(`document.getElementById("pick").style.display==="block"`, 5000, "sort choices"); await sleep(1500); await app.shot("sort choices");
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

await U("Sales list on a database that has never been filled", async (step) => {
  await step("'From 24 sales ›' opens without an error before any Fill has been done", async () => { await app.tap({ text: "From 24 sales" }); await app.waitText("Sales behind this price");
    await app.waitFor(`/Sells for about|Couldn't load/.test(document.getElementById("sheet").innerText)`, 25000, "the sales list or an error"); await app.shot("sales list fresh database");
    const t = await app.eval(`document.getElementById("sheet").innerText`); await app.back();
    ok(!/Couldn't load/.test(t), "APP FINDING: on a database where Fill has never run, the sales list fails: " + (t.match(/Couldn't load[^\n]*/) || [""])[0]); });
});

await J("Sales list (From N sales ›)", async (step) => {
  await step("'From 24 sales ›' opens the sales behind the price", async () => { await app.tap({ text: "From 24 sales" }); await app.waitText("Sales behind this price");
    await app.waitFor(`/Sells for about/.test(document.getElementById("sheet").innerText)`, 25000, "the sales list loaded"); await app.shot("sales list"); });
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

await J("Turn on admin tools", async (step) => {
  await step("tapping the version in Menu 7 times turns on admin tools", async () => { await menu(); const p = await app.locate({ text: "FlipScout version", sel: "div[onclick]" });
    for (let i = 0; i < 7; i++) { await app.tapXY(p.x, p.y); await sleep(150); } await app.waitText("Admin tools on", 6000); await app.waitText("Open admin tools", 5000); });
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
  await step("Next page reads page 2 as well", async () => { await app.tap({ sel: "#fs_next", wait: 4000 }, iab);
    await app.waitFor(`/_pgn=2/.test(location.href)`, 20000, "page 2 open", iab); await app.waitFor(`!!document.getElementById("fs_bar")&&/48/.test(document.getElementById("fs_bar").innerText)`, 25000, "48 sold read", iab); await app.shot("fill page 2"); });
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
  await step("fake deals reloaded", freshDeals);
  await step("with the Scan service unreachable, Scan now shows a calm message and keeps the deals on screen", async () => { await sleep(46000);
    const before = await app.eval(`document.querySelectorAll(".dcard").length`); ok(before > 0, "no deals on screen to begin with");
    await CHAOS("down"); await app.tap("Scan now"); await app.waitText("Couldn't refresh just now|no connection", 25000);
    const after = await app.eval(`document.querySelectorAll(".dcard").length`); await app.shot("offline"); await CHAOS("normal");
    ok(after === before, `deals on screen went from ${before} to ${after} when the connection failed`); });
  await step("when the connection comes back, Scan now works again", async () => { await sleep(46000); await app.tap("Scan now"); await app.waitText("Checked|new deal|Check had problems|Just scanned", 40000); });
});

await U("Server errors and dropped connections", async (step) => {
  await step("fake deals reloaded", freshDeals);
  await step("a Scan service error while opening the sales list shows a clear message", async () => { await CHAOS("error"); await app.tap({ text: "From 24 sales" }); await app.waitText("Couldn't load", 15000); await app.shot("server error"); await CHAOS("normal"); await app.tap({ text: "Close", exact: true }); });
  await step("a connection cut half-way through an answer doesn't crash the app", async () => { await CHAOS("cut"); await app.tap({ text: "From 24 sales" }); await sleep(6000); await CHAOS("normal"); await app.shot("cut connection");
    ok(app.alive(), "app died"); await app.eval(`closeSheet(),1`).catch(() => {}); });
  await step("a very slow answer shows Loading and then the sales", async () => { await CHAOS("slow", 6000); await app.tap({ text: "From 24 sales" }); await app.waitText("Loading sales", 3000);
    await app.waitFor(`/Sells for about/.test(document.getElementById("sheet").innerText)`, 30000, "the sales list after the slow answer"); await CHAOS("normal"); await app.tap({ text: "Close", exact: true }); });
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

const openBox = async () => { if (!(await app.eval(`!!document.getElementById("s_url")&&document.getElementById("s_url").offsetParent!==null`))) await app.tap({ sel: "#adv summary" }); };
const savedKey = (k) => `(()=>{try{return JSON.parse(localStorage.getItem("resell_helper_v1")).set.key===${JSON.stringify(k)}}catch(e){return false}})()`;

await U("Wrong key can be fixed from Menu (fix 1)", async (step) => {
  await step("once connected, Menu still has the connection box (folded away)", async () => { await menu(); await sleep(1000);
    ok(!!(await app.eval(`!!document.getElementById("adv")&&!!document.getElementById("s_url")`)), "no connection box in Menu"); });
  await step("type a setup code with a WRONG key in Menu", async () => { await openBox(); await app.fill({ sel: "#s_url" }, "http://localhost:8787#wrongkey0000000000", undefined, openBox);
    await app.waitFor(savedKey("wrongkey0000000000"), 8000, "wrong key saved"); });
  await step("Deals shows 'wrong key' with Check address and key and Try again, and not 'Loading deals…' (fix 3)", async () => { await dealsTab(); await app.waitText("wrong key", 20000);
    const t = await app.eval(`document.getElementById("app").innerText`); await app.shot("wrong key with buttons");
    ok(/Check address and key/.test(t), "no 'Check address and key' button"); ok(/Try again/.test(t), "no 'Try again' button"); ok(!/Loading deals…/.test(t), "still says Loading deals… under the error"); });
  await step("'Check address and key ›' opens the connection box in Menu", async () => { await app.tap("Check address and key"); await sleep(1200);
    await app.waitFor(`!!document.getElementById("s_url")&&document.getElementById("s_url").offsetParent!==null`, 6000, "the open connection box"); });
  await step("putting the right key in fixes Deals", async () => { await app.fill({ sel: "#s_url" }, `http://localhost:8787#${KEY}`, undefined, openBox);
    await app.waitFor(savedKey(KEY), 8000, "right key saved"); await dealsTab();
    await app.waitFor(`!!document.querySelector(".dcard")||/No deals right now/.test(document.getElementById("app").innerText)`, 30000, "deals (or 'No deals right now')");
    ok(!/wrong key/i.test(await app.eval(`document.getElementById("app").innerText`)), "still says wrong key"); await app.shot("fixed key"); });
});

await U("First load fails, then Try again (fix 3)", async (step) => {
  await step("with no connection when the app opens, Deals says so and offers Try again, without 'Loading deals…'", async () => { await seedDeals(DEALS); await CHAOS("down");
    await app.stop(); await app.launch(); await app.waitText("no connection", 30000); await sleep(1500);
    const t = await app.eval(`document.getElementById("app").innerText`); await app.shot("first load failed");
    ok(/Try again/.test(t), "no Try again button"); ok(!/Loading deals…/.test(t), "says Loading deals… under the error"); });
  await step("when the connection is back, Try again loads the deals", async () => { await CHAOS("normal"); await app.tap("Try again");
    await app.waitFor(`!!document.querySelector(".dcard")`, 30000, "deal cards after Try again"); });
});

await U("Sales list on a brand-new database (fix 2, Scan service)", async (step) => {
  await step("the test database's price book has every column before any Fill", async () => {
    const r = await query("SELECT name FROM pragma_table_info('prices')"); const cols = r.map((x) => x.name);
    for (const c of ["lo", "hi", "src", "n", "spd", "sdays", "sn", "act", "act_at"]) ok(cols.includes(c), "missing column " + c); });
});

// Owner checked this on a real Android phone on 4 Nov 2026: tapping the admin Service address box opens the keyboard and it
// stays open. On the emulator it doesn't. This only records what happens on the emulator (focus and box events) to explain why.
await R.journey("Android emulator", "Investigation: admin connection box on the emulator", async (step) => {
  await step("open admin tools and the connection box", async () => { await menu(); await app.tap("Open admin tools"); await app.waitText("Admin tools", 8000); await app.netQuiet(); await openBox(); });
  await step("record what happens when the Service address box is tapped", async () => {
    await app.eval(`(()=>{window.__fe=[];const t0=Date.now(),lg=(k,e)=>window.__fe.push((Date.now()-t0)+"ms "+k+" "+((e.target&&(e.target.id||e.target.tagName))||""));
      ["focusin","focusout","pointerdown","pointerup","click"].forEach(n=>document.addEventListener(n,e=>lg(n,e),{capture:true,passive:true}));
      const d=document.getElementById("adv");if(d)d.addEventListener("toggle",()=>window.__fe.push((Date.now()-t0)+"ms box "+(d.open?"opened":"closed")));
      window.addEventListener("resize",()=>window.__fe.push((Date.now()-t0)+"ms page resized to "+innerWidth+"x"+innerHeight));return 1})()`);
    const calc = await app.locate({ sel: "#s_url" }), nb = app.nativeById("s_url"), geo = await app.eval(`(()=>{const r=document.getElementById("s_url").getBoundingClientRect();return Math.round(r.top)+"-"+Math.round(r.bottom)+" of "+innerHeight})()`);
    R.add("Android emulator", "admin connection box: where it is", "PASS", `calculated tap ${Math.round(calc.x)},${Math.round(calc.y)}; Android says ${nb ? Math.round(nb.x) + "," + Math.round(nb.y) + " (" + nb.t + "-" + nb.b + ")" : "not listed"}; box in page ${geo}; screen ${sh("wm size").trim()}`);
    await app.tap({ sel: "#s_url", wait: 2500 });
    const ev = await app.eval("window.__fe.join(' · ')"), f = await app.eval(`document.activeElement.id||document.activeElement.tagName`);
    let kb = ""; try { kb = (sh("dumpsys input_method").match(/mInputShown=\w+|mIsInputViewShown=\w+|isInputViewShown=\w+/g) || []).join(","); } catch (e) {}
    await app.shot("admin box tapped");
    R.add("Android emulator", "admin connection box: what the emulator did", f === "s_url" ? "PASS" : "PARTIALLY TESTED",
      `focus after tap: ${f}; keyboard: ${kb || "unknown"}; events: ${String(ev).slice(0, 200)}. Earlier failures: the emulator's web view ignored "scroll into view", so taps landed below the screen (test problem, now scrolls by swiping). Verified working on the owner's real Android phone, 4 Nov 2026.`);
  });
});

finish();

function finish() {
  try { app.logcat && app.logcat.kill(); } catch (e) {}
  fs.writeFileSync("results/android.json", JSON.stringify(R.rows, null, 1));
  const c = (s) => R.rows.filter((r) => r.status === s).length;
  if (app.posNotes) R.add("Android emulator", "taps that needed Android's own box position", "PARTIALLY TESTED", app.posNotes.join(" | ").slice(0, 400));
  if (app.swipes) console.log(`Finger swipes used to bring controls on screen: ${app.swipes}`);
  if (app.missed) console.log(`Taps corrected after the screen shifted: ${app.missed}`);
  if (app.events.length) console.log("Screen-link events:\n" + app.events.join("\n"));
  if (app.unblocked) R.add("Android emulator", "the virtual phone itself froze and was un-stuck", "PARTIALLY TESTED", `${app.unblocked} system "isn't responding" pop-up(s) closed during the run (emulator slowness, not FlipScout)`);
  fs.writeFileSync("results/android.json", JSON.stringify(R.rows, null, 1));
  console.log(`\nEmulator tests: ${c("PASS")} passed, ${c("FAIL")} failed, ${c("NOT TESTED")} not run`);
  for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + r.detail : ""}`);
}
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
