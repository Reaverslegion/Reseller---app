// STAGE 4 in the real app: crash and error monitoring, harmful listing data, accessibility, and (on the emulator)
// dark mode, large text, small screens, rotation, low memory, bad connections, repeated taps, backup and restore.
// Works with the same "driver" as the Stage 3 audit (tests/integrity/audit.mjs). Uses ONLY the private test Scan
// service, its throwaway database and the fake eBay, all on this test machine.
import fs from "node:fs";
import * as F from "../integrity/scan-flow.mjs";
import * as DS from "../integrity/datasets.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 864e5;
const errlog = (where = "1=1", args = []) => F.query(`SELECT src, kind, msg, place, ver, n FROM errlog WHERE ${where} ORDER BY at DESC`, args).catch(() => []);
const clearLog = () => F.seedSql([["CREATE TABLE IF NOT EXISTS errlog (sig TEXT PRIMARY KEY, src TEXT, kind TEXT, msg TEXT, place TEXT, ver TEXT, n INTEGER, first INTEGER, at INTEGER, alerted INTEGER)"], ["DELETE FROM errlog"]]);
const seed = async (deals) => { const now = Date.now(), sql = [["DELETE FROM deals"]];
  for (const d of deals) sql.push(["INSERT INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)", [d.id, JSON.stringify(d), d.score || 0, now - 60000, now + 2 * DAY]]);
  for (let i = 0; i < sql.length; i += 200) await F.seedSql(sql.slice(i, i + 200)); };

// ---------- the accessibility checker (runs inside the app) ----------
// Contrast (WCAG 2.2 AA: 4.5:1, or 3:1 for large text), names for buttons/links/fields, picture descriptions, touch-target
// sizes (24px minimum by WCAG 2.2 AA; 48px is Android's recommendation), text running off the screen, zoom allowed, page language.
export const A11Y = `(()=>{const out={contrast:[],noName:[],noLabel:[],noAlt:[],small24:[],small44:[],overflow:false,zoomBlocked:false,lang:document.documentElement.lang||"",checked:0};
 const vis=e=>{if(e.checkVisibility&&!e.checkVisibility({visibilityProperty:true,contentVisibilityAuto:false}))return false;if(e.closest("details:not([open])")&&!e.closest("summary"))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&+s.opacity!==0&&r.bottom>0&&r.top<innerHeight*3};
 const rgb=c=>{const m=String(c).match(/rgba?\\(([^)]+)\\)/);if(!m)return null;const p=m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number);return{r:p[0],g:p[1],b:p[2],a:p.length>3?p[3]:1}};
 const lum=c=>{const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4)};return .2126*f(c.r)+.7152*f(c.g)+.0722*f(c.b)};
 const mix=(a,b)=>({r:a.r*a.a+b.r*(1-a.a),g:a.g*a.a+b.g*(1-a.a),b:a.b*a.a+b.b*(1-a.a),a:1});
 const bgOf=e=>{const layers=[];let img=false;for(let x=e;x;x=x.parentElement){const s=getComputedStyle(x);if(s.backgroundImage&&s.backgroundImage!=="none")img=true;const c=rgb(s.backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break}}
   let b=rgb(getComputedStyle(document.body).backgroundColor)||{r:255,g:255,b:255,a:1};if(b.a<1)b={r:255,g:255,b:255,a:1};for(let i=layers.length-1;i>=0;i--)b=mix(layers[i],b);return{c:b,img}};
 const name=e=>(e.getAttribute("aria-label")||e.getAttribute("title")||e.innerText||e.value||[...e.querySelectorAll("img[alt]")].map(i=>i.alt).join(" ")||"").trim();
 const where=e=>(e.innerText||e.getAttribute("aria-label")||e.id||e.className||e.tagName).toString().replace(/\\s+/g," ").trim().slice(0,40);
 const seen=new Set();
 for(const e of document.querySelectorAll("body *")){if(!vis(e)||["SCRIPT","STYLE","svg","path"].includes(e.tagName))continue;
   const own=[...e.childNodes].filter(n=>n.nodeType===3&&n.textContent.trim()).map(n=>n.textContent.trim()).join(" ");if(!own)continue;
   const s=getComputedStyle(e),fg=rgb(s.color);if(!fg)continue;const {c:bg,img}=bgOf(e);if(img)continue;out.checked++;
   const f=mix({...fg,a:fg.a*(+s.opacity||1)},bg),L1=lum(f),L2=lum(bg),ratio=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05),px=parseFloat(s.fontSize),bold=+s.fontWeight>=700;
   const need=(px>=24||(bold&&px>=18.66))?3:4.5;
   if(ratio<need){const k=s.color+"|"+bg.r+","+bg.g+","+bg.b+"|"+need;if(!seen.has(k)){seen.add(k);out.contrast.push({text:own.slice(0,40),ratio:Math.round(ratio*100)/100,need,fg:s.color,bg:"rgb("+[bg.r,bg.g,bg.b].map(Math.round)+")",px})}}}
 for(const e of document.querySelectorAll("button,a[href],[role=button],[onclick]")){if(!vis(e))continue;if(!name(e))out.noName.push(e.outerHTML.slice(0,80));
   const r=e.getBoundingClientRect(),inText=e.tagName==="A"&&getComputedStyle(e).display==="inline";if(inText)continue;
   if(r.width<24||r.height<24)out.small24.push(where(e)+" ("+Math.round(r.width)+"×"+Math.round(r.height)+")");else if(r.width<44||r.height<44)out.small44.push(where(e)+" ("+Math.round(r.width)+"×"+Math.round(r.height)+")")}
 for(const e of document.querySelectorAll("input:not([type=hidden]),select,textarea")){if(!vis(e))continue;const id=e.id,lab=(id&&document.querySelector('label[for="'+CSS.escape(id)+'"]'))||e.closest("label");
   if(!lab&&!e.getAttribute("aria-label")&&!e.getAttribute("aria-labelledby")&&!e.getAttribute("title"))out.noLabel.push((e.placeholder?"(placeholder only) "+e.placeholder:e.outerHTML.slice(0,70)))}
 for(const e of document.querySelectorAll("img")){if(vis(e)&&!e.hasAttribute("alt")&&e.getAttribute("aria-hidden")!=="true")out.noAlt.push((e.src||"").slice(0,60))}
 out.overflow=document.documentElement.scrollWidth>innerWidth+1?document.documentElement.scrollWidth+" > "+innerWidth:false;
 const vp=(document.querySelector("meta[name=viewport]")||{}).content||"";out.zoomBlocked=/user-scalable\\s*=\\s*(no|0)|maximum-scale\\s*=\\s*1(\\.0)?\\b/.test(vp)?vp:false;
 return out})()`;
