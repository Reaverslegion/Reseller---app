// FlipScout service: app <-> this worker <-> eBay Browse API (eBay UK)
// Secrets: APP_KEY, EBAY_ID, EBAY_SECRET.  Bindings (set by the deploy workflow): DB (D1), BACKUP (KV)
// Runs every 5 minutes (cron) to hunt for deals in the user's categories, learn sold prices from
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

let TOKEN = null, TOKEN_EXP = 0, SCHEMA = false;
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
    D.prepare("CREATE INDEX IF NOT EXISTS li_key ON listings(pkey)"),
    D.prepare("CREATE TABLE IF NOT EXISTS sales (id TEXT PRIMARY KEY, pkey TEXT, cat TEXT, price REAL, kind TEXT, at INTEGER)"),
    D.prepare("CREATE INDEX IF NOT EXISTS sa_key ON sales(pkey, at)"),
    D.prepare("CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, data TEXT, score INTEGER, created INTEGER, expires INTEGER, notified INTEGER DEFAULT 0)"),
    D.prepare("CREATE TABLE IF NOT EXISTS follows (id TEXT PRIMARY KEY, data TEXT, max REAL, created INTEGER, alerted TEXT)"),
  ]);
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
  return Math.min(N - r.minProfit, (N - k * r.pack) / (1 + k), low - sellFee(low, r) - out - 0.01);
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
function consoleKey(t) {
  if (ACCESSORY.test(t) || (/\b(game|games only|disc only|controller|dualsense|dualshock|joy-?cons?|headset|pro controller|faceplate|shell)\b/i.test(t) && !/\b(console|with|\+|inc|includes?|bundle)\b/i.test(t))) return null;
  const l = t.toLowerCase(); let m, k = null;
  if ((m = l.match(/\b(ps5|playstation\s*5)\b/))) k = "ps5 " + (/\bpro\b/.test(l) ? "pro" : /digital/.test(l) ? "digital" : "disc") + (/\bslim\b/.test(l) ? " slim" : "");
  else if ((m = l.match(/\b(ps4|playstation\s*4)\b/))) k = "ps4" + (/\bpro\b/.test(l) ? " pro" : /\bslim\b/.test(l) ? " slim" : "");
  else if ((m = l.match(/\bxbox\s*series\s*(x|s)\b/))) k = "xbox series " + m[1];
  else if ((m = l.match(/\bxbox\s*one\s*(x|s)?\b/))) k = "xbox one" + (m[1] ? " " + m[1] : "");
  else if ((m = l.match(/\bnintendo\s*switch\b|\bswitch\s*(oled|lite)\b/))) k = "switch" + (/\boled\b/.test(l) ? " oled" : /\blite\b/.test(l) ? " lite" : /\bswitch\s*2\b/.test(l) ? " 2" : "");
  else if ((m = l.match(/\bsteam\s*deck\b/))) k = "steam deck" + (/\boled\b/.test(l) ? " oled" : "") + ((m = l.match(/\b(64|256|512)\s*gb\b/)) ? " " + m[1] : "") + (/\b1\s*tb\b/.test(l) ? " 1tb" : "");
  if (!k) return null;
  return { key: "con:" + k, label: k.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Ps/, "PS").replace("Oled", "OLED"), match: 0.9 };
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

function groupOf(it, cat, catName, bucket) {
  const title = it.title || "";
  const lapCat = /laptop|netbook|notebook/i.test(catName || "") || cat === "177" || cat === "111422";
  let g = null;
  if (lapCat || LAPTOP_RE.test(title)) g = laptopKey(title);
  if (!g && !lapCat) g = gpuKey(title) || phoneKey(title) || consoleKey(title) || tabletKey(title) || cpuKey(title, catName) || ramKey(title, catName) || storageKey(title, catName) || monitorKey(title, catName);
  if (g) return { key: g.key + "|" + bucket, label: g.label, match: g.match };
  if (it.epid) return { key: "e" + it.epid + "|" + bucket, label: "Same eBay product", match: 1 };
  const s = sig(title);
  return s ? { key: "t" + cat + ":" + s + "|" + bucket, label: "Similar title", match: s.split(" ").length >= 2 ? 0.7 : 0.45 } : null;
}

