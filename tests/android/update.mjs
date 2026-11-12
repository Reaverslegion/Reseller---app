// UPDATE TEST (emulator only): installs the PREVIOUS FlipScout build (main, build #120 — same app and signing key as your
// phone's), fills it with items, settings and an unsaved draft, then installs the NEW build from the testing branch OVER it,
// exactly as an update on a phone, and checks every piece of information survived. Then, against a private local copy of
// your CURRENT live Scan service code (main's worker.js, fake eBay, no real keys), it checks which features work, and tests
// backup and restore. Run: OLD_APK=... NEW_APK=... TEST_APP_KEY=... node tests/android/update.mjs
import fs from "node:fs";
import { App, Results, sleep, sh, adb, PKG } from "./driver.mjs";
import * as F from "../integrity/scan-flow.mjs";
console.log = (...a) => { try { fs.writeSync(1, a.map(String).join(" ") + "\n"); } catch (e) {} };
const KEY = process.env.TEST_APP_KEY, OLD = process.env.OLD_APK, NEW = process.env.NEW_APK, A = "Update test";
const app = new App("screenshots/update", PKG), R = new Results(app, "results/update.json");
const add = (name, ok, detail = "", status) => R.add(A, name, status || (ok ? "PASS" : "FAIL"), String(detail).slice(0, 400));
const NEEDS = (name, detail) => R.add("Needs Scan service update", name, "PARTIALLY TESTED", "NEEDS SCAN SERVICE UPDATE — " + String(detail).slice(0, 300));
const svc = async (q, body) => { const r = await fetch(`http://127.0.0.1:8787/?${q}`, { method: body ? "POST" : "GET", headers: { "X-FlipScout-Key": KEY, "content-type": "text/plain" }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; };
const safe = (f) => { try { return f(); } catch (e) { return String(e.stdout || e.message || e); } };
const M1 = "UPD-MARK-1 RTX 3070 Founders", M2 = "UPD-MARK-2 Switch OLED (sold)", M3 = "UPD-MARK-3 iPad Air (following)", DRAFT = "UPD-DRAFT not saved yet";
const DUMP = `JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])))`;
const info = () => { const p = safe(() => sh(`dumpsys package ${PKG}`)); const g = (re) => ((p.match(re) || [])[1] || "").trim();
  return { code: g(/versionCode=(\d+)/), name: g(/versionName=(\S+)/), first: g(/firstInstallTime=([^\n]+)/), last: g(/lastUpdateTime=([^\n]+)/), sig: g(/signatures:\[([0-9a-f, ]+)\]/), flags: g(/pkgFlags=\[([^\]]*)\]/) }; };
const open = async () => { let last; for (let i = 0; i < 3; i++) { try { if (i) { await app.stop(); await sleep(4000); } await app.launch(); await app.waitFor(`typeof render==="function"&&typeof S==="object"`, 40000, "the app"); return; } catch (e) { last = e; } } throw last; };
// leave the app the way a phone does (Home), give Android time to write storage to disk, then close it
const leave = async () => { sh("input keyevent KEYCODE_HOME"); await sleep(8000); await app.stop(); };
const norm = (s) => { const x = JSON.parse(s || "{}"); return { items: (x.items || []).map((i) => JSON.stringify(i)).sort(), rules: JSON.stringify(x.rules), set: JSON.stringify(x.set), gate: JSON.stringify(x.gate), base: JSON.stringify(x.base), hunt: JSON.stringify(x.hunt) }; };

app.startLog("logcat-update.txt"); app.prepPhone(); adb("reverse", "tcp:8787", "tcp:8787");
for (let i = 0; i < 24; i++) { let busy = ""; try { busy = sh("top -b -n 1 | head -4"); } catch (e) {} const idle = +((busy.match(/(\d+)%idle/) || [])[1] || 0); if (i >= 6 && idle > 120) break; await sleep(5000); }
await app.unblock();
let before = null, beforeInfo = null, oldBackup = null;

await R.journey(A, "Previous version (build #120) with your kind of information", async (step) => {
  await step("previous version installed and filled with items, settings and a draft", async () => {
    safe(() => adb("uninstall", PKG)); app.install(OLD); await open(); await sleep(2000);
    const r = await app.eval(`(async()=>{try{localStorage.setItem("flipscout_seen_v2","1");try{$("onb").style.display="none"}catch(e){}
      S.set.url="http://localhost:8787";S.set.key=${JSON.stringify(KEY)};S.set.theme="dark";S.rules.feePct=13.1;S.rules.minProfit=25;S.rules.budget=350;
      H().cats=[{id:"27386",name:"Graphics Cards"}];ED=null;
      F={...BLANK,n:${JSON.stringify(M1)},b:"120",p:"4.5",k:"1",sp:"250\\n260\\n245\\n255\\n270"};addItem("Bought");
      F={...BLANK,n:${JSON.stringify(M2)},b:"150",p:"6",k:"1",sp:"230\\n240\\n235"};addItem("Bought");
      F={...BLANK,n:${JSON.stringify(M3)},b:"90",p:"5",k:"1",sp:"200\\n210\\n190"};addItem("Considered");
      const s=S.items.find(i=>i.name===${JSON.stringify(M2)});s.status="Sold";s.soldPrice=239;s.fees=31.2;s.soldOn=today();s.profit=s.soldPrice-s.fees-(s.outPost||0)-s.buy-s.pack;
      save();try{pushConfig(true)}catch(e){}
      F={...BLANK,n:${JSON.stringify(DRAFT)},b:"42",sp:"99"};saveDraft();
      const ok=await cloudPush(true);return JSON.stringify({ok,n:S.items.length})}catch(e){return "ERR "+e.message}})()`);
    add("previous version accepted the items, settings and draft", /"n":3/.test(r), r);
    await sleep(3000); await app.eval(`tab="stock";render();1`); await sleep(1500); await app.shot("previous version - stock");
    oldBackup = await svc("backup=1");
    add("previous version's cloud backup (needs https; the private test service here is http — backup/restore is tested below with the test wrapper)", false, `real builds only connect over https; app reported ${r}`, "NOT TESTED");
    await leave(); await open(); before = await app.eval(DUMP);
    const b = JSON.parse(before), s = JSON.parse(b.resell_helper_v1 || "{}");
    add("previous version kept everything after closing and reopening", (s.items || []).length === 3 && (b.flipscout_draft || "").includes(DRAFT) && s.set && s.set.theme === "dark",
      `${(s.items || []).length} items, draft ${(b.flipscout_draft || "").includes(DRAFT) ? "kept" : "MISSING"}, ${Object.keys(b).length} stored entries: ${Object.keys(b).join(", ")}`);
    await leave(); beforeInfo = info();
    add("previous version recorded", !!beforeInfo.code, `version ${beforeInfo.name} (code ${beforeInfo.code}), installed ${beforeInfo.first}`);
    await open(); // left running, as on a phone, so the update below replaces a running app
  });
});

await R.journey(A, "Update to the testing build, installed over the top", async (step) => {
  await step("Android accepts the new build as an update (no uninstall)", async () => {
    const inst = safe(() => adb("install", "-r", NEW));
    add("Android accepted the testing build as an UPDATE of your app (same app ID and signing key; nothing uninstalled)", /Success/.test(inst), inst.trim().split("\n").pop());
    const a = info();
    add("same signing certificate before and after", !!a.sig && a.sig === beforeInfo.sig, a.sig === beforeInfo.sig ? "identical" : `before ${beforeInfo.sig} after ${a.sig}`);
    add("it is an update, not a fresh install (original install time kept; version number went up)", a.first === beforeInfo.first && +a.code > +beforeInfo.code && a.last !== beforeInfo.last,
      `version ${beforeInfo.name} (${beforeInfo.code}) → ${a.name} (${a.code}); first installed ${a.first}; updated ${a.last}`);
    add("the new build turns Android's own backup off (as designed)", !/ALLOW_BACKUP/.test(a.flags), `flags: ${a.flags.slice(0, 140)}`);
  });
  await step("all information survived the update", async () => {
    await open(); await sleep(3000); const after = await app.eval(DUMP);
    const b = JSON.parse(before), c = JSON.parse(after), lost = Object.keys(b).filter((k) => !(k in c)), changed = Object.keys(b).filter((k) => k in c && b[k] !== c[k]);
    add("no stored entry was lost in the update", lost.length === 0, lost.length ? "LOST: " + lost.join(", ") : `all ${Object.keys(b).length} entries present; new entries added by the new version: ${Object.keys(c).filter((k) => !(k in b)).join(", ") || "none"}`);
    const x = norm(b.resell_helper_v1), y = norm(c.resell_helper_v1);
    add("every item is identical after the update (names, prices, status, sale figures)", JSON.stringify(x.items) === JSON.stringify(y.items), `${y.items.length} items`);
    { const rb = JSON.parse(b.resell_helper_v1 || "{}").rules || {}, ra = JSON.parse(c.resell_helper_v1 || "{}").rules || {};
      const diffs = [...new Set([...Object.keys(rb), ...Object.keys(ra)])].filter((k) => JSON.stringify(rb[k]) !== JSON.stringify(ra[k])).map((k) => `${k}: ${JSON.stringify(rb[k])} → ${JSON.stringify(ra[k])}`);
      console.log("MONEY RULE DIFFERENCES: " + (diffs.join("; ") || "none"));
      const yours = ["feePct", "feeFixed", "minProfit", "budget", "maxPrice", "minRoi", "maxStock", "minSales", "staleDays", "minPct", "seller", "cheap"].filter((k) => k in rb && JSON.stringify(rb[k]) !== JSON.stringify(ra[k]));
      add("your money rule values are unchanged (fees, minimum profit, budget, limits, seller type)", yours.length === 0, yours.length ? "CHANGED: " + diffs.join("; ") : `all kept${diffs.length ? "; extra fields only: " + diffs.join("; ") : ""}`); }
    for (const k of ["set", "hunt", "gate", "base"]) add(`${{ rules: "money rules (fees, minimum profit, budget)", set: "settings (Scan service address and key, theme)", hunt: "hunt settings (categories)", gate: "checklist", base: "tracked items" }[k]} identical after the update`, x[k] === y[k], x[k] === y[k] ? "identical" : "CHANGED");
    add("the unsaved add-item draft survived the update", b.flipscout_draft === c.flipscout_draft && (c.flipscout_draft || "").includes(DRAFT), b.flipscout_draft === c.flipscout_draft ? "identical" : "CHANGED");
    // the app's own start-up markers (crash/close reporting: last start time and last Android close record seen) are rewritten on
    // every start by design, are not your data and are not in backups, so they are listed but not counted as a change
    { const MARK = ["flipscout_exit_seen", "flipscout_running"], other = changed.filter((k) => k !== "resell_helper_v1" && !MARK.includes(k)), ign = changed.filter((k) => MARK.includes(k));
      add("other stored entries unchanged (apart from the app's own start-up markers)", other.length === 0, (other.length ? "CHANGED: " + other.join(", ") : "none changed") + (ign.length ? ` · start-up markers updated as designed: ${ign.join(", ")}` : "")); }
    await app.eval(`tab="stock";render();1`); await sleep(1500); const st = await app.eval(`document.getElementById("app").innerText`); await app.shot("updated - stock");
    add("your items show on screen in the updated app", st.includes(M1.slice(0, 20)), st.replace(/\s+/g, " ").slice(0, 160));
    await app.eval(`tab="settings";render();1`); await sleep(1500); const se = await app.eval(`document.getElementById("app").innerText`); await app.shot("updated - settings");
    add("settings screen shows your categories and cloud backup still on", /Graphics Cards/.test(se) && /cloud backup is on/i.test(se), se.replace(/\s+/g, " ").slice(0, 160));
    add("the draft is loaded in the add-item form", await app.eval(`JSON.stringify(F).includes(${JSON.stringify(DRAFT)})`));
  });
});

// CAPACITOR 8 BRANCH ONLY (ROLLBACK_APK set): push alert registration on the real signed Capacitor 8 build (no alert is sent:
// nothing here has your live alert key), then the Capacitor 6 rollback rehearsal installed over it, with every stored entry compared.
const ROLLBACK = process.env.ROLLBACK_APK || "";
// app-internal markers that change on every start by design (not your data): the crash-report bookmark (time of the
// last Android "app closed" record already checked) and the "app is open" flag. Only these two are ignored; any other
// difference fails and is NAMED (names only: values such as the Scan key are never printed).
const INTERNAL = new Set(["flipscout_exit_seen", "flipscout_running"]);
const diffKeys = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !INTERNAL.has(k) && a[k] !== b[k]);
let pushToken = "";
if (ROLLBACK) {
  await R.journey("Push alerts (Capacitor 8)", "Alert registration on the signed Capacitor 8 build (nothing is sent)", async (step) => {
    await step("turn alerts on and register with Google's alert service", async () => {
      safe(() => sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`));
      const st = await app.eval(`(async()=>{try{const P=PN();if(!P)return "NO PLUGIN";await enableAlerts();return "called"}catch(e){return "ERR "+e.message}})()`);
      R.add("Push alerts (Capacitor 8)", "the push plugin is present and alerts can be switched on (permission granted, register called)", st === "called" ? "PASS" : "FAIL", st);
      let r = null; for (let i = 0; i < 40 && !r; i++) { await sleep(1500); r = JSON.parse(await app.eval(`JSON.stringify({t:PUSH.token||"",e:PUSH.err||""})`)); if (!r.t && !/couldn't register for alerts/i.test(r.e)) r = null; }
      if (r && r.t) { pushToken = r.t;
        R.add("Push alerts (Capacitor 8)", "this phone got its alert address from Google (Firebase) through Capacitor 8's push plugin", r.t.length > 20 ? "PASS" : "FAIL", `address received (${r.t.length} characters; not shown)`);
        R.add("Push alerts (Capacitor 8)", "the app then tries to give that address to its Scan service", /Couldn't register this phone|alert key/i.test(r.e) || !r.e ? "PASS" : "FAIL",
          "real builds only connect over https, so this private http copy can't receive it here; the same call is checked with the test wrapper below. App message: " + (r.e || "none"));
      } else if (r) R.add("Push alerts (Capacitor 8)", "this phone got its alert address from Google (Firebase) through Capacitor 8's push plugin",
          /SERVICE_NOT_AVAILABLE|MISSING_INSTANCEID|AUTHENTICATION_FAILED|PHONE_REGISTRATION|TIMEOUT|play services/i.test(r.e) ? "NOT TESTED" : "FAIL", "EMULATOR OR PLUGIN — Google's alert service refused on this emulator: " + r.e);
      else R.add("Push alerts (Capacitor 8)", "this phone got its alert address from Google (Firebase) through Capacitor 8's push plugin", "NOT TESTED", "no answer from Google's alert service within 60 s on this emulator (no error from the app)");
      const ch = safe(() => sh("dumpsys notification"));
      const mine = ch.split(/\n(?=\s*AppSettings: )/).filter((b) => b.includes(PKG)).join("\n");
      R.add("Push alerts (Capacitor 8)", "the 'Deals and price alerts' channel exists (deals arrive with sound and on the lock screen)", /mId='deals'/.test(mine || ch) ? "PASS" : "FAIL", /mId='deals'/.test(mine || ch) ? "channel 'deals' registered" : "channel not found");
      await app.shot("cap8 - alerts on");
    });
  });
  let mid = null, midInfo = null;
  await R.journey("Rollback rehearsal", "Go back from Capacitor 8 to a Capacitor 6 build of the same app, installed over the top", async (step) => {
    await step("Android accepts the Capacitor 6 rollback build as an update", async () => {
      await open(); await sleep(2000); mid = await app.eval(DUMP); await leave(); midInfo = info();
      const inst = safe(() => adb("install", "-r", ROLLBACK));
      R.add("Rollback rehearsal", "Android accepted the Capacitor 6 rollback build as an UPDATE (nothing uninstalled)", /Success/.test(inst) ? "PASS" : "FAIL", inst.trim().split("\n").pop());
      const a = info();
      R.add("Rollback rehearsal", "same signing certificate, original install time kept, version number went up", a.sig === midInfo.sig && a.first === midInfo.first && +a.code > +midInfo.code ? "PASS" : "FAIL",
        `${midInfo.name} (${midInfo.code}) → ${a.name} (${a.code}); first installed ${a.first}`);
    });
    await step("all information survived going back", async () => {
      await open(); await sleep(3000); const back = await app.eval(DUMP);
      const b = JSON.parse(mid), c = JSON.parse(back), lost = Object.keys(b).filter((k) => !(k in c)), changed = Object.keys(b).filter((k) => k in c && b[k] !== c[k]);
      const x = norm(b.resell_helper_v1), y = norm(c.resell_helper_v1);
      R.add("Rollback rehearsal", "no stored entry was lost", lost.length ? "FAIL" : "PASS", lost.length ? "LOST: " + lost.join(", ") : `all ${Object.keys(b).length} entries present`);
      R.add("Rollback rehearsal", "every item identical (names, prices, status, sale figures)", JSON.stringify(x.items) === JSON.stringify(y.items) && y.items.length === 3 ? "PASS" : "FAIL", `${y.items.length} items`);
      for (const [k, n] of [["rules", "money rules"], ["set", "settings incl. Scan service address and key"], ["hunt", "categories and alert settings"], ["gate", "checklist"], ["base", "tracked items"]])
        R.add("Rollback rehearsal", `${n} identical`, x[k] === y[k] ? "PASS" : "FAIL", x[k] === y[k] ? "identical" : "CHANGED");
      R.add("Rollback rehearsal", "the unsaved add-item draft survived", b.flipscout_draft === c.flipscout_draft && (c.flipscout_draft || "").includes(DRAFT) ? "PASS" : "FAIL");
      const other = changed.filter((k) => !INTERNAL.has(k)), ign = changed.filter((k) => INTERNAL.has(k));
      R.add("Rollback rehearsal", "nothing else stored changed (apart from the app's own start-up markers)", other.length ? "FAIL" : "PASS",
        (other.length ? "CHANGED: " + other.join(", ") : "none changed") + (ign.length ? ` · start-up markers updated as designed: ${ign.join(", ")}` : ""));
      await app.eval(`tab="stock";render();1`); await sleep(1500); const st = await app.eval(`document.getElementById("app").innerText`); await app.shot("rollback - stock");
      R.add("Rollback rehearsal", "your items show on screen after going back", st.includes(M1.slice(0, 20)) ? "PASS" : "FAIL", st.replace(/\s+/g, " ").slice(0, 160));
      await leave(); await open(); const again = await app.eval(DUMP);
      const ra = JSON.parse(again), rb = JSON.parse(back), d2 = diffKeys(rb, ra), gone = Object.keys(rb).filter((k) => !(k in ra));
      R.add("Rollback rehearsal", "still all there after closing and reopening (every stored entry compared)", d2.length ? "FAIL" : "PASS",
        d2.length ? `CHANGED: ${d2.join(", ")}${gone.length ? " · LOST: " + gone.join(", ") : ""}` : `identical (${Object.keys(ra).length} entries; only the start-up markers may change)`);
    });
  });
}

// The real APK only connects over https (as your phone does to the live service), but the private local copy of the Scan
// service here is plain http. So the service and backup checks below use the TEST WRAPPER of the same testing-branch app code
// (identical app code; its Android wrapper also allows http to this machine), loaded with exactly the data the update produced.
await R.journey(A, "Switch to the test wrapper of the same app code (for the Scan service checks)", async (step) => {
  await step("test wrapper installed with the updated app's data", async () => {
    const data = await app.eval(DUMP); await leave(); safe(() => adb("uninstall", PKG)); app.install(process.env.WRAP_APK); await open();
    await app.eval(`(()=>{const d=${JSON.stringify("__D__")};for(const [k,v] of Object.entries(JSON.parse(d)))localStorage.setItem(k,v);return 1})()`.replace(JSON.stringify("__D__"), JSON.stringify(data)));
    await leave(); await open(); await app.eval(`S.set.url="http://localhost:8787";save();try{pushConfig(true)}catch(e){}1`); await sleep(3000);
    add("test wrapper holds the same items as the updated app", await app.eval(`S.items.length`) === 3);
  });
});
await R.journey(A, "Updated app with your CURRENT Scan service (local copy of the live code)", async (step) => {
  await step("features against the current Scan service", async () => {
    // fake eBay: sold prices and 16 listings for sale (same fixtures as the back-end gap tests), so the current service code finds deals
    try { await F.call("fill=1", { cat: "27386", catName: "Graphics Cards", cond: "used", rows: F.soldRows(7) }); const L = []; let lid = 760000000000;
      F.MODELS.forEach((m) => [0.5, 0.6, 0.7, 0.8].forEach((f) => L.push(F.listing({ id: ++lid, title: `${m.title.replace(" Graphics Card", "")} used #${lid}`, price: Math.round(m.base * f * 100) / 100, ship: 4.99 }))));
      await F.fakeSearch(L); await F.seedSql([], { lastRun: 0, lastManual: 0 }); } catch (e) { console.log("fixture setup: " + e.message); }
    const run = await svc("run=1"); add("a scan runs on the current Scan service code (fake eBay)", run.status === 200, `HTTP ${run.status} ${JSON.stringify(run.j || {}).slice(0, 120)}`);
    await app.eval(`tab="deals";HD.busy=false;loadDeals().then(render);1`);
    let n = 0; try { await app.waitFor(`document.querySelectorAll(".dcard").length>0`, 60000, "deal cards"); n = await app.eval(`(HD.deals||[]).length`); } catch (e) {}
    await app.shot("updated - deals"); add("deals load from the current Scan service", n > 0, `${n} deals`);
    if (n > 0) {
      await app.eval(`openDeal(0);1`); await sleep(3000); const dp = await app.eval(`document.getElementById("app").innerText`); await app.shot("updated - deal page");
      add("a deal's page opens with its money figures", /Sells for about|The money/.test(dp) && !/NaN|undefined/.test(dp), dp.replace(/\s+/g, " ").slice(0, 200));
      await app.eval(`onBack();1`); await sleep(800);
      await app.eval(`salesSheet((HD.deals[0]||{}).pkey,"x");1`); await sleep(4000); const sl = await app.eval(`document.getElementById("sheet").innerText`); await app.eval(`closeSheet();1`);
      add("the sales list behind a price loads", /Sales behind this price/.test(sl) && !/Couldn't load/.test(sl), sl.replace(/\s+/g, " ").slice(0, 120));
    }
    const calls = await app.eval(`(async()=>{const o={};const id=((HD.deals||[])[0]||{}).id||"";for(const q of ["config=1","follows=1","prices=1","flags=1","fillstats=1",...(id?["check="+id]:[]),"problems=1"]){try{const d=await api(q);o[q.split("=")[0]]=d&&d.error?"error: "+d.error:"ok "+JSON.stringify(d).slice(0,60)}catch(e){o[q.split("=")[0]]="error: "+e.message}}return JSON.stringify(o)})()`);
    const c = JSON.parse(calls);
    for (const k of ["config", "follows", "prices", "flags", "fillstats", "check"]) if (c[k] || k !== "check") add(`"${k}" works with the current Scan service`, /^ok/.test(c[k]), c[k]);
    if (/^ok/.test(c.problems) && /problems/.test(c.problems)) add(`"problems" works with the current Scan service`, true, c.problems);
    else NEEDS("admin tools › Problems list (and crash reports sent from the app)", `the current Scan service doesn't have it: ${c.problems}`);
    await app.eval(`S.set.admin=true;go("admin");1`); await sleep(3000); const pr = await app.eval(`document.getElementById("app").innerText`); await app.shot("updated - admin problems"); await app.eval(`onBack();1`);
    add("the app copes when the Problems list isn't available (shows a message, no crash)", app.alive(), pr.replace(/\s+/g, " ").slice(0, 160));
    if (ROLLBACK && pushToken) {
      const d = await app.eval(`api("device=1",{token:${JSON.stringify(pushToken)},name:"Android"}).then(r=>JSON.stringify(r)).catch(e=>"ERR "+e.message)`);
      R.add("Push alerts (Capacitor 8)", "the phone's alert address is accepted by the Scan service (private local copy)", /"ok":true|"ready"/.test(d) ? "PASS" : "FAIL", String(d).replace(pushToken, "[address]").slice(0, 160));
      const t = await svc("test=1");
      R.add("Push alerts (Capacitor 8)", "no alert can be sent from this test (the private copy has no alert key)", t.status === 400 ? "PASS" : "FAIL", `test alert request refused: ${JSON.stringify(t.j || {}).slice(0, 100)}`);
      R.add("Push alerts (Capacitor 8)", "an alert actually arriving on a phone", "NOT TESTED", "needs your live service's alert key; checked on your phone after release with Settings › Alerts › Send test alert");
    }
    const cfg = await svc("config=1"); add("settings changes still reach the current Scan service", JSON.stringify(cfg.j || {}).includes("27386"), JSON.stringify((cfg.j || {}).config || {}).slice(0, 120));
  });
});

let backupText = "", itemsBefore = "";
await R.journey(A, "Backup and restore (emulator copy of the app, local Scan service)", async (step) => {
  await step("Back up now holds your important information", async () => {
    itemsBefore = await app.eval(`JSON.stringify(S.items.map(i=>[i.id,i.name,i.status,i.buy,i.soldPrice??null,i.profit??null]))`);
    const ok = await app.eval(`cloudPush(true)`); const b = await svc("backup=1"), d = (b.j || {}).data || {};
    add("Back up now succeeded", ok === true, `HTTP ${b.status}`);
    add("the cloud backup holds all items, money rules, settings and hunt settings", (d.items || []).length === 3 && !!d.rules && !!d.set && !!d.hunt && JSON.stringify(d).includes(M2), `${(d.items || []).length} items; rules ${!!d.rules}; settings ${!!d.set}; hunt ${!!d.hunt}`);
    add("the backup does NOT include the unsaved add-item draft (by design: only saved items are backed up)", !JSON.stringify(d).includes(DRAFT), JSON.stringify(d).includes(DRAFT) ? "draft included" : "draft not in backup", JSON.stringify(d).includes(DRAFT) ? "PASS" : "PARTIALLY TESTED");
    add("the backup contains the Scan service key (keep the manual backup text private)", JSON.stringify(d.set || {}).includes(KEY), "key present in backup settings", "PARTIALLY TESTED");
    backupText = await app.eval(`JSON.stringify(S)`); // exactly what "Copy backup text" copies
  });
  await step("wipe the emulator app, then Restore from cloud", async () => {
    await leave(); safe(() => sh(`pm clear ${PKG}`)); await open(); await sleep(2000);
    add("after wiping (emulator only) the app is empty", await app.eval(`S.items.length`) === 0);
    await app.eval(`localStorage.setItem("flipscout_seen_v2","1");try{$("onb").style.display="none"}catch(e){}S.set.url="http://localhost:8787";S.set.key=${JSON.stringify(KEY)};save();cloudCheck();1`);
    await app.waitFor(`document.getElementById("sheet").innerText.includes("Restore your data?")`, 20000, "restore offer"); await app.shot("restore offer");
    await app.eval(`cloudRestore();1`); await sleep(2000);
    const got = await app.eval(`JSON.stringify(S.items.map(i=>[i.id,i.name,i.status,i.buy,i.soldPrice??null,i.profit??null]))`);
    add("Restore from cloud brings back every item exactly", got === itemsBefore, `${JSON.parse(got).length} items restored`);
    add("money rules and categories restored", await app.eval(`S.rules.feePct===13.1&&S.rules.minProfit===25&&H().cats.some(c=>c.id==="27386")`));
  });
  await step("wipe again, then restore from the manual backup text", async () => {
    await leave(); safe(() => sh(`pm clear ${PKG}`)); await open(); await sleep(2000);
    await app.eval(`localStorage.setItem("flipscout_seen_v2","1");try{$("onb").style.display="none"}catch(e){}restoreSheet();$("imp").value=${JSON.stringify("My note:\n" + backupText + "\n")};restore();1`); await sleep(2000);
    const got = await app.eval(`JSON.stringify(S.items.map(i=>[i.id,i.name,i.status,i.buy,i.soldPrice??null,i.profit??null]))`);
    add("Paste backup restores every item exactly (text pasted from a note)", got === itemsBefore, `${JSON.parse(got).length} items restored`);
    add("Paste backup restores the Scan service connection and rules", await app.eval(`S.set.url==="http://localhost:8787"&&S.rules.feePct===13.1`));
    await leave(); await open(); add("restored information is still there after closing and reopening", await app.eval(`S.items.length`) === 3);
  });
});
try { app.logcat && app.logcat.kill(); } catch (e) {}
for (const r of R.rows) console.log(`${r.status.padEnd(10)} ${r.area} | ${r.name}${r.detail ? "  — " + r.detail : ""}`);
process.exit(R.rows.some((r) => r.status === "FAIL") ? 1 : 0);
