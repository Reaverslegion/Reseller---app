// Builds the master inventory of FlipScout from the code itself: screens, buttons and their actions, settings,
// Scan service endpoints, database tables and operations, outside services, and unfinished/hidden features. For each item
// it lists which test files mention it (a first, mechanical coverage map — a mention is not proof of a meaningful test).
// Run from the repository root: node tests/ci/inventory.mjs > inventory.md
import fs from "node:fs";
import path from "node:path";
const app = fs.readFileSync("index.html", "utf8"), svc = fs.readFileSync("worker.js", "utf8");
const testFiles = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mjs|js|sh|py)$/.test(e.name)) testFiles.push(p); } })("tests");
const tests = Object.fromEntries(testFiles.filter((f) => !/tests\/ci\//.test(f)).map((f) => [f, fs.readFileSync(f, "utf8")]));
const who = (needle) => { const re = needle instanceof RegExp ? needle : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")); return Object.keys(tests).filter((f) => re.test(tests[f])).map((f) => f.replace(/^tests\//, "")); };
const out = [], line = (s = "") => out.push(s);
const clean = (s) => String(s).replace(/<[^>]*>/g, " ").replace(/\$\{[^}]*\}/g, "…").replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, 60);

// 1. screens (tabs) — the map in render()
const tabMap = (app.match(/\(\{([^}]*?)\}\)\[tab\]\(\)/) || [])[1] || "";
const screens = [...tabMap.matchAll(/(\w+):(v\w+)/g)].map((m) => ({ tab: m[1], fn: m[2] }));
line("## Screens"); line("| Screen (tab) | Drawn by | Test files that open it |"); line("|---|---|---|");
for (const s of screens) { const body = (app.match(new RegExp(`function ${s.fn}\\(\\)\\{[\\s\\S]{0,1500}`)) || [""])[0], head = clean((body.match(/<h2[^>]*>([^<]{3,40})</) || body.match(/<b>([^<]{4,40})<\/b>/) || [, ""])[1]);
  const hits = [...new Set([...who(`go("${s.tab}")`), ...who(`go('${s.tab}')`), ...who(`tab="${s.tab}"`), ...who(s.fn), ...(head ? who(head) : [])])];
  line(`| ${s.tab}${head ? ` ("${head}")` : ""} | ${s.fn}() | ${hits.join(", ") || "**none**"} |`); }