/* ---------------- what the hunter avoids ---------------- */
const RISK_WORDS = /\b(box only|empty box|read desc|read description|photo of|picture of|image of|replica|fake|not genuine|dummy|display only|case only|cover only|manual only|cable only|stand only|bundle only|no console|card only|for parts|spares|repairs?|faulty|broken|cracked|not working|untested|bios lock|icloud|activation lock|locked|blacklisted|no power|water damage|liquid damage)\b/i;
const SCAM_WORDS = /\b(read desc|read description|photo of|picture of|image of|empty box|box only|replica|fake|not genuine|contact me|message me before|whatsapp|bank transfer)\b/i;
const MISSPELT = /\b(nvidea|nvida|nvdia|geforse|gefroce|playstaion|playsation|plastation|playstatio|nintedo|nintndo|nitendo|xobx|xbxo|iphne|iphome|ipohne|samsng|samsumg|sumsung|macbok|mackbook|macbbok|thinkpda|lenova|lenvo|hewlet|cannon eos|nikkon|dysen|delonghi|de longhi|airpod pro|sonos|bose|playstation 4 pro|ps4 pro|ps5 disc|xbox seris|xbox sereis|apple watc|ipda|ipadd|gopro hreo|go pro|dyosn|kitchen aid|lego technic)\b/i;
const MIS_ONLY = /\b(nvidea|nvida|nvdia|geforse|gefroce|playstaion|playsation|plastation|playstatio|nintedo|nintndo|nitendo|xobx|xbxo|iphne|iphome|ipohne|samsng|samsumg|sumsung|macbok|mackbook|macbbok|thinkpda|lenova|lenvo|hewlet|nikkon|dysen|xbox seris|xbox sereis|apple watc|ipda|ipadd|gopro hreo|dyosn)\b/i;

function ukHour(ts) {
  try { return +new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: "Europe/London" }).format(new Date(ts)); }
  catch (e) { return new Date(ts).getUTCHours(); }
}

