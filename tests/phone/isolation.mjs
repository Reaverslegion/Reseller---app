// Proves, on the Android emulator, that the "FlipScout TEST" app is kept apart from the real FlipScout before you're asked to
// install it. A stand-in for your real app (same package name as yours, com.reaverslegion.flipscout, holding a marker in place
// of your data) is installed first; then the exact TEST app file you'd download is installed next to it.
// Run (inside the phone-test workflow): REAL_APK=... TEST_APK=... TEST_SVC_URL=... TEST_SVC_KEY=... node tests/phone/isolation.mjs
import fs from "node:fs";
import { App, Results, sleep, sh, adb, PKG } from "../android/driver.mjs";
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
const TPKG = "com.reaverslegion.flipscout.test", SVC = process.env.TEST_SVC_URL, KEY = process.env.TEST_SVC_KEY, AREA = "Phone test setup";
const real = new App("screenshots/phone-real", PKG), test = new App("screenshots/phone-test", TPKG), R = new Results(test, "results/phone-isolation.json");
const add = (name, ok, detail = "", status) => R.add(AREA, name, status || (ok ? "PASS" : "FAIL"), String(detail).slice(0, 300));
const svc = (q, body) => fetch(`${SVC}/?${q}`, { method: body ? "POST" : "GET", headers: { "X-FlipScout-Key": KEY, "content-type": "text/plain" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const MARK = "REAL-APP-DATA-MARKER-" + Date.now();
real.startLog("logcat-phone.txt"); test.logFile = real.logFile; real.prepPhone();
for (let i = 0; i < 24; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await real.unblock();
const open = async (app) => { let last; for (let i = 0; i < 3; i++) { try { if (i) { await app.stop(); await sleep(4000); } await app.launch(); await app.waitFor(`typeof render==="function"`, 40000, "the app"); return; } catch (e) { last = e; } } throw last; };

R.app = real; // (each journey's crash check watches the app it uses)
await R.journey(AREA, "Your real app (stand-in) with its data", async (step) => {
  await step("stand-in real app installed and holding a data marker", async () => {
    try { adb("uninstall", TPKG); } catch (e) {} real.install(process.env.REAL_APK); await open(real);
    await real.eval(`localStorage.setItem("flipscout_seen_v2","1");S.items.push({id:1,name:${JSON.stringify(MARK)},cost:1,status:"Listed"});S.set.url="https://real-scan-service.invalid";S.set.key="real-key-stand-in";save();1`);
    // give Android time to write the page's storage to disk before the forced close (as a phone does when you leave the app)
    sh("input keyevent KEYCODE_HOME"); await sleep(8000); await real.stop(); await open(real);
    add("the stand-in real app keeps its data marker after reopening", (await real.eval(`JSON.stringify(S.items)`)).includes(MARK));
    sh("input keyevent KEYCODE_HOME"); await sleep(3000);
  });
});
R.app = test;
await R.journey(AREA, "TEST app installed next to it", async (step) => {
  await step("TEST app installed (the exact file you'd download)", async () => {
    test.install(process.env.TEST_APK);
    const pk = sh("pm list packages | grep reaverslegion");
    const L = pk.split(/\s+/); add("both apps are installed side by side (neither replaced the other)", L.includes(`package:${PKG}`) && L.includes(`package:${TPKG}`), pk.replace(/\s+/g, " "));
    const lab = sh(`dumpsys package ${TPKG} | grep -m1 -E "versionName"`).trim(); add("TEST app version recorded", /-TEST|2\.0\./.test(lab) || !!lab, lab);
  });
  await step("TEST app opened: clearly labelled, its own storage, locked to the test service", async () => {
    await open(test); await sleep(2000); await test.shot("TEST app first screen");
    const r = await test.eval(`({ver:VER,label:document.body.innerText.includes("TEST BUILD"),url:S.set.url,hasReal:JSON.stringify(localStorage).includes(${JSON.stringify(MARK)}),realUrl:JSON.stringify(localStorage).includes("real-scan-service")})`);
    add("the TEST app shows a red TEST BUILD label and a -TEST version", r.label && /-TEST$/.test(r.ver), `version ${r.ver}`);
    add("the TEST app can't see the real app's data (separate storage)", !r.hasReal && !r.realUrl, r.hasReal || r.realUrl ? "REAL DATA VISIBLE" : "none of the real app's data or address is visible");
    add("the TEST app is set to the separate test service", r.url === SVC, r.url === SVC ? "test service" : "other address");
  });
  await step("TEST app loads the fake deals from the test service", async () => {
    await test.eval(`localStorage.setItem("flipscout_seen_v2","1");try{$("onb").style.display="none"}catch(e){}tab="deals";HD.busy=false;loadDeals().then(render);1`);
    await test.waitFor(`document.querySelectorAll(".dcard").length>0`, 90000, "deal cards"); await sleep(1500); await test.shot("TEST app deals");
    const n = await test.eval(`(HD.deals||[]).length`); add("1,500 fake deals load from the separate test service", n === 1500, `${n} deals`);
  });
  await step("the lock: even with your real address typed in, the TEST app only talks to the test service", async () => {
    const hosts = await test.eval(`(async()=>{performance.clearResourceTimings();S.set.url="https://real-scan-service.invalid";S.set.key="real-key-stand-in";try{await api("config=1")}catch(e){}
      await new Promise(r=>setTimeout(r,800));const h=[...new Set(performance.getEntriesByType("resource").map(e=>{try{return new URL(e.name).host}catch(x){return""}}).filter(Boolean))];S.set.url=TEST_SVC;S.set.key=TEST_KEY;return h})()`);
    add("requests go only to the test service, never to another Scan service", hosts.length > 0 && hosts.every((h) => h === new URL(SVC).host), hosts.join(", "));
  });
  await step("TEST app journeys: deal page, sales list, sort, Back, Problems, Back up now", async () => {
    await test.eval(`openDeal(0);1`); await sleep(3000); const dp = await test.eval(`document.getElementById("app").innerText`);
    add("a deal's page opens with its money panel", /Sells for about|The money/.test(dp)); await test.eval(`onBack();1`); await sleep(800);
    await test.eval(`salesSheet((HD.deals[0]||{}).pkey,"x");1`); await sleep(4000); const sl = await test.eval(`document.getElementById("sheet").innerText`); await test.eval(`closeSheet();1`);
    add("the sales list loads from the test service", /Sales behind this price/.test(sl) && !/Couldn't load/.test(sl), sl.replace(/\s+/g, " ").slice(0, 120));
    const so = await test.eval(`(()=>{const s=document.getElementById("ds");s.value=[...s.options].map(o=>o.value)[1];s.dispatchEvent(new Event("change"));return document.querySelectorAll(".dcard").length})()`);
    add("sorting works", so > 0, `${so} cards after sorting`);
    await test.eval(`go("admin");1`); await sleep(3000); const pr = await test.eval(`document.getElementById("app").innerText`); await test.eval(`onBack();1`);
    add("admin tools › Problems loads from the test service", /Problems/.test(pr) && !/Couldn't load/.test(pr));
    await test.eval(`S.items.push({id:2,name:"TEST-APP-ITEM",cost:1,status:"Listed"});save();cloudPush(true);1`); await sleep(5000);
    const b = await svc("backup=1"), bj = JSON.stringify(b);
    add("Back up now saves to the TEST service's own backup (with the TEST item, without your real data)", bj.includes("TEST-APP-ITEM") && !bj.includes(MARK), bj.includes("TEST-APP-ITEM") ? "test backup holds the TEST item only" : "backup not found");
    await test.shot("TEST app after journeys");
  });
});
R.app = real;
await R.journey(AREA, "Removing the TEST app leaves the real app alone", async (step) => {
  await step("TEST app uninstalled; real app opened", async () => {
    await test.stop(); adb("uninstall", TPKG); await sleep(2000);
    const pk = sh("pm list packages | grep reaverslegion"); await open(real);
    const r = await real.eval(`({mark:JSON.stringify(S.items).includes(${JSON.stringify(MARK)}),url:S.set.url})`);
    add("after uninstalling the TEST app, the real app and its data are untouched", !pk.includes(TPKG) && r.mark && r.url === "https://real-scan-service.invalid", `real app data marker ${r.mark ? "still there" : "MISSING"}`);
  });
});
try { real.logcat && real.logcat.kill(); } catch (e) {}
for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + r.detail : ""}`);
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
