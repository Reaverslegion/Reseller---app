// Compatibility check on another Android version (and for trial builds such as Capacitor 8): installs the app on a clean
// virtual phone, connects it to the private TEST Scan service with 30 fake deals, and looks at each main screen:
// does it draw, does anything run off the side, and is the top of the app hidden under the phone's status bar?
// Run (inside an emulator job): LABEL="Android 15" APK=apk/FlipScout.apk TEST_APP_KEY=... node tests/android/compat.mjs
import fs from "node:fs";
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
import { App, Results, sleep, sh, adb, PKG } from "./driver.mjs";
import { makeDeals, seedDeals } from "./seed.mjs";
const LABEL = process.env.LABEL || "compat", KEY = process.env.TEST_APP_KEY;
const app = new App(`screenshots/compat-${LABEL.replace(/\W+/g, "-")}`), AREA = `Compatibility: ${LABEL}`, R = new Results(app, `results/compat-${LABEL.replace(/\W+/g, "-")}.json`);
R.crashArea = AREA;
adb("reverse", "tcp:8787", "tcp:8787");
fs.mkdirSync("results", { recursive: true });
app.startLog(`logcat-compat-${LABEL.replace(/\W+/g, "-")}.txt`); app.prepPhone();
for (let i = 0; i < 24; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await app.unblock();
const sdk = sh("getprop ro.build.version.sdk").trim();
// what the screen looks like at the top: where the app's area starts, the status bar's size, and where the header is
const LAYOUT = `(()=>{const p=document.createElement("div");p.style.cssText="position:fixed;top:0;height:env(safe-area-inset-top,0px)";document.body.appendChild(p);const inset=p.getBoundingClientRect().height;p.remove();
  const h=document.querySelector("header")||document.querySelector(".hdr")||document.body.firstElementChild,r=h.getBoundingClientRect(),cs=getComputedStyle(h);
  const firstText=[...document.querySelectorAll("header *,main *")].find(e=>e.childNodes.length&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&e.getBoundingClientRect().height>0);
  return{inset,headerTop:Math.round(r.top),padTop:parseFloat(cs.paddingTop),firstTextTop:firstText?Math.round(firstText.getBoundingClientRect().top):null,firstText:firstText?firstText.textContent.trim().slice(0,20):"",
    over:document.documentElement.scrollWidth>innerWidth+1,w:innerWidth,dpr:devicePixelRatio}})()`;
const statusBarPx = () => { try { const d = sh("dumpsys window windows | grep -E 'StatusBar|statusBars' | head -20"); const m = d.match(/statusBars[^\n]*?frame=\[\d+,\d+\]\[\d+,(\d+)\]/) || d.match(/Window\{[^}]*StatusBar\}[\s\S]*?mFrame=\[\d+,\d+\]\[\d+,(\d+)\]/); return m ? +m[1] : null; } catch (e) { return null; } };
let shots = 0;
const look = async (name) => {
  const L = await app.eval(LAYOUT), wv = app.webviewBounds(), sb = statusBarPx(), dpr = L.dpr || 1;
  // the first words of the app, in real screen pixels; hidden if they start inside the status bar
  // if Android starts the app's area below the status bar (top > 0), nothing of the app can be under it; if the area starts at
  // the very top (edge-to-edge), the app's first words must start below the status bar (or 24dp when its size can't be read)
  const textScreenY = wv.t + (L.firstTextTop || 0) * dpr, bar = sb != null ? sb : Math.round(24 * dpr), hidden = wv.t === 0 && textScreenY < bar - 2;
  await app.shot(`${++shots} ${name}`);
  R.add(AREA, `${name}: top of the app not hidden under the status bar`, hidden ? "FAIL" : wv.t > 0 || sb != null ? "PASS" : "PARTIALLY TESTED",
    `app area starts at ${wv.t}px, status bar ends at ${sb ?? "?"}px, first words "${L.firstText}" at ${Math.round(textScreenY)}px; safe-area inset ${L.inset}px`);
  R.add(AREA, `${name}: nothing runs off the side`, L.over ? "FAIL" : "PASS", `width ${L.w}`);
};
await R.journey(AREA, `App on ${LABEL} (Android API ${sdk})`, async (step) => {
  await step("installed on a clean phone and opened", async () => { try { adb("uninstall", PKG); } catch (e) {} app.install(process.env.APK);
    await app.launch(); await app.waitFor(`typeof render==="function"`, 40000, "the app"); await sleep(1500); });
  await step("welcome screen", async () => { await app.waitText("Your 24/7 bargain hunter", 20000); await look("welcome screen"); });
  await step("connected to the test service with 30 fake deals", async () => {
    await seedDeals(makeDeals(30));
    await app.eval(`localStorage.setItem("flipscout_seen_v2","1");$("onb").style.display="none";S.set.url="http://localhost:8787";S.set.key=${JSON.stringify(KEY)};H().cats=[{id:"27386",name:"Graphics Cards"},{id:"9355",name:"Mobile & Smart Phones"}];save();tab="deals";HD.busy=false;loadDeals().then(render);1`);
    await app.waitFor(`document.querySelectorAll(".dcard").length>=20`, 60000, "deal cards"); await sleep(1500); });
  await step("deals list", async () => { await look("deals list"); });
  await step("a deal's page", async () => { await app.eval(`openDeal(0);1`); await sleep(3000); await look("deal page"); await app.eval(`onBack();1`); await sleep(800); });
  await step("menu", async () => { await app.eval(`go("settings");1`); await sleep(1500); await look("menu"); await app.eval(`onBack();1`); });
  await step("a sheet (pop-up) over the deals", async () => { await app.eval(`tip(Object.keys(TIPS)[0]);1`); await sleep(1200); await look("pop-up sheet"); await app.eval(`closeSheet();1`); });
});
try { app.logcat && app.logcat.kill(); } catch (e) {}
fs.writeFileSync(`results/compat-${LABEL.replace(/\W+/g, "-")}.json`, JSON.stringify(R.rows, null, 1));
for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + r.detail : ""}`);
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