// axe-core (Deque's free open-source checker) when the test machine has it (CI installs it from npm)
const AXE = process.env.AXE_JS && fs.existsSync(process.env.AXE_JS) ? fs.readFileSync(process.env.AXE_JS, "utf8") : null;

export async function runStage4(drv, R, dev = {}) {
  const A = (area) => ({ add: (name, status, detail = "") => R.add(area, name, status, String(detail).slice(0, 400)) });
  const ok = (b) => (b ? "PASS" : "FAIL");
  const appText = () => drv.eval(`document.getElementById("app").innerText`);
  const toDeals = async () => { await drv.dealsTab(); await drv.waitFor(`!!document.querySelector(".dcard")||/No deals right now|Pick what to hunt/.test(document.getElementById("app").innerText)`, 60000, "deals"); };
  const reopen = async () => { await drv.relaunch(); await toDeals(); await sleep(1200); };
  const VER = await drv.eval(`typeof VER!=="undefined"?VER:""`);

  // ===================== 1. crash and error monitoring =====================
  const M = A("Monitoring");
  await R.journey("Monitoring", "App errors are recorded on the Scan service", async (step) => {
    await step("problem log emptied", async () => { await clearLog(); });
    await step("a harmless test error is thrown inside the app", async () => {
      await drv.eval(`setTimeout(()=>{throw new Error("FlipScout harmless test error token=SECRETabc123 seller@example.com https://x.example/a?key=zzz")},0);1`);
      await drv.eval(`Promise.reject(new Error("FlipScout harmless test rejection"));1`);
      let rows = []; for (let i = 0; i < 20 && rows.length < 2; i++) { await sleep(1000); rows = await errlog("src='app' AND msg LIKE '%harmless test%'"); }
      const err = rows.find((r) => /test error/.test(r.msg)), rej = rows.find((r) => /rejection/.test(r.msg));
      M.add("a crash in the app's code is recorded with its type, app version and time", ok(err && err.kind === "crash" && String(err.ver).startsWith(VER)), err ? `${err.kind}: "${err.msg}" · version ${err.ver}` : "not recorded");
      M.add("an unhandled failure in the app's background work is recorded too", ok(!!rej), rej ? rej.msg : "not recorded");
      M.add("the recorded error has the secret, email address and web-address details removed", ok(err && !/SECRETabc123|seller@example|zzz/.test(err.msg) && /\[hidden\]/.test(err.msg) && /\[email\]/.test(err.msg)), err ? err.msg : "");
      M.add("the app keeps working after the error", ok(/deals?|No deals right now/i.test(await appText())));
    });
    await step("the Scan service can't be reached 3 times in a row: the app notes it and sends the note once it's back", async () => {
      await clearLog();
      if (dev.chaos) await dev.chaos("down"); else await drv.eval(`window.__u=S.set.url;S.set.url="http://127.0.0.1:9";1`);
      for (let i = 0; i < 3; i++) { await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`); await sleep(500); }
      const queued = await drv.eval(`JSON.parse(localStorage.getItem("flipscout_problems")||"[]").map(r=>r.kind)`);
      M.add("3 failed deal loads in a row are noted on the phone while there's no connection", ok(queued.includes("deals-load-failed")), `waiting on the phone: ${queued.join(", ") || "nothing"}`);
      if (dev.chaos) await dev.chaos("normal"); else await drv.eval(`S.set.url=window.__u;1`);
      await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`); let rows = [];
      for (let i = 0; i < 15 && !rows.length; i++) { await sleep(1000); rows = await errlog("src='app' AND kind='deals-load-failed'"); }
      const left = await drv.eval(`JSON.parse(localStorage.getItem("flipscout_problems")||"[]").length`);
      M.add("once the connection is back, the note reaches the Scan service and leaves the phone", ok(rows.length === 1 && left === 0), rows[0] ? `"${rows[0].msg}" (${left} left on the phone)` : `not received (${left} still on the phone)`);
    });
    await step("the sales list can't load twice in a row", async () => {
      await clearLog();
      if (dev.chaos) await dev.chaos("down"); else await drv.eval(`window.__u=S.set.url;S.set.url="http://127.0.0.1:9";1`);
      for (let i = 0; i < 2; i++) { await drv.eval(`salesSheet("gpu:rtx 3070","RTX 3070");1`); await sleep(2500); await drv.eval(`closeSheet();1`); }
      if (dev.chaos) await dev.chaos("normal"); else await drv.eval(`S.set.url=window.__u;1`);
      await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`); let rows = [];
      for (let i = 0; i < 15 && !rows.length; i++) { await sleep(1000); rows = await errlog("src='app' AND kind='sales-load-failed'"); }
      M.add("2 failed sales-list loads in a row are recorded", ok(rows.length === 1), rows[0] ? rows[0].msg : "not recorded");
    });
    await step("a damaged deal record in the database", async () => {
      await clearLog(); await seed(DS.scale(5, 992000000000));
      await F.seedSql([["INSERT OR REPLACE INTO deals (id,data,score,created,expires) VALUES ('999000000001','{broken',99,?,?)", [Date.now(), Date.now() + DAY]]]);
      await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`); await sleep(1500);
      const rows = await errlog("src='database' AND kind='damaged deal record'"), cards = await drv.eval(`document.querySelectorAll(".dcard").length`), t = await appText();
      M.add("one damaged record doesn't stop the other deals loading (5 good deals shown)", ok(cards === 5 && !/internal error|JSON/.test(t)), `${cards} cards`);
      M.add("the damaged record is written to the problem log, with where it happened", ok(rows.length === 1 && rows[0].place === "deals"), rows[0] ? rows[0].msg : "not recorded");
      await F.seedSql([["DELETE FROM deals WHERE id='999000000001'"]]);
    });
    await step("the database refuses a write (a harmless test rule makes saving settings fail)", async () => {
      await clearLog();
      await F.seedSql([["CREATE TRIGGER IF NOT EXISTS stage4fail BEFORE INSERT ON kv WHEN NEW.k='config' BEGIN SELECT RAISE(ABORT,'stage4 harmless database failure'); END"]]);
      try {
        const r = await fetch(`http://127.0.0.1:8787/?config=1`, { method: "POST", headers: { "X-FlipScout-Key": process.env.TEST_APP_KEY, "content-type": "text/plain" }, body: JSON.stringify(F.CONFIG) }), body = await r.text();
        const rows = await errlog("msg LIKE '%stage4 harmless database failure%'");
        M.add("a database error inside the Scan service is recorded (source, where, message)", ok(r.status >= 500 && rows.length === 1 && rows[0].place === "config"), rows[0] ? `${rows[0].src} · ${rows[0].kind} at ${rows[0].place}: ${rows[0].msg}` : `answered ${r.status}, nothing recorded`);
        M.add("the failure answer doesn't include program details", ok(!/at \w+ \(|\.js:\d+|node_modules/.test(body)), body.slice(0, 120));
      } finally { await F.seedSql([["DROP TRIGGER IF EXISTS stage4fail"]]); }
    });
    await step("the Problems list in admin tools shows what was recorded", async () => {
      await drv.eval(`report("test","FlipScout harmless test for the Problems list","stage 4");1`); await sleep(2500);
      await drv.menu(); await drv.tap("Open admin tools"); await drv.waitText("Problems", 15000); await sleep(2500); await drv.shot("admin problems list");
      const t = await appText();
      M.add("admin tools › Problems lists recorded errors with where, when, how often and the app version", ok(/App · test \(stage 4\)/.test(t) && /harmless test for the Problems list/.test(t) && /last just now · /.test(t) && t.includes(VER)),
        (t.match(/Problems[\s\S]{0,300}/) || [""])[0].replace(/\s+/g, " "));
      await drv.dealsTab();
    });
  });

  // ===================== 2. harmful listing data =====================
  const X = A("Security");
  await R.journey("Security", "Harmful listing data can't run code in the app", async (step) => {
    const evil = [`<img src=x onerror="window.__xss=1">`, `"><script>window.__xss=2<\/script>`, `<svg onload="window.__xss=3">`, `{{constructor.constructor('window.__xss=4')()}}`, `\${window.__xss=5}`, `'); window.__xss=6; ('`];
    const deals = DS.scale(6, 990000000000).map((d, i) => ({ ...d, title: `Harmful title ${i} ${evil[i]}`, catName: evil[(i + 1) % 6], matchLabel: evil[(i + 2) % 6], where: evil[(i + 3) % 6],
      img: i === 0 ? `x" onerror="window.__xss=7` : i === 1 ? "javascript:window.__xss=8" : d.img, url: i === 2 ? "javascript:window.__xss=9" : d.url, tags: [evil[i % 6]] }));
    await step("6 deals with harmful titles, pictures, links and labels loaded; app reopened", async () => {
      await seed(deals);
      await fetch("http://127.0.0.1:8788/__fake/items", { method: "POST", body: JSON.stringify(deals.map((d) => ({ itemId: `v1|${d.id}|0`, legacyItemId: d.id, title: d.title, price: { value: String(d.price), currency: "GBP" },
        buyingOptions: ["FIXED_PRICE"], shippingOptions: [{ shippingCost: { value: "4.99", currency: "GBP" } }], description: `<p>ok</p>${evil[0]}${evil[2]}<iframe src="javascript:window.__xss=10"></iframe>`,
        seller: { username: `<b onmouseover=window.__xss=11>x</b>`, feedbackPercentage: "99", feedbackScore: 5 }, itemLocation: { city: evil[0], country: "GB" } }))) }).catch(() => {});
      await reopen(); });
    await step("cards checked, then a deal page opened (with a harmful seller description)", async () => {
      const cards = await drv.eval(`document.querySelectorAll(".dcard").length`);
      await drv.tap({ sel: ".dcard" }); await sleep(3500); await drv.shot("deal page with harmful data");
      // every button whose action carries the harmful text is pressed: the text must arrive as plain words, never run
      const pressed = await drv.eval(`(()=>{const L=[...document.querySelectorAll("#app *")].filter(e=>[...e.attributes].some(a=>a.name==="onclick"&&/__xss/.test(a.value)));L.forEach(e=>{try{e.click()}catch(x){}});try{closeSheet()}catch(x){}return L.length})()`);
      await sleep(1500);
      const r = await drv.eval(`({xss:window.__xss||null,handlers:${pressed},
        scripts:[...document.querySelectorAll("#app script,#sheet script,#app iframe,#sheet iframe")].length,jsLinks:[...document.querySelectorAll('a[href^="javascript" i],img[src^="javascript" i]')].length,
        shown:document.getElementById("app").innerText.includes("<img src=x")})`);
      X.add(`harmful text in titles, labels, places, tags and descriptions shows as plain text and never runs (${cards} cards and a deal page checked)`, ok(!r.xss && !r.scripts && r.shown),
        `ran: ${r.xss || "no"} · ${r.handlers} buttons carrying harmful text pressed, none ran it · scripts/frames: ${r.scripts} · shown as text: ${r.shown}`);
      X.add("harmful 'javascript:' links and pictures are never made into working links", ok(!r.jsLinks), `${r.jsLinks} found`);
      await drv.back(); await toDeals();
    });
    await step("a restored backup with a harmful stock-item link", async () => {
      const r = await drv.eval(`(()=>{const a=document.createElement("div");a.innerHTML=\`<a href="\${esc(ukUrl("javascript:window.__xss=12"))}">x</a><a href="\${esc(ukUrl("https://www.ebay.com/itm/1"))}">y</a>\`;return[...a.querySelectorAll("a")].map(x=>x.getAttribute("href"))})()`);
      X.add("links saved in stock items or backups only become links if they're real web addresses", ok(r[0] === "#" && r[1] === "https://www.ebay.co.uk/itm/1"), r.join(" , "));
    });
  });

  // ===================== 3. accessibility =====================
  const AC = A("Accessibility");
  const screens = [["Deals list", async () => { await toDeals(); }], ["A deal's page", async () => { await toDeals(); await drv.tap({ sel: ".dcard" }); await sleep(3000); }],
    ["Filters and sorting", async () => { await drv.back(); await toDeals(); }], ["Menu and settings", async () => { await drv.menu(); await sleep(800); }],
    ["Admin tools", async () => { await drv.tap("Open admin tools"); await sleep(1500); }], ["Middle tab", async () => { await drv.tap({ sel: "#nav button", nth: 1 }); await sleep(1200); }]];
  const runA11y = async (label, themeNote = "") => {
    const totals = { contrast: [], noName: [], noLabel: [], noAlt: [], small24: [], small44: [], overflow: [], axe: [] };
    for (const [name, go] of screens) { try { await go(); } catch (e) { AC.add(`${label}: ${name} › opened`, "NOT TESTED", e.message); continue; }
      const r = await drv.eval(A11Y); for (const k of ["contrast", "noName", "noLabel", "noAlt", "small24", "small44"]) totals[k].push(...r[k].map((x) => ({ screen: name, x })));
      if (r.overflow) totals.overflow.push({ screen: name, x: r.overflow });
      if (AXE) { try { await drv.eval(AXE + ";1"); const ax = await drv.eval(`axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa","wcag22aa"]}}).then(r=>({p:r.passes.length,v:r.violations.map(v=>({id:v.id,impact:v.impact,n:v.nodes.length,eg:(v.nodes[0]||{}).target+""}))}))`);
        totals.axe.push(...ax.v.map((x) => ({ screen: name, x }))); totals.axeRules = (totals.axeRules || 0) + ax.p; } catch (e) { totals.axe.push({ screen: name, x: { id: "axe could not run: " + e.message } }); } }
      if (name === "Deals list") { AC.add(`${label}: page language set and zoom not blocked`, ok(r.lang === "en" || /^en/.test(r.lang)) === "PASS" && !r.zoomBlocked ? "PASS" : "FAIL", `lang="${r.lang}"${r.zoomBlocked ? `, zoom blocked by "${r.zoomBlocked}"` : ""}`); }
    }
    await drv.dealsTab();
    const fmt = (L, f = (o) => (typeof o.x === "string" ? o.x : JSON.stringify(o.x))) => L.slice(0, 6).map((o) => `${o.screen}: ${f(o)}`).join(" | ");
    AC.add(`${label}: text contrast meets WCAG AA (4.5:1, large text 3:1)${themeNote}`, ok(!totals.contrast.length), totals.contrast.length ? `${totals.contrast.length} colour pairs too faint: ` + fmt(totals.contrast, (o) => `"${o.x.text}" ${o.x.ratio}:1 (needs ${o.x.need}) ${o.x.fg} on ${o.x.bg}`) : "");
    AC.add(`${label}: every button and link has a name a screen reader can say`, ok(!totals.noName.length), fmt(totals.noName));
    AC.add(`${label}: every box and drop-down has a label`, ok(!totals.noLabel.length), fmt(totals.noLabel));
    AC.add(`${label}: pictures have descriptions (or are marked as decoration)`, ok(!totals.noAlt.length), totals.noAlt.length ? `${totals.noAlt.length}: ` + fmt(totals.noAlt) : "");
    AC.add(`${label}: nothing to tap is smaller than 24×24 (WCAG 2.2 AA minimum)`, ok(!totals.small24.length), totals.small24.length ? `${totals.small24.length}: ` + fmt(totals.small24) : "");
    AC.add(`${label}: things to tap are at least 44×44 (Android recommends 48)`, totals.small44.length ? "PARTIALLY TESTED" : "PASS", totals.small44.length ? `${totals.small44.length} between 24 and 44 (allowed by WCAG, smaller than ideal): ` + fmt(totals.small44) : "");
    AC.add(`${label}: nothing runs off the side of the screen`, ok(!totals.overflow.length), fmt(totals.overflow));
    if (AXE) AC.add(`${label}: axe-core automated check (WCAG 2.2 AA rules)`, ok(!totals.axe.length && totals.axeRules > 0), totals.axe.length ? fmt(totals.axe) : `no problems found (${totals.axeRules || 0} rule checks passed across the screens)`);
    else AC.add(`${label}: axe-core automated check`, "NOT TESTED", "axe-core isn't installed on this machine (it is in GitHub)");
    return totals;
  };
  await R.journey("Accessibility", "Automated accessibility checks", async (step) => {
    await step("13 ordinary deals loaded", async () => { await seed(DS.scale(13, 991000000000)); await reopen(); });
    await step("light appearance", async () => { await drv.eval(`S.set.theme="light";save();render();1`); await runA11y("Light"); });
    await step("dark appearance", async () => { await drv.eval(`S.set.theme="dark";save();render();1`); await drv.shot("dark mode deals"); await runA11y("Dark"); await drv.eval(`S.set.theme="auto";save();render();1`); });
  });

  // ===================== performance at every size =====================
  const P = A("Performance");
  const sh0 = (c) => { try { return dev.sh ? dev.sh(c) : ""; } catch (e) { return ""; } };
  const memMB0 = () => { const m = sh0(`dumpsys meminfo ${dev.pkg} | grep -E "TOTAL PSS|TOTAL:"`).match(/TOTAL(?: PSS)?:?\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; };
  const frame = `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`;
  const timed = (code) => drv.eval(`(async()=>{const t=performance.now();${code};await ${frame};return Math.round(performance.now()-t)})()`);
  const perf = [];
  await R.journey("Performance", "Speed at every size", async (step) => {
    for (const n of dev.sizes || [0, 13, 200, 500, 837, 1000, 1500, 3000]) await step(`${n.toLocaleString("en-GB")} deals`, async () => {
      await seed(DS.scale(n, 993000000000)); const t = Date.now(); await drv.relaunch();
      await drv.waitFor(n ? `document.querySelectorAll(".dcard").length>0` : `/No deals right now/.test(document.getElementById("app").innerText)`, 120000, "deals on screen"); const open = Date.now() - t;
      // where the time went: Android starting the app and its web view / fetching the deals / building and drawing the cards
      const shown = await drv.eval(`(()=>{const r=performance.getEntriesByType("resource").filter(e=>/[?&]deals=1/.test(e.name)).pop();
        return{cards:document.querySelectorAll(".dcard").length,have:(HD.deals||[]).length,page:Math.round(performance.now()),fs:r?Math.round(r.startTime):null,fe:r?Math.round(r.responseEnd):null,kb:r&&r.encodedBodySize?Math.round(r.encodedBodySize/1024):null}})()`);
      const startup = Math.max(0, open - shown.page), fetchMs = shown.fe != null ? shown.fe - shown.fs : null, drawMs = shown.fe != null ? shown.page - shown.fe : null;
      let sort = null, filter = null, jank = null;
      if (n) { sort = await timed(`const s=document.getElementById("ds");if(s){s.value=[...s.options].map(o=>o.value).find(v=>v!==s.value);s.dispatchEvent(new Event("change"))}`);
        filter = await timed(`const b=[...document.querySelectorAll("#chips button")].find(b=>/^Auctions/.test(b.innerText.trim()));if(b)b.click()`);
        await timed(`const b=[...document.querySelectorAll("#chips button")].find(b=>/^All/.test(b.innerText.trim()));if(b)b.click()`);
        if (dev.sh) { sh0(`dumpsys gfxinfo ${dev.pkg} reset`); for (let i = 0; i < 6; i++) { sh0("input swipe 540 1500 540 400 250"); await sleep(400); }
          const g = sh0(`dumpsys gfxinfo ${dev.pkg}`), m = g.match(/Janky frames: (\d+) \(([\d.]+)%\)/), tf = g.match(/Total frames rendered: (\d+)/); jank = m ? { n: +m[1], pct: +m[2], of: tf ? +tf[1] : null } : null; } }
      const mem = memMB0(), row = { n, open, startup, page: shown.page, fetchMs, drawMs, kb: shown.kb, cards: shown.cards, sort, filter, jank, mem }; perf.push(row);
      const fast = n <= 1500 ? shown.page < 5000 : shown.page < 10000;
      P.add(`${n.toLocaleString("en-GB")} deals: from the app's screen starting to deals shown`, n && shown.have !== n ? "FAIL" : fast ? "PASS" : "FAIL",
        `${(shown.page / 1000).toFixed(1)} s (aim: under ${n <= 1500 ? 5 : 10} s): fetching ${fetchMs ?? "?"} ms${shown.kb ? ` (${shown.kb} KB)` : ""}, building and drawing ${drawMs ?? "?"} ms · plus ${(startup / 1000).toFixed(1)} s for Android to start the app · total ${(open / 1000).toFixed(1)} s · all ${shown.have.toLocaleString("en-GB")} deals loaded`);
      if (n) P.add(`${n.toLocaleString("en-GB")} deals: change the sort order, tap a filter`, sort < 2000 && filter < 2000 ? "PASS" : "FAIL", `sort ${sort} ms · filter ${filter} ms${mem ? ` · memory ${mem} MB` : ""}`);
      if (n && jank) P.add(`${n.toLocaleString("en-GB")} deals: scrolling smoothness`, "PARTIALLY TESTED",
        `${jank.pct}% of ${jank.of} frames slow on the emulator, which draws with software (no graphics chip), so this can't be judged here: check on your phone`);
    });
  });
  await R.journey("Performance", "Back from a deal returns to the same card (1,500 deals)", async (step) => {
    await step("1,500 deals loaded", async () => { await seed(DS.scale(1500, 996000000000)); await reopen(); });
    for (const target of [40, 300, 700]) await step(`card ${target}`, async () => {
      const r = await drv.eval(`(async()=>{const fr=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));try{closeSheet()}catch(e){}
        const cards=()=>[...document.querySelectorAll(".dcard[data-id]")];
        const t0=cards()[${target}];if(t0)t0.scrollIntoView({block:"start"});await fr();
        for(let i=0;i<40;i++){const c=cards()[${target}];if(!c)break;const y=c.getBoundingClientRect().top;if(Math.abs(y-120)<5)break;scrollBy(0,Math.max(-600,Math.min(600,y-120)));await fr()}
        const top=()=>{let b=null,bd=1e9;for(const c of cards()){const d=Math.abs(c.getBoundingClientRect().top-120);if(d<bd){bd=d;b=c}}return b&&b.dataset.id};
        const before=top(),d=HD.deals.find(x=>String(x.id)===before);DV=d;d.live=undefined;go("deal");await fr();await new Promise(r=>setTimeout(r,400));
        onBack();await fr();await fr();await new Promise(r=>setTimeout(r,400));const after=top(),L=cards();
        return{before:L.findIndex(c=>c.dataset.id===before),after:L.findIndex(c=>c.dataset.id===after),tab}})()`);
      P.add(`after scrolling to deal ${target}, opening it and pressing Back, the same deal is at the top`, ok(r.tab === "deals" && r.before >= 0 && r.before === r.after), `before: card ${r.before}, after Back: card ${r.after}`);
      await drv.eval(`scrollTo(0,0);1`);
    });
  });
  // ---- the slow sorts: repeat every sort option many times and record where the time goes ----
  // total = tap to screen updated; js = time inside the app's own render(); long = browser freezes over 50 ms;
  // idle = how idle the virtual phone's processor was just before (low = something else was using it)
  const probe = [];
  await R.journey("Performance", "Sort timing probe (every sort option, repeated)", async (step) => {
    for (const n of [13, 1000, 1500]) await step(`${n.toLocaleString("en-GB")} deals`, async () => {
      await seed(DS.scale(n, 998000000000)); await reopen(); await sleep(3000);
      await drv.eval(`(()=>{if(!window.__rw){const r0=render;window.__js=0;render=function(){const t=performance.now();try{return r0.apply(this,arguments)}finally{window.__js+=performance.now()-t}};window.__rw=1}
        window.__long=[];try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__long.push(Math.round(e.duration))}).observe({entryTypes:["longtask"]})}catch(e){}return 1})()`);
      const opts = await drv.eval(`[...document.getElementById("ds").options].map(o=>o.value)`);
      for (let round = 0; round < 3; round++) for (const v of opts) {
        const idle = dev.sh ? +((sh0("top -b -n 1 | head -4").match(/(\d+)%idle/) || [])[1] || -1) : -1;
        const r = await drv.eval(`(async()=>{window.__js=0;window.__long=[];const h0=(performance.memory||{}).usedJSHeapSize||0,t=performance.now();
          const s=document.getElementById("ds");s.value=${JSON.stringify(v)};s.dispatchEvent(new Event("change"));
          await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await new Promise(r=>setTimeout(r,60));
          return{total:Math.round(performance.now()-t-60),js:Math.round(window.__js),long:window.__long.slice(),heapMB:Math.round((((performance.memory||{}).usedJSHeapSize||0)-h0)/1048576)}})()`);
        probe.push({ n, sort: v, round, idle, ...r });
      }
      const mine = probe.filter((x) => x.n === n), tot = mine.map((x) => x.total).sort((a, b) => a - b), slow = mine.filter((x) => x.total > 1500);
      const med = tot[Math.floor(tot.length / 2)], why = slow.map((x) => `${x.sort} round ${x.round + 1}: ${x.total} ms (app code ${x.js} ms, phone ${x.idle}% idle${x.long.length ? ", freezes " + x.long.join("/") + " ms" : ""})`).join("; ");
      P.add(`sort probe, ${n.toLocaleString("en-GB")} deals: ${mine.length} sorts (${opts.length} options × 3)`, slow.length ? "FAIL" : "PASS",
        `median ${med} ms, slowest ${tot[tot.length - 1]} ms, app code median ${mine.map((x) => x.js).sort((a, b) => a - b)[Math.floor(mine.length / 2)]} ms${slow.length ? ` · over 1.5 s: ${why}` : ""}`);
    });
  });
  fs.mkdirSync("results", { recursive: true }); fs.writeFileSync("results/sort-probe.txt", JSON.stringify(probe, null, 1));
  console.log("SORTPROBE " + JSON.stringify(probe));
  fs.writeFileSync("results/performance-raw.txt", JSON.stringify(perf, null, 1));

  if (!dev.sh) return;
  // ===================== 4. emulator only: the phone's own settings and conditions =====================
  const sh = (c) => { try { return dev.sh(c); } catch (e) { return ""; } };
  const D = A("Device conditions");
  const memMB = () => { const m = sh(`dumpsys meminfo ${dev.pkg} | grep -E "TOTAL PSS|TOTAL:"`).match(/TOTAL(?: PSS)?:?\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : null; };
  await R.journey("Device conditions", "Phone settings and conditions", async (step) => {
    await step("13 ordinary deals loaded", async () => { await seed(DS.scale(13, 994000000000)); await reopen(); });
    await step("phone set to dark mode (Auto appearance follows it)", async () => { sh("cmd uimode night yes"); await reopen(); await sleep(1000);
      const dark = await drv.eval(`(()=>{const c=getComputedStyle(document.body).backgroundColor.match(/\\d+/g).map(Number);return c[0]+c[1]+c[2]<200})()`); await drv.shot("phone dark mode");
      D.add("the app follows the phone's dark mode", ok(dark)); sh("cmd uimode night no"); });
    for (const scale of [1.3, 2.0]) await step(`largest text: phone font size ×${scale}`, async () => {
      sh(`settings put system font_scale ${scale}`); await reopen(); await drv.shot(`font scale ${scale}`);
      const r = await drv.eval(A11Y), fs_ = await drv.eval(`parseFloat(getComputedStyle(document.querySelector(".dcard")||document.body).fontSize)`);
      await drv.menu(); await sleep(800); const r2 = await drv.eval(A11Y); await drv.shot(`font scale ${scale} menu`); await drv.dealsTab();
      D.add(`text gets bigger with the phone's font size ×${scale}, and nothing runs off the screen`, ok(fs_ > 16 * (scale - 0.15) && !r.overflow && !r2.overflow), `card text ${fs_}px${r.overflow ? `, deals overflow ${r.overflow}` : ""}${r2.overflow ? `, menu overflow ${r2.overflow}` : ""}`);
      sh("settings put system font_scale 1.0"); });
    await step("small phone screen (320 wide, like an older small phone)", async () => {
      sh("wm density 540"); await sleep(1500); await reopen(); await drv.shot("small screen");
      const w = await drv.eval(`innerWidth`), r = await drv.eval(A11Y); await drv.menu(); await sleep(800); const r2 = await drv.eval(A11Y); await drv.dealsTab();
      D.add(`small screen: nothing runs off the side (screen ${w} wide)`, ok(w <= 330 && !r.overflow && !r2.overflow), `${r.overflow || ""} ${r2.overflow || ""}`.trim());
      sh("wm density reset"); await sleep(1500); await reopen(); });
    await step("phone turned sideways and back", async () => {
      const before = await drv.eval(`document.querySelectorAll(".dcard").length`);
      sh("settings put system accelerometer_rotation 0"); sh("settings put system user_rotation 1"); await sleep(3000); await drv.shot("sideways");
      const r = await drv.eval(`({w:innerWidth,h:innerHeight,cards:document.querySelectorAll(".dcard").length,over:document.documentElement.scrollWidth>innerWidth+1})`).catch((e) => ({ err: e.message }));
      sh("settings put system user_rotation 0"); await sleep(2500);
      const after = await drv.eval(`document.querySelectorAll(".dcard").length`).catch(() => -1);
      D.add("turning the phone sideways and back keeps the deals and doesn't restart the app", ok(!r.err && r.w > r.h && r.cards === before && after === before && !r.over), JSON.stringify(r) + ` · after: ${after}`); });
    await step("Android asks the app to free memory, then closes it in the background", async () => {
      const m0 = memMB(); sh(`am send-trim-memory ${dev.pkg} RUNNING_CRITICAL`); await sleep(2000);
      const alive = await drv.eval(`document.querySelectorAll(".dcard").length`).catch(() => -1);
      D.add("low memory warning: the app keeps running and keeps its deals", ok(alive > 0), `${alive} cards after the warning · memory ${m0} MB`);
      await drv.eval(`S.rules.maxPrice=150;save();1`); await dev.app.home(); sh(`am kill ${dev.pkg}`); await sleep(1500); await dev.app.resume();
      await dev.app.connect(); dev.app.appPid = dev.app.pid(); // restarted on purpose: follow the new app process await drv.waitFor(`typeof render==="function"`, 30000, "the app"); await toDeals(); await sleep(1000);
      const kept = await drv.eval(`({lim:S.rules.maxPrice,cards:document.querySelectorAll(".dcard").length})`);
      D.add("closed by Android in the background: reopens with deals and settings kept", ok(kept.lim === 150 && kept.cards > 0), JSON.stringify(kept));
      await drv.eval(`S.rules.maxPrice=0;save();if(typeof reLimit==="function")reLimit();render();1`); });
    await step("going back and forth between the tabs 40 times", async () => {
      const m0 = memMB(), errs0 = (await errlog("src='app'")).length;
      for (let i = 0; i < 40; i++) { await drv.eval(`document.querySelectorAll("#nav button")[${i % 3}].click();1`); await sleep(120); }
      await toDeals(); await sleep(2000); const m1 = memMB(), errs1 = (await errlog("src='app'")).length;
      D.add("40 tab changes: no errors, and memory doesn't keep growing", ok(errs1 === errs0 && (m0 == null || m1 - m0 < 60)), `memory ${m0} MB → ${m1} MB · new app errors ${errs1 - errs0}`); });
    await step("Scan now tapped 5 times quickly", async () => {
      await dev.chaos("normal"); await fetch("http://127.0.0.1:8791/reset").catch(() => {}); await drv.waitText("Scan now", 15000);
      for (let i = 0; i < 5; i++) await drv.eval(`(()=>{const b=[...document.querySelectorAll("button")].find(b=>/Scan now/.test(b.innerText));if(b)b.click();return 1})()`);
      await sleep(8000); const st = await fetch("http://127.0.0.1:8791/stats").then((r) => r.json()).catch(() => null), n = st ? Object.entries(st.stats).filter(([k]) => k === "run").reduce((a, [, v]) => a + v, 0) : null;
      D.add("5 quick taps on Scan now start one scan, not five", n == null ? "NOT TESTED" : ok(n === 1), n == null ? "couldn't count requests" : `${n} scan requests`); });
    await step("slow connection (4 seconds per request), then a connection that cuts out", async () => {
      await fetch("http://127.0.0.1:8791/mode?m=slow&ms=4000").catch(() => {}); const t0 = Date.now(); await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`); const slowMs = Date.now() - t0;
      const t1 = await drv.eval(`({cards:document.querySelectorAll(".dcard").length,err:(document.querySelector("#app .card.bad")||{}).innerText||""})`);
      D.add("slow connection: deals still load (just later), nothing breaks", ok(t1.cards > 0 && !t1.err), `${(slowMs / 1000).toFixed(1)} s · ${t1.cards} cards`);
      await dev.chaos("cut"); await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`).catch(() => {}); await sleep(1000);
      const t2 = await drv.eval(`({cards:document.querySelectorAll(".dcard").length,txt:document.getElementById("app").innerText.slice(0,300)})`);
      D.add("connection cuts out mid-way: the deals already shown stay, with a message", ok(t2.cards > 0), `${t2.cards} cards kept`);
      await dev.chaos("normal"); await drv.eval(`(async()=>{HD.busy=false;await loadDeals();return 1})()`); });
  });

  // ===================== native (Android) crash capture: a real test crash =====================
  await R.journey("Monitoring", "Native Android crash is recorded (deliberate test crash)", async (step) => {
    await step("Android told to crash the app (adb: am crash)", async () => {
      await clearLog(); await dev.chaos("normal"); await toDeals(); await sleep(2000);
      sh(`am crash ${dev.pkg}`); await sleep(4000);
      if (dev.app.alive()) throw new Error("the app didn't crash (this Android version may not support 'am crash')");
    });
    await step("app opened again; the crash reaches the Problems list", async () => {
      await dev.app.launch(); dev.app.appPid = dev.app.pid(); await drv.waitFor(`typeof render==="function"`, 30000, "the app"); await toDeals();
      let rows = []; for (let i = 0; i < 20 && !rows.length; i++) { await sleep(1000); rows = await errlog("src='app' AND kind LIKE 'native-crash%'"); }
      const all = await errlog("src='app'"), info = await drv.eval(`(async()=>{try{const r=await Capacitor.Plugins.CrashInfo.read();return{sdk:r.sdk,exits:(r.exits||[]).length}}catch(e){return{err:String(e)}}})()`);
      M.add("a native Android crash is recorded with what crashed and where, once (not twice)", ok(rows.length === 1 && rows[0].n === 1 && /CrashedByAdb|shell-induced|RemoteServiceException/i.test(rows[0].msg)),
        rows[0] ? `"${rows[0].msg}" · version ${rows[0].ver}` : `not recorded; app problems: ${all.map((r) => r.kind).join(", ") || "none"}; crash capture: ${JSON.stringify(info)}`);
      M.add("the crash record has no private details", ok(rows[0] && !/key=|@|https?:\/\/[^\s]*\?/.test(rows[0].msg)), rows[0] ? "" : "nothing recorded");
      await drv.menu(); await drv.tap("Open admin tools"); await drv.waitText("Problems", 15000); await sleep(2500); const t = await appText(); await drv.shot("problems list native crash");
      M.add("admin tools › Problems shows the native crash", ok(/native-crash/.test(t)), (t.match(/App · native-crash[^\n]*/) || ["not shown"])[0]); await drv.dealsTab();
    });
  }, { expectCrash: true });

  // ===================== 5. backup and restore (round trip through the cloud backup on the test service) =====================
  const B = A("Backup and restore");
  await R.journey("Backup and restore", "Back up, clear the app, restore", async (step) => {
    let before = null;
    await step("a stock item, a spend limit and a hidden deal added; Back up now tapped", async () => {
      await drv.eval(`S.items.push({id:Date.now(),name:"Stage 4 backup test item",cost:12.5,status:"Listed",url:"https://www.ebay.co.uk/itm/123"});S.rules.maxPrice=175;save();1`);
      await drv.menu(); await drv.tap("Back up now"); await drv.waitText("Backed up", 20000);
      before = await drv.eval(`JSON.stringify({items:S.items.map(i=>[i.name,i.cost,i.status]),max:S.rules.maxPrice,cats:H().cats.length})`);
      const saved = (await F.call("backup=1")).data; B.add("the backup reaches the Scan service", ok(!!saved && JSON.stringify(saved).includes("Stage 4 backup test item")));
    });
    await step("app data wiped (like a new phone), reconnected, Restore tapped", async () => {
      if (!dev.sh) return; sh(`pm clear ${dev.pkg}`); await dev.app.launch(); await drv.waitFor(`typeof render==="function"`, 30000, "the app");
      // connect the way the setup code does, in the running app (no restart: Android may stop the app before its last save reaches the disk)
      await drv.eval(`localStorage.setItem("flipscout_seen_v2","1");try{$("onb").style.display="none"}catch(e){}S.set.url="http://localhost:8787";S.set.key=${JSON.stringify(process.env.TEST_APP_KEY)};save();1`);
      await sleep(3000); if (!/Restore your data\?/.test(await drv.eval("document.body.innerText"))) await drv.eval(`cloudCheck();1`);
      await sleep(3000); if (!/Restore your data\?/.test(await drv.eval("document.body.innerText"))) throw new Error("no restore offered; screen says: " + (await drv.eval("document.body.innerText")).replace(/\s+/g, " ").slice(0, 200));
      await drv.waitText("Restore your data\\?", 20000); await drv.shot("restore offered"); await drv.tap({ text: "Restore it", exact: true }); await sleep(3000);
      const after = await drv.eval(`JSON.stringify({items:S.items.map(i=>[i.name,i.cost,i.status]),max:S.rules.maxPrice,cats:H().cats.length})`);
      B.add("after restoring, stock items, spend limit and categories are exactly as before", ok(after === before), after === before ? "" : `before ${before} · after ${after}`);
    });
  });
}
