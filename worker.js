// FlipScout service: app <-> this worker <-> eBay Browse API (eBay UK)
// Secrets: APP_KEY, EBAY_ID, EBAY_SECRET.  Bindings (set by the deploy workflow): DB (D1), BACKUP (KV)
// Runs every minute (cron; hunts at the user's interval) to hunt for deals in the user's categories, learn sold prices from
// ending auctions, watch followed listings and send FlipScout phone alerts (Firebase Cloud Messaging).
// Push alerts need the secret FCM_SA (the Firebase service-account JSON), set by the deploy workflow.
//
// Endpoints (all need ?key=APP_KEY):
//   search  ?q=&max=&region=&cat=        one-off keyword search (used by Check)
//   suggest ?suggest=words               eBay category suggestions
//   tree    ?tree=1                      full eBay UK category list
//   backup  GET/POST ?backup=1           app data backup
//   config  GET/POST ?config=1           hunting settings (categories, rules, alerts)
//   deals   ?deals=1                     current deals found by the hunter
//   run     ?run=1                       run a hunt now
//   follows ?follows=1 | POST ?follow=1 | ?unfollow=ID
//   test    ?test=1                      send a test phone alert
//   check   ?check=ID                    is a deal still for sale, at what price
//   price   POST ?price=1                save a price book value (avg sold, sell-through, postage, trend)
//   prices  ?prices=1 | ?unprice=KEY     the price book
//   needs   ?needs=1                     products in your categories that need a price book value

let TOKEN = null, TOKEN_EXP = 0, SCHEMA = false, CALLS = 0;
// eBay allows 5,000 Browse calls a day on our keyset. We count them and hold back optional work near the limit.
const EBAY_DAILY = 5000;
const today = () => new Date().toISOString().slice(0, 10);
async function quota(env) { const q = await kvGet(env, "quota", null); return q && q.d === today() ? q.n : 0; }
async function saveQuota(env) {
  if (!CALLS) return;
  const n = (await quota(env)) + CALLS; CALLS = 0;
  await kvSet(env, "quota", { d: today(), n });
}
const DAY = 864e5;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

/* ---------------- eBay access ---------------- */
async function getToken(env) {
  if (TOKEN && Date.now() < TOKEN_EXP) return TOKEN;
  if (env.DB) {
    try {
      const t = await kvGet(env, "token", null);
      if (t && t.exp > Date.now()) { TOKEN = t.t; TOKEN_EXP = t.exp; return TOKEN; }
    } catch (e) {}
  }
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(env.EBAY_ID + ":" + env.EBAY_SECRET),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("eBay login failed (" + res.status + ")");
  const d = await res.json();
  TOKEN = d.access_token;
  TOKEN_EXP = Date.now() + (d.expires_in - 300) * 1000;
  if (env.DB) { try { await kvSet(env, "token", { t: TOKEN, exp: TOKEN_EXP }); } catch (e) {} }
  return TOKEN;
}
async function ebay(env, path) {
  const token = await getToken(env);
  CALLS++;
  const r = await fetch("https://api.ebay.com" + path, {
    headers: {
      Authorization: "Bearer " + token,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=GB",
    },
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error("eBay request failed (" + r.status + ")");
  return r.json();
}

/* ---------------- database ---------------- */
async function schema(env) {
  if (SCHEMA) return;
  const D = env.DB;
  await D.batch([
    D.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)"),
    D.prepare("CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, cat TEXT, pkey TEXT, title TEXT, cond TEXT, type TEXT, price REAL, ship REAL, bids INTEGER, end_at INTEGER, first_seen INTEGER, last_seen INTEGER, status TEXT)"),
    D.prepare("CREATE INDEX IF NOT EXISTS li_status ON listings(status, end_at)"),
    // indexes use first_seen (never changes) so updates don't cost extra writes
    D.prepare("CREATE INDEX IF NOT EXISTS li_key2 ON listings(pkey, first_seen)"),
    D.prepare("CREATE INDEX IF NOT EXISTS li_cat ON listings(cat, first_seen)"),
    D.prepare("DROP INDEX IF EXISTS li_key"),
    D.prepare("CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, pkey TEXT, cat TEXT, price REAL, kind TEXT, at INTEGER)"),
    D.prepare("CREATE INDEX IF NOT EXISTS sa_key ON sales(pkey, at)"),
    D.prepare("CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, data TEXT, score INTEGER, created INTEGER, expires INTEGER, notified INTEGER DEFAULT 0)"),
    D.prepare("CREATE INDEX IF NOT EXISTS de_exp ON deals(expires)"),
    D.prepare("CREATE TABLE IF NOT EXISTS follows (id TEXT PRIMARY KEY, data TEXT, max REAL, created INTEGER, alerted TEXT)"),
    // price book: values users read off eBay's research page and type in, one row per product group
    D.prepare("CREATE TABLE IF NOT EXISTS fillsales (pkey TEXT PRIMARY KEY, data TEXT, at INTEGER)"),
    D.prepare("CREATE TABLE IF NOT EXISTS prices (pkey TEXT PRIMARY KEY, label TEXT, q TEXT, avg REAL, st REAL, post REAL, trend TEXT, at INTEGER)"),
  ]);
  for (const sql of ["ALTER TABLE listings ADD COLUMN data TEXT", "ALTER TABLE deals ADD COLUMN checked INTEGER DEFAULT 0"]) {
    try { await D.prepare(sql).run(); } catch (e) { /* column already there */ }
  }
  SCHEMA = true;
}
async function kvGet(env, k, def) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  return r ? JSON.parse(r.v) : def;
}
async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, JSON.stringify(v)).run();
}

/* ---------------- money maths ---------------- */
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, l = Math.floor(i), h = Math.ceil(i); return s[l] + (s[h] - s[l]) * (i - l); };
function sellFee(x, r) { return r.seller === "private" ? 0 : x * r.feePct / 100 + (x > 10 ? r.feeFixed : Math.min(r.feeFixed, 0.3)); }
// UK buyer protection fee on private sellers' items (estimate: £0.10 + 7% to £20, 4% to £300, 2% to £4,000)
function bpf(p) { return 0.1 + Math.min(p, 20) * 0.07 + Math.max(0, Math.min(p, 300) - 20) * 0.04 + Math.max(0, Math.min(p, 4000) - 300) * 0.02; }
function maxPay(med, low, r) {
  const out = r.post + r.pack, N = med - sellFee(med, r) - out, k = r.minRoi / 100;
  // "cheap" (on by default): also never lose money if it only sells at the cheap end
  return Math.min(N - r.minProfit, (N - k * r.pack) / (1 + k), r.cheap === false ? Infinity : low - sellFee(low, r) - out - 0.01);
}