/* ---------------- the hunt ---------------- */
const DEFAULT_RULES = { minProfit: 15, minRoi: 30, seller: "business", feePct: 12.8, feeFixed: 0.4, post: 5, pack: 1, bpf: true, alertScore: 70, minScore: 40 };
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
  };
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
  // 1. auctions that have ended become sold prices (only if they had bids)
  await D.batch([
    D.prepare("INSERT OR IGNORE INTO sales (id,pkey,cat,price,kind,at) SELECT id,pkey,cat,price+ship,'auction',end_at FROM listings WHERE status='live' AND type='AUC' AND end_at<? AND bids>0 AND pkey IS NOT NULL").bind(now),
    D.prepare("UPDATE listings SET status='ended' WHERE status='live' AND type='AUC' AND end_at<?").bind(now),
    D.prepare("UPDATE listings SET status='stale' WHERE status='live' AND type='BIN' AND last_seen<?").bind(now - 3 * DAY),
    D.prepare("DELETE FROM listings WHERE last_seen<?").bind(now - 40 * DAY),
    D.prepare("DELETE FROM sales WHERE at<?").bind(now - 120 * DAY),
    D.prepare("DELETE FROM deals WHERE expires<?").bind(now),
  ]);

  // 2. which categories this run (rotate so every category gets its turn)
  let rot = await kvGet(env, "rot", 0);
  const per = manual ? Math.min(cfg.cats.length, 6) : Math.min(cfg.cats.length, 4);
  const cats = [];
  for (let i = 0; i < per; i++) cats.push(cfg.cats[(rot + i) % cfg.cats.length]);
  await kvSet(env, "rot", (rot + per) % cfg.cats.length);

  const base = ["priceCurrency:GBP", "deliveryCountry:GB", "price:[1..3000]"];
  if (cfg.region === "uk") base.push("itemLocationCountry:GB");
  const seen = [];
  for (const c of cats) {
    const calls = [];
    if (cfg.types.bin || cfg.types.misspelt || cfg.types.spares) calls.push(["BIN", "buyingOptions:{FIXED_PRICE}", "newlyListed"]);
    if (cfg.types.auction || cfg.types.spares) calls.push(["AUC", "buyingOptions:{AUCTION}", "endingSoonest"]);
    for (const [type, f, sort] of calls) {
      try {
        const d = await ebay(env, `/buy/browse/v1/item_summary/search?category_ids=${c.id}&limit=50&sort=${sort}&filter=${encodeURIComponent([...base, f].join(","))}`);
        for (const it of d.itemSummaries || []) {
          const id = it.legacyItemId || String(it.itemId || "").split("|")[1];
          if (!id) continue;
          const auction = type === "AUC";
          const pr = auction && it.currentBidPrice ? it.currentBidPrice : it.price;
          const price = pr ? parseFloat(pr.value) : 0;
          const so = (it.shippingOptions || [])[0];
          const ship = so && so.shippingCost ? parseFloat(so.shippingCost.value) || 0 : 0;
          const bucket = condBucket(it.conditionId);
          seen.push({
            id, cat: c.id, catName: c.name, title: it.title || "", cond: it.condition || "", condId: it.conditionId || "", bucket,
            type, price, ship, bids: +it.bidCount || 0, end: it.itemEndDate ? Date.parse(it.itemEndDate) : null,
            created: it.itemCreationDate ? Date.parse(it.itemCreationDate) : null,
            seller: it.seller ? { name: it.seller.username || "", fb: +it.seller.feedbackScore || 0, pct: parseFloat(it.seller.feedbackPercentage) || 0 } : { name: "", fb: 0, pct: 0 },
            loc: (it.itemLocation && it.itemLocation.country) || "", img: it.image ? it.image.imageUrl : "",
            url: "https://www.ebay.co.uk/itm/" + id, bestOffer: (it.buyingOptions || []).includes("BEST_OFFER"),
            ...(() => { const g = groupOf(it, c.id, c.name, bucket), w = groupOf(it, c.id, c.name, "used"); return { pkey: g ? g.key : null, matchLabel: g ? g.label : "", matchQ: g ? g.match : 0, workKey: w ? w.key : null, workQ: w ? w.match : 0 }; })(),
          });
        }
        report.checked++;
      } catch (e) { report.errors.push(c.name + ": " + e.message); }
    }
  }
  if (!seen.length) { await kvSet(env, "lastReport", { at: now, ...report }); return report; }

  // 3. remember everything we saw (this builds the sold history over time)
  const firstSeen = {};
  const ids = seen.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await D.prepare(`SELECT id, first_seen FROM listings WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const row of rows.results || []) firstSeen[row.id] = row.first_seen;
  }
  const up = seen.map((s) => D.prepare(
    "INSERT INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'live') ON CONFLICT(id) DO UPDATE SET price=excluded.price, ship=excluded.ship, bids=excluded.bids, last_seen=excluded.last_seen, end_at=excluded.end_at, status='live'"
  ).bind(s.id, s.cat, s.pkey, s.title.slice(0, 200), s.bucket, s.type, s.price, s.ship, s.bids, s.end, s.created || now, now));
  for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));

  // 4. market price for each product group: sold history first, asking prices as a fallback
  const keys = [...new Set(seen.flatMap((s) => [s.pkey, s.workKey]).filter(Boolean))];
  const soldBy = {}, askBy = {};
  for (let i = 0; i < keys.length; i += 90) {
    const chunk = keys.slice(i, i + 90), q = chunk.map(() => "?").join(",");
    const sr = await D.prepare(`SELECT pkey, price FROM sales WHERE pkey IN (${q}) AND at>?`).bind(...chunk, now - 30 * DAY).all();
    for (const row of sr.results || []) (soldBy[row.pkey] = soldBy[row.pkey] || []).push(row.price);
    const ar = await D.prepare(`SELECT pkey, id, price+ship AS t FROM listings WHERE pkey IN (${q}) AND type='BIN' AND status='live' AND last_seen>?`).bind(...chunk, now - 2 * DAY).all();
    for (const row of ar.results || []) (askBy[row.pkey] = askBy[row.pkey] || []).push([row.id, row.t]);
  }
  // Looser matches (e.g. "similar title") need more evidence before we trust a price.
  function trim(a) {
    if (a.length < 5) return a;
    const m = median(a);
    return a.filter((x) => x >= m * 0.4 && x <= m * 2.5);
  }
  function market(key, selfId, q = 0.5) {
    if (!key) return null;
    const needSold = q >= 0.8 ? 3 : q >= 0.6 ? 5 : 8;
    const sold = trim((soldBy[key] || []).filter((x) => x > 0));
    if (sold.length >= needSold) {
      const med = median(sold), low = pct(sold, 0.25), iqr = pct(sold, 0.75) - low;
      return { med, low, n: sold.length, src: "sold", spread: med ? iqr / med : 1 };
    }
    if (q < 0.65) return null; // asking prices are too noisy for loose matches
    const ask = trim((askBy[key] || []).filter(([id]) => id !== selfId).map(([, t]) => t).filter((x) => x > 0));
    if (ask.length >= (q >= 0.8 ? 4 : 6)) {
      const med = pct(ask, 0.3) * 0.95, low = pct(ask, 0.1) * 0.95;
      return { med, low, n: ask.length, src: "asking", spread: med ? (pct(ask, 0.75) - pct(ask, 0.25)) / med : 1 };
    }
    return null;
  }

  // 5. judge each listing
  const deals = [], spares = [];
  let hidden = 0;
  for (const s of seen) {
    const extra = r.bpf ? bpf(s.price) : 0;
    if (s.bucket === "parts") {
      if (!cfg.types.spares) continue;
      const m = market(s.workKey, s.id, s.workQ || 0.5);
      if (!m || s.price + s.ship > m.med * 0.6) continue;
      if (SCAM_WORDS.test(s.title)) { hidden++; continue; }
      spares.push({ ...s, kind: "spares", tags: [], score: 0, cost: Math.round((s.price + s.ship + extra) * 100) / 100, workMed: Math.round(m.med), n: m.n, src: m.src });
      continue;
    }
    if (RISK_WORDS.test(s.title)) continue;
    const m = market(s.pkey, s.id, s.matchQ || 0.5);
    if (!m) continue;
    if (m.spread > 0.9 && (s.matchQ || 0.5) < 0.8) continue; // prices all over the place: not confident
    const cost = s.price + s.ship + extra;
    if (cost < m.med * 0.4 && (s.seller.fb < 5 || s.seller.pct < 95 || SCAM_WORDS.test(s.title))) { hidden++; continue; }
    if (SCAM_WORDS.test(s.title)) { hidden++; continue; }
    const mp = maxPay(m.med, m.low, r);
    if (mp <= 0) continue;
    const out = r.post + r.pack;
    const profit = m.med - sellFee(m.med, r) - out - cost;
    const lowProfit = m.low - sellFee(m.low, r) - out - cost;
    const roi = cost + r.pack > 0 ? (profit / (cost + r.pack)) * 100 : 0;
    const misspelt = MIS_ONLY.test(s.title);
    const tags = [];
    let ok = false, maxBid = null;
    if (s.type === "BIN") {
      if (!(cfg.types.bin || (cfg.types.misspelt && misspelt))) continue;
      ok = profit >= r.minProfit && roi >= r.minRoi;
      const age = now - (s.created || firstSeen[s.id] || now);
      if (age < 60 * 60000) tags.push("New listing");
    } else {
      if (!cfg.types.auction) continue;
      if (!s.end || s.end - now > 12 * 3600e3) continue;
      maxBid = Math.floor((mp - s.ship - (r.bpf ? bpf(mp) : 0)) * 100) / 100;
      ok = maxBid > s.price;
      const h = ukHour(s.end);
      if (h >= 0 && h < 6) tags.push("Ends overnight");
      if (s.bids <= 2) tags.push(s.bids ? s.bids + " bid" + (s.bids > 1 ? "s" : "") : "No bids yet");
    }
    if (!ok) continue;
    if (misspelt) tags.push("Misspelt title");
    if (s.bestOffer) tags.push("Best Offer");
    if (s.loc && s.loc !== "GB") tags.push("Ships from " + s.loc);

    // confidence score, built from parts the user can see
    const ev = (m.src === "sold" ? Math.min(1, m.n / 10) : Math.min(0.5, m.n / 16)) * Math.max(0.3, 1 - Math.min(1, m.spread));
    const match = s.matchQ || 0.5;
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
    const score = Math.round(30 * ev + 20 * match + 15 * sel + 20 * mar + 15 * comp);
    if (score < r.minScore) continue;
    deals.push({
      ...s, kind: "deal", cost: Math.round(cost * 100) / 100, extra: Math.round(extra * 100) / 100,
      profit: Math.round(profit * 100) / 100, lowProfit: Math.round(lowProfit * 100) / 100, roi: Math.round(roi),
      maxPay: Math.floor(mp * 100) / 100, maxBid, med: Math.round(m.med * 100) / 100, low: Math.round(m.low * 100) / 100,
      n: m.n, src: m.src, score, parts: { evidence: ev, match, seller: sel, margin: mar, competition: comp }, tags,
      sellFee: Math.round(sellFee(m.med, r) * 100) / 100, out: r.post + r.pack,
    });
  }
  report.hidden = hidden;

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
    ).bind(d.id, JSON.stringify(d), d.score || 0, now, d.type === "AUC" && d.end ? d.end : now + 2 * DAY));
    for (let i = 0; i < st.length; i += 50) await D.batch(st.slice(i, i + 50));
    report.newDeals = all.filter((d) => !existing[d.id]).length;
  }
  // deals that went over our price or vanished from the latest results for their category stay until they expire

  // 8. followed listings
  await checkFollows(env, cfg);

  // 9. phone alerts for strong new deals
  if (cfg.alerts && env.FCM_SA) {
    const rows = await D.prepare("SELECT id, data FROM deals WHERE notified=0 AND score>=? ORDER BY score DESC LIMIT 5").bind(r.alertScore).all();
    for (const row of rows.results || []) {
      const d = JSON.parse(row.data);
      if (d.kind !== "deal") continue;
      const msg = d.type === "AUC"
        ? `Bid up to £${d.maxBid.toFixed(2)} (now £${d.price.toFixed(2)}). Score ${d.score}.`
        : `£${d.cost.toFixed(2)} now, about £${d.profit.toFixed(0)} profit. Score ${d.score}.`;
      await push(env, d.title.slice(0, 80), msg, { url: d.url, id: d.id, kind: "deal" });
    }
    await D.prepare("UPDATE deals SET notified=1 WHERE notified=0").run();
  }
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
        f.status = f.end && f.end < now ? "ended" : "live";
        f.checked = now;
      }
      let alert = "";
      if (f.status === "live") {
        const total = (f.price || 0) + (f.ship || 0);
        if (f.type === "BIN" && total <= row.max && row.alerted !== "under") alert = "under";
        if (f.type === "AUC" && f.end - now < 60 * 60000 && f.price < row.max && row.alerted !== "ending") alert = "ending";
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
    if (env.DB) ctx.waitUntil(sweep(env, false).catch(() => {}));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url), P = (k) => u.searchParams.get(k);
    if (!env.APP_KEY || P("key") !== env.APP_KEY) return json({ error: "wrong key" }, 401);

    // ---- hunting (needs the database) ----
    const huntCall = ["config", "deals", "run", "follows", "follow", "unfollow", "test", "device"].some((k) => u.searchParams.has(k));
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
          const learned = await env.DB.prepare("SELECT cat, COUNT(*) AS n FROM sales GROUP BY cat").all();
          return json({ deals, report: await kvGet(env, "lastReport", null), learned: learned.results || [] });
        }
        if (P("follows")) {
          const rows = await env.DB.prepare("SELECT id, data, max, created FROM follows ORDER BY created DESC").all();
          return json({ follows: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), id: r.id, max: r.max, created: r.created })) });
        }
        if (P("follow") && request.method === "POST") {
          const b = JSON.parse(await request.text());
          const id = String(b.id || "").replace(/\D/g, ""), max = parseFloat(b.max);
          if (!id || !(max > 0)) return json({ error: "need a listing and a max price" }, 400);
          const data = { title: String(b.title || "").slice(0, 200), url: "https://www.ebay.co.uk/itm/" + id, type: b.type === "AUC" ? "AUC" : "BIN", price: +b.price || 0, ship: +b.ship || 0, end: +b.end || null, status: "live" };
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