// 2. functions called from buttons and other controls
const handlers = new Map();
for (const m of app.matchAll(/on(click|change|input|keydown)="([^"]{1,400})"/g)) {
  for (const f of m[2].matchAll(/\b([a-zA-Z_]\w*)\s*\(/g)) { const n = f[1]; if (/^(if|for|while|return|function|setTimeout|requestAnimationFrame|parseFloat|parseInt|Number|String|Math|JSON|encodeURIComponent|esc|\$|event|this|alert|confirm)$/.test(n)) continue;
    const ctx = app.slice(m.index, m.index + 500), label = clean((ctx.match(/>([^<]{2,80})</) || [, ""])[1]) || clean((app.slice(Math.max(0, m.index - 200), m.index).match(/aria-label="([^"]+)"[^>]*$/) || [, ""])[1]);
    const h = handlers.get(n) || { n, labels: new Set(), kinds: new Set() }; if (label) h.labels.add(label); h.kinds.add(m[1]); handlers.set(n, h); } }
const defined = (n) => new RegExp(`(function\\s+${n}\\s*\\(|const\\s+${n}\\s*=|let\\s+${n}\\s*=)`).test(app);
line(); line("## Buttons and controls (by the action they run)"); line("| Action | Example labels | Defined | Test files that run it (by name or visible words) |"); line("|---|---|---|---|");
let untested = 0;
for (const h of [...handlers.values()].filter((h) => defined(h.n)).sort((a, b) => a.n.localeCompare(b.n))) {
  const byName = who(new RegExp(`\\b${h.n}\\(`)), words = [...h.labels].map((l) => l.replace(/…/g, "").trim()).filter((l) => l.length >= 4 && !/[{}`=]/.test(l));
  const byWords = words.flatMap((w) => who(w)), all = [...new Set([...byName, ...byWords])]; if (!all.length) untested++;
  line(`| ${h.n}() | ${[...h.labels].slice(0, 3).join(" · ") || "(icon/no text)"} | yes | ${all.slice(0, 5).join(", ") || "**none**"} |`); }
line(); line(`${untested} actions are not mentioned by any test (by name or by their visible words).`);

// 3. settings the user can change (S.rules / S.set / H())
const settings = new Set([...app.matchAll(/(S\.rules|S\.set|H\(\))\.(\w+)\s*=/g)].map((m) => `${m[1]}.${m[2]}`));
line(); line("## Settings that can be changed"); line("| Setting | Test files that mention it |"); line("|---|---|");
for (const s of [...settings].sort()) line(`| ${s} | ${who(s.split(".").pop()).slice(0, 5).join(", ") || "**none**"} |`);

// 4. Scan service endpoints
const eps = [...new Set([...svc.matchAll(/P\("(\w+)"\)/g)].map((m) => m[1]))].filter((e) => e !== "key");
line(); line("## Scan service endpoints (?name=…)"); line("| Endpoint | Used by the app? | Test files that call it |"); line("|---|---|---|");
for (const e of eps) line(`| ${e} | ${new RegExp(`["'\`&?]${e}=`).test(app) ? "yes" : "no (service/admin/test only)"} | ${who(new RegExp(`["'\`?&]${e}=`)).slice(0, 6).join(", ") || "**none**"} |`);

// 5. database: tables and what's done to them
const ops = {};
for (const m of svc.matchAll(/\b(SELECT[\s\S]{0,200}?FROM|INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM|CREATE TABLE IF NOT EXISTS|ALTER TABLE|DROP TABLE(?: IF EXISTS)?)\s+(\w+)/gi)) {
  const verb = m[1].split(/\s/)[0].toUpperCase(), t = m[2]; if (/^(SELECT|WHERE|VALUES|SET)$/i.test(t)) continue; (ops[t] = ops[t] || new Set()).add(verb); }
line(); line("## Database tables and operations"); line("| Table | Operations in the Scan service | Test files that mention it |"); line("|---|---|---|");
for (const [t, v] of Object.entries(ops).sort()) line(`| ${t} | ${[...v].join(", ")} | ${who(new RegExp(`\\b${t}\\b`)).slice(0, 5).join(", ") || "**none**"} |`);

// 6. outside services
const ext = [["eBay Browse API (search, item details)", /api\.ebay\.com\/buy\/browse|buy\/browse\/v1/, svc], ["eBay OAuth (app token)", /identity\/v1\/oauth2/, svc], ["eBay Taxonomy (category tree)", /commerce\/taxonomy/, svc],
  ["eBay user sign-in (Connect eBay)", /ebayconnect|auth\.ebay\.com/, svc + app], ["eBay sold-listing pages (in-app browser, user taps)", /sch\/i\.html/, app], ["Firebase Cloud Messaging (alerts)", /fcm\.googleapis\.com/, svc],
  ["Cloudflare D1 database", /env\.DB/, svc], ["Cloudflare KV (backup)", /env\.BACKUP/, svc], ["Cloudflare cron (background job)", /async scheduled\(/, svc], ["Capacitor App / AppLauncher / Push plugins", /Capacitor\.Plugins/, app],
  ["Cordova in-app browser", /InAppBrowser/, app], ["FlipScout crash capture (Android)", /CrashInfo/, app]];
line(); line("## Outside services and integrations"); line("| Integration | Present | Test files |"); line("|---|---|---|");
for (const [n, re, src] of ext) line(`| ${n} | ${re.test(src) ? "yes" : "no"} | ${who(re).slice(0, 5).join(", ") || "**none (needs a real account/device)**"} |`);

// 7. unfinished, hidden or placeholder
line(); line("## Unfinished, hidden or placeholder (text found in the code)"); line("| Where | Text |"); line("|---|---|");
for (const [name, src] of [["app", app], ["service", svc]]) for (const m of src.matchAll(/(TODO|FIXME|XXX|coming soon|not yet|placeholder|admin only|S\.set\.admin)/gi)) {
  const ln = src.slice(0, m.index).split("\n").length; line(`| ${name} line ${ln} | ${clean(src.slice(Math.max(0, m.index - 40), m.index + 60))} |`); }
console.log(`# FlipScout master inventory (generated from the code, ${new Date().toISOString().slice(0, 10)})\n\n` +
  `${screens.length} screens · ${handlers.size} button/control actions · ${settings.size} settings · ${eps.length} endpoints · ${Object.keys(ops).length} tables · ${ext.length} integrations\n\n` + out.join("\n"));