/* ---------------- grouping comparable items (by spec, not brand) ---------------- */
const MODS = new Set(["ti", "super", "pro", "max", "plus", "mini", "lite", "oled", "xl", "ultra", "slim", "air", "se", "disc", "digital", "fe"]);
function condBucket(id) { const n = +id || 0; if (n >= 7000) return "parts"; if (n && n < 2000) return "new"; return "used"; }
function sig(title) {
  const t = String(title || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b([a-z]{2,})\s+(\d{1,2})\b(?!\s*(gb|tb|mb|inch|in|cm|mm|pcs|pack|x)\b)/g, "$1$2").split(/\s+/).filter(Boolean);
  const keep = t.filter((w) => (/\d/.test(w) && w.length >= 2 && !/^\d{1,2}$/.test(w) && !/^\d+(x|pcs|pc|pack)$/.test(w) && !/^x\d+$/.test(w)) || MODS.has(w));
  return [...new Set(keep)].sort().join(" ");
}
const LAPTOP_RE = /\b(laptop|notebook|macbook|chromebook|thinkpad|elitebook|probook|latitude|ideapad|thinkbook|zenbook|vivobook|inspiron|vostro|surface laptop|galaxy book|ultrabook)\b/i;
const NOT_A_CARD = /\b(laptop|notebook|desktop|tower|gaming pc|pc build|full pc|computer|ssd|hdd|ram|i[3579][\s-]?\d|ryzen|bundle|job ?lot|joblot|pair of|waterblock|water block|heatsink|backplate|fan|fans|cooler|bracket|riser|cable|box only|empty box)\b/i;
const MULTI_VRAM = new Set(["gtx 1060", "rtx 2060", "rtx 3050", "rtx 3060", "rtx 4060 ti", "rx 470", "rx 480", "rx 570", "rx 580", "rx 5500 xt", "rx 6500 xt"]);
function gpuChip(t) {
  let m = t.match(/\b(rtx|gtx|rx|arc)\s*-?\s*([ab]?\d{3,4})\s*(ti\s*super|super|ti|xtx|xt|gre)?(?![a-z0-9])/i);
  let pre, num, suf;
  if (m) { pre = m[1].toLowerCase(); num = m[2].toLowerCase(); suf = (m[3] || "").toLowerCase().replace(/\s+/g, " "); }
  else if (/\b(geforce|nvidia)\b/i.test(t)) {
    m = t.match(/\b(10[5-8]0|16[5-6]0|20[5-8]0|30[5-9]0|40[5-9]0|50[5-9]0)\s*(ti\s*super|super|ti)?(?![a-z0-9])/i);
    if (!m) return null;
    num = m[1]; suf = (m[2] || "").toLowerCase().replace(/\s+/g, " "); pre = /^1/.test(num) ? "gtx" : "rtx";
  } else return null;
  if (pre === "arc" && !/^[ab]/.test(num)) return null;
  if (pre === "rx" && !/^\d{3,4}$/.test(num)) return null;
  return [pre, num, suf].filter(Boolean).join(" ");
}
function gpuKey(title) {
  const t = String(title || "");
  if (NOT_A_CARD.test(t) || /^\s*[2-9]\s?x\s|\bx\s?[2-9]\s*$/i.test(t)) return null;
  const chip = gpuChip(t);
  if (!chip) return null;
  let label = chip.toUpperCase().replace("SUPER", "Super").replace(" TI", " Ti").replace("ARC ", "Arc ");
  let key = chip;
  if (MULTI_VRAM.has(chip)) {
    const g = t.match(/\b(\d{1,2})\s*gb\b/i);
    if (g && +g[1] <= 24) { key += " " + g[1] + "gb"; label += " " + g[1] + "GB"; }
  }
  return { key: "gpu:" + key, label: label + " (any brand)", match: 0.85 };
}
function laptopKey(title) {
  const t = String(title || "").toLowerCase();
  let cpu = null, cpuL = "";
  let m;
  if (/macbook/.test(t)) {
    const kind = /macbook\s*pro/.test(t) ? "pro" : /macbook\s*air/.test(t) ? "air" : "mb";
    m = t.match(/\bm([1-5])\s*(pro|max|ultra)?\b/);
    if (m) { cpu = `apple-${kind}-m${m[1]}${m[2] ? "-" + m[2] : ""}`; cpuL = `MacBook ${kind === "mb" ? "" : kind === "pro" ? "Pro " : "Air "}M${m[1]}${m[2] ? " " + m[2][0].toUpperCase() + m[2].slice(1) : ""}`; }
    else { m = t.match(/\b(20[01]\d|202[0-4])\b/); cpu = `apple-${kind}-intel${m ? "-" + m[1] : ""}`; cpuL = `MacBook ${kind === "pro" ? "Pro " : kind === "air" ? "Air " : ""}Intel${m ? " " + m[1] : ""}`; }
  } else if ((m = t.match(/\bi([3579])[\s-]*(\d{4,5})[a-z]{0,2}\d?\b/))) {
    const gen = m[2].length === 5 ? m[2].slice(0, 2) : m[2][0];
    cpu = `intel-i${m[1]}-g${gen}`; cpuL = `Intel i${m[1]} ${gen}th gen`;
  } else if ((m = t.match(/\bi([3579])\b.*?\b(\d{1,2})(?:st|nd|rd|th)\s*gen/)) || (m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*gen\b.*?\bi([3579])\b/))) {
    const a = /^\d{1,2}$/.test(m[1]) && /gen/.test(t.slice(t.indexOf(m[1]), t.indexOf(m[1]) + 8)) ? [m[2], m[1]] : [m[1], m[2]];
    cpu = `intel-i${a[0]}-g${a[1]}`; cpuL = `Intel i${a[0]} ${a[1]}th gen`;
  } else if ((m = t.match(/\bcore\s*ultra\s*([579])\b/))) {
    cpu = `intel-ultra${m[1]}`; cpuL = `Intel Core Ultra ${m[1]}`;
  } else if ((m = t.match(/\bryzen\s*([3579])\s*(?:pro\s*)?(\d)\d{3}[a-z]{0,2}\b/))) {
    cpu = `amd-r${m[1]}-s${m[2]}`; cpuL = `Ryzen ${m[1]} ${m[2]}000 series`;
  } else if (/\b(celeron|pentium|atom|n4020|n4500|n100|n200|athlon|mediatek|snapdragon)\b/.test(t)) {
    cpu = "budget"; cpuL = "Budget processor";
  }
  if (!cpu) return null;
  let ram = null;
  const rm = t.match(/\b(4|6|8|12|16|20|24|32|36|48|64)\s*gb\s*(?:of\s*)?(?:ram|ddr\d?|lpddr\d?x?|memory|unified)\b/) || t.match(/\b(4|6|8|12|16|20|24|32|36|48|64)\s*gb\b(?!\s*(?:ssd|hdd|emmc|nvme|storage|m\.?2|flash))/);
  if (rm) ram = +rm[1];
  let st = null;
  const sm = t.match(/\b(\d)\s*tb\b/) ? [null, t.match(/\b(\d)\s*tb\b/)[1] * 1000] : t.match(/\b(64|120|128|240|250|256|480|500|512|960|1000|1024|2048)\s*gb\b/);
  if (sm) { const v = +sm[1]; st = v <= 128 ? 128 : v <= 256 ? 256 : v <= 512 ? 512 : 1000; }
  const g = gpuChip(t);
  const parts = [cpu, ram ? "r" + ram : "r?", st ? "s" + st : "s?", g ? g.replace(/\s+/g, "") : ""].filter(Boolean);
  const label = [cpuL, ram ? ram + "GB RAM" : "", st ? (st >= 1000 ? "1TB+" : st + "GB") : "", g ? g.toUpperCase() : ""].filter(Boolean).join(" · ");
  return { key: "lap:" + parts.join("|"), label: label + (cpu.startsWith("apple") ? "" : " (any brand)"), match: ram && st ? 0.65 : 0.5 };
}
const ACCESSORY = /\b(case|cover|protector|screen guard|tempered glass|charger|charging|cable|adapter|dock|stand|mount|holder|skin|sticker|strap|band|controller only|pad only|remote|box only|empty box|manual|replacement|lcd|digitiser|digitizer|housing|back glass|battery|motherboard|logic board|fan|heatsink|job ?lot|joblot|bundle of|lot of)\b/i;
const storageOf = (t) => { let m = t.match(/\b(\d)\s*tb\b/i); if (m) return +m[1] * 1024; m = t.match(/\b(16|32|64|120|128|240|250|256|480|500|512|960|1000|1024)\s*gb\b/i); if (!m) return null; const g = +m[1]; return g >= 960 ? 1024 : g === 480 ? 500 : g === 500 ? 500 : g === 240 || g === 250 ? 256 : g === 120 ? 128 : g; };
const stLabel = (g) => (g >= 1024 ? g / 1024 + "TB" : g + "GB");
function phoneKey(t) {
  if (ACCESSORY.test(t)) return null;
  const l = t.toLowerCase(); let m, model = null;
  if ((m = l.match(/\biphone\s*(\d{1,2}e?|se|xs|xr|x)\s*(pro\s*max|pro|plus|mini|max)?\b/))) model = "iphone " + m[1] + (m[2] ? " " + m[2].replace(/\s+/g, " ") : "");
  else if ((m = l.match(/\bgalaxy\s*(s|a|note|z\s*fold|z\s*flip|m)\s*(\d{1,3})\s*(ultra|plus|\+|fe|lite|5g)?\b/))) model = "galaxy " + m[1].replace(/\s+/g, "") + m[2] + (m[3] && m[3] !== "5g" ? " " + m[3].replace("+", "plus") : "");
  else if ((m = l.match(/\bpixel\s*(\d{1,2}a?)\s*(pro\s*xl|pro\s*fold|pro|xl|a)?\b/))) model = "pixel " + m[1] + (m[2] ? " " + m[2] : "");
  if (!model) return null;
  const st = storageOf(t);
  return { key: "phone:" + model + (st ? " " + st : ""), label: model.replace(/\b\w/g, (c) => c.toUpperCase()).replace("Iphone", "iPhone") + (st ? " " + stLabel(st) : ""), match: st ? 0.9 : 0.7 };
}
const NOT_CONSOLE = /\b(portal|remote play|vr2?|psvr2?|camera|headset|pulse|dualsense edge|charging station|disc drive|drive only|media remote|cover plates?|vertical stand|cooling|games?|game bundle only|steelbook|amiibo|gift card|voucher|membership|subscription|ps plus|game pass|pegi|code only|(?:download|digital|game) code|code in (?:a )?box|cartridge|cart only|disc only|game card)\b/i;
const CON_ACC = /\b(controllers?|joy[- ]?cons?|gamepads?|dualsense|dualshock|grips?|docks?|charg(?:er|ers|ing)|cables?|cases?|covers?|skins?|stands?|headsets?|faceplates?|shells?|screen protectors?|tempered glass|memory cards?|sd cards?|carry(?:ing)? (?:bag|case)|power (?:supply|adapter)|psu|fans?|cooling|replacement|thumb ?sticks?|joysticks?|buttons?)\b/i;
const CON_YES = /\b(console|system|handheld|bundle|with|inc|includes?|including|boxed|complete|\+)(?=\W|$)/i;
const CON_BARE = /\b(console only|tablet only|unit only|handheld only|screen only|system only|main unit|no (?:joy[- ]?cons?|controllers?|pads?|dock|charger|cables?|leads?|power (?:lead|cable|supply))|without (?:joy[- ]?cons?|controllers?|pads?|dock|charger|cables?|leads?))\b/i;
function consoleKey(t) {
  if (NOT_CONSOLE.test(t) && !/\b(console|with|\+|inc|includes?|bundle)\b/i.test(t.replace(NOT_CONSOLE, ""))) return null;
  if (/\b(portal|remote play|psvr|vr2|disc drive|drive only)\b/i.test(t)) return null;
  // accessories on their own (controllers, docks, cases...) are not consoles; a console listing that mentions them is fine
  if (CON_ACC.test(t) && !CON_YES.test(t)) return null;
  if (/\b(lcd|screen replacement|motherboard|housing|shell|faceplate|for parts|empty|packaging|box only|pegi|code only)\b/i.test(t)) return null;
  const l = t.toLowerCase(); let m, k = null;
  if ((m = l.match(/\b(ps5|playstation\s*5)\b/))) k = "ps5 " + (/\bpro\b/.test(l) ? "pro" : /digital/.test(l) ? "digital" : "disc") + (/\bslim\b/.test(l) ? " slim" : "");
  else if ((m = l.match(/\b(ps4|playstation\s*4)\b/))) k = "ps4" + (/\bpro\b/.test(l) ? " pro" : /\bslim\b/.test(l) ? " slim" : "");
  else if ((m = l.match(/\bxbox\s*series\s*(x|s)\b/))) k = "xbox series " + m[1];
  else if ((m = l.match(/\bxbox\s*one\s*(x|s)?\b/))) k = "xbox one" + (m[1] ? " " + m[1] : "");
  else if ((m = l.match(/\bnintendo\s*switch\b|\bswitch\s*(oled|lite)\b/))) k = "switch" + (/\boled\b/.test(l) ? " oled" : /\blite\b/.test(l) ? " lite" : /\bswitch\s*2\b/.test(l) ? " 2" : "");
  else if ((m = l.match(/\bsteam\s*deck\b/))) k = "steam deck" + (/\boled\b/.test(l) ? " oled" : "") + ((m = l.match(/\b(64|256|512)\s*gb\b/)) ? " " + m[1] : "") + (/\b1\s*tb\b/.test(l) ? " 1tb" : "");
  if (!k) return null;
  // "console only", "no controller" etc. sell for less than a complete set, so they're compared with each other
  const bare = CON_BARE.test(t);
  const label = k.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Ps/, "PS").replace("Oled", "OLED") + (bare ? " (not complete)" : "");
  return { key: "con:" + k + (bare ? " bare" : ""), label, match: 0.9 };
}
function tabletKey(t) {
  if (ACCESSORY.test(t)) return null;
  const l = t.toLowerCase(); let m;
  if (!(m = l.match(/\bipad\s*(pro|air|mini)?\b/))) return null;
  const kind = m[1] || "ipad";
  const gen = (l.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*gen/) || [])[1] || (l.match(/\bm([1-4])\b/) ? "M" + l.match(/\bm([1-4])\b/)[1] : "");
  const size = (l.match(/\b(7\.9|8\.3|9\.7|10\.2|10\.5|10\.9|11|12\.9|13)\s*(?:"|''|inch|in)?/) || [])[1] || "";
  const st = storageOf(t);
  if (!gen && !size) return null;
  return { key: `tab:${kind}|${gen}|${size}|${st || "?"}`, label: `iPad ${kind === "ipad" ? "" : kind[0].toUpperCase() + kind.slice(1) + " "}${gen ? gen + (/^\d/.test(gen) ? "th gen" : "").replace(/^(\d+)th gen$/, "$1th gen") + " " : ""}${size ? size + '" ' : ""}${st ? stLabel(st) : ""}`.trim(), match: st && gen ? 0.85 : 0.6 };
}
function cpuKey(t, catName) {
  if (!/processor|cpu/i.test(catName || "") && !/\b(processor|cpu)\b/i.test(t)) return null;
  if (/\b(laptop|desktop|pc|computer|motherboard|bundle|combo)\b/i.test(t)) return null;
  const l = t.toLowerCase(); let m;
  if ((m = l.match(/\bi([3579])[\s-]*(\d{4,5}[a-z]{0,2})\b/))) return { key: "cpu:i" + m[1] + "-" + m[2], label: "Intel i" + m[1] + "-" + m[2].toUpperCase(), match: 0.95 };
  if ((m = l.match(/\bryzen\s*([3579])\s*(\d{4}[a-z0-9]{0,3})\b/))) return { key: "cpu:r" + m[1] + "-" + m[2], label: "Ryzen " + m[1] + " " + m[2].toUpperCase(), match: 0.95 };
  return null;
}
function ramKey(t, catName) {
  if (!/memory|ram/i.test(catName || "") && !/\b(ram|ddr[345])\b/i.test(t)) return null;
  if (/\b(laptop|desktop|pc|computer|motherboard|phone|tablet)\b/i.test(t)) return null;
  const l = t.toLowerCase();
  const type = (l.match(/\bddr([345])\b/) || [])[1];
  if (!type) return null;
  let cap = null, m;
  if ((m = l.match(/\b(\d)\s*x\s*(\d{1,2})\s*gb\b/))) cap = +m[1] * +m[2];
  else if ((m = l.match(/\b(\d{1,3})\s*gb\b/))) cap = +m[1];
  if (!cap) return null;
  const sp = (m = l.match(/\b(\d{4})\s*(?:mhz|mt\/s)?\b/)) ? Math.round(+m[1] / 400) * 400 : "";
  const so = /\b(so-?dimm|laptop)\b/.test(l) ? " sodimm" : "";
  return { key: `ram:ddr${type}|${cap}|${sp}${so}`, label: `DDR${type} ${cap}GB${sp ? " ~" + sp + "MHz" : ""}${so ? " laptop" : ""} (any brand)`, match: sp ? 0.75 : 0.6 };
}
function storageKey(t, catName) {
  if (!/drive|ssd|storage|hard disk/i.test(catName || "") && !/\b(ssd|nvme|hdd|hard drive)\b/i.test(t)) return null;
  if (/\b(laptop|desktop|pc|computer|console|ps5|ps4|xbox|enclosure|caddy|adapter)\b/i.test(t)) return null;
  const l = t.toLowerCase();
  const kind = /\bnvme|m\.?2\b/.test(l) ? "nvme" : /\bssd\b/.test(l) ? "ssd" : /\bhdd|hard (disk )?drive\b/.test(l) ? "hdd" : null;
  const st = storageOf(t);
  if (!kind || !st) return null;
  const ext = /\b(external|portable|usb)\b/.test(l) ? " external" : "";
  return { key: `sto:${kind}${ext}|${st}`, label: `${stLabel(st)} ${kind.toUpperCase()}${ext} (any brand)`, match: 0.65 };
}
function monitorKey(t, catName) {
  if (!/monitor/i.test(catName || "") && !/\bmonitor\b/i.test(t)) return null;
  if (ACCESSORY.test(t) || /\b(arm|baby|heart|tv)\b/i.test(t)) return null;
  const l = t.toLowerCase();
  const size = (l.match(/\b(2[0-9]|3[0-9]|4[0-9])(?:\.\d)?\s*(?:"|''|inch|in\b)/) || [])[1];
  if (!size) return null;
  const hz = (l.match(/\b(60|75|100|120|144|165|170|180|240|280|360)\s*hz\b/) || [])[1] || "";
  const res = /\b(4k|uhd|2160p)\b/.test(l) ? "4k" : /\b(1440p|qhd|2k|wqhd)\b/.test(l) ? "1440p" : /\b(1080p|fhd|full hd)\b/.test(l) ? "1080p" : "";
  return { key: `mon:${size}|${res}|${hz}`, label: `${size}" monitor${res ? " " + res : ""}${hz ? " " + hz + "Hz" : ""} (any brand)`, match: res && hz ? 0.6 : 0.45 };
}


/* ---------------- fashion: brand + product line (sizes and colours vary, so these get a wider range) ---------------- */
// [brand label, brand pattern, [[line label, line pattern], ...]]
const FASHION = [
  ["Nike", /\bnike\b|\bjordan\b/, [["Air Max 90", /air ?max ?90\b/], ["Air Max 95", /air ?max ?95\b/], ["Air Max 97", /air ?max ?97\b/], ["Air Max 1", /air ?max ?1\b(?!\d)/], ["Air Max Plus TN", /air ?max ?plus|\btn\b/], ["Air Force 1", /air ?force ?1|\baf1\b/], ["Dunk Low", /dunk ?low/], ["Dunk High", /dunk ?high/], ["Jordan 1 High", /jordan ?1\b.*\bhigh\b|\baj1\b.*\bhigh\b/], ["Jordan 1 Mid", /jordan ?1\b.*\bmid\b/], ["Jordan 1 Low", /jordan ?1\b.*\blow\b/], ["Jordan 4", /jordan ?4\b|\baj4\b/], ["Jordan 3", /jordan ?3\b/], ["Jordan 11", /jordan ?11\b/], ["Blazer Mid", /blazer ?mid/], ["VaporMax", /vapou?r ?max/], ["P-6000", /p ?-? ?6000/], ["Cortez", /\bcortez\b/], ["Tech Fleece", /tech ?fleece/]]],
  ["Adidas", /\badidas\b|\byeezy\b/, [["Samba", /\bsamba\b/], ["Gazelle", /\bgazelle\b/], ["Handball Spezial", /\bspezial\b/], ["Campus", /\bcampus\b/], ["Superstar", /\bsuperstar\b/], ["Stan Smith", /stan ?smith/], ["Forum", /\bforum\b/], ["Ultraboost", /ultra ?boost/], ["Yeezy 350", /yeezy.*\b350\b|\b350\b.*yeezy/], ["Yeezy 700", /yeezy.*\b700\b/], ["Yeezy Slide", /yeezy.*slide/]]],
  ["New Balance", /new ?balance|\bnb\b/, [["550", /\b550\b/], ["530", /\b530\b/], ["574", /\b574\b/], ["327", /\b327\b/], ["990", /\b990\b/], ["991", /\b991\b/], ["992", /\b992\b/], ["993", /\b993\b/], ["2002R", /\b2002 ?r\b/], ["9060", /\b9060\b/], ["1906R", /\b1906 ?r\b/]]],
  ["ASICS", /\basics\b/, [["Gel-Kayano 14", /kayano ?14/], ["Gel-1130", /\b1130\b/], ["Gel-NYC", /gel ?-? ?nyc/], ["Gel-Lyte III", /lyte ?(iii|3)\b/]]],
  ["Salomon", /\bsalomon\b/, [["XT-6", /xt ?-? ?6\b/], ["XT-4", /xt ?-? ?4\b/], ["Speedcross", /speedcross/]]],
  ["Converse", /\bconverse\b/, [["Chuck 70", /chuck ?(taylor)? ?70|\bct ?70\b/], ["Chuck Taylor", /chuck ?taylor|all ?star/]]],
  ["Vans", /\bvans\b/, [["Old Skool", /old ?skool/], ["Sk8-Hi", /sk8 ?-? ?hi/], ["Knu Skool", /knu ?skool/]]],
  ["Dr. Martens", /dr\.? ?martens?|doc ?martens?|\bdms\b/, [["1460", /\b1460\b/], ["1461", /\b1461\b/], ["2976", /\b2976\b/], ["Jadon", /\bjadon\b/], ["Adrian", /\badrian\b/]]],
  ["UGG", /\bugg\b/, [["Tasman", /\btasman\b/], ["Ultra Mini", /ultra ?mini/], ["Classic Mini", /classic ?mini/], ["Classic Short", /classic ?short/]]],
  ["The North Face", /north ?face|\btnf\b/, [["Nuptse", /\bnuptse\b/], ["1996 Retro", /\b1996\b/], ["Himalayan", /\bhimalayan\b/], ["Denali", /\bdenali\b/], ["McMurdo", /mcmurdo/]]],
  ["Barbour", /\bbarbour\b/, [["Bedale", /\bbedale\b/], ["Beaufort", /\bbeaufort\b/], ["Ashby", /\bashby\b/], ["International", /\binternational\b/], ["Liddesdale", /liddesdale/]]],
  ["Stone Island", /stone ?island/, [["Overshirt", /\bovershirt\b/], ["Jumper", /\bjumper\b|\bknit\b/], ["Sweatshirt", /\bsweatshirt\b|\bsweater\b|crew ?neck/], ["Hoodie", /\bhoodie\b|\bhooded\b/], ["Jacket", /\bjacket\b|\bcoat\b/]]],
  ["Canada Goose", /canada ?goose/, [["Expedition", /\bexpedition\b/], ["Chilliwack", /chilliwack/], ["Langford", /langford/], ["Wyndham", /wyndham/], ["Chateau", /chateau/], ["Crofton", /crofton/]]],
  ["Arc'teryx", /arc'?\s?teryx/, [["Beta LT", /beta ?lt/], ["Beta AR", /beta ?ar/], ["Alpha SV", /alpha ?sv/], ["Atom LT", /atom ?lt/], ["Atom Hoody", /atom ?ho/]]],
  ["Patagonia", /\bpatagonia\b/, [["Retro-X", /retro ?-? ?x/], ["Nano Puff", /nano ?puff/], ["Better Sweater", /better ?sweater/], ["Synchilla", /synchilla/]]],
  ["Levi's", /\blevi'?s?\b/, [["501", /\b501\b/], ["505", /\b505\b/], ["511", /\b511\b/], ["550", /\b550\b/], ["Trucker Jacket", /trucker/]]],
  ["Carhartt", /\bcarhartt\b/, [["Detroit Jacket", /\bdetroit\b/], ["Active Jacket", /active ?jacket/], ["Double Knee", /double ?knee/], ["Michigan", /\bmichigan\b/]]],
  ["Ralph Lauren", /ralph ?lauren|\bpolo\b.*\blauren\b/, [["Cable Knit Jumper", /cable ?knit/], ["Harrington", /harrington/]]],
];
const KIDS = /\b(kids?|junior|jnr|infants?|toddler|baby|youth|gs|child(ren)?|boys|girls|td|ps)\b/;
function fashionKey(title) {
  const t = String(title || "").toLowerCase();
  for (const [brand, bre, lines] of FASHION) {
    if (!bre.test(t)) continue;
    for (const [line, lre] of lines) if (lre.test(t)) {
      const kid = KIDS.test(t);
      return { key: "fas:" + brand.toLowerCase().replace(/[^a-z]/g, "") + " " + line.toLowerCase() + (kid ? " kids" : ""), label: brand + " " + line + (kid ? " (kids)" : ""), match: 0.75 };
    }
    return null; // brand without a known line: too vague to price
  }
  return null;
}
function groupOf(it, cat, catName, bucket) {
  const title = it.title || "";
  const lapCat = /laptop|netbook|notebook/i.test(catName || "") || cat === "177" || cat === "111422";
  let g = null;
  if (lapCat || LAPTOP_RE.test(title)) g = laptopKey(title);
  // each spec group only applies in a category where that kind of item belongs (sellers mis-file things)
  const cn = catName || "", fits = (re) => !cn || re.test(cn);
  if (!g && !lapCat) g = (fits(/graphic|video card|gpu|component|computer/i) && gpuKey(title))
    || (fits(/phone|mobile/i) && phoneKey(title))
    || (fits(/console|video game|gaming|handheld/i) && consoleKey(title))
    || (fits(/tablet|ipad|e-?book/i) && tabletKey(title))
    || cpuKey(title, catName) || ramKey(title, catName) || storageKey(title, catName) || monitorKey(title, catName)
    || (fits(/cloth|shoe|trainer|sneaker|boot|footwear|coat|jacket|jumper|hoodie|jean|shirt|fashion|men|women|unisex|bag/i) && fashionKey(title)) || null;
  if (g) return { key: g.key + "|" + bucket, label: g.label, match: g.match };
  if (it.epid) return { key: "e" + it.epid + "|" + bucket, label: "Same eBay product", match: 1 };
  const s = sig(title);
  return s ? { key: "t" + cat + ":" + s + "|" + bucket, label: "Similar title", match: s.split(" ").length >= 2 ? 0.7 : 0.45 } : null;
}

/* ---------------- price book: the search FlipScout opens on eBay's research page ---------------- */
// Users never type filters. FlipScout builds the search and adds "leave out" words itself,
// so the sold average on eBay's page is for the item itself, not PCs, parts or boxes.
const LOOK_ALL = ["faulty", "spares", "repair", "repairs", "broken", "parts", "joblot", "job", "bundle", "empty", "untested", "read"];
const LOOK_EX = {
  gpu: ["pc", "build", "computer", "desktop", "laptop", "bridge", "nvlink", "sli", "i5", "i7", "i9", "ryzen", "heatsink", "backplate", "waterblock", "bracket", "riser", "shroud"],
  phone: ["case", "cover", "protector", "charger", "cable", "lcd", "housing", "cracked", "locked", "icloud"],
  // accessory listings say "for Switch", "AC adapter", "replacement"...; complete bundles mention dock/case, so those stay in
  con: ["skin", "faceplate", "shell", "headset", "for", "adapter", "ac", "psu", "supply", "replacement", "compatible", "protector", "grip", "joystick", "thumbstick", "sticker"],
  tab: ["case", "cover", "protector", "charger", "lcd", "cracked", "locked", "icloud"],
  lap: ["motherboard", "hinge", "lcd", "palmrest", "sleeve", "bag"],
  cpu: ["laptop", "desktop", "pc", "computer", "motherboard", "combo"],
  ram: ["laptop", "desktop", "pc", "computer", "motherboard", "combo"],
  sto: ["laptop", "desktop", "pc", "computer", "console", "ps5", "ps4", "xbox", "enclosure", "caddy", "adapter"],
  mon: ["arm", "mount", "panel", "bracket", "tv"],
  any: ["manual"],
};
const FILLER = new Set("new used brand genuine original official uk free fast quick postage delivery p&p excellent good great very fair mint perfect immaculate condition working tested fully boxed unboxed rare look l@@k bnib bnwt bnwob nwt with without and the for in of a an to by on from x1 inc incl including only item items sale cheap bargain see pics photos pictures description".split(" "));
// Every variant name that changes the price; any not in this item's name gets left out.
const VARIANTS = { gpu: ["ti", "super"], rx: ["xt", "xtx", "gre"], phone: ["pro", "max", "plus", "mini", "ultra", "fe", "lite", "xl"], con: ["pro", "digital", "slim", "oled", "lite"], tab: ["pro", "air", "mini"] };
function lookupQ(title, pkey) {
  const k = String(pkey || "").replace(/\|(new|used|parts)$/, "");
  const kind = (k.match(/^(gpu|lap|phone|con|tab|cpu|ram|sto|mon):/) || [])[1] || "any";
  const body = k.slice(kind.length + 1);
  let words = [];
  if (kind === "gpu") words = body.split(" ");
  else if (kind === "phone") { words = body.split(" "); const st = words[words.length - 1]; if (/^\d+$/.test(st)) words[words.length - 1] = st >= 1024 ? st / 1024 + "tb" : st + "gb"; }
  else if (kind === "con") { // most disc consoles don't say "disc"; "console" keeps chargers and spare parts out
    words = body.split(" ").filter((w) => w !== "disc" && w !== "bare");
    if (words[0] === "switch") words.unshift("nintendo");
    words.push(/ bare$/.test(body) ? "only" : "console"); // "console only" / "tablet only" listings
  }
  else if (kind === "tab") { const [t, gen, size, st] = body.split("|"); words = ["ipad", t === "ipad" ? "" : t, gen ? (/^m/i.test(gen) ? gen.toLowerCase() : gen + "th") : "", size, st && st !== "?" ? (st >= 1024 ? st / 1024 + "tb" : st + "gb") : ""]; }
  else if (kind === "cpu") words = [body.replace(/^(i\d)-/, "$1 ").replace(/^r(\d)-/, "ryzen $1 ")];
  else if (kind === "ram") { const [t, cap, sp] = body.split("|"); words = [t, cap + "gb", /sodimm/.test(sp || "") ? "sodimm" : ""]; }
  else if (kind === "sto") { const [t, cap] = body.split("|"); words = [t.replace(" external", ""), /external/.test(t) ? "external" : "", cap >= 1024 ? cap / 1024 + "tb" : cap + "gb"]; }
  else if (kind === "mon") { const [size, res, hz] = body.split("|"); words = [size, "monitor", res, hz ? hz + "hz" : ""]; }
  else { // laptops and everything else
    // the title's key words: the title's key words (brand, model, size), without sales talk
    words = String(title || "").toLowerCase().replace(/[^a-z0-9.\- ]+/g, " ").split(/\s+/).filter((w) => w && !FILLER.has(w) && (w.length > 1 || /\d/.test(w))).slice(0, 7);
  }
  words = words.join(" ").split(/\s+/).filter(Boolean);
  const ex = [...LOOK_ALL, ...(LOOK_EX[kind] || LOOK_EX.any), ...(VARIANTS[kind === "gpu" && words[0] === "rx" ? "rx" : kind] || []).filter((v) => !words.includes(v))];
  if (kind === "phone" && words.includes("pixel")) { const n = words.find((w) => /^\d+$/.test(w)); if (n) ex.push(n + "a"); }
  if (kind === "ram" && !words.includes("sodimm")) ex.push("sodimm");
  const seen = new Set(words);
  return [...words, ...ex.filter((w) => !seen.has(w) && (seen.add(w), true)).map((w) => "-" + w)].join(" ");
}
const lookupUrl = (q) => "https://www.ebay.co.uk/sh/research?marketplace=EBAY-GB&keywords=" + encodeURIComponent(q) + "&dayRange=30&tabName=SOLD";

const bookLabel = (label, title, key) => (!label || /^(Similar title|Same eBay product)$/.test(label) ? String(title || "").slice(0, 60) : label) + (/\|new$/.test(key) ? " · new" : " · used");
const bareKey = (k) => String(k || "").replace(/^t\d*:/, "t:"); // "similar title" groups without the category, so typed searches match
const BOOK_DAYS = 30;
// prices saved by a category fill are marked "fill"; prices the user checked themselves have no mark
let srcReady = false;
async function ensureSrc(env) { if (srcReady) return; for (const c of ["src TEXT", "n INTEGER", "lo REAL", "hi REAL"]) { try { await env.DB.prepare("ALTER TABLE prices ADD COLUMN " + c).run(); } catch (e) {} } srcReady = true; }
// a careful "sells for": the lower-middle sale price (40th percentile), from the last 30 days when there are 5+ sales, else 90 days
const pctl = (a, f) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * f, lo = Math.floor(i); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo); };
const FILL_SKIP = /\b(faulty|spares|repairs?|broken|for parts|parts only|job ?lot|joblot|bundle|empty box|box only|untested|read desc|read description|see desc|see description|please read|not working|cracked|icloud locked)\b/i;
async function fillPrices(env, b) {
  // Every sale is kept by its eBay item number (so pages read twice, or on different days, never count twice)
  // in one small record per model; each model's price comes from all its sales in the last 90 days.
  const cat = String(b.cat || "").replace(/\D/g, ""), catName = String(b.catName || "").slice(0, 80), cond = b.cond === "new" ? "new" : "used";
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 3000), groups = new Map(), now = Date.now(), cut = now - 90 * DAY;
  for (const r of rows) {
    const t = String((r && r.n) || "").slice(0, 200), p = +r.p, id = String((r && r.id) || "").replace(/\D/g, "").slice(0, 20);
    if (!t || !id || !(p > 0 && p < 100000) || FILL_SKIP.test(t)) continue;
    if (r.c && r.c !== cond) continue; // the listing's own condition (eBay's filter sometimes drops on later pages)
    const g = groupOf({ title: t }, cat, catName, cond);
    // known kinds are matched model by model; anything else needs a strong title match or a single model code like "75192"
    const known = /^(gpu|lap|phone|con|tab|cpu|ram|sto|mon|fas):/.test(g && g.key), code = g && /^t\d*:([a-z0-9]{4,})\|/.exec(g.key);
    if (!g || g.match < (known ? 0.6 : code ? 0.45 : 0.7)) continue;
    const key = bareKey(g.key);
    let x = groups.get(key); if (!x) groups.set(key, (x = { label: bookLabel(g.label, t, key), q: lookupQ(t, g.key), add: [] }));
    x.add.push([id, Math.round(p * 100) / 100, r.s != null && +r.s >= 0 && +r.s < 500 ? Math.round(+r.s * 100) / 100 : null, +r.d || null]);
  }
  // first fill after the careful-price update: recalculate every model already collected, not just this page's
  if (!(await kvGet(env, "fillV2", false))) {
    const all = await env.DB.prepare("SELECT f.pkey, p.label, p.q FROM fillsales f LEFT JOIN prices p ON p.pkey = f.pkey").all();
    for (const r of all.results || []) if (!groups.has(r.pkey) && r.label) groups.set(r.pkey, { label: r.label, q: r.q || "", add: [], recalc: true });
    await kvSet(env, "fillV2", true);
  }
  const keys = [...groups.keys()], have = new Map();
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90), q = await env.DB.prepare("SELECT pkey, data FROM fillsales WHERE pkey IN (" + part.map(() => "?").join(",") + ")").bind(...part).all();
    for (const r of q.results || []) { try { have.set(r.pkey, JSON.parse(r.data)); } catch (e) {} }
  }
  const old = await env.DB.prepare("SELECT pkey, at, src FROM prices WHERE at > ?").bind(now - 7 * DAY).all();
  const mine = new Set((old.results || []).filter((r) => r.src !== "fill").map((r) => r.pkey));
  const blobs = [], prices = [], saved = []; let few = 0, kept = 0, fresh = 0;
  for (const [key, x] of groups) {
    const all = new Map((have.get(key) || []).filter((r) => !r[3] || r[3] >= cut).map((r) => [r[0], r]));
    for (const r of x.add) if (!all.has(r[0])) { all.set(r[0], r); fresh++; }
    const list = [...all.values()].sort((a, c) => (c[3] || 0) - (a[3] || 0)).slice(0, 3000);
    blobs.push([key, JSON.stringify(list), now]);
    const m = median(list.map((r) => r[1])), keep = list.filter((r) => r[1] >= m * 0.5 && r[1] <= m * 1.5);
    if (keep.length < 5) { few++; continue; }
    if (mine.has(key)) { kept++; continue; }
    const recent = keep.filter((r) => r[3] && r[3] >= now - 30 * DAY), use = recent.length >= 5 ? recent : keep, ps = use.map((r) => r[1]);
    const avg = Math.round(pctl(ps, 0.4) * 100) / 100, lo = Math.round(pctl(ps, 0.25)), hi = Math.round(pctl(ps, 0.75)), sh = use.map((r) => r[2]).filter((v) => v != null);
    const dated = keep.filter((r) => r[3]).sort((a, c) => a[3] - c[3]); let trend = "steady";
    if (dated.length >= 8) { const h = dated.length >> 1, o = median(dated.slice(0, h).map((r) => r[1])), nw = median(dated.slice(h).map((r) => r[1])); trend = nw > o * 1.05 ? "rising" : nw < o * 0.95 ? "falling" : "steady"; }
    prices.push([key, x.label.slice(0, 120), x.q.slice(0, 400), avg, null, sh.length ? Math.round(median(sh) * 100) / 100 : null, trend, now, "fill", use.length, lo, hi]);
    saved.push({ label: x.label, n: use.length, avg, key });
  }
  // few queries per save (free plan allows 50): many rows per statement
  const multi = (head, tail, cols, list, per) => { const st = []; for (let i = 0; i < list.length; i += per) { const part = list.slice(i, i + per); st.push(env.DB.prepare(head + part.map(() => "(" + Array(cols).fill("?").join(",") + ")").join(",") + tail).bind(...part.flat())); } return st; };
  const st = [...multi("INSERT INTO fillsales (pkey,data,at) VALUES ", " ON CONFLICT(pkey) DO UPDATE SET data=excluded.data, at=excluded.at", 3, blobs, 30),
    ...multi("INSERT INTO prices (pkey,label,q,avg,st,post,trend,at,src,n,lo,hi) VALUES ", " ON CONFLICT(pkey) DO UPDATE SET label=excluded.label, q=excluded.q, avg=excluded.avg, post=excluded.post, trend=excluded.trend, at=excluded.at, src='fill', n=excluded.n, lo=excluded.lo, hi=excluded.hi", 12, prices, 8)];
  if (st.length) await env.DB.batch(st);
  saved.sort((a, c) => c.n - a.n);
  // per-category totals for Admin tools: sales stored and models priced
  let stats = null;
  try {
    const fc = await kvGet(env, "fillCats", {}), e = fc[cat] || { k: {} }, ok = new Set(saved.map((x) => x.key));
    const kind = (k) => k.split(":")[0], kinds = new Set([...groups].filter(([, x]) => x.add.length).map(([k]) => kind(k)));
    for (const [key, list] of blobs) {
      const x = groups.get(key);
      // this page's models, ones already counted for this category, and (on the one-off recalculation) earlier models of the same kind
      if (!(x.add.length || e.k[key] || (x.recalc && kinds.has(kind(key)) && !/^t/.test(key)))) continue;
      e.k[key] = [JSON.parse(list).length, ok.has(key) || mine.has(key) ? 1 : 0];
    }
    e.name = catName; e.at = now; fc[cat] = e; await kvSet(env, "fillCats", fc);
    stats = fillStat(e);
  } catch (err) {}
  return { read: rows.length, fresh, models: groups.size, saved: saved.length, few, kept, top: saved.slice(0, 40), stats };
}

const fillStat = (e) => { const v = Object.values(e.k || {}); return { sales: v.reduce((a, x) => a + x[0], 0), models: v.filter((x) => x[1]).length, at: e.at || 0, name: e.name || "" }; };
// the sold-price search FlipScout opens for a listing's product (Check sold prices)
function lookInfo(s, alt) {
  if (!s.pkey || s.bucket === "parts") return null;
  const q = lookupQ(s.title, s.pkey);
  return { key: s.pkey, label: bookLabel(s.matchLabel, s.title, s.pkey), q, url: lookupUrl(q), expect: alt ? Math.round(alt.med) : null };
}

// versions that often sell for a different price than the standard model
const SPECIAL = /\b(poseidon|water ?cooled|watercooled|water ?block|hybrid|aio|blower|low ?profile|lp|mini|itx|oem|kingpin|hof|wasserk\w*|refurb\w*|engineering sample)\b/i;
// auction learning buckets: time left (day+, 2h+, 30m+, under 30m) and bids (0-2, 3+)
const aucBucket = (mins, bids) => (mins > 1440 ? "d" : mins > 120 ? "h" : mins > 30 ? "m" : "s") + (bids > 2 ? "+" : "-");
/* ---------------- what the hunter avoids ---------------- */
const RISK_WORDS = /\b(empty (?:retail |original |console )?(?:box|packaging|case)|packaging only|box (?:and|&) (?:inserts?|packaging|manual)|box\W{1,4}empty|empty\W{1,4}(?:box|packaging)|box only|empty box|read desc|read description|see desc|see description|please read|photo of|picture of|image of|replica|fake|not genuine|dummy|display only|case only|cover only|manual only|cable only|stand only|bundle only|no console|card only|for parts|spares|repairs?|faulty|broken|cracked|not working|untested|bios lock|icloud|activation lock|locked|blacklisted|no power|water damage|liquid damage|damaged|dented|bent pins?|burnt|burned|scorched|melted|smashed|shattered|bricked|no display|no signal|no picture|dead pixels?|artifact(?:s|ing)|artefact(?:s|ing))\b/i;
const SCAM_WORDS = /\b(empty (?:retail |original |console )?(?:box|packaging|case)|packaging only|box (?:and|&) (?:inserts?|packaging|manual)|box\W{1,4}empty|empty\W{1,4}(?:box|packaging)|read desc|read description|photo of|picture of|image of|empty box|box only|replica|fake|not genuine|contact me|message me before|whatsapp|bank transfer)\b/i;
// "iPhone 12 Pro Max 128GB BOX": a title that ends in "box" is usually the box alone ("... with box" is fine)
const BOX_END = /(?<!\b(?:with|w\/|and|&|\+|inc|incl|includes?|including|in|original|retail) )\bbox(?:es)?\W*$/i;
const RISK_G = new RegExp(RISK_WORDS.source, "gi");
const MISSPELT = /\b(nvidea|nvida|nvdia|geforse|gefroce|playstaion|playsation|plastation|playstatio|nintedo|nintndo|nitendo|xobx|xbxo|iphne|iphome|ipohne|samsng|samsumg|sumsung|macbok|mackbook|macbbok|thinkpda|lenova|lenvo|hewlet|cannon eos|nikkon|dysen|delonghi|de longhi|airpod pro|sonos|bose|playstation 4 pro|ps4 pro|ps5 disc|xbox seris|xbox sereis|apple watc|ipda|ipadd|gopro hreo|go pro|dyosn|kitchen aid|lego technic)\b/i;
const MIS_ONLY = /\b(nvidea|nvida|nvdia|geforse|gefroce|playstaion|playsation|plastation|playstatio|nintedo|nintndo|nitendo|xobx|xbxo|iphne|iphome|ipohne|samsng|samsumg|sumsung|macbok|mackbook|macbbok|thinkpda|lenova|lenvo|hewlet|nikkon|dysen|xbox seris|xbox sereis|apple watc|ipda|ipadd|gopro hreo|dyosn)\b/i;

function ukHour(ts) {
  try { return +new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(new Date(ts)); }
  catch (e) { return new Date(ts).getUTCHours(); }
}

/* ---------------- background learning ---------------- */
// Popular UK resale categories. FlipScout watches their auctions just to learn sold prices,
// so any category you add later already has price history.
const LEARN_TERMS = ["iPhone", "Samsung Galaxy smartphone", "PlayStation 5 console", "Nintendo Switch console", "Xbox Series X console",
  "Apple iPad tablet", "Apple Watch", "Apple AirPods", "Wireless headphones", "Laptop", "Graphics card", "Computer monitor",
  "CPU processor", "Desktop memory RAM", "SSD solid state drive", "Digital camera", "Camera lens", "LEGO set",
  "Cordless drill", "Dyson vacuum cleaner", "Smart watch", "Steam Deck"];
async function learnCats(env) {
  const st = await kvGet(env, "learnCats", { i: 0, cats: [] });
  let n = 0;
  while (st.i < LEARN_TERMS.length && n < 2) {
    n++;
    try {
      const d = await ebay(env, "/commerce/taxonomy/v1/category_tree/3/get_category_suggestions?q=" + encodeURIComponent(LEARN_TERMS[st.i]));
      const c = ((d.categorySuggestions || [])[0] || {}).category;
      if (c && !st.cats.some((x) => x.id === String(c.categoryId))) st.cats.push({ id: String(c.categoryId), name: c.categoryName });
    } catch (e) { break; }
    st.i++;
  }
  if (n) await kvSet(env, "learnCats", st);
  return st.cats;
}
// Auctions jump in their last minutes. Look again just before they end, so we learn the real price.
async function closing(env) {
  await schema(env);
  const D = env.DB, now = Date.now();
  const used = await quota(env);
  if (used > EBAY_DAILY * 0.85) return 0; // keep the rest of today's eBay calls for hunting
  // your deals and followed auctions first; other auctions with bids only while plenty of today's calls are left
  const mine = "(id IN (SELECT id FROM deals) OR id IN (SELECT id FROM follows))";
  const rows = await D.prepare(`SELECT id FROM listings WHERE status='live' AND type='AUC' AND pkey IS NOT NULL AND end_at>? AND end_at<=? AND (${mine}${used < EBAY_DAILY * 0.5 ? " OR bids>0" : ""}) ORDER BY ${mine} DESC, bids DESC LIMIT 3`).bind(now, now + 150000).all();
  if (!(rows.results || []).length) return 0;
  const up = [];
  for (const row of rows.results || []) {
    try {
      const d = await ebay(env, `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${row.id}`);
      if (d.notFound) continue;
      const pr = d.currentBidPrice || d.price, so = (d.shippingOptions || [])[0];
      if (!pr) continue;
      up.push(D.prepare("UPDATE listings SET price=?, ship=?, bids=?, last_seen=? WHERE id=?").bind(parseFloat(pr.value) || 0, so && so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0, +d.bidCount || 0, now, row.id));
    } catch (e) { break; }
  }
  if (up.length) await D.batch(up);
  await saveQuota(env);
  return up.length;
}

/* ---------------- the hunt ---------------- */
const DEFAULT_RULES = { cheap: true, minProfit: 20, minRoi: 0, seller: "business", feePct: 12.8, feeFixed: 0.4, post: 5, pack: 1, bpf: true, alertScore: 70, minScore: 40 };
function cleanConfig(c) {
  c = c || {};
  return {
    cats: Array.isArray(c.cats) ? c.cats.filter((x) => x && /^\d+$/.test(String(x.id))).slice(0, 15).map((x) => ({ id: String(x.id), name: String(x.name || "").slice(0, 80) })) : [],
    rules: { ...DEFAULT_RULES, ...(c.rules || {}) },
    types: { bin: true, auction: true, misspelt: true, spares: false, ...(c.types || {}) },
    region: c.region === "any" ? "any" : "uk",
    alerts: c.alerts !== false,
    interval: [5, 10, 15, 30, 60].includes(+c.interval) ? +c.interval : 10,
    paused: !!c.paused,
    // quiet hours: no phone alerts between these UK hours (e.g. 23 to 7). Hunting carries on
    quiet: c.quiet && c.quiet.on ? { on: true, from: Math.max(0, Math.min(23, +c.quiet.from || 0)), to: Math.max(0, Math.min(23, +c.quiet.to || 0)) } : { on: false, from: 23, to: 7 },
  };
}
function isQuiet(cfg, ts) {
  const q = cfg.quiet; if (!q || !q.on || q.from === q.to) return false;
  const h = ukHour(ts || Date.now());
  return q.from < q.to ? h >= q.from && h < q.to : h >= q.from || h < q.to;
}

// "sales learned" counts read every sales row, so they're worked out once a day and kept
async function refreshLearned(env) {
  const by = await env.DB.prepare("SELECT cat, COUNT(*) AS n FROM sales GROUP BY cat").all();
  const byCat = by.results || [];
  const c = { byCat, total: byCat.reduce((t, r) => t + r.n, 0), at: Date.now() };
  await kvSet(env, "learnedCounts", c);
  return c;
}

async function sweep(env, manual) {
  await schema(env);
  const cfg = cleanConfig(await kvGet(env, "config", null));
  const now = Date.now();
  const last = await kvGet(env, "lastRun", 0);
  if (!manual) {
    if (cfg.paused || !cfg.cats.length) return { skipped: "nothing to hunt" };
    if (now - last < cfg.interval * 60000 - 30000) return { skipped: "not due" };
  }
  if (!cfg.cats.length) return { error: "Add some categories first." };
  await kvSet(env, "lastRun", now);
  const D = env.DB, r = cfg.rules, report = { checked: 0, newDeals: 0, hidden: 0, errors: [] };

  // 0. matching rules changed (spec-based groups): start learning afresh once
  if ((await kvGet(env, "keyver", 1)) < 3) {
    await D.batch([D.prepare("DELETE FROM listings"), D.prepare("DELETE FROM sales"), D.prepare("DELETE FROM deals")]);
    await kvSet(env, "keyver", 3);
  }
  // 0b. one-off clean-up: handhelds and add-ons were once filed as consoles (e.g. PlayStation Portal as PS5)
  if (!(await kvGet(env, "fix1", false))) {
    const bad = "pkey LIKE 'con:%' AND (lower(title) LIKE '%portal%' OR lower(title) LIKE '%remote play%' OR lower(title) LIKE '%vr2%' OR lower(title) LIKE '%psvr%' OR lower(title) LIKE '%disc drive%' OR lower(title) LIKE '%drive only%')";
    await D.batch([
      D.prepare(`DELETE FROM sales WHERE id IN (SELECT id FROM listings WHERE ${bad})`),
      D.prepare(`DELETE FROM deals WHERE id IN (SELECT id FROM listings WHERE ${bad})`),
      D.prepare(`UPDATE listings SET pkey=NULL, data=NULL WHERE ${bad}`),
    ]);
    await kvSet(env, "fix1", true);
  }
  // 0c. one-off: re-file console sales/listings under the new rules (accessories out, "console only" separate)
  if (!(await kvGet(env, "fix2", false))) {
    const rows = await D.prepare("SELECT id, cat, title, cond FROM listings WHERE pkey LIKE 'con:%'").all();
    const up = [];
    for (const r0 of rows.results || []) {
      const g = groupOf({ title: r0.title }, r0.cat, "Video Game Consoles", r0.cond || "used");
      const nk = g ? g.key : null;
      up.push(D.prepare("UPDATE listings SET pkey=? WHERE id=?").bind(nk, r0.id), D.prepare("UPDATE sales SET pkey=? WHERE id=?").bind(nk, r0.id));
    }
    for (let i = 0; i < up.length; i += 100) await D.batch(up.slice(i, i + 100));
    await D.prepare("DELETE FROM deals WHERE data LIKE '%\"pkey\":\"con:%'").run();
    await kvSet(env, "fix2", true);
  }
  // 1. auctions that have ended become sold prices (only if they had bids)
  // (the free database allows 5 million rows read a day, so every query here must use an index)
  await D.batch([
    D.prepare("INSERT OR IGNORE INTO sales (id,pkey,cat,price,kind,at) SELECT id,pkey,cat,price+ship,'auction',end_at FROM listings WHERE status='live' AND end_at<? AND end_at>? AND type='AUC' AND bids>0 AND pkey IS NOT NULL").bind(now, now - 2 * DAY),
    D.prepare("UPDATE listings SET status='ended' WHERE status='live' AND end_at<? AND end_at>? AND type='AUC'").bind(now, now - 2 * DAY),
    D.prepare("DELETE FROM deals WHERE expires<?").bind(now),
  ]);
  // learn how auctions really end: compare each auction deal's final price with where it was when FlipScout saw it
  try {
    const snaps = await kvGet(env, "aucSnaps", {}), ids = Object.keys(snaps);
    if (ids.length) {
      const fin = new Map();
      for (let i = 0; i < ids.length; i += 90) { const part = ids.slice(i, i + 90); const q = await D.prepare(`SELECT id, price FROM sales WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all(); for (const r of q.results || []) fin.set(r.id, r.price); }
      const old = ids.filter((id) => now - snaps[id][6] > 3 * DAY);
      if (fin.size || old.length) {
        const L = await kvGet(env, "aucLearn", {});
        for (const id of ids) {
          const sn = snaps[id];
          if (fin.has(id)) { const [, med, p0, bids, mins, ship] = sn, end = fin.get(id) - ship, target = 0.88 * med - ship;
            if (target > p0 + 1) { const w = Math.max(0, Math.min(2, (end - p0) / (target - p0))), b = aucBucket(mins, bids), x = L[b] || { s: 0, n: 0 }; x.s = Math.round((x.s + w) * 1000) / 1000; x.n++; L[b] = x; }
            delete snaps[id];
          } else if (now - sn[6] > 3 * DAY) delete snaps[id];
        }
        await kvSet(env, "aucLearn", L); await kvSet(env, "aucSnaps", snaps);
      }
    }
  } catch (e) {}
  // once a day: tidy old rows and refresh the "sales learned" counts
  if (now - (await kvGet(env, "lastClean", 0)) > DAY) {
    await kvSet(env, "lastClean", now);
    await D.batch([
      D.prepare("UPDATE listings SET status='ended' WHERE status='live' AND end_at<? AND type='AUC'").bind(now),
      D.prepare("DELETE FROM listings WHERE last_seen<?").bind(now - 40 * DAY),
      D.prepare("DELETE FROM sales WHERE at<?").bind(now - 120 * DAY),
    ]);
  }
  // every 6 hours: refresh the "sales learned" counts (they read every sales row)
  if (now - ((await kvGet(env, "learnedCounts", null)) || { at: 0 }).at > 6 * 3600e3) await refreshLearned(env);

  // 2. which categories this run (rotate so every category gets its turn)
  let rot = await kvGet(env, "rot", 0);
  const per = manual ? Math.min(cfg.cats.length, 10) : Math.min(cfg.cats.length, 8);
  const cats = [];
  for (let i = 0; i < per; i++) cats.push(cfg.cats[(rot + i) % cfg.cats.length]);
  await kvSet(env, "rot", (rot + per) % cfg.cats.length);

  const base = ["priceCurrency:GBP", "deliveryCountry:GB", "price:[1..3000]"];
  if (cfg.region === "uk") base.push("itemLocationCountry:GB");
  const seen = [];
  for (const c of cats) {
    const calls = [];
    if (cfg.types.bin || cfg.types.misspelt || cfg.types.spares) calls.push(["BIN", "buyingOptions:{FIXED_PRICE}", "newlyListed", 100]);
    if (cfg.types.auction || cfg.types.spares) calls.push(["AUC", "buyingOptions:{AUCTION}", "endingSoonest", 50]);
    // every other scan: newly listed auctions too, for "Ending later" (high-start auctions days away)
    if (cfg.types.auction && (manual || Math.floor(now / 600000) % 2 === 0)) calls.push(["AUC", "buyingOptions:{AUCTION}", "newlyListed", 50]);
    for (const [type, f, sort, lim] of calls) {
      try {
        const d = await ebay(env, `/buy/browse/v1/item_summary/search?category_ids=${c.id}&limit=${lim}&sort=${sort}&filter=${encodeURIComponent([...base, f].join(","))}`);
        for (const it of d.itemSummaries || []) {
          const id = it.legacyItemId || String(it.itemId || "").split("|")[1];
          if (!id) continue;
          const auction = type === "AUC";
          const pr = auction && it.currentBidPrice ? it.currentBidPrice : it.price;
          const price = pr ? parseFloat(pr.value) : 0;
          const so = (it.shippingOptions || [])[0];
          const ship = so && so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0;
          // collection only: eBay sends no postage option (or only local pickup). Not "free post"
          const collect = !(it.shippingOptions || []).some((o) => o && o.shippingCost) && ((it.pickupOptions || []).length > 0 || !(it.shippingOptions || []).length);
          const bucket = condBucket(it.conditionId);
          seen.push({
            id, cat: c.id, catName: c.name, title: it.title || "", cond: it.condition || "", condId: it.conditionId || "", bucket,
            type, price, ship, bids: +it.bidCount || 0, end: it.itemEndDate ? Date.parse(it.itemEndDate) : null,
            created: it.itemCreationDate ? Date.parse(it.itemCreationDate) : null,
            seller: it.seller ? { name: it.seller.username || "", fb: +it.seller.feedbackScore || 0, pct: parseFloat(it.seller.feedbackPercentage) || 0 } : { name: "", fb: 0, pct: 0 },
            loc: (it.itemLocation && it.itemLocation.country) || "", img: it.image ? it.image.imageUrl : "",
            url: "https://www.ebay.co.uk/itm/" + id, bestOffer: (it.buyingOptions || []).includes("BEST_OFFER"),
            collect, where: collect ? String((it.itemLocation && (it.itemLocation.postalCode || it.itemLocation.city)) || "").replace(/\*+/g, "").trim().slice(0, 20) : "",
            ...(() => { const g = groupOf(it, c.id, c.name, bucket), w = groupOf(it, c.id, c.name, "used"); return { pkey: g ? g.key : null, matchLabel: g ? g.label : "", matchQ: g ? g.match : 0, workKey: w ? w.key : null, workQ: w ? w.match : 0 }; })(),
          });
        }
        report.checked++;
      } catch (e) { report.errors.push(c.name + ": " + e.message); }
    }
  }
  // background learning: a few popular categories per run, auctions only (skipped when near eBay's daily limit)
  if ((await quota(env)) + CALLS < EBAY_DAILY * 0.7) try {
    const mine = new Set(cfg.cats.map((c) => c.id));
    const lc = (await learnCats(env)).filter((c) => !mine.has(c.id));
    if (lc.length) {
      let lr = await kvGet(env, "lrot", 0);
      const pick = [];
      for (let i = 0; i < Math.min(5, lc.length); i++) pick.push(lc[(lr + i) % lc.length]);
      await kvSet(env, "lrot", (lr + pick.length) % lc.length);
      for (const c of pick) {
        try {
          const d = await ebay(env, `/buy/browse/v1/item_summary/search?category_ids=${c.id}&limit=50&sort=endingSoonest&filter=${encodeURIComponent([...base, "buyingOptions:{AUCTION}"].join(","))}`);
          for (const it of d.itemSummaries || []) {
            const id = it.legacyItemId || String(it.itemId || "").split("|")[1];
            if (!id || !it.currentBidPrice || !(+it.bidCount > 0)) continue; // no bids = no sale to learn
            const bucket = condBucket(it.conditionId), g = groupOf(it, c.id, c.name, bucket);
            if (!g) continue;
            const so = (it.shippingOptions || [])[0];
            seen.push({ id, cat: c.id, title: it.title || "", bucket, type: "AUC", price: parseFloat(it.currentBidPrice.value) || 0,
              ship: so && so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0, bids: +it.bidCount || 0,
              end: it.itemEndDate ? Date.parse(it.itemEndDate) : null, created: null, pkey: g.key, learn: true });
          }
          report.learning = (report.learning || 0) + 1;
        } catch (e) { /* learning is best effort */ }
      }
    }
  } catch (e) {}
  if (!seen.length) { await saveQuota(env); await kvSet(env, "lastReport", { at: now, ...report }); return report; }

  // 3. remember everything we saw (this builds the sold history over time)
  const firstSeen = {}, have = {};
  const ids = seen.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await D.prepare(`SELECT id, first_seen, price, ship, bids, last_seen FROM listings WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const row of rows.results || []) { firstSeen[row.id] = row.first_seen; have[row.id] = row; }
  }
  // only save what's new or changed (the free database allows 100,000 saved rows a day)
  const dirty = seen.filter((s, i) => {
    if (ids.indexOf(s.id) !== i) return false; // same listing twice in one run
    const h = have[s.id];
    return !h || h.price !== s.price || h.ship !== s.ship || h.bids !== s.bids || now - h.last_seen > 6 * 3600e3;
  });
  const up = dirty.map((s) => D.prepare(
    "INSERT INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'live',?) ON CONFLICT(id) DO UPDATE SET price=excluded.price, ship=excluded.ship, bids=excluded.bids, last_seen=excluded.last_seen, end_at=excluded.end_at, status=CASE WHEN listings.status='gone' THEN 'gone' ELSE 'live' END, data=excluded.data"
  ).bind(s.id, s.cat, s.pkey, s.title.slice(0, 200), s.bucket, s.type, s.price, s.ship, s.bids, s.end, s.created || now, now, s.learn ? null : JSON.stringify(s)));
  for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));
  report.saved = up.length;

  // 3b. also re-judge recent live listings from these categories that weren't in this run's results.
  // As sold history grows, listings we couldn't price yesterday can become deals today.
  const seenIds = new Set(ids);
  const why = { noData: 0, risky: 0, fair: 0 }, close = [];
  const cands = seen.filter((s) => !s.learn);
  {
    const rowsAll = [];
    for (const c of cats) {
      const rr = await D.prepare("SELECT id, data, status, end_at, last_seen FROM listings WHERE cat=? AND first_seen>? ORDER BY first_seen DESC LIMIT 150").bind(c.id, now - DAY).all();
      for (const x of rr.results || []) if (x.status === "live" && x.data && x.last_seen > now - DAY && (!x.end_at || x.end_at > now + 5 * 60000)) rowsAll.push(x);
    }
    // every deal already on the list is judged again too, so new rules and new prices reach it straight away
    // (an auction listed days ago and ending tonight isn't in the newest or ending-soonest results yet)
    const dl = await D.prepare("SELECT l.id, l.data, l.status, l.end_at, l.last_seen FROM deals d JOIN listings l ON l.id = d.id WHERE d.expires > ? LIMIT 200").bind(now).all();
    const inRun = new Set(rowsAll.map((x) => x.id));
    for (const x of dl.results || []) if (!inRun.has(x.id) && x.status === "live" && x.data && (!x.end_at || x.end_at > now + 5 * 60000)) { rowsAll.push(x); inRun.add(x.id); }
    for (const row of rowsAll) {
      if (seenIds.has(row.id)) continue;
      try {
        const o = JSON.parse(row.data); o.old = true;
        if (o.pkey && !/^e\d/.test(o.pkey)) { // matching rules may have improved since it was saved
          const g = groupOf({ title: o.title }, o.cat, o.catName, o.bucket), w = groupOf({ title: o.title }, o.cat, o.catName, "used");
          Object.assign(o, { pkey: g ? g.key : null, matchLabel: g ? g.label : "", matchQ: g ? g.match : 0, workKey: w ? w.key : null, workQ: w ? w.match : 0 });
        }
        cands.push(o);
      } catch (e) {}
    }
  }

  // 4. market price for each product group: sold history first, asking prices as a fallback
  const keys = [...new Set(cands.flatMap((s) => [s.pkey, s.workKey]).filter(Boolean))];
  const soldBy = {}, askBy = {}, bookBy = {}, soldLast = {};
  for (let i = 0; i < keys.length; i += 45) { // D1 allows 100 values per query (keys + bare keys + date)
    const chunk = keys.slice(i, i + 45), q = chunk.map(() => "?").join(",");
    const bk = [...new Set([...chunk, ...chunk.map(bareKey)])];
    await ensureSrc(env);
    const br = await D.prepare(`SELECT pkey, avg, st, post, trend, at, src, n, lo, hi FROM prices WHERE pkey IN (${bk.map(() => "?").join(",")}) AND at>?`).bind(...bk, now - BOOK_DAYS * DAY).all();
    for (const row of br.results || []) bookBy[row.pkey] = row;
    const sr = await D.prepare(`SELECT pkey, price, at FROM sales WHERE pkey IN (${q}) AND at>?`).bind(...chunk, now - 30 * DAY).all();
    for (const row of sr.results || []) { (soldBy[row.pkey] = soldBy[row.pkey] || []).push(row.price); soldLast[row.pkey] = Math.max(soldLast[row.pkey] || 0, row.at || 0); }
    const ar = await D.prepare(`SELECT pkey, id, price+ship AS t FROM listings WHERE pkey IN (${q}) AND first_seen>? AND last_seen>? AND type='BIN' AND status='live'`).bind(...chunk, now - 7 * DAY, now - 2 * DAY).all();
    for (const row of ar.results || []) (askBy[row.pkey] = askBy[row.pkey] || []).push([row.id, row.t]);
  }
  // Looser matches (e.g. "similar title") need more evidence before we trust a price.
  function trim(a) {
    if (a.length < 5) return a;
    const m = median(a);
    return a.filter((x) => x >= m * 0.4 && x <= m * 2.5);
  }
  function market(key, selfId, q = 0.5, noBook) {
    if (!key) return null;
    const needSold = q >= 0.8 ? 3 : q >= 0.6 ? 5 : 8;
    const sold = trim((soldBy[key] || []).filter((x) => x > 0));
    // 1. the price book comes first: a person read it off eBay's sold prices
    const b = !noBook && (bookBy[key] || bookBy[bareKey(key)]);
    if (b) {
      const post = b.post != null ? b.post : null;
      const med = b.avg + (post || 0); // what buyers pay in total, like our own sold prices
      let ev = now - b.at < 7 * DAY ? 1 : 0.85; // fresher is better
      if (sold.length >= 3) { const off = Math.abs(median(sold) - med) / med; ev *= off < 0.15 ? 1 : off < 0.3 ? 0.85 : 0.65; } // agrees with what we've seen sell?
      // the cheap end: the real 25th percentile when the fill recorded it (its "sells for" is already careful), else 15% under
      let low = b.lo != null ? Math.min(b.lo + (post || 0), med) : med * 0.85;
      if (b.trend === "falling") low = Math.min(low, med * 0.8);
      if (b.st != null && b.st < 25) low = Math.min(low, med * 0.8); // slow sellers: plan for a lower price
      return { med, low, n: sold.length, src: "book", fill: b.src === "fill", bookN: b.n || null, spread: 0.15, ev, st: b.st, post, trend: b.trend, at: b.at, lo: b.lo != null ? b.lo + (post || 0) : null, hi: b.hi != null ? b.hi + (post || 0) : null, lastAt: b.at };
    }
    if (sold.length >= needSold) {
      const med = median(sold), low = pct(sold, 0.25), iqr = pct(sold, 0.75) - low;
      return { med, low, n: sold.length, src: "sold", spread: med ? iqr / med : 1, lo: low, hi: pct(sold, 0.75), lastAt: soldLast[key] || null };
    }
    if (q < 0.65) return null; // asking prices are too noisy for loose matches
    const ask = trim((askBy[key] || []).filter(([id]) => id !== selfId).map(([, t]) => t).filter((x) => x > 0));
    if (ask.length >= (q >= 0.8 ? 8 : 12)) {
      // asking prices run high (sellers hope), so take the cheaper end and knock more off
      const med = pct(ask, 0.25) * 0.9, low = pct(ask, 0.1) * 0.85;
      return { med, low, n: ask.length, src: "asking", spread: med ? (pct(ask, 0.75) - pct(ask, 0.25)) / med : 1, lo: pct(ask, 0.25), hi: pct(ask, 0.75), lastAt: now };
    }
    return null;
  }

  // 5. judge each listing
  const deals = [], spares = [], later = [];
  let hidden = 0;
  for (const s of cands) {
    const extra = r.bpf ? bpf(s.price) : 0;
    if (s.bucket === "parts") {
      if (!cfg.types.spares) continue;
      const m = market(s.workKey, s.id, s.workQ || 0.5);
      if (!m || s.price + s.ship > m.med * 0.6) continue;
      if (SCAM_WORDS.test(s.title)) { hidden++; continue; }
      spares.push({ ...s, kind: "spares", tags: [], score: 0, cost: Math.round((s.price + s.ship + extra) * 100) / 100, workMed: Math.round(m.med), n: m.n, src: m.src });
      continue;
    }
    if (RISK_WORDS.test(s.title)) { why.risky++; continue; }
    if (BOX_END.test(s.title)) { hidden++; continue; }
    const m = market(s.pkey, s.id, s.matchQ || 0.5);
    if (!m) { why.noData++; continue; }
    if (m.spread > 0.9 && (s.matchQ || 0.5) < 0.8) { why.noData++; continue; } // prices all over the place: not confident
    const cost = s.price + s.ship + extra;
    if (cost < m.med * 0.4 && (s.seller.fb < 5 || s.seller.pct < 95 || SCAM_WORDS.test(s.title))) { hidden++; continue; }
    if (SCAM_WORDS.test(s.title)) { hidden++; continue; }
    // a Buy It Now at under a fifth of what it sells for is almost always a box, a photo, a code or a scam
    if (s.type !== "AUC" && cost < m.med * 0.2) { hidden++; continue; }
    const ri = m.post != null ? { ...r, post: m.post } : r; // postage out for this product, from the price book
    const mp = maxPay(m.med, m.low, ri);
    if (mp <= 0) continue;
    const out = ri.post + ri.pack;
    const profit = m.med - sellFee(m.med, r) - out - cost;
    const lowProfit = m.low - sellFee(m.low, r) - out - cost;
    const roi = cost + r.pack > 0 ? (profit / (cost + r.pack)) * 100 : 0;
    const misspelt = MIS_ONLY.test(s.title);
    const tags = [];
    let ok = false, maxBid = null;
    const slow = m.st != null && m.st < 25; // few listings sell: need a bigger cushion
    if (s.type === "BIN") {
      if (!(cfg.types.bin || (cfg.types.misspelt && misspelt))) continue;
      ok = profit >= r.minProfit * (slow ? 1.5 : 1) && (!(r.minRoi > 0) || roi >= r.minRoi);
      const age = now - (s.created || firstSeen[s.id] || now);
      if (age < 60 * 60000) tags.push("New listing");
    } else {
      if (!cfg.types.auction) continue;
      if (!s.end) continue;
      // more than 12 hours left: only "serious" auctions whose price is already well up (not 99p starts), for "Ending later"
      if (s.end - now > 12 * 3600e3 && !(s.price >= m.med * 0.6)) continue;
      maxBid = Math.floor(((slow ? mp - r.minProfit * 0.5 : mp) - s.ship - (r.bpf ? bpf(mp) : 0)) * 100) / 100;
      ok = maxBid > s.price;
      const h = ukHour(s.end);
      if (h >= 0 && h < 6) tags.push("Ends overnight");
      if (s.bids <= 2) tags.push(s.bids ? s.bids + " bid" + (s.bids > 1 ? "s" : "") : "No bids yet");
    }
    if (!ok) {
      why.fair++;
      if (s.type === "BIN" && (m.src === "sold" || m.src === "book") && cost < m.med * 0.97 && profit > 0) {
        close.push({ id: s.id, title: s.title, img: s.img, url: s.url, cond: s.cond, catName: s.catName, price: s.price, ship: s.ship, cost: Math.round(cost * 100) / 100,
          med: Math.round(m.med * 100) / 100, profit: Math.round(profit * 100) / 100, roi: Math.round(roi), n: m.n, matchLabel: s.matchLabel, at: now });
      }
      continue;
    }
    if (misspelt) tags.push("Misspelt title");
    if (s.bestOffer) tags.push("Best Offer");
    if (s.loc && s.loc !== "GB") tags.push("Ships from " + s.loc);

    // confidence score, built from parts the user can see
    const ev = m.src === "book" ? m.ev : (m.src === "sold" ? Math.min(1, m.n / 10) : Math.min(0.5, m.n / 16)) * Math.max(0.3, 1 - Math.min(1, m.spread));
    const match = (s.matchQ || 0.5) * (SPECIAL.test(s.title) ? 0.75 : 1); // special versions: less sure it's the same as the rest
    const sel = s.seller.fb >= 50 && s.seller.pct >= 99 ? 1 : s.seller.fb >= 10 && s.seller.pct >= 98 ? 0.7 : s.seller.fb >= 5 ? 0.4 : 0.15;
    const mar = lowProfit <= 0 ? 0 : Math.min(1, lowProfit / Math.max(1, r.minProfit));
    let comp;
    if (s.type === "BIN") {
      const age = now - (s.created || firstSeen[s.id] || now);
      comp = age < 15 * 60000 ? 1 : age < 60 * 60000 ? 0.8 : age < 6 * 3600e3 ? 0.5 : 0.3;
      if (misspelt) comp = Math.min(1, comp + 0.2);
    } else {
      const h = ukHour(s.end);
      comp = (s.bids <= 1 ? 0.6 : s.bids <= 4 ? 0.4 : 0.2) + (h < 6 ? 0.3 : 0) + (misspelt ? 0.2 : 0);
      comp = Math.min(1, comp);
    }
    // demand: how many listings actually sell (from the price book). Unknown counts as average.
    const dem = m.st == null ? 0.6 : m.st >= 60 ? 1 : m.st >= 40 ? 0.8 : m.st >= 25 ? 0.55 : 0.25;
    let score = Math.round(25 * ev + 20 * match + 15 * sel + 20 * mar + 10 * comp + 10 * dem);
    if (m.src === "asking") { score = Math.min(score, r.alertScore - 1, 69); tags.push("Price not confirmed by sales"); }
    if (m.src === "book") tags.push(m.fill ? "Price from category check" : "Price from price book");
    if (SPECIAL.test(s.title)) tags.push("Special version");
    if (slow) tags.push("Slow seller");
    if (m.trend === "falling") tags.push("Prices falling");
    if (score < r.minScore) continue;
    (s.type === "AUC" && s.end - now > 12 * 3600e3 ? later : deals).push({
      ...s, kind: "deal", cost: Math.round(cost * 100) / 100, extra: Math.round(extra * 100) / 100,
      profit: Math.round(profit * 100) / 100, lowProfit: Math.round(lowProfit * 100) / 100, roi: Math.round(roi),
      maxPay: Math.floor(mp * 100) / 100, maxBid,
      // the most to pay for the item itself (before postage and fee), and profit if you pay exactly that
      maxItem: s.type === "AUC" ? maxBid : Math.floor((mp - s.ship - (r.bpf ? bpf(mp) : 0)) * 100) / 100,
      profitAtMax: (() => { const it = s.type === "AUC" ? maxBid : Math.floor((mp - s.ship - (r.bpf ? bpf(mp) : 0)) * 100) / 100; return Math.round((m.med - sellFee(m.med, r) - out - (it + s.ship + (r.bpf ? bpf(it) : 0))) * 100) / 100; })(),
      med: Math.round(m.med * 100) / 100, low: Math.round(m.low * 100) / 100,
      n: m.n, src: m.src, fill: !!m.fill, bookN: m.bookN || null, score, parts: { evidence: ev, match, seller: sel, margin: mar, competition: comp, demand: dem }, tags,
      sellFee: Math.round(sellFee(m.med, r) * 100) / 100, out: Math.round(out * 100) / 100,
      st: m.st != null ? m.st : null, trend: m.trend || null, bookAt: m.at || null,
      // evidence shown on the deal page: typical price range and how recent the newest evidence is
      rangeLo: m.lo != null ? Math.round(m.lo) : null, rangeHi: m.hi != null ? Math.round(m.hi) : null, lastAt: m.lastAt || null,
      look: lookInfo(s, market(s.pkey, s.id, s.matchQ || 0.5, true)),
    });
  }
  report.hidden = hidden;
  report.why = { ...why, judged: cands.length };
  // ending later: cheap high-start auctions with days left. Shown with a Follow button, never alerted
  try {
    const keep = new Set(cands.map((s) => s.id)), mk = (d) => ({ id: d.id, collect: d.collect, where: d.where, title: d.title, img: d.img, url: d.url, cond: d.cond, cat: d.cat, catName: d.catName, type: "AUC",
      price: d.price, ship: d.ship, bids: d.bids, end: d.end, med: d.med, maxBid: d.maxBid, maxItem: d.maxItem, maxPay: d.maxPay, profitAtMax: d.profitAtMax, sellFee: d.sellFee, out: d.out,
      score: d.score, n: d.n, src: d.src, fill: d.fill, rangeLo: d.rangeLo, rangeHi: d.rangeHi, seen: now });
    const old = (await kvGet(env, "later", [])).filter((x) => !keep.has(x.id) && x.end - now > 12 * 3600e3 && now - x.seen < 3 * DAY);
    await kvSet(env, "later", [...later.map(mk), ...old].sort((a, b) => b.maxBid - b.price - (a.maxBid - a.price)).slice(0, 25));
  } catch (e) {}
  // close calls: below the usual sold price, but not enough profit for your rules. Shown, never alerted.
  try {
    const old = (await kvGet(env, "close", [])).filter((c) => now - c.at < 6 * 3600e3 && !cands.some((s) => s.id === c.id));
    const merged = [...close, ...old].sort((a, b) => b.profit - a.profit).slice(0, 10);
    await kvSet(env, "close", merged);
  } catch (e) {}

  // 6. spares: fetch the seller's own condition words (a few per run)
  for (const sp of spares.slice(0, 3)) {
    try {
      const d = await ebay(env, `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${sp.id}`);
      if (!d.notFound) sp.sellerSays = String(d.conditionDescription || d.shortDescription || "").slice(0, 300);
    } catch (e) {}
  }

  // 7. save deals, keep old ones that are still live
  const all = [...deals, ...spares];
  if (all.length) {
    const existing = {};
    for (let i = 0; i < all.length; i += 90) {
      const chunk = all.slice(i, i + 90).map((d) => d.id);
      const rows = await D.prepare(`SELECT id FROM deals WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
      for (const row of rows.results || []) existing[row.id] = 1;
    }
    const st = all.map((d) => D.prepare(
      "INSERT INTO deals (id,data,score,created,expires,notified) VALUES (?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET data=excluded.data, score=excluded.score, expires=excluded.expires"
    ).bind(d.id, JSON.stringify(d), d.score || 0, now, d.type === "AUC" && d.end ? d.end : now + DAY));
    for (let i = 0; i < st.length; i += 50) await D.batch(st.slice(i, i + 50));
    report.newDeals = all.filter((d) => !existing[d.id]).length;
  }
  // listings we just judged that are no longer deals (price went up, bids passed our max): take them off the list
  {
    const keep = new Set(all.map((d) => d.id));
    const drop = cands.map((s) => s.id).filter((id) => !keep.has(id));
    for (let i = 0; i < drop.length; i += 90) {
      const chunk = drop.slice(i, i + 90);
      await D.prepare(`DELETE FROM deals WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
  }
  // 7b. make sure the deals on the list are still for sale (a few per run, oldest check first)
  {
    const fresh = deals.filter((d) => !d.old).map((d) => d.id);
    for (let i = 0; i < fresh.length; i += 90) { const part = fresh.slice(i, i + 90); await D.prepare(`UPDATE deals SET checked=? WHERE id IN (${part.map(() => "?").join(",")})`).bind(now, ...part).run(); }
  }
  report.gone = await verifyDeals(env, 6);

  // remember where each auction deal stood, to learn from its final price later
  try {
    const au = deals.filter((d) => d.type === "AUC" && d.end > now);
    if (au.length) { const snaps = await kvGet(env, "aucSnaps", {}); let add = 0;
      for (const d of au) if (!snaps[d.id] && Object.keys(snaps).length < 400) { snaps[d.id] = [d.cat, d.med, d.price, d.bids || 0, Math.round((d.end - now) / 60000), d.ship || 0, now]; add++; }
      if (add) await kvSet(env, "aucSnaps", snaps); }
  } catch (e) {}
  // 8. followed listings
  await checkFollows(env, cfg);

  // 9. phone alerts for strong new deals
  if (cfg.alerts && env.FCM_SA && !isQuiet(cfg, now)) {
    const rows = await D.prepare("SELECT id, data FROM deals WHERE notified=0 AND score>=? ORDER BY score DESC LIMIT 5").bind(r.alertScore).all();
    for (const row of rows.results || []) {
      const d = JSON.parse(row.data);
      if (d.kind !== "deal") continue;
      const v = await checkLive(env, d.id);
      if (!v.live) continue; // sold or ended since we found it: no alert
      const msg = d.type === "AUC"
        ? `Bid up to £${d.maxBid.toFixed(2)} (now £${d.price.toFixed(2)}). Score ${d.score}.`
        : `£${d.cost.toFixed(2)} now, about £${d.profit.toFixed(0)} profit. Score ${d.score}.`;
      await push(env, d.title.slice(0, 80), msg, { url: d.url, id: d.id, kind: "deal" });
    }
    await D.prepare("UPDATE deals SET notified=1 WHERE notified=0").run();
  }
  else if (isQuiet(cfg, now)) await D.prepare("UPDATE deals SET notified=1 WHERE notified=0").run(); // quiet hours: no catch-up flood in the morning
  await saveQuota(env);
  report.ebayToday = await quota(env);
  await kvSet(env, "lastReport", { at: now, ...report, cats: cats.map((c) => c.name) });
  return report;
}

/* ---------------- FlipScout push alerts (Firebase Cloud Messaging v1) ---------------- */
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));
async function fcmAccess(env) {
  const c = await kvGet(env, "fcmtok", null);
  if (c && c.exp > Date.now()) return c;
  const sa = JSON.parse(env.FCM_SA);
  const iat = Math.floor(Date.now() / 1000);
  const head = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64urlStr(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + body + "." + b64url(sig),
  });
  if (!r.ok) throw new Error("alert sign-in failed (" + r.status + ")");
  const d = await r.json();
  const out = { t: d.access_token, project: sa.project_id, exp: Date.now() + (d.expires_in - 300) * 1000 };
  await kvSet(env, "fcmtok", out);
  return out;
}
async function push(env, title, body, data) {
  if (!env.FCM_SA) return { sent: 0, error: "alerts not set up on the service yet" };
  let devices = await kvGet(env, "devices", []);
  if (!devices.length) return { sent: 0, error: "no phone registered for alerts yet" };
  let tok;
  try { tok = await fcmAccess(env); } catch (e) { return { sent: 0, error: e.message }; }
  let sent = 0;
  const dead = [];
  for (const dv of devices) {
    try {
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${tok.project}/messages:send`, {
        method: "POST",
        headers: { Authorization: "Bearer " + tok.t, "Content-Type": "application/json" },
        body: JSON.stringify({ message: {
          token: dv.t,
          notification: { title, body },
          data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
          android: { priority: "high", notification: { channel_id: "deals", icon: "ic_stat_flipscout", color: "#22c55e", default_sound: true, default_vibrate_timings: true, notification_priority: "PRIORITY_MAX", visibility: "PUBLIC" } },
        } }),
      });
      if (r.ok) sent++;
      else if (r.status === 404 || r.status === 400) dead.push(dv.t);
    } catch (e) {}
  }
  if (dead.length) await kvSet(env, "devices", devices.filter((d) => !dead.includes(d.t)));
  return { sent };
}

/* ---------------- several listings in one call (eBay's getItems is limited to selected partners: try once a day, else one by one) ---------------- */
async function getMany(env, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const ok = await kvGet(env, "multi", null);
  if (!ok || ok.ok || Date.now() - ok.at > DAY) {
    try {
      for (let i = 0; i < ids.length; i += 20) {
        const part = ids.slice(i, i + 20);
        const d = await ebay(env, "/buy/browse/v1/item/?item_ids=" + encodeURIComponent(part.map((id) => `v1|${id}|0`).join(",")));
        for (const it of d.items || []) { const lid = it.legacyItemId || String(it.itemId || "").split("|")[1]; if (lid) out.set(String(lid), it); }
      }
      if (!ok || !ok.ok) await kvSet(env, "multi", { ok: true, at: Date.now() });
      // listings missing from the answer may have ended: check a couple one by one
      for (const id of ids.filter((x) => !out.has(String(x))).slice(0, 2)) { try { out.set(String(id), await ebay(env, `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${id}`)); } catch (e) {} }
      return out;
    } catch (e) { await kvSet(env, "multi", { ok: false, at: Date.now() }); out.clear(); }
  }
  for (const id of ids.slice(0, 6)) { try { out.set(String(id), await ebay(env, `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${id}`)); } catch (e) {} }
  return out;
}

/* ---------------- is a listing still for sale? ---------------- */
async function checkLive(env, id, pre, full) {
  const D = env.DB, now = Date.now();
  let d = pre;
  if (!d) try { d = await ebay(env, `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${id}`); }
  catch (e) { return { live: true, unknown: true }; } // eBay hiccup: don't hide it
  const avail = ((d.estimatedAvailabilities || [])[0] || {}).estimatedAvailabilityStatus;
  const end = d.itemEndDate ? Date.parse(d.itemEndDate) : null;
  const gone = d.notFound || (end && end < now) || avail === "OUT_OF_STOCK";
  if (gone) {
    await D.batch([
      D.prepare("DELETE FROM deals WHERE id=?").bind(id),
      D.prepare("UPDATE listings SET status='gone' WHERE id=? AND type='BIN'").bind(id),
    ]);
    return { live: false };
  }
  const auction = (d.buyingOptions || []).includes("AUCTION") && !(d.buyingOptions || []).includes("FIXED_PRICE");
  const pr = auction && d.currentBidPrice ? d.currentBidPrice : d.price;
  const so = (d.shippingOptions || [])[0];
  const out = { live: true, price: pr ? parseFloat(pr.value) : null, ship: so && so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0, bids: +d.bidCount || 0, end };
  if (full) out.info = listingInfo(d);
  const row = await D.prepare("SELECT data FROM deals WHERE id=?").bind(id).first();
  if (row && out.price != null) {
    const deal = JSON.parse(row.data);
    const tooDear = deal.kind === "deal" && (deal.type === "AUC" ? out.price >= (deal.maxBid || 0) : out.price + out.ship > (deal.maxPay || 0));
    if (tooDear) { await D.prepare("DELETE FROM deals WHERE id=?").bind(id).run(); return { ...out, live: true, tooDear: true }; }
    Object.assign(deal, { price: out.price, ship: out.ship, bids: out.bids, end: out.end || deal.end });
    await D.prepare("UPDATE deals SET data=?, checked=? WHERE id=?").bind(JSON.stringify(deal), now, id).run();
  } else if (row) {
    await D.prepare("UPDATE deals SET checked=? WHERE id=?").bind(now, id).run();
  }
  return out;
}
// what the seller wrote: description, condition notes, item details, photos, returns. Shown on the deal page.
function plainText(h) {
  return String(h || "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&pound;/g, "£")
    .replace(/[ \t]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
}
function listingInfo(d) {
  const desc = plainText(d.description || d.shortDescription).slice(0, 4000);
  const note = String(d.conditionDescription || "").slice(0, 600);
  const words = [...new Set(((note + "\n" + desc).match(RISK_G) || []).map((w) => w.toLowerCase()))].slice(0, 6);
  const rt = d.returnTerms || {}, sl = d.seller || {}, loc = d.itemLocation || {};
  return {
    desc, note, warn: words,
    photos: [d.image, ...(d.additionalImages || [])].filter(Boolean).map((x) => x.imageUrl).filter(Boolean).slice(0, 12),
    specs: (d.localizedAspects || []).slice(0, 20).map((a) => [String(a.name).slice(0, 40), String(a.value).slice(0, 80)]),
    returns: rt.returnsAccepted ? (rt.returnPeriod ? rt.returnPeriod.value + " " + String(rt.returnPeriod.unit || "days").toLowerCase() : "accepted") : rt.returnsAccepted === false ? "none" : null,
    seller: sl.username ? { name: sl.username, pct: parseFloat(sl.feedbackPercentage) || 0, fb: +sl.feedbackScore || 0 } : null,
    where: [loc.city, loc.postalCode].filter(Boolean).join(" "),
  };
}
async function verifyDeals(env, n) {
  // checks the deals checked longest ago (deals in this scan's results already count as checked)
  const multi = await kvGet(env, "multi", null), lim = multi && multi.ok ? 20 : n;
  const rows = await env.DB.prepare("SELECT id FROM deals WHERE expires>? ORDER BY checked ASC, score DESC LIMIT ?").bind(Date.now(), lim).all();
  const ids = (rows.results || []).map((r) => r.id), got = await getMany(env, ids);
  let gone = 0;
  for (const id of ids) {
    if (!got.has(String(id))) continue; // not answered this time
    const v = await checkLive(env, id, got.get(String(id)));
    if (!v.live || v.tooDear) gone++;
  }
  return gone;
}

async function checkFollows(env, cfg) {
  const D = env.DB, now = Date.now();
  const rows = await D.prepare("SELECT id, data, max, alerted FROM follows ORDER BY created DESC LIMIT 10").all();
  for (const row of rows.results || []) {
    const f = JSON.parse(row.data);
    if (f.status === "ended" || f.status === "sold") continue;
    try {
      const d = await ebay(env, `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${row.id}`);
      if (d.notFound) { f.status = "ended"; }
      else {
        const auction = (d.buyingOptions || []).includes("AUCTION") && !(d.buyingOptions || []).includes("FIXED_PRICE");
        const pr = auction && d.currentBidPrice ? d.currentBidPrice : d.price;
        const so = (d.shippingOptions || [])[0];
        f.price = pr ? parseFloat(pr.value) : f.price;
        f.ship = so && so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : f.ship || 0;
        f.bids = +d.bidCount || 0;
        f.end = d.itemEndDate ? Date.parse(d.itemEndDate) : f.end;
        f.type = auction ? "AUC" : "BIN";
        if (d.image && d.image.imageUrl) f.img = d.image.imageUrl;
        if (d.condition) f.cond = d.condition;
        f.status = f.end && f.end < now ? "ended" : "live";
        f.checked = now;
      }
      let alert = "";
      if (f.status === "live") {
        const total = (f.price || 0) + (f.ship || 0);
        if (f.type === "BIN" && total <= row.max && row.alerted !== "under") alert = "under";
        if (f.type === "AUC" && f.end - now < 60 * 60000 && f.price < row.max && row.alerted !== "ending") alert = "ending";
        if (isQuiet(cfg, now)) alert = ""; // quiet hours: not marked as alerted, so it still alerts afterwards if it's still true
      }
      await D.prepare("UPDATE follows SET data=?, alerted=COALESCE(?, alerted) WHERE id=?").bind(JSON.stringify(f), alert || null, row.id).run();
      if (alert && cfg.alerts) {
        await push(env, (f.title || "Followed listing").slice(0, 80),
          alert === "under" ? `Now £${((f.price || 0) + (f.ship || 0)).toFixed(2)}, under your max of £${row.max.toFixed(2)}.`
            : `Ends within the hour. Current bid £${f.price.toFixed(2)}, your max £${row.max.toFixed(2)}.`, { url: f.url, id: row.id, kind: "follow" });
      }
    } catch (e) {}
  }
}

/* ---------------- web requests ---------------- */
export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      const r = await sweep(env, false).catch(() => ({}));
      if (r && r.skipped) await closing(env).catch(() => {});
    })());
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url), P = (k) => u.searchParams.get(k);
    if (!env.APP_KEY || P("key") !== env.APP_KEY) return json({ error: "wrong key" }, 401);

    // ---- hunting (needs the database) ----
    const huntCall = ["config", "deals", "run", "follows", "follow", "unfollow", "test", "device", "check", "price", "prices", "unprice", "needs", "lookfor", "fill", "fillstats"].some((k) => u.searchParams.has(k));
    if (huntCall) {
      if (!env.DB) return json({ error: "hunting database not set up yet" }, 501);
      try {
        await schema(env);
        if (P("config")) {
          if (request.method === "POST") {
            const c = cleanConfig(JSON.parse(await request.text()));
            await kvSet(env, "config", c);
            return json({ ok: true, config: c });
          }
          return json({ config: cleanConfig(await kvGet(env, "config", null)) });
        }
        if (P("run")) {
          const last = await kvGet(env, "lastManual", 0);
          if (Date.now() - last < 45000) return json({ error: "Just scanned. Try again in a minute." }, 429);
          await kvSet(env, "lastManual", Date.now());
          return json(await sweep(env, true));
        }
        if (P("deals")) {
          const rows = await env.DB.prepare("SELECT data, created FROM deals WHERE expires>? ORDER BY score DESC LIMIT 200").bind(Date.now()).all();
          const deals = (rows.results || []).map((r) => ({ ...JSON.parse(r.data), found: r.created }));
          const lc = await kvGet(env, "learnCats", { cats: [] });
          const cnt = (await kvGet(env, "learnedCounts", null)) || (await refreshLearned(env));
          return json({ deals, report: await kvGet(env, "lastReport", null), learned: cnt.byCat, close: await kvGet(env, "close", []), later: await kvGet(env, "later", []), aucLearn: await kvGet(env, "aucLearn", {}), learning: { cats: lc.cats.length, sales: cnt.total } });
        }
        if (P("check")) {
          const id = String(P("check")).replace(/\D/g, "");
          if (!id) return json({ error: "need a listing" }, 400);
          return json(await checkLive(env, id, null, true));
        }
        if (P("price") && request.method === "POST") {
          const b = JSON.parse(await request.text());
          const key = String(b.key || "").slice(0, 200), avg = parseFloat(b.avg);
          if (!key || !(avg > 0 && avg < 100000)) return json({ error: "need the average sold price" }, 400);
          const n = (v, max) => { const x = parseFloat(v); return x >= 0 && x <= max ? x : null; };
          const trend = ["rising", "steady", "falling"].includes(b.trend) ? b.trend : null;
          await env.DB.prepare("INSERT INTO prices (pkey,label,q,avg,st,post,trend,at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pkey) DO UPDATE SET label=excluded.label, q=excluded.q, avg=excluded.avg, st=excluded.st, post=excluded.post, trend=excluded.trend, at=excluded.at")
            .bind(key, String(b.label || "").slice(0, 120), String(b.q || "").slice(0, 400), avg, n(b.st, 100), n(b.post, 500), trend, Date.now()).run();
          return json({ ok: true });
        }
        if (P("lookfor")) {
          // the user typed what they want to price: build the same search FlipScout would
          const text = String(P("lookfor")).replace(/\s+/g, " ").trim().slice(0, 120), cond = P("cond") === "new" ? "new" : "used";
          if (text.length < 2) return json({ error: "Type what you want to price." }, 400);
          const g = groupOf({ title: text }, "", "", cond);
          const key = g ? bareKey(g.key) : "w:" + text.toLowerCase() + "|" + cond;
          const q = lookupQ(text, g && g.match >= 0.6 ? g.key : null);
          const sr = await env.DB.prepare("SELECT price FROM sales WHERE pkey=? AND at>?").bind(key, Date.now() - 30 * DAY).all();
          const sold = (sr.results || []).map((r) => r.price);
          return json({ key, label: bookLabel(g ? g.label : "", text, key), q, url: lookupUrl(q), expect: sold.length >= 3 ? Math.round(median(sold)) : null });
        }
        if (P("fill") && request.method === "POST") {
          // the user read eBay's sold listings for a whole category on their phone: sort them into models and save each model's typical price
          await ensureSrc(env);
          const b = JSON.parse(await request.text());
          return json(await fillPrices(env, b));
        }
        if (P("fillstats")) {
          const fc = await kvGet(env, "fillCats", {}), out = {};
          for (const c in fc) out[c] = fillStat(fc[c]);
          return json({ stats: out });
        }
        if (P("prices")) {
          await ensureSrc(env);
          const rows = await env.DB.prepare("SELECT pkey, label, q, avg, st, post, trend, at, src, n, lo, hi FROM prices ORDER BY at DESC LIMIT 3000").all();
          return json({ prices: (rows.results || []).map((r) => ({ ...r, url: lookupUrl(r.q || ""), fresh: Date.now() - r.at < BOOK_DAYS * DAY })) });
        }
        if (P("unprice")) {
          await env.DB.prepare("DELETE FROM prices WHERE pkey=?").bind(String(P("unprice"))).run();
          return json({ ok: true });
        }
        if (P("needs")) {
          // products seen most often in your categories that have no fresh price book value
          const cfg = cleanConfig(await kvGet(env, "config", null));
          if (!cfg.cats.length) return json({ needs: [] });
          const names = Object.fromEntries(cfg.cats.map((c) => [c.id, c.name]));
          const rows = await env.DB.prepare(`SELECT pkey, MAX(title) AS title, MAX(cat) AS cat, COUNT(*) AS n FROM listings WHERE cat IN (${cfg.cats.map(() => "?").join(",")}) AND pkey IS NOT NULL AND pkey NOT LIKE '%|parts' AND last_seen>? GROUP BY pkey ORDER BY n DESC LIMIT 80`)
            .bind(...cfg.cats.map((c) => c.id), Date.now() - 3 * DAY).all();
          const have = new Set(((await env.DB.prepare("SELECT pkey FROM prices WHERE at>?").bind(Date.now() - BOOK_DAYS * DAY).all()).results || []).map((r) => r.pkey));
          const needs = [];
          for (const r of rows.results || []) {
            if (have.has(r.pkey) || r.n < 3) continue;
            const g = groupOf({ title: r.title }, r.cat, names[r.cat] || "", r.pkey.split("|").pop());
            const q = lookupQ(r.title, r.pkey);
            needs.push({ key: r.pkey, label: bookLabel(g && g.key === r.pkey ? g.label : "", r.title, r.pkey), q, url: lookupUrl(q), seen: r.n, cat: names[r.cat] || "" });
            if (needs.length >= 20) break;
          }
          return json({ needs });
        }
        if (P("follows")) {
          const rows = await env.DB.prepare("SELECT id, data, max, created FROM follows ORDER BY created DESC").all();
          return json({ follows: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), id: r.id, max: r.max, created: r.created })) });
        }
        if (P("follow") && request.method === "POST") {
          const b = JSON.parse(await request.text());
          const id = String(b.id || "").replace(/\D/g, ""), max = parseFloat(b.max);
          if (!id || !(max > 0)) return json({ error: "need a listing and a max price" }, 400);
          const data = { title: String(b.title || "").slice(0, 200), url: "https://www.ebay.co.uk/itm/" + id, type: b.type === "AUC" ? "AUC" : "BIN", price: +b.price || 0, ship: +b.ship || 0, end: +b.end || null, status: "live",
            img: /^https:\/\//.test(String(b.img || "")) ? String(b.img).slice(0, 400) : "", cond: String(b.cond || "").slice(0, 40), med: +b.med || null };
          await env.DB.prepare("INSERT INTO follows (id,data,max,created,alerted) VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET max=excluded.max, alerted=NULL").bind(id, JSON.stringify(data), max, Date.now()).run();
          return json({ ok: true });
        }
        if (P("unfollow")) {
          await env.DB.prepare("DELETE FROM follows WHERE id=?").bind(String(P("unfollow")).replace(/\D/g, "")).run();
          return json({ ok: true });
        }
        if (P("device") && request.method === "POST") {
          const b = JSON.parse(await request.text());
          const t = String(b.token || "").slice(0, 400);
          if (t.length < 20) return json({ error: "bad device token" }, 400);
          let devices = (await kvGet(env, "devices", [])).filter((d) => d.t !== t);
          devices.unshift({ t, at: Date.now(), name: String(b.name || "").slice(0, 60) });
          await kvSet(env, "devices", devices.slice(0, 5));
          return json({ ok: true, devices: Math.min(devices.length, 5), ready: !!env.FCM_SA });
        }
        if (P("test")) {
          // check alerts are possible now, then send the test 10 seconds later so the user can close the app and see a real notification
          if (!env.FCM_SA) return json({ error: "alerts not set up on the service yet" }, 400);
          if (!(await kvGet(env, "devices", [])).length) return json({ error: "no phone registered for alerts yet" }, 400);
          const send = new Promise((res) => setTimeout(res, 10000)).then(() => push(env, "FlipScout test alert", "Alerts are working. Deals will arrive like this.", { kind: "test" }));
          if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send;
          return json({ ok: true, delayed: 10 });
        }
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---- cloud backup ----
    if (P("backup")) {
      if (!env.BACKUP) return json({ error: "cloud backup not set up" }, 501);
      try {
        if (request.method === "POST") {
          const body = await request.text();
          if (body.length > 5000000) return json({ error: "backup too big" }, 413);
          JSON.parse(body);
          const prev = await env.BACKUP.get("backup-v1");
          if (prev) await env.BACKUP.put("backup-prev", prev);
          await env.BACKUP.put("backup-v1", body, { metadata: { at: Date.now() } });
          return json({ ok: true, at: Date.now() });
        }
        const r = await env.BACKUP.getWithMetadata("backup-v1");
        if (!r.value) return json({ none: true });
        return json({ at: (r.metadata && r.metadata.at) || null, data: JSON.parse(r.value) });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---- eBay category list ----
    if (P("tree")) {
      try {
        const token = await getToken(env);
        const r = await fetch("https://api.ebay.com/commerce/taxonomy/v1/category_tree/3", {
          headers: { Authorization: "Bearer " + token, "Accept-Encoding": "gzip" },
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
        if (!r.ok) return json({ error: "category list failed (" + r.status + ")" }, 502);
        return new Response(r.body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", ...CORS } });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    const sug = (P("suggest") || "").trim();
    if (sug) {
      try {
        const d = await ebay(env, "/commerce/taxonomy/v1/category_tree/3/get_category_suggestions?q=" + encodeURIComponent(sug));
        const cats = (d.categorySuggestions || []).slice(0, 8).map((c) => ({
          id: c.category.categoryId,
          name: c.category.categoryName,
          path: (c.categoryTreeNodeAncestors || []).map((a) => a.categoryName).reverse().concat(c.category.categoryName).join(" › "),
        }));
        return json({ cats });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // ---- one-off keyword search ----
    const q = (P("q") || "").trim();
    if (!q) return json({ error: "no search words" }, 400);
    const max = Math.max(1, parseFloat(P("max")) || 50);
    const cat = (P("cat") || "").replace(/[^0-9]/g, "");
    const filters = [`price:[..${max}]`, "priceCurrency:GBP", "buyingOptions:{FIXED_PRICE|AUCTION}", "deliveryCountry:GB"];
    if (P("region") !== "any") filters.push("itemLocationCountry:GB");
    try {
      const d = await ebay(env, "/buy/browse/v1/item_summary/search?limit=100&q=" + encodeURIComponent(q) + (cat ? "&category_ids=" + cat : "") + "&filter=" + encodeURIComponent(filters.join(",")));
      const items = (d.itemSummaries || []).map((it) => {
        const auction = (it.buyingOptions || []).includes("AUCTION") && !(it.buyingOptions || []).includes("FIXED_PRICE");
        const pr = auction && it.currentBidPrice ? it.currentBidPrice : it.price;
        const so = (it.shippingOptions || [])[0];
        const id = it.legacyItemId || (it.itemId || "").split("|")[1];
        return {
          title: it.title || "", price: pr ? parseFloat(pr.value) : 0,
          ship: so && so.shippingCost ? parseFloat(so.shippingCost.value) : 0,
          cond: it.condition || "", auction, end: it.itemEndDate || null,
          loc: (it.itemLocation && it.itemLocation.country) || "",
          url: id ? "https://www.ebay.co.uk/itm/" + id : it.itemWebUrl,
        };
      });
      return json({ items });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
