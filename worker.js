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
// compares the app key in constant time, so its length or letters can't be guessed from how fast "wrong key" comes back
function sameKey(a, b) {
  a = String(a || ""); b = String(b || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ b.charCodeAt(i);
  return diff === 0 && a.length > 0;
}
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400", // the phone asks "may I send the key header?" once a day, not before every call
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
  const res = await xfetch(env, "https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(env.EBAY_ID + ":" + env.EBAY_SECRET),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) throw new Error("eBay login failed (" + res.status + ")");
  const d = await timedBody(env, res.json());
  TOKEN = d.access_token;
  TOKEN_EXP = Date.now() + (d.expires_in - 300) * 1000;
  if (env.DB) { try { await kvSet(env, "token", { t: TOKEN, exp: TOKEN_EXP }); } catch (e) {} }
  return TOKEN;
}
async function ebay(env, path) {
  const token = await getToken(env);
  // counted only if it really goes to eBay (a call the scan's time limits refused never leaves the Scan service)
  let r; try { r = await xfetch(env, "https://api.ebay.com" + path, {
    headers: {
      Authorization: "Bearer " + token,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_GB",
      "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=GB",
    },
  }); } catch (e) { if (!e.scanBudget && !e.scanStop) CALLS++; throw e; }
  CALLS++;
  if (r.status === 404) return { notFound: true };
  if (!r.ok) throw new Error("eBay request failed (" + r.status + ")");
  return timedBody(env, r.json());
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
    // deals a user flagged as wrong (wrong model, bad price, faulty, scam): a snapshot of the deal as it was shown, for fixing the cause
    D.prepare("CREATE TABLE IF NOT EXISTS flags (deal_id TEXT PRIMARY KEY, reason TEXT, data TEXT, at INTEGER)"),
    // price book: values users read off eBay's research page and type in, one row per product group
    D.prepare("CREATE TABLE IF NOT EXISTS fillsales (pkey TEXT PRIMARY KEY, data TEXT, at INTEGER)"),
    D.prepare("CREATE TABLE IF NOT EXISTS prices (pkey TEXT PRIMARY KEY, label TEXT, q TEXT, avg REAL, st REAL, post REAL, trend TEXT, at INTEGER)"),
  ]);
  // deal diary: what FlipScout predicted the first time it showed each deal. Never updated, so it can be checked later against what really sold.
  // Separate from the batch above so a problem here can never stop the main tables being set up.
  try {
    await D.batch([
      D.prepare(`CREATE TABLE IF NOT EXISTS ${DIARY_COLS.table} (${DIARY_COLS.cols.map((c, i) => c + (i ? "" : " TEXT PRIMARY KEY")).join(", ")})`),
      D.prepare(`CREATE INDEX IF NOT EXISTS dl_at ON ${DIARY_COLS.table}(at)`),
    ]);
  } catch (e) { /* diary is optional */ }
  // every sold item a fill has read (matched to a model or not), by eBay item number: tells the next fill which sales are
  // already saved, and is matched against listings FlipScout saw for sale to learn how long they took to sell
  try { await D.prepare("CREATE TABLE IF NOT EXISTS deal_out (id TEXT PRIMARY KEY, at INTEGER, why TEXT, price REAL, title TEXT)").run(); } catch (e) {}
  try { await D.prepare("CREATE TABLE IF NOT EXISTS fillseen (id TEXT PRIMARY KEY, cat TEXT, price REAL, at INTEGER)").run(); } catch (e) {}
  for (const sql of ["ALTER TABLE listings ADD COLUMN data TEXT", "ALTER TABLE deals ADD COLUMN checked INTEGER DEFAULT 0",
    "ALTER TABLE listings ADD COLUMN sold_at INTEGER", "ALTER TABLE listings ADD COLUMN sold_price REAL", "ALTER TABLE listings ADD COLUMN ended_at INTEGER", "ALTER TABLE listings ADD COLUMN ended_from INTEGER",
    "ALTER TABLE fillseen ADD COLUMN title TEXT", "ALTER TABLE fillseen ADD COLUMN cond TEXT", "ALTER TABLE fillseen ADD COLUMN pkey TEXT",
    // sold details from eBay's Trading API (GetItem): when it was listed, seller, format, quantities, when looked up (0 = not found)
    "ALTER TABLE fillseen ADD COLUMN start_at INTEGER", "ALTER TABLE fillseen ADD COLUMN seller TEXT", "ALTER TABLE fillseen ADD COLUMN fmt TEXT",
    "ALTER TABLE fillseen ADD COLUMN qty INTEGER", "ALTER TABLE fillseen ADD COLUMN qty_sold INTEGER", "ALTER TABLE fillseen ADD COLUMN gi_at INTEGER"]) {
    try { await D.prepare(sql).run(); } catch (e) { /* column already there */ }
  }
  // the price book's extra columns (source, sales count, range, sell speed, stock): on a brand-new database they were only
  // added by the first Fill, so the sales list and stock check failed until then ("no such column: lo")
  await ensureSrc(env);
  SCHEMA = true;
}
async function kvGet(env, k, def) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  return r ? JSON.parse(r.v) : def;
}
async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, JSON.stringify(v)).run();
}

/* ---------------- deal diary ---------------- */
// One row per deal, written once (the first time it's shown). Outcomes are matched later by item id
// against sales (auctions), fillsales (sold pages) and listings, so nothing here ever needs updating.
const DIARY_COLS = { table: "deal_log", cols: ["id", "at", "cat", "pkey", "type", "cond", "title", "price", "ship", "cost", "med", "low", "lo", "hi", "src", "n", "book_n", "profit", "low_profit", "max_pay", "max_bid", "score", "end_at", "biz"] };
function diaryRow(d, now) {
  const n = (v) => (v == null || !isFinite(+v) ? null : +v);
  return [String(d.id), now, String(d.cat || ""), d.pkey || null, d.type || null, d.bucket || null, String(d.title || "").slice(0, 200),
    n(d.price), n(d.ship), n(d.cost), n(d.med), n(d.low), n(d.rangeLo), n(d.rangeHi), d.src || null, n(d.n), n(d.bookN),
    n(d.profit), n(d.lowProfit), n(d.maxPay), n(d.maxBid), n(d.score), n(d.end), d.seller && d.seller.biz ? 1 : 0];
}

/* ---------------- money maths ---------------- */
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * p, l = Math.floor(i), h = Math.ceil(i); return s[l] + (s[h] - s[l]) * (i - l); };
function sellFee(x, r) { return r.seller === "private" ? 0 : x * r.feePct / 100 + (x > 10 ? r.feeFixed : Math.min(r.feeFixed, 0.3)); }
// UK buyer protection fee on private sellers' items (estimate: £0.10 + 7% to £20, 4% to £300, 2% to £4,000)
// work a stored deal's money out again after its price or postage changed (same sums as judging it; see sweep step 5).
// The selling price it's compared with (med/low) and the postage out stay as judged.
function reprice(d, r, oldShip) {
  const r2 = (x) => Math.round(x * 100) / 100, fee = (p) => (d.bpfOn ? bpf(p) : 0), out = d.out != null ? d.out : (r.post + r.pack), sf = (x) => sellFee(x, r);
  d.extra = r2(fee(d.price)); d.cost = r2(d.price + d.ship + d.extra);
  d.profit = r2(d.med - sf(d.med) - out - d.cost);
  if (d.low != null) d.lowProfit = r2(d.low - sf(d.low) - out - d.cost);
  d.roi = d.cost + r.pack > 0 ? Math.round((d.profit / (d.cost + r.pack)) * 100) : 0;
  if (d.type === "AUC") {
    if (d.maxBid != null && oldShip != null && oldShip !== d.ship) d.maxBid = Math.floor((d.maxBid + oldShip - d.ship) * 100) / 100; // more postage, lower max bid
    d.maxItem = d.maxBid;
  } else if (d.maxPay != null) d.maxItem = Math.floor((d.maxPay - d.ship - fee(d.maxPay)) * 100) / 100;
  const it = d.type === "AUC" ? d.maxBid : d.maxItem;
  if (it != null) d.profitAtMax = r2(d.med - sf(d.med) - out - (it + d.ship + fee(it)));
  d.repricedAt = Date.now();
  return d;
}
function bpf(p) { return 0.1 + Math.min(p, 20) * 0.07 + Math.max(0, Math.min(p, 300) - 20) * 0.04 + Math.max(0, Math.min(p, 4000) - 300) * 0.02; }
function maxPay(med, low, r) {
  const out = r.post + r.pack, N = med - sellFee(med, r) - out, k = r.minRoi / 100;
  // "cheap" (on by default): also never lose money if it only sells at the cheap end
  return Math.min(N - r.minProfit, (N - k * r.pack) / (1 + k), r.cheap === false ? Infinity : low - sellFee(low, r) - out - 0.01);
}

/* ---------------- grouping comparable items (by spec, not brand) ---------------- */
const MODS = new Set(["ti", "super", "pro", "max", "plus", "mini", "lite", "oled", "xl", "ultra", "slim", "air", "se", "disc", "digital", "fe"]);
function condBucket(id) { const n = +id || 0; if (n >= 7000) return "parts"; if (n && n < 2000) return "new"; return "used"; }
// sizes, units and generations ("32gb", "144hz", "10th") — none of them names a product on its own
const UNIT_TOKEN = /^\d+(?:\.\d+)?(gb|tb|mb|mah|hz|khz|mhz|ghz|w|v|mm|cm|m|in|inch|inches|p|k|mp|fps|ms|rpm|pcs|pc|pack|x|g|kg|ml|l|st|nd|rd|th)$/;
// connection/standard names ("sata3", "pcie4", "usb3", "gddr6") describe a spec, not a product
const SPEC_TOKEN = /^(sata|pcie|gen|usb|ddr|lpddr|gddr|hdmi|dp|wifi|ip|bt|lte|nvme)\d/;
// big no-name SSDs are a common fake-capacity scam
const FAKE_SSD = (t) => /\b([2-9]|1\d|[2-9]\d)\s*tb\b/i.test(t) && /\b(ssd|nvme|solid state)\b/i.test(t) && !SSD_BRANDS.test(t);
const QTY_RE = /\b(pair of|matched pair|lot of \d|set of [2-9]|(?:[2-9]\s?|\d{2,}\s)x\s(?!\d+\s?gb)|x\s?[2-9]\b|\(x[2-9]\))/i;
function sig(title) {
  // prices in a title ("for £20") are not model names
  const t = String(title || "").toLowerCase().replace(/[£$€]\s?\d+(?:[.,]\d+)?/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\b([a-z]{2,})\s+(\d{1,2})\b(?!\s*(gb|tb|mb|inch|in|cm|mm|pcs|pack|x)\b)/g, "$1$2").split(/\s+/).filter(Boolean);
  // several items in one listing ("pair of", "2x", "x2"): the price is for more than one, so never compare with single items
  if (QTY_RE.test(String(title || ""))) return "";
  const keep = t.filter((w) => (/\d/.test(w) && w.length >= 2 && !/^\d{1,2}$/.test(w) && !/^\d+(x|pcs|pc|pack)$/.test(w) && !/^x\d+$/.test(w)
    && !/^(uk|eu|us|size|sz)\d+(\.5)?$/.test(w)) || MODS.has(w)); // shoe sizes ("uk9") aren't model names
  // sizes and units ("32gb", "144hz", "5000mah") say nothing about which product it is: without at least one real
  // model code ("rvl001", "75192", "sm-x110"), titles can't be grouped (all "32GB" tablets were being priced together)
  if (!keep.some((w) => /\d/.test(w) && !UNIT_TOKEN.test(w) && !SPEC_TOKEN.test(w))) return "";
  // one word alone must be a real model code ("rvl001", "75192"), not a platform or short number ("ps3", "360")
  const uniq = [...new Set(keep)];
  if (uniq.length === 1 && !((/[a-z]/.test(uniq[0]) && uniq[0].length >= 5) || /^\d{4,}$/.test(uniq[0]))) return "";
  return uniq.sort().join(" ");
}
const LAPTOP_RE = /\b(laptop|notebook|macbook|chromebook|thinkpad|elitebook|probook|latitude|ideapad|thinkbook|zenbook|vivobook|inspiron|vostro|surface laptop|galaxy book|ultrabook)\b/i;
const NOT_A_CARD = /\b(precision \d{4}|n1[5-9][a-z]-|for dell|mobile|mxm|gpu chip|gpu module|bga|laptop|notebook|desktop|tower|gaming pc|pc build|full pc|computer|ssd|hdd|ram|i[3579][\s-]?\d|ryzen|bundle|job ?lot|joblot|pair of|waterblock|water block|heatsink|backplate|heat ?sinks?|fans? only|fun only|replacement fans?|fans? for|cooler only|cooler for|gaming ?pro cooler|bracket|riser|cable|box only|empty box)\b/i;
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
const ordinal = (n) => { n = +n; const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"; return n + s; };
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
    // 5 digits (10210U) or 4 digits starting with 1 (1035G1, 1135G7, 1235U) = 10th gen and later; else the first digit (8250U = 8th)
    const gen = m[2].length === 5 || m[2][0] === "1" ? m[2].slice(0, 2) : m[2][0];
    if (+gen > 15) return null; // a typo, not a real generation
    cpu = `intel-i${m[1]}-g${gen}`; cpuL = `Intel i${m[1]} ${ordinal(gen)} gen`;
  } else if ((m = t.match(/\bi([3579])\b.*?\b(\d{1,2})(?:st|nd|rd|th)\s*gen/)) || (m = t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*gen\b.*?\bi([3579])\b/))) {
    const a = /^\d{1,2}$/.test(m[1]) && /gen/.test(t.slice(t.indexOf(m[1]), t.indexOf(m[1]) + 8)) ? [m[2], m[1]] : [m[1], m[2]];
    cpu = `intel-i${a[0]}-g${a[1]}`; cpuL = `Intel i${a[0]} ${ordinal(a[1])} gen`;
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
  const l = t.toLowerCase().replace(/(\d)\s*\+/g, "$1 plus"); let m, model = null;
  if ((m = l.match(/\biphone\s*(\d{1,2}e?|se|xs|xr|x)\s*(pro\s*max|pro|plus|mini|max)?\b/))) model = "iphone " + m[1] + (m[2] ? " " + m[2].replace(/\s+/g, " ") : "");
  else if ((m = l.match(/\bgalaxy\s*(s|a|note|z\s*fold|z\s*flip|m)\s*(\d{1,3})\s*(ultra|plus|\+|fe|lite|5g)?\b/))) model = "galaxy " + m[1].replace(/\s+/g, "") + m[2] + (m[3] && m[3] !== "5g" ? " " + m[3].replace("+", "plus") : "");
  else if ((m = l.match(/\bpixel\s*(\d{1,2}a?)\s*(pro\s*xl|pro\s*fold|pro|xl|a)?\b/))) model = "pixel " + m[1] + (m[2] ? " " + m[2] : "");
  if (!model) return null;
  const st = storageOf(t);
  return { key: "phone:" + model + (st ? " " + st : ""), label: model.replace(/\b\w/g, (c) => c.toUpperCase()).replace("Iphone", "iPhone") + (st ? " " + stLabel(st) : ""), match: st ? 0.9 : 0.7 };
}
const NOT_CONSOLE = /\b(portal|remote play|vr2?|psvr2?|camera|headset|pulse|dualsense edge|charging station|disc drive|drive only|media remote|cover plates?|vertical stand|cooling|games?|game bundle only|steelbook|amiibo|gift card|voucher|membership|subscription|ps plus|game pass|pegi|code only|(?:download|digital|game) code|code in (?:a )?box|cartridge|cart only|disc only|game card)\b/i;
const CON_ACC = /\b(controllers?|joy[- ]?cons?|gamepads?|dualsense|dualshock|grips?|docks?|charg(?:er|ers|ing)|cables?|cases?|covers?|skins?|stands?|headsets?|faceplates?|shells?|screen protectors?|tempered glass|memory cards?|sd cards?|micro ?sd(?:hc|xc)?|carry(?:ing)? (?:bag|case)|power (?:supply|adapter)|psu|fans?|cooling|replacement|thumb ?sticks?|joysticks?|buttons?)\b/i;
const CON_ACC_PHRASE = /\bconsoles?\s+(?=(?:covers?|cover plates?|skins?|stands?|cases?|bags?|faceplates?|shells?|stickers?|decals?|wraps?)\b)/gi;
const CON_YES = /\b(console|system|handheld|bundle|with|inc|includes?|including|boxed|complete|\+)(?=\W|$)/i;
const CON_BARE = /\b(switch tablet|tablet console|bare unit|bare console|missing joy-?cons?|no stand|console only|tablet only|unit only|handheld only|screen only|system only|main unit|no (?:joy[- ]?cons?|controllers?|pads?|dock|charger|cables?|leads?|power (?:lead|cable|supply))|without (?:joy[- ]?cons?|controllers?|pads?|dock|charger|cables?|leads?))\b/i;
// a listing must show it is the console itself: "console", "system", "handheld", a storage size, a model code, or
// joy-cons/controllers included. Games, accessories and parts filed under consoles have none of these (30 Oct audit:
// Red Dead Redemption 2 Ps4, Ring Fit, racing wheels, MixAmp, boards, a "Xbox Series X fridge" were all priced as consoles)
const CON_EVIDENCE = /\b(consoles?|system|handheld|\d{2,4}\s?gb|[12]\s?tb|hac-?\d{3}|heg-?\d{3}|hdh-?\d{3}|bee-?\d{3}|cfi-?\d{4}|cuh-?\d{4}|scph-?\d{4,5}|model\s?\d{4}|joy-?cons?|with (?:\d|two|one|a)?\s?(?:wireless )?(?:controllers?|pads?|dualshock|dualsense))\b/i;
const CON_PARTS = /\b(portal\w*|portable playstation|playstation 5 portable|steam link|faceplates?|console covers?|cover plates?|dock only|base only|stand only|charger only|cover only|faceplate only|shell(?: housing)?|housing|motherboard|power ?board|wi-?fi(?:\/usb)? (?:card|board)|rf board|front board|pcb|fan (?:&|and) heatsink|heatsink|games? only|cart(?:ridge)? only|carry case|bag\/carry|insert and leaflets|leaflets only|rear cover|power switch|eye ?toy|rumble pak|memory pak|controller only)\b/i;
// parts named after "with" / "+" are extras that come with it ("PS5 Disc Console with Cover Plates")
const conHead = (t) => String(t).replace(/\s(?:with|w\/|\+|inc|incl|including|plus)\s[\s\S]*$/i, "");
function consoleKey(t) {
  if (/portal|portable playstation|playstation 5 portable|remote play/i.test(t)) return null; // "ps5 portalblack", "PlayStation 5 Portable"
  // "Not Xbox Series X Or S", "Non Oled": the named model is NOT what's for sale
  t = t.replace(/\b(?:not|non|isn'?t|no)[\s-]+(?:an?\s+)?(?:xbox(?:\s*series)?\s*[xs]?(?:\s*or\s*[xs])?|ps[345]|playstation\s*[345]|oled|lite|switch\s*2|pro|slim|digital)\b/gi, " ");
  if (!CON_EVIDENCE.test(t)) return null;
  if (CON_PARTS.test(conHead(t))) return null;
  // "Console Covers", "console skin": the word console here describes an accessory, not a console in the listing
  const tc = t.replace(CON_ACC_PHRASE, " ");
  // "bundle" alone doesn't prove a console is included ("PS4 Games Bundle", "Covers, Controller & Games Bundle")
  if (NOT_CONSOLE.test(tc) && !/\b(console|with|\+|inc|includes?)\b/i.test(tc.replace(NOT_CONSOLE, ""))) return null;
  if (/\b(portal|remote play|psvr|vr2|disc drive|drive only)\b/i.test(t)) return null;
  // "Switch Accessories Bundle": accessories without the console itself
  if (/\baccessor(?:y|ies)\b/i.test(t) && !/\bconsoles?\b/i.test(t)) return null;
  // accessories on their own (controllers, docks, cases...) are not consoles; a console listing that mentions them is fine
  if (CON_ACC.test(t) && !CON_YES.test(tc.replace(/\bbundle\b/gi, " "))) return null;
  if (/\b(lcd|screen replacement|motherboard|housing|shell|faceplate|for parts|empty|packaging|box only|pegi|code only)\b/i.test(t)) return null;
  const l = t.toLowerCase(); let m, k = null;
  if ((m = l.match(/\b(ps5|playstation\s*5)\b/))) k = "ps5 " + (/\bpro\b/.test(l) ? "pro" : /digital/.test(l) ? "digital" : "disc") + (/\bslim\b/.test(l) ? " slim" : "");
  else if ((m = l.match(/\b(ps4|playstation\s*4)\b/))) k = "ps4" + (/\bpro\b/.test(l) ? " pro" : /\bslim\b/.test(l) ? " slim" : "");
  else if ((m = l.match(/\bxbox\s*series\s*(x|s)\b/))) k = "xbox series " + m[1] + (m[1] === "x" && /\bdigital\b/.test(l) ? " digital" : "");
  else if ((m = l.match(/\bxbox\s*one\s*(x|s)?\b/))) k = "xbox one" + (m[1] ? " " + m[1] : "") + (/\b(all[\s-]*)?digital\b/.test(l) ? " digital" : "");
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
  const gen = (l.match(/\b(\d{1,2})(?:st|nd|rd|th)\s*gen/) || [])[1] || (l.match(/\bm([1-5])\b/) ? "M" + l.match(/\bm([1-5])\b/)[1] : "")
    || ((kind === "air" || kind === "mini") && (l.match(/\bipad\s*(?:air|mini)\s*([1-7])\b(?![.\d]|\s*(?:"|inch|in\b))/) || [])[1])
    || ((l.match(/\b(20(?:1\d|2\d))\b/) || [])[1] || "");
  const size = (l.match(/\b(7\.9|8\.3|9\.7|10\.2|10\.5|10\.9|11|12\.9|13)\s*(?:"|''|inch|in)?/) || [])[1] || "";
  const st = storageOf(t);
  if (!gen && !size) return null;
  return { key: `tab:${kind}|${gen}|${size}|${st || "?"}`, label: `iPad ${kind === "ipad" ? "" : kind[0].toUpperCase() + kind.slice(1) + " "}${gen ? (/^\d{4}$/.test(gen) ? "(" + gen + ")" : /^\d/.test(gen) ? ordinal(gen) + " gen" : gen) + " " : ""}${size ? size + '" ' : ""}${st ? stLabel(st) : ""}`.trim(), match: st && gen ? 0.85 : 0.6 };
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
  const so = /\b(so[- ]?dimm|laptop)\b/.test(l) ? " sodimm" : "";
  return { key: `ram:ddr${type}|${cap}|${sp}${so}`, label: `DDR${type} ${cap}GB${sp ? " ~" + sp + "MHz" : ""}${so ? " laptop" : ""} (any brand)`, match: sp ? 0.75 : 0.6 };
}
const SSD_BRANDS = /\b(samsung|wd|western digital|wd_black|crucial|micron|kingston|sandisk|seagate|sabrent|corsair|kioxia|toshiba|intel|solidigm|sk ?hynix|hynix|lexar|team ?group|teamgroup|pny|adata|xpg|gigabyte|aorus|msi|patriot|transcend|hp|lenovo|dell|silicon power|verbatim|integral|nextorch|orico|fanxiang|netac|hikvision|hiksemi|acer|predator|kingspec|ssstc|lite-?on|plextor|apple|biwin|lacie|g-?technology|asus|rog|thermaltake|mushkin|inland)\b/i;
function storageKey(t, catName) {
  if (!/drive|ssd|storage|hard disk/i.test(catName || "") && !/\b(ssd|nvme|hdd|hard drive)\b/i.test(t)) return null;
  if (/\b(laptop|desktop|pc|computer|workstation|tower|raspberry|nas|console|ps5|ps4|xbox|enclosure|caddy|adapter)\b/i.test(t)) return null;
  // 2TB+ SSDs from no known maker are often fake-capacity scams: never price them as real drives
  if (/\b([2-9]|1\d)\s*tb\b/i.test(t) && !SSD_BRANDS.test(t)) return null;
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
  const size = (l.match(/(?<![\d.])(2[0-9]|3[0-9]|4[0-9])(?:\.\d+)?\s*(?:"|''|-?inch|in\b)/) || [])[1];
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
    || (fits(/processor|cpu|component|part/i) && cpuKey(title, catName)) || (fits(/memory|\bram\b|component|part/i) && ramKey(title, catName))
    || (fits(/drive|ssd|storage|hard disk|component|part/i) && storageKey(title, catName)) || (fits(/monitor|display|component|part/i) && monitorKey(title, catName))
    || (fits(/cloth|shoe|trainer|sneaker|boot|footwear|coat|jacket|jumper|hoodie|jean|shirt|fashion|men|women|unisex|bag/i) && fashionKey(title)) || null;
  if (g) return { key: g.key + "|" + bucket, label: g.label, match: g.match };
  if (it.epid) return { key: "e" + it.epid + "|" + bucket, label: "Same eBay product", match: 1 };
  // consoles: a "similar title" group (retro consoles) only takes listings that show they're the console itself, never
  // parts or accessories (30 Oct audit: PS2 power boards, Game Boy shells, N64 carts were grouped with consoles)
  // graphics cards: laptop GPU modules and anything else that isn't a card never form a "similar title" group either
  if ((String(cat) === "27386" || /graphic|video card/i.test(catName || "")) && NOT_A_CARD.test(title)) return null;
  if ((String(cat) === "139971" || /console|video game/i.test(catName || "")) && (!CON_EVIDENCE.test(title) || CON_PARTS.test(conHead(title)) || RISK_WORDS.test(title))) return null;
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
async function ensureSrc(env) { if (srcReady) return; for (const c of ["src TEXT", "n INTEGER", "lo REAL", "hi REAL", "spd REAL", "sdays REAL", "sn INTEGER", "act INTEGER", "act_at INTEGER"]) { try { await env.DB.prepare("ALTER TABLE prices ADD COLUMN " + c).run(); } catch (e) {} } srcReady = true; }
// a careful "sells for": the lower-middle sale price (40th percentile), from the last 30 days when there are 5+ sales, else 90 days
const pctl = (a, f) => { const s = [...a].sort((x, y) => x - y); if (!s.length) return null; const i = (s.length - 1) * f, lo = Math.floor(i); return s[lo] + (s[Math.min(s.length - 1, lo + 1)] - s[lo]) * (i - lo); };
// one listing offering several sizes ("500GB 1TB 2TB 4TB"): the price shown is for one of them, we can't tell which
const MULTI_VAR = /\b\d+(?:\.\d+)?\s?(?:gb|tb)\s*[\/,|&+-]?\s*\d+(?:\.\d+)?\s?(?:gb|tb)\s*[\/,|&+-]?\s*\d+(?:\.\d+)?\s?(?:gb|tb)\b/i;
const FILL_SKIP = /\b(faulty|spares|repairs?|broken|for parts|parts only|job ?lot|joblot|bundle|empty box|box only|untested|read desc|read description|see desc|see description|please read|not working|cracked|icloud locked)\b/i;
/* ---------------- sell speed ----------------
   eBay's sold pages show the day each item sold, not how long it was listed. So speed is estimated from
   (a) sales per day: sales counted only on days whose sold pages were actually read ("covered" days), and
   (b) how many of the model are for sale now (one official API call per model, refreshed every 3 days).
   Rough wait = for sale now ÷ sales per day. Never shown as a promise; thin evidence shows "not enough data". */
const SPEED_MIN_SALES = 10, SPEED_MIN_DAYS = 3, SPEED_WINDOW = 30;
// covered time: a list of [from, to] ms ranges, merged, kept for 90 days
function coverAdd(list, from, to, now) {
  const all = [...(Array.isArray(list) ? list : []), [from, to]].filter((r) => r && r[1] > r[0] && r[1] > now - 90 * DAY).sort((a, c) => a[0] - c[0]), out = [];
  for (const r of all) { const l = out[out.length - 1]; if (l && r[0] <= l[1]) l[1] = Math.max(l[1], r[1]); else out.push([r[0], r[1]]); }
  return out;
}
const coverDays = (list, since, until) => (list || []).reduce((a, r) => a + Math.max(0, Math.min(r[1], until) - Math.max(r[0], since)), 0) / DAY;
const covered = (list, from, to) => to <= from ? inCover(list, to) : coverDays(list, from, to) >= ((to - from) / DAY) * 0.95;
const inCover = (list, t) => (list || []).some((r) => t >= r[0] && t < r[1]);
// the range a fill's rows prove was read in full: from the day after the oldest sale (that day was only partly read) to the end of the newest day
// Sold pages run newest first, so the sales read form one unbroken run of days. eBay mixes in a few stray old
// dates (multi-unit listings show their first sale), which once stretched "read in full" back by months. So only
// "busy" days count: days with at least 15% of the busiest day's sales (and at least 2). A run is busy days with
// at most one quiet day between them. (Measured against the busiest day, not a typical one: with weeks of 1–5 stray
// sales a day, a "typical" day is a stray day, and strays chained into a fake month-long run.)
function coverOf(rows, now) {
  const r = coverRuns(rows.map((x) => +(x && x.d)), now);
  return r.length ? r[r.length - 1] : null; // the run that reaches the newest sale
}
// every run of 20+ sales → [from, to] (the oldest day of a run was only partly read, so it starts the day after)
function coverRuns(dates, now) {
  const per = new Map();
  for (const d of dates) if (d > now - 400 * DAY && d <= now + DAY) { const k = Math.floor(d / DAY); per.set(k, (per.get(k) || 0) + 1); }
  if (!per.size) return [];
  const ref = Math.max(...per.values());
  const busy = [...per.entries()].filter(([, n]) => n >= Math.max(2, ref * 0.15)).sort((a, c) => a[0] - c[0]), out = [];
  let i = 0;
  while (i < busy.length) {
    let j = i, n = busy[i][1];
    while (j + 1 < busy.length && busy[j + 1][0] - busy[j][0] <= 2) { j++; n += busy[j][1]; }
    // the newest day is usually only partly read too (the fill was done that day): if it has under half a normal
    // day's sales it isn't counted (when filling today, "now" already ends the range at the right time)
    const mid = busy.slice(i, j + 1).map((x) => x[1]).sort((a, c) => a - c)[(j - i) >> 1], last = busy[j][0];
    const end = j > i && busy[j][1] < mid * 0.5 && (last + 1) * DAY <= now ? last * DAY : (last + 1) * DAY;
    if (n >= 20) { const from = (busy[i][0] + 1) * DAY, to = Math.min(now, end); if (to > from) out.push([from, to]); }
    i = j + 1;
  }
  return out;
}
// sales per day for one model, from its sales [id, price, post, soldAt] inside covered days of the last 30
function salesRate(list, cover, now) {
  const since = now - SPEED_WINDOW * DAY, days = coverDays(cover, since, now);
  const sn = list.filter((r) => r[3] && r[3] >= since && inCover(cover, r[3])).length;
  return { spd: days >= 1 ? sn / days : null, sdays: Math.round(days * 10) / 10, sn };
}
// what the app shows: band + a range in days, or why there isn't one. b = price row {spd, sdays, sn, act, act_at}
function speedOf(b, now) {
  if (!b || b.sn == null) return null;
  const base = { sold: b.sn, overDays: b.sdays, forSale: b.act != null ? b.act : null, checked: b.act_at || null };
  if (b.sn < SPEED_MIN_SALES || b.sdays < SPEED_MIN_DAYS || !(b.spd > 0)) return { ...base, band: "none" };
  const perWeek = Math.round(b.spd * 7 * 10) / 10;
  if (b.act == null || !b.act_at || now - b.act_at > 7 * DAY) return { ...base, band: null, perWeek };
  const days = Math.max(1, b.act) / b.spd;
  return { ...base, perWeek, days: Math.round(days * 10) / 10, lo: Math.max(1, Math.round(days * 0.6)), hi: Math.max(2, Math.round(days * 1.6)), band: days <= 7 ? "fast" : days <= 28 ? "normal" : "slow" };
}
// self-check: did last fill's sales rate hold up in the days read since? (within ±50% counts as a hit)
function rateCheck(prev, list, cover, now) {
  if (!prev || !(prev.spd > 0) || (prev.sn || 0) < SPEED_MIN_SALES || (prev.sdays || 0) < SPEED_MIN_DAYS || !prev.at) return null;
  const days = coverDays(cover, prev.at, now);
  if (days < SPEED_MIN_DAYS) return null;
  const n = list.filter((r) => r[3] && r[3] > prev.at && inCover(cover, r[3])).length, obs = n / days;
  return { hit: Math.abs(obs - prev.spd) <= prev.spd * 0.5, pred: prev.spd, obs };
}
async function fillPrices(env, b) {
  // Every sale is kept by its eBay item number (so pages read twice, or on different days, never count twice)
  // in one small record per model; each model's price comes from all its sales in the last 90 days.
  const cat = String(b.cat || "").replace(/\D/g, ""), catName = String(b.catName || "").slice(0, 80), cond = b.cond === "new" ? "new" : "used";
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 3000), groups = new Map(), now = Date.now(), cut = now - 90 * DAY, seenRows = [];
  // which days these pages covered in full, for sales-per-day
  const covAll = await kvGet(env, "fillCover", {}), rng = coverOf(rows, now);
  const cover = rng ? coverAdd(covAll[cat], rng[0], rng[1], now) : coverAdd(covAll[cat], 0, 0, now);
  if (rng && cat) { covAll[cat] = cover; await kvSet(env, "fillCover", covAll); }
  for (const r of rows) {
    const t = String((r && r.n) || "").slice(0, 200), p = +r.p, id = String((r && r.id) || "").replace(/\D/g, "").slice(0, 20);
    // every sale read is kept with its title and condition, matched to a model or not, so it can be re-sorted later
    const seenRow = [id, cat, Math.round((p + (r.s != null && +r.s >= 0 && +r.s < 500 ? +r.s : 0)) * 100) / 100, +r.d || null, t || null, r.c ? String(r.c).slice(0, 10) : null, null];
    if (id && p > 0 && p < 100000) seenRows.push(seenRow);
    if (!t || !id || !(p > 0 && p < 100000) || FILL_SKIP.test(t) || MULTI_VAR.test(t) || FAKE_SSD(t)) continue;
    if (r.c && r.c !== cond) continue; // the listing's own condition (eBay's filter sometimes drops on later pages)
    const g = groupOf({ title: t }, cat, catName, cond);
    // known kinds are matched model by model; anything else needs a strong title match or a single model code like "75192"
    const known = /^(gpu|lap|phone|con|tab|cpu|ram|sto|mon|fas):/.test(g && g.key), code = g && /^t\d*:([a-z0-9]{4,})\|/.exec(g.key);
    if (!g || g.match < (known ? 0.6 : code ? 0.45 : 0.7)) continue;
    const key = bareKey(g.key);
    seenRow[6] = key;
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
  const prevRate = new Map();
  for (let i = 0; i < keys.length; i += 90) {
    const part = keys.slice(i, i + 90), q = await env.DB.prepare("SELECT pkey, spd, sdays, sn, at FROM prices WHERE pkey IN (" + part.map(() => "?").join(",") + ")").bind(...part).all();
    for (const r of q.results || []) prevRate.set(r.pkey, r);
  }
  const chk = await kvGet(env, "spdCheck", { n: 0, hit: 0 }); let chkNew = 0;
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
    const rt = salesRate(keep, cover, now), ck = rng ? rateCheck(prevRate.get(key), keep, cover, now) : null;
    if (ck) { chk.n++; if (ck.hit) chk.hit++; chkNew++; }
    prices.push([key, x.label.slice(0, 120), x.q.slice(0, 400), avg, null, sh.length ? Math.round(median(sh) * 100) / 100 : null, trend, now, "fill", use.length, lo, hi, rt.spd, rt.sdays, rt.sn]);
    saved.push({ label: x.label, n: use.length, avg, key });
  }
  // few queries per save (free plan allows 50): many rows per statement
  const multi = (head, tail, cols, list, per) => { const st = []; for (let i = 0; i < list.length; i += per) { const part = list.slice(i, i + per); st.push(env.DB.prepare(head + part.map(() => "(" + Array(cols).fill("?").join(",") + ")").join(",") + tail).bind(...part.flat())); } return st; };
  const st = [...multi("INSERT INTO fillsales (pkey,data,at) VALUES ", " ON CONFLICT(pkey) DO UPDATE SET data=excluded.data, at=excluded.at", 3, blobs, 30),
    ...multi("INSERT INTO prices (pkey,label,q,avg,st,post,trend,at,src,n,lo,hi,spd,sdays,sn) VALUES ", " ON CONFLICT(pkey) DO UPDATE SET label=excluded.label, q=excluded.q, avg=excluded.avg, post=excluded.post, trend=excluded.trend, at=excluded.at, src='fill', n=excluded.n, lo=excluded.lo, hi=excluded.hi, spd=excluded.spd, sdays=excluded.sdays, sn=excluded.sn", 15, prices, 6)];
  if (chkNew) { chk.at = now; await kvSet(env, "spdCheck", chk); }
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
  // remember every sale read, then learn how long the listings FlipScout saw for sale took to sell (best effort)
  let tracked = null;
  try { await seenAdd(env, seenRows); tracked = await markSold(env, seenRows); await sellStats(env); } catch (err) {}
  return { read: rows.length, fresh, models: groups.size, saved: saved.length, few, kept, top: saved.slice(0, 40), stats, tracked };
}

// rebuild fill coverage from every sale date read (fillseen), then each fill-priced model's sales rate
async function rebuildCover(env, now) {
  const D = env.DB, cover = {}, before = await kvGet(env, "fillCover", {});
  const cats = await D.prepare("SELECT DISTINCT cat FROM fillseen WHERE cat <> ''").all();
  for (const { cat } of cats.results || []) {
    const q = await D.prepare("SELECT at FROM fillseen WHERE cat=? AND at IS NOT NULL").bind(cat).all();
    let list = [];
    for (const r of coverRuns((q.results || []).map((x) => x.at), now)) list = coverAdd(list, r[0], r[1], now);
    cover[cat] = list;
  }
  await kvSet(env, "fillCover", cover);
  if (!(await kvGet(env, "fillCoverOld", null))) await kvSet(env, "fillCoverOld", before); // the original, kept so the change can be compared or undone
  const fc = await kvGet(env, "fillCats", {}), catOf = {};
  for (const c in fc) for (const k in (fc[c].k || {})) if (!catOf[k]) catOf[k] = c;
  const rows = await D.prepare("SELECT f.pkey, f.data FROM fillsales f JOIN prices p ON p.pkey = f.pkey WHERE p.src='fill'").all(), up = [];
  for (const r of rows.results || []) {
    let list = []; try { list = JSON.parse(r.data); } catch (e) { continue; }
    const m = median(list.map((x) => x[1])), keep = list.filter((x) => x[1] >= m * 0.5 && x[1] <= m * 1.5);
    const rt = salesRate(keep, cover[catOf[r.pkey]], now);
    up.push(D.prepare("UPDATE prices SET spd=?, sdays=?, sn=? WHERE pkey=?").bind(rt.spd, rt.sdays, rt.sn, r.pkey));
  }
  for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));
  // the speed self-check so far measured the old, wrong ranges: start it again
  await kvSet(env, "spdCheck", { n: 0, hit: 0, restarted: now });
  try { await sellStats(env); } catch (e) {}
  return { cats: Object.keys(cover).length, models: up.length };
}

// why deals left the list (sold out, ended, price up, rules), so a missing deal can always be traced
async function dealOut(env, ids, why) {
  const q = await env.DB.prepare(`SELECT id, data FROM deals WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all(), now = Date.now();
  const st = (q.results || []).map((r) => { let x = {}; try { x = JSON.parse(r.data); } catch (e) {}
    return env.DB.prepare("INSERT OR REPLACE INTO deal_out (id, at, why, price, title) VALUES (?,?,?,?,?)").bind(r.id, now, String(why(r.id)).slice(0, 60), x.price ?? null, String(x.title || "").slice(0, 120)); });
  if (st.length) await env.DB.batch(st);
}

async function cleanup5(env, cfg, report) {
  const D = env.DB, st = await kvGet(env, "fix5", { stage: 0, after: 0, changed: 0 });
  if (st.stage === 3) return;
  if (st.stage === 0) {
    const fc = await kvGet(env, "fillCats", {}), keys = Object.keys((fc["139971"] || {}).k || {});
    const conKeys = (await D.prepare("SELECT pkey FROM fillsales WHERE pkey LIKE 'con:%'").all()).results.map((r) => r.pkey);
    const all = [...new Set([...keys, ...conKeys])];
    await D.batch([
      D.prepare("CREATE TABLE IF NOT EXISTS backup_fillsales AS SELECT * FROM fillsales WHERE 0"),
      D.prepare("CREATE TABLE IF NOT EXISTS backup_prices AS SELECT * FROM prices WHERE 0"),
      D.prepare("CREATE TABLE IF NOT EXISTS backup_fillseen AS SELECT * FROM fillseen WHERE 0"),
      D.prepare("INSERT INTO backup_fillseen SELECT * FROM fillseen WHERE cat='139971'"),
      D.prepare("DELETE FROM fillseen WHERE cat='139971'"),
    ]);
    for (let i = 0; i < all.length; i += 90) {
      const ch = all.slice(i, i + 90), q = ch.map(() => "?").join(",");
      await D.batch([
        D.prepare(`INSERT INTO backup_fillsales SELECT * FROM fillsales WHERE pkey IN (${q})`).bind(...ch),
        D.prepare(`INSERT INTO backup_prices SELECT * FROM prices WHERE pkey IN (${q})`).bind(...ch),
        D.prepare(`DELETE FROM fillsales WHERE pkey IN (${q})`).bind(...ch),
        D.prepare(`DELETE FROM prices WHERE pkey IN (${q})`).bind(...ch),
      ]);
    }
    delete fc["139971"]; await kvSet(env, "fillCats", fc);
    const cov = await kvGet(env, "fillCover", {}); delete cov["139971"]; await kvSet(env, "fillCover", cov);
    Object.assign(st, { stage: 1, consoleModels: all.length, at: Date.now() });
    await kvSet(env, "fix5", st);
    return;
  }
  if (st.stage === 1) {
    const names = Object.fromEntries((cfg.cats || []).map((c) => [String(c.id), c.name]));
    const rows = (await D.prepare("SELECT rowid r, id, cat, title, cond, pkey FROM listings WHERE rowid>? ORDER BY rowid LIMIT 2500").bind(st.after).all()).results || [];
    const up = [];
    for (const x of rows) {
      const g = x.title ? groupOf({ title: x.title }, x.cat, names[String(x.cat)] || "", x.cond || "used") : null, k = g ? g.key : null;
      if (k !== x.pkey && !/^e\d/.test(x.pkey || "")) up.push(D.prepare("UPDATE listings SET pkey=? WHERE id=?").bind(k, x.id));
    }
    for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));
    st.changed += up.length; st.read = (st.read || 0) + rows.length;
    if (rows.length) st.after = rows[rows.length - 1].r;
    if (rows.length < 2500) st.stage = 2;
    await kvSet(env, "fix5", st);
    report.cleanup = { read: st.read, changed: st.changed };
    return;
  }
  if (st.stage === 2) {
    const r = await D.prepare("UPDATE sales SET pkey=(SELECT l.pkey FROM listings l WHERE l.id=sales.id) WHERE EXISTS (SELECT 1 FROM listings l WHERE l.id=sales.id AND l.pkey IS NOT sales.pkey)").run();
    await D.prepare("UPDATE prices SET act_at=NULL").run();
    Object.assign(st, { stage: 3, salesChanged: (r.meta && r.meta.changes) || 0, done: Date.now() });
    await kvSet(env, "fix5", st);
  }
}

/* ---------------- sold details from eBay's Trading API ---------------- */
// The owner connects their eBay account once (OAuth, "view public data" only). eBay gives a refresh token (about 18
// months) that FlipScout keeps in its database and uses to get 2-hour access tokens. GetItem then returns, for any sold
// item number up to about 90 days after it ended: when it was listed (StartTime), the seller, the format and quantities.
// Tested 3 Nov 2026: 130 of 130 sold items answered with an upload time, 30 of 30 matching FlipScout's own records.
const RUNAME = "Anthony_Wildsmi-AnthonyW-FlipSc-wqplioem"; // eBay "redirect URL name" for the FlipScout keyset (not secret)
const USER_SCOPE = "https://api.ebay.com/oauth/api_scope";
const GI_PER_SCAN = 25, GI_DAILY = 4000; // Trading API calls: well under eBay's default 5,000 a day
const ebayConnectUrl = (env) => "https://auth.ebay.com/oauth2/authorize?client_id=" + encodeURIComponent(env.EBAY_ID) + "&response_type=code&redirect_uri=" +
  encodeURIComponent(RUNAME) + "&scope=" + encodeURIComponent(USER_SCOPE);
async function ebayUserTokenCall(env, body) {
  const res = await xfetch(env, "https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + btoa(env.EBAY_ID + ":" + env.EBAY_SECRET) } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("eBay sign-in refused (" + res.status + "): " + String(d.error_description || d.error || "").slice(0, 120));
  return d;
}
// the code eBay hands back after the owner taps Agree → a refresh token kept in the database
async function ebayConnect(env, code) {
  const d = await ebayUserTokenCall(env, "grant_type=authorization_code&code=" + encodeURIComponent(code) + "&redirect_uri=" + encodeURIComponent(RUNAME));
  if (!d.refresh_token) throw new Error("eBay didn't return a long-lasting token");
  const now = Date.now();
  await kvSet(env, "ebayUser", { refresh: d.refresh_token, refreshExp: now + (+d.refresh_token_expires_in || 47304000) * 1000,
    access: d.access_token, accessExp: now + ((+d.expires_in || 7200) - 300) * 1000, at: now });
  return { ok: true, until: now + (+d.refresh_token_expires_in || 47304000) * 1000 };
}
async function ebayUserToken(env) {
  const u = await kvGet(env, "ebayUser", null);
  if (!u || !u.refresh) return null;
  if (u.access && Date.now() < u.accessExp) return u.access;
  if (Date.now() > u.refreshExp) return null;
  const d = await ebayUserTokenCall(env, "grant_type=refresh_token&refresh_token=" + encodeURIComponent(u.refresh) + "&scope=" + encodeURIComponent(USER_SCOPE));
  u.access = d.access_token; u.accessExp = Date.now() + ((+d.expires_in || 7200) - 300) * 1000;
  await kvSet(env, "ebayUser", u);
  return u.access;
}
const xmlTag = (x, t) => { const m = x.match(new RegExp("<" + t + ">([^<]*)</" + t + ">")); return m ? m[1] : null; };
async function getItemTrading(env, tok, id) {
  const body = `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${String(id).replace(/\D/g, "")}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`;
  const res = await xfetch(env, "https://api.ebay.com/ws/api.dll", { method: "POST", body, headers: { "X-EBAY-API-IAF-TOKEN": tok, "Content-Type": "text/xml",
    "X-EBAY-API-SITEID": "3", "X-EBAY-API-COMPATIBILITY-LEVEL": "1423", "X-EBAY-API-CALL-NAME": "GetItem" } });
  const x = await timedBody(env, res.text());
  if (/<ErrorCode>(?:21917053|931|932|21916984)<\/ErrorCode>/.test(x)) throw new Error("eBay token no longer accepted"); // expired or revoked
  if (!/<Ack>(?:Success|Warning)<\/Ack>/.test(x)) return { missing: true, err: xmlTag(x, "ErrorCode") };
  const st = xmlTag(x, "StartTime");
  return { start: st ? Date.parse(st) : null, seller: (xmlTag(x, "UserID") || "").slice(0, 64) || null, fmt: xmlTag(x, "ListingType"),
    qty: +xmlTag(x, "Quantity") || null, sold: +xmlTag(x, "QuantitySold") || null };
}
// a batch of sold items each scan, oldest first (eBay stops answering about 90 days after a listing ends)
async function soldDetails(env, report) {
  const D = env.DB, now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
  const use = await kvGet(env, "giUse", { d: day, n: 0 });
  if (use.d !== day) { use.d = day; use.n = 0; }
  if (use.n >= GI_DAILY) return;
  const tok = await ebayUserToken(env);
  if (!tok) return;
  const rows = (await D.prepare("SELECT id FROM fillseen WHERE gi_at IS NULL AND at > ? ORDER BY at ASC LIMIT ?").bind(now - 92 * DAY, Math.min(GI_PER_SCAN, GI_DAILY - use.n)).all()).results || [];
  let found = 0, missing = 0;
  const up = [];
  for (const r of rows) {
    let g;
    try { g = await getItemTrading(env, tok, r.id); } catch (e) { report.errors.push("sold details: " + e.message); if (/no longer accepted/.test(e.message)) await kvSet(env, "ebayUser", { ...(await kvGet(env, "ebayUser", {})), broken: now }); break; }
    use.n++;
    if (g.missing) { missing++; up.push(D.prepare("UPDATE fillseen SET gi_at=0 WHERE id=?").bind(r.id)); continue; }
    found++;
    up.push(D.prepare("UPDATE fillseen SET start_at=?, seller=?, fmt=?, qty=?, qty_sold=?, gi_at=? WHERE id=?").bind(g.start, g.seller, g.fmt, g.qty, g.sold, now, r.id));
  }
  for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));
  await kvSet(env, "giUse", use);
  if (rows.length) report.soldDetails = { found, missing, today: use.n };
}

/* ---------------- how long listings take to sell ---------------- */
// rows: [itemId, cat, price incl. post, soldAt, title?, condition?, model key?] — a sale read again fills in what was missing
async function seenAdd(env, rows) {
  const st = [], full = rows.map((r) => [...r, null, null, null].slice(0, 7));
  for (let i = 0; i < full.length; i += 14) { const part = full.slice(i, i + 14);
    st.push(env.DB.prepare("INSERT INTO fillseen (id,cat,price,at,title,cond,pkey) VALUES " + part.map(() => "(?,?,?,?,?,?,?)").join(",") +
      " ON CONFLICT(id) DO UPDATE SET title=COALESCE(fillseen.title, excluded.title), cond=COALESCE(fillseen.cond, excluded.cond), pkey=COALESCE(excluded.pkey, fillseen.pkey)").bind(...part.flat())); }
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
}
// which of these sold items FlipScout had seen for sale as Buy It Now: mark them sold, with the price and date
async function markSold(env, rows) {
  const D = env.DB, by = new Map(rows.map((r) => [String(r[0]), r])), ids = [...by.keys()], up = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const q = await D.prepare(`SELECT id FROM listings WHERE id IN (${chunk.map(() => "?").join(",")}) AND type='BIN' AND sold_at IS NULL`).bind(...chunk).all();
    for (const x of q.results || []) { const r = by.get(String(x.id)); if (r && r[3]) up.push(D.prepare("UPDATE listings SET status='sold', sold_at=?, sold_price=? WHERE id=?").bind(r[3], r[2], x.id)); }
  }
  for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));
  return up.length;
}
// per model (price-list key): Buy It Now listings FlipScout saw for sale that later sold (days from listing to sale), and
// ones that ended without appearing in a sold list that was read for that day ("probably withdrawn"; an assumption)
async function sellStats(env) {
  const D = env.DB, now = Date.now(), cover = await kvGet(env, "fillCover", {});
  const q = await D.prepare("SELECT id, pkey, cat, first_seen, last_seen, sold_at, ended_at, ended_from, status FROM listings WHERE type='BIN' AND pkey IS NOT NULL AND status IN ('sold','gone')").all();
  const m = {}, done = new Set();
  // sold items looked up with eBay's GetItem: listed → sold. Single-item listings only (a listing selling many units
  // over months says how old the listing is, not how fast one sells), and nothing over a year.
  const g = await D.prepare("SELECT id, pkey, at, start_at FROM fillseen WHERE pkey IS NOT NULL AND start_at > 0 AND at >= start_at AND COALESCE(qty, 1) <= 1 AND at - start_at < ?").bind(365 * DAY).all();
  for (const r of g.results || []) { const x = (m[r.pkey] = m[r.pkey] || { d: [], wd: 0 }); x.d.push((r.at - r.start_at) / DAY); done.add(String(r.id)); }
  for (const r of q.results || []) {
    const k = bareKey(r.pkey), x = (m[k] = m[k] || { d: [], wd: 0 });
    if (r.status === "sold" && r.sold_at >= r.first_seen) { if (!done.has(String(r.id))) x.d.push((r.sold_at - r.first_seen) / DAY); }
    // ended unsold: it ended some time between ended_from and ended_at, and the sold pages for that whole time were read
    else if (r.status === "gone" && covered(cover[r.cat], r.ended_from || r.last_seen, r.ended_at || r.last_seen)) x.wd++;
  }
  const out = {};
  for (const [k, x] of Object.entries(m)) {
    const d = x.d.sort((a, c) => a - c), at = (p) => Math.round(d[Math.min(d.length - 1, Math.floor(p * d.length))] * 10) / 10;
    out[k] = { n: d.length, wd: x.wd, med: d.length ? at(0.5) : null, lo: d.length ? at(0.25) : null, hi: d.length ? at(0.75) : null };
  }
  await kvSet(env, "sellTime", { at: now, m: out });
  return out;
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
const RISK_WORDS = /\b(no (?:hdd|ssd|ram|memory|storage|hard ?drive|screen|display|battery|motherboard)|trade bundle|bulk lot|job ?lots?|joblots?|lot of \d+|bundle of \d+|bad health|parts\/|(?<!\bno |\bwithout |\bzero |\bany )damage|parts only|spares only|for parts|parts or not working|parts\/repair|as is|sold as seen|not tested|empty (?:retail |original |console )?(?:box|packaging|case)|packaging only|box (?:and|&) (?:inserts?|packaging|manual)|box\W{1,4}empty|empty\W{1,4}(?:box|packaging)|box only|empty box|read desc|read description|see desc|see description|please read|photo of|picture of|image of|replica|fake|not genuine|dummy|display only|case only|cover only|manual only|cable only|stand only|bundle only|no console|card only|for parts|spares|repairs?|faulty|broken|cracked|not working|untested|bios lock|icloud|activation lock|locked|blacklisted|no power|water damage|liquid damage|damaged|dented|bent pins?|burnt|burned|scorched|melted|smashed|shattered|bricked|no display|no signal|no picture|dead pixels?|artifact(?:s|ing)|artefact(?:s|ing)|(?<!\bno )faults?|flicker\w*|(?:needs?|needed|requires?|need)\s+(?:a\s+)?(?:new\s+)?(?:screen|lcd|battery|charging port)|new (?:screen|lcd|battery) (?:needed|required)|screen (?:bar|line|lines|issue|problem)s?|scra?t?c?h?ed screen|scratched screen|chipped screen|low battery|poor battery|battery (?:issue|fault|problem)|missing joy-?cons?|box (?:with|w\/) inserts?)\b/i;
const SCAM_WORDS = /\b(empty (?:retail |original |console )?(?:box|packaging|case)|packaging only|box (?:and|&) (?:inserts?|packaging|manual)|box\W{1,4}empty|empty\W{1,4}(?:box|packaging)|read desc|read description|photo of|picture of|image of|empty box|box only|replica|fake|not genuine|contact me|message me before|whatsapp|bank transfer)\b/i;
// "iPhone 12 Pro Max 128GB BOX": a title that ends in "box" is usually the box alone ("... with box" is fine)
const BOX_END = /(?<!\b(?:with|w\/|and|&|\+|inc|incl|includes?|including|in|original|retail) )\bbox(?:es)?\W*$/i;
const RISK_G = new RegExp(RISK_WORDS.source, "gi");
// faults sellers only mention in the description (titles look fine): battery, charger, screen, locks, damage
const DESC_FAULT = /\b(battery (?:does(?:n'?t| not)|won'?t|will not|doesn'?t|wont) (?:hold|charge|last)(?: (?:a |the )?charge)?|(?:needs?|requires?|will need) (?:a )?(?:new|replacement) (?:battery|screen|charger|keyboard|hinge|motherboard)|no (?:charger|power|display|signal|sound|wifi|touch)|not charging|won'?t (?:turn|switch|power|boot) on|does(?:n'?t| not) (?:turn|switch|power|boot) on|dead pixels?|lines? (?:on|across) (?:the )?screen|screen (?:burn|bleed)|cracked|smashed|i ?cloud lock(?:ed)?|activation lock(?:ed)?|bios (?:lock(?:ed)?|password)|password locked|blacklisted|(?:water|liquid) damage(?:d)?)\b/gi;
// fault phrases in a description, skipping ones the seller denies ("not cracked", "no water damage")
function descFaults(text) {
  const t = String(text || ""), out = new Set();
  for (const m of t.matchAll(DESC_FAULT)) if (!/\b(no|not|never|isn'?t|without|zero)\s+$/i.test(t.slice(Math.max(0, m.index - 12), m.index))) out.add(m[0].toLowerCase());
  return [...out].slice(0, 6);
}
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
// Categories whose product matching has been checked by hand on real titles (see docs/ENGINEERING_LOG.md).
// Deals from any other category are shown as "Not verified yet": scored no higher than Medium and never alerted,
// until a sample of its titles has been checked and the category is added here with the date.
// a Buy It Now under this share of the usual sold price is tagged "Very cheap" (see the deal scoring)
const VERY_CHEAP = 0.6, HIDE_BELOW = 0.4;
// most deals sent to the app and re-judged each scan (the app is told the true total, and says if any are left out)
const DEALS_MAX = 3000;
// a price needs at least this many sales behind it before anything can be a deal
const MIN_SALES = 8;
const VERIFIED_CATS = {
  "27386": "2026-10-26", // Graphics/Video Cards
  "139971": "2026-10-26", // Video Game Consoles
  "9355": "2026-10-26", // Mobile & Smart Phones
  "171485": "2026-10-26", // Tablets & eBook Readers
  "177": "2026-10-26", // PC Laptops & Netbooks
  "175672": "2026-10-26", // Laptops & Netbooks
  "179": "2026-10-26", // PC Desktops & All-in-Ones
  "164": "2026-10-26", // CPUs/Processors
  "170083": "2026-10-26", // Memory (RAM)
  "175669": "2026-10-26", // Solid State Drives
  "80053": "2026-10-26", // Monitors
  "15709": "2026-10-26", // Trainers
};
const DEFAULT_RULES = { cheap: true, maxSpend: 0, minProfit: 20, minRoi: 0, seller: "business", feePct: 12.8, feeFixed: 0.4, post: 5, pack: 1, bpf: true, alertScore: 70, minScore: 40, riskPct: 0 };
function cleanConfig(c) {
  c = c || {};
  return {
    // off: kept in your list but not searched, so eBay calls go to the categories you've ticked
    cats: Array.isArray(c.cats) ? c.cats.filter((x) => x && /^\d+$/.test(String(x.id))).slice(0, 15).map((x) => ({ id: String(x.id), name: String(x.name || "").slice(0, 80), off: !!x.off })) : [],
    // every setting that feeds the money sums is checked here too (old app versions, restores, anyone with the key):
    // numbers in range, never text or negative; anything unusable falls back to the default
    rules: (() => { const r = { ...DEFAULT_RULES, ...(c.rules || {}) }, D0 = DEFAULT_RULES;
      const num = (k, lo, hi) => { const v = +r[k]; r[k] = Number.isFinite(v) && v >= lo && v <= hi ? v : D0[k]; };
      r.maxSpend = Math.max(0, Math.min(100000, +r.maxSpend || 0));
      num("minProfit", 0, 10000); num("minRoi", 0, 1000); num("feePct", 0, 50); num("feeFixed", 0, 10); num("post", 0, 200); num("pack", 0, 100); num("alertScore", 0, 100); num("minScore", 0, 100); num("riskPct", 0, 30); // riskPct: optional risk allowance, shown only, never a fee
      r.seller = r.seller === "private" ? "private" : "business"; r.bpf = r.bpf !== false; r.cheap = r.cheap !== false; return r; })(),
    types: { bin: true, auction: true, misspelt: true, spares: false, ...(c.types || {}) },
    region: c.region === "any" ? "any" : "uk",
    alerts: c.alerts !== false,
    // 0 = automatic: every 5 minutes when 1–2 categories are ticked (deep search), every 10 otherwise
    interval: [0, 5, 10, 15, 30, 60].includes(+c.interval) ? +c.interval : 0,
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

// once a week: copy the price list (and the sales behind it) to the backup store, keeping the last 4 weeks.
// Cloudflare's own undo only reaches back 30 days; this is an extra copy that can be put back if ever needed.
async function weeklyExport(env) {
  if (!env.BACKUP || !env.DB) return;
  const now = Date.now(), last = await kvGet(env, "lastExport", 0);
  if (now - last < 7 * DAY) return;
  await kvSet(env, "lastExport", now);
  const prices = (await env.DB.prepare("SELECT * FROM prices").all()).results || [];
  const sales = (await env.DB.prepare("SELECT pkey, data, at FROM fillsales").all()).results || [];
  let body = JSON.stringify({ at: now, prices, fillsales: sales, cover: await kvGet(env, "fillCover", {}), cats: await kvGet(env, "fillCats", {}) });
  if (body.length > 20e6) body = JSON.stringify({ at: now, prices, note: "sales left out: too big" });
  const name = "prices-" + new Date(now).toISOString().slice(0, 10);
  await env.BACKUP.put(name, body, { metadata: { at: now, prices: prices.length } });
  const list = await env.BACKUP.list({ prefix: "prices-" });
  const old = (list.keys || []).map((k) => k.name).sort().slice(0, -4);
  for (const k of old) await env.BACKUP.delete(k);
}
// automatic scan timing: a focused search (1–2 categories) is cheap in eBay calls, so it can run every 5 minutes
const autoInterval = (ticked) => (ticked <= 2 ? 5 : 10);
// should this scheduled scan wait, to keep eBay calls within the day? used = calls so far today, sinceLast = ms since last scan
function paceSkip(used, now, cats, interval, sinceLast) {
  const left = EBAY_DAILY * 0.97 - used, d = new Date(now), minsLeft = 1440 - (d.getUTCHours() * 60 + d.getUTCMinutes()), perScan = Math.min(cats, 8) * 3 + 10;
  if (left < perScan) return "eBay daily limit reached";
  const need = Math.ceil(minsLeft / Math.max(1, Math.floor(left / perScan)));
  const ahead = used > EBAY_DAILY * 0.9 * ((1440 - minsLeft) / 1440) + 200; // using calls faster than the day allows
  return ahead && need > interval && sinceLast < need * 60000 - 30000 ? "slowed to stay under eBay's daily limit" : "";
}
/* ---------------- full stock check ---------------- */
// Scans only ask eBay for the newest listings, so listings put up before FlipScout started watching were never seen.
// The stock check pages through EVERY listing for sale in each ticked category (eBay's official API, 200 per call),
// a few calls per scan, about every 3 days per category. Each listing's last_seen is refreshed, so when a pass is
// complete, Buy It Now listings it didn't find have ended (sold or withdrawn: the sold pages from a fill tell which).
// eBay returns at most 10,000 results per search, so results come cheapest first and a full search carries on from the last price.
const STOCK_CALLS = 5, STOCK_UNTIL = 0.85, STOCK_EVERY = 3 * DAY, STOCK_MAX = 100000; // every price (owner: keep all the data)
async function stockStep(env, cfg, seen, report) {
  const D = env.DB, now = Date.now(), st = await kvGet(env, "stock", { q: [], cats: {} });
  st.cats = st.cats || {};
  // start a pass for any ticked category that's due
  if (!st.q.length) {
    const due = cfg.cats.filter((c) => !st.cats[c.id] || now - (st.cats[c.id].done || 0) > STOCK_EVERY).sort((a, c) => ((st.cats[a.id] || {}).done || 0) - ((st.cats[c.id] || {}).done || 0))[0];
    if (!due) return;
    st.q.push({ cat: due.id, name: due.name, lo: 1, hi: STOCK_MAX, off: 0 });
    st.cats[due.id] = { ...(st.cats[due.id] || {}), start: now, n: 0, calls: 0, err: 0 };
  }
  const base = ["priceCurrency:GBP", "deliveryCountry:GB", "buyingOptions:{FIXED_PRICE|AUCTION}"];
  if (cfg.region === "uk") base.push("itemLocationCountry:GB");
  let calls = 0;
  while (st.q.length && calls < STOCK_CALLS) {
    const b = st.q[0], c = { id: b.cat, name: b.name }, cs = st.cats[b.cat];
    let d;
    try { calls++; cs.calls++;
      d = await ebay(env, `/buy/browse/v1/item_summary/search?category_ids=${b.cat}&limit=200&offset=${b.off}&sort=price&filter=${encodeURIComponent([...base, `price:[${b.lo}..${b.hi}]`].join(","))}`);
    } catch (e) { cs.err++; cs.lastErr = String(e.message || e).slice(0, 200); (report.errors = report.errors || []).push("stock check " + b.name + ": " + cs.lastErr);
      if (cs.err > 5) { st.q = st.q.filter((x) => x.cat !== b.cat); cs.failed = now; } break; }
    // (eBay's "total" proved unreliable here — it claimed 9,800+ even for £1–£98 — so it isn't used to plan pages)
    const got = [];
    for (const it of d.itemSummaries || []) {
      const type = (it.buyingOptions || []).includes("AUCTION") ? "AUC" : "BIN", x = toListing(it, c, type);
      if (x) { x.stock = true; got.push(x); }
    }
    seen.push(...got); cs.n += got.length;
    // refresh "last seen" even for listings that haven't changed (the normal save skips those)
    const ids = got.map((x) => x.id);
    // (and a listing once thought ended that turns up again is back on sale)
    for (let i = 0; i < ids.length; i += 90) { const ch = ids.slice(i, i + 90), q = ch.map(() => "?").join(",");
      await D.batch([D.prepare(`UPDATE listings SET last_seen=? WHERE id IN (${q})`).bind(now, ...ch),
        D.prepare(`UPDATE listings SET status='live', ended_at=NULL, ended_from=NULL WHERE id IN (${q}) AND status='gone'`).bind(...ch)]); }
    // offsets stay whole pages of 200 (eBay refused the overlapping 160-steps tried first: 1 page read, then errors).
    // A listing that slips between pages while others end is only marked ended if the NEXT pass misses it too.
    // results come cheapest first. A search stops at 10,000 results, so when a band reaches that, the next search
    // starts again from the last price reached (a few repeats at that price are harmless, nothing is skipped)
    if (got.length < 200) st.q.shift();
    else if (b.off + 200 >= 10000) {
      const last = Math.floor(Math.max(...got.map((x) => x.price)));
      st.q[0] = { ...b, lo: last > b.lo ? last : b.lo + 1, off: 0 };
    } else b.off += 200;
    // pass for this category finished: Buy It Nows not seen since it started have ended
    if (!st.q.some((x) => x.cat === b.cat)) {
      const live = await D.prepare("SELECT COUNT(*) n FROM listings WHERE cat=? AND type='BIN' AND status='live' AND last_seen>=?").bind(b.cat, cs.start).first();
      // safety: only trust a pass that found a sensible number of listings and had no errors
      // a listing has ended only when two passes in a row missed it (one pass can miss a listing that moved price band);
      // on the first pass, only listings not seen for 2+ days. It ended some time between last_seen and now.
      if (!cs.err && cs.n >= 50) {
        const r = await D.prepare("UPDATE listings SET status='gone', ended_at=?, ended_from=last_seen WHERE cat=? AND type='BIN' AND status='live' AND last_seen<? AND first_seen<?")
          .bind(now, b.cat, cs.prevStart || cs.start - 2 * DAY, cs.start).run();
        cs.gone = (r.meta && r.meta.changes) || 0;
      } else cs.gone = null;
      cs.done = now; cs.prevStart = cs.start; cs.live = live ? live.n : null;
      report.stock = { cat: b.name, listings: cs.n, calls: cs.calls, ended: cs.gone };
    }
  }
  await kvSet(env, "stock", st);
}

// What eBay says about postage, as one of:
//   free    eBay gives a fixed £0 postage          fixed   eBay gives a fixed postage price
//   est     eBay calculates it and gives its estimate   calc    eBay calculates it but gives no figure
//   unknown postage is offered but no price is given    collect collection only (no postage offered, or only pickup)
// For calc and unknown, sums use a careful allowance (POST_ALLOW, or the model's usual postage if higher) so profit is
// never overstated; the app says the postage isn't known. (Before 4 Nov these were all counted as free postage.)
const POST_ALLOW = 5;
// Postage OUT (what it costs you to send it on once sold). The price book's postage is what buyers paid, and it is
// already inside "sells for", so it is counted once. When similar items sold with free postage (0) or postage isn't
// known, you still pay to send it, so your own postage setting is used, never £0 (7 Nov 2026 profit check: 507 deals
// assumed £0). Big items cost more to send than a normal parcel, so for these categories at least this is used.
// £12 / £15 are PROVISIONAL ESTIMATES (owner-approved for testing, 7 Nov 2026), not real shipping quotes.
// It only ever raises the postage, never lowers it below your setting or what buyers paid.
const BULKY_POST = [[/monitor|television|\btvs?\b|projector/i, 12], [/desktop|all-in-one|pc tower|server|computer case|printer/i, 15]];
function bulkyPost(catName) { for (const [re, v] of BULKY_POST) if (re.test(String(catName || ""))) return v; return 0; }
function postOutFor(bookPost, r, catName) {
  const sold = bookPost > 0 ? bookPost : null, base = sold != null ? sold : r.post, size = bulkyPost(catName);
  return size > base ? { post: size, src: "size" } : { post: base, src: sold != null ? "sold" : "setting" };
}
function postageOf(it) {
  const L = (it.shippingOptions || []).filter(Boolean), pickup = (it.pickupOptions || []).length > 0;
  if (!L.length) return { ship: 0, post: "collect" };
  const calc = L.some((o) => /CALCULATED/i.test(o.shippingCostType || ""));
  const priced = L.find((o) => o.shippingCost && Number.isFinite(parseFloat(o.shippingCost.value)));
  if (priced) { const v = parseFloat(priced.shippingCost.value); return { ship: v, post: calc ? "est" : v === 0 ? "free" : "fixed" }; }
  if (calc) return { ship: 0, post: "calc" };
  if (pickup) return { ship: 0, post: "collect" };
  return { ship: 0, post: "unknown" };
}
const postUnknown = (s) => s && (s.post === "calc" || s.post === "unknown");
// one eBay search result → the listing record FlipScout keeps (used by scans and the full stock check)
function toListing(it, c, type) {
  const id = it.legacyItemId || String(it.itemId || "").split("|")[1];
  if (!id) return null;
  const auction = type === "AUC";
  const pr = auction && it.currentBidPrice ? it.currentBidPrice : it.price;
  // eBay UK normally gives every price in pounds; a price in another currency would be read as pounds, so skip it
  if (pr && pr.currency && pr.currency !== "GBP") return null;
  const price = pr ? parseFloat(pr.value) : 0;
  const { ship, post } = postageOf(it);
  // collection only: eBay sends no postage option (or only local pickup). Not "free post"
  const collect = post === "collect";
  const bucket = condBucket(it.conditionId);
  return {
    id, cat: c.id, catName: c.name, title: it.title || "", cond: it.condition || "", condId: it.conditionId || "", bucket,
    type, price, ship, post, bids: +it.bidCount || 0, end: it.itemEndDate ? Date.parse(it.itemEndDate) : null,
    created: it.itemCreationDate ? Date.parse(it.itemCreationDate) : null,
    seller: it.seller ? { name: it.seller.username || "", fb: +it.seller.feedbackScore || 0, pct: parseFloat(it.seller.feedbackPercentage) || 0, biz: it.seller.sellerAccountType === "BUSINESS" } : { name: "", fb: 0, pct: 0 },
    loc: (it.itemLocation && it.itemLocation.country) || "", img: it.image ? it.image.imageUrl : "",
    url: "https://www.ebay.co.uk/itm/" + id, bestOffer: (it.buyingOptions || []).includes("BEST_OFFER"),
    collect, where: collect ? String((it.itemLocation && (it.itemLocation.postalCode || it.itemLocation.city)) || "").replace(/\*+/g, "").trim().slice(0, 20) : "",
    ...(() => { const g = groupOf(it, c.id, c.name, bucket), w = groupOf(it, c.id, c.name, "used"); return { pkey: g ? g.key : null, matchLabel: g ? g.label : "", matchQ: g ? g.match : 0, workKey: w ? w.key : null, workQ: w ? w.match : 0 }; })(),
  };
}
// ONE SCAN AT A TIME (9 Nov 2026): manual + manual, manual + background and background + background used to be able to
// run together (each read "when was the last scan?" before the other wrote it), doubling eBay calls. A scan now has to
// claim a lease first, in ONE database statement (the row is only written if no unexpired lease is there), so only one
// request can win. The lease is given back when the scan ends; if a scan is cut off, it runs out on its own after
// SCAN_LEASE (longer than Cloudflare lets a scheduled job run), so it can never block scans for ever.
const SCAN_LEASE = 15 * 60000;
async function scanClaim(env, now) {
  const until = String(now + SCAN_LEASE + Math.random()); // unique, so only the holder can give it back
  const r = await env.DB.prepare("INSERT INTO kv(k,v) VALUES('scanLock',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v WHERE CAST(kv.v AS REAL) < ?").bind(until, now).run();
  return r && r.meta && r.meta.changes === 1 ? until : null;
}
async function scanRelease(env, until) { try { await env.DB.prepare("UPDATE kv SET v='0' WHERE k='scanLock' AND v=?").bind(until).run(); } catch (e) {} }

// TIME LIMITS (9 Nov 2026), so a scan always ends well inside its 15-minute lease, even if eBay stops answering:
//  - every outside network call gives up after NET_TIMEOUT (eBay, eBay sign-in, Google alerts)
//  - inside a scan, no new network call starts after SCAN_SOFT (the scan saves what it has and says it's incomplete)
//  - after SCAN_HARD, no database query or network call runs at all inside that scan
// Worst case: SCAN_HARD + one call already running (Cloudflare stops a database query after 30 s; ours after 20 s)
// + a little processing = about 11 minutes, leaving room for clock differences before the lease runs out.
// kv "scanLimits" can make these shorter (used by the tests), never longer.
const NET_TIMEOUT = 20000, SCAN_SOFT = 8 * 60000, SCAN_HARD = 10 * 60000;
function scanLimits(v) {
  const pick = (x, d) => (Number.isFinite(+x) && +x > 0 ? Math.min(+x, d) : d), o = v || {};
  const hard = pick(o.hard, SCAN_HARD);
  return { soft: Math.min(pick(o.soft, SCAN_SOFT), hard), hard, net: pick(o.net, NET_TIMEOUT) };
}
const scanErr = (msg, flag) => Object.assign(new Error(msg), { [flag]: true });
// the env a scan runs with: the same bindings, but its database refuses every query once the hard stop has passed
function scanScope(env, t0, lim) {
  const sc = { soft: t0 + lim.soft, hard: t0 + lim.hard, net: lim.net, budget: false }, raw = env.DB;
  const chk = () => { if (Date.now() > sc.hard) throw scanErr("stopped at the scan's safety limit", "scanStop"); };
  const wrap = (st) => ({ __st: st, bind: (...a) => wrap(st.bind(...a)), run: async (...a) => { chk(); return st.run(...a); },
    all: async (...a) => { chk(); return st.all(...a); }, first: async (...a) => { chk(); return st.first(...a); }, raw: async (...a) => { chk(); return st.raw(...a); } });
  return { ...env, __scan: sc, DB: { prepare: (q) => wrap(raw.prepare(q)), batch: async (list) => { chk(); return raw.batch(list.map((x) => (x && x.__st) || x)); } } };
}
// reading an answer is covered by the same timeout (Cloudflare cancels a stalled body read when the signal fires);
// this only gives that timeout the same clear wording as one before the headers arrive. Every other error is unchanged.
async function timedBody(env, p) {
  try { return await p; }
  catch (e) { if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`no answer within ${Math.round((((env && env.__scan) || {}).net || NET_TIMEOUT) / 1000)} seconds`); throw e; }
}
// every outside network call goes through here
async function xfetch(env, url, opts = {}) {
  const sc = env && env.__scan;
  if (sc) { const t = Date.now();
    if (t > sc.hard) throw scanErr("stopped at the scan's safety limit", "scanStop");
    if (t > sc.soft) { sc.budget = true; throw scanErr("not started: the scan's time budget was used up", "scanBudget"); } }
  const ms = (sc && sc.net) || NET_TIMEOUT;
  try { return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) }); }
  catch (e) { if (e && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`no answer within ${Math.round(ms / 1000)} seconds`); throw e; }
}

async function sweep(env, manual) {
  await schema(env);
  const cfg0 = cleanConfig(await kvGet(env, "config", null));
  // only the ticked categories are searched (all of them if none are ticked)
  const on = cfg0.cats.filter((c) => !c.off), cfg = { ...cfg0, cats: on.length ? on : cfg0.cats };
  if (!cfg.interval) cfg.interval = autoInterval(cfg.cats.length);
  const now = Date.now();
  const last = await kvGet(env, "lastRun", 0);
  if (!manual) {
    if (cfg.paused || !cfg.cats.length) return { skipped: "nothing to hunt" };
    if (now - last < cfg.interval * 60000 - 30000) return { skipped: "not due" };
  }
  if (!cfg.cats.length) return { error: "Add some categories first." };
  // stay under eBay's 5,000 calls a day: near the limit, scans space themselves out so calls last until midnight (UTC)
  if (!manual) { const why = paceSkip(await quota(env), now, cfg.cats.length, cfg.interval, now - last); if (why) return { skipped: why }; }
  const lease = await scanClaim(env, now);
  if (!lease) return manual ? { busy: true, error: "A scan is already running. Try again in a minute." } : { skipped: "another scan is running" };
  // from here on the scan runs inside its time limits (see scanScope); the lease is always given back with the real env
  const rawEnv = env, report = { checked: 0, newDeals: 0, hidden: 0, errors: [] };
  env = scanScope(rawEnv, now, scanLimits(await kvGet(rawEnv, "scanLimits", null)));
  try {
  await kvSet(env, "lastRun", now);
  const D = env.DB, r = cfg.rules;

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
  // 0d. one-off (26 Oct 2026, owner approved): delete price groups made by old matching mistakes —
  // "similar title" groups keyed only by a size or generation ("32gb", "10th") and laptops misread as "1th gen"
  if (!(await kvGet(env, "fix3", false))) {
    const rows = await D.prepare("SELECT pkey FROM prices WHERE pkey LIKE 't%' OR pkey LIKE 'lap:intel-%-g1|%'").all();
    const bad = (rows.results || []).map((r) => r.pkey).filter((k) => k.startsWith("lap:") ||
      !k.replace(/^t\d*:/, "").replace(/\|[^|]*$/, "").split(" ").some((w) => /\d/.test(w) && !UNIT_TOKEN.test(w)));
    for (let i = 0; i < bad.length; i += 45) {
      const part = bad.slice(i, i + 45), q = part.map(() => "?").join(",");
      await D.batch([D.prepare(`DELETE FROM prices WHERE pkey IN (${q})`).bind(...part), D.prepare(`DELETE FROM fillsales WHERE pkey IN (${q})`).bind(...part)]);
    }
    const fc = await kvGet(env, "fillCats", {}), gone = new Set(bad);
    for (const c in fc) for (const k in (fc[c].k || {})) if (gone.has(k)) delete fc[c].k[k];
    await kvSet(env, "fillCats", fc);
    await kvSet(env, "fix3", { at: now, deleted: bad });
  }
  // 0g. one-off (30 Oct 2026, owner approved after the deal audit): new matching rules reach saved data.
  //  (1) console sold prices from fills are moved to backup tables and cleared (saved before titles were kept, so they
  //      can't be re-sorted; the owner refills Consoles); (2) every saved listing is re-matched, a batch per scan;
  //  (3) then auction sales learned from those listings follow their listing's new model, and for-sale counts refresh.
  try { await cleanup5(env, cfg, report); } catch (e) { report.errors.push("cleanup: " + e.message); }
  // 0f. one-off (29 Oct 2026, owner approved): rebuild each category's "days read in full" from the saved sale dates
  // with the stray-date rule, then recalculate every model's sales rate. Raw sales are not touched.
  // (cover3: run again after the busy-day rule was corrected the same evening)
  if ((await kvGet(env, "seen1", false)) && !(await kvGet(env, "cover3", false))) {
    try { await kvSet(env, "cover3", { at: now, ...(await rebuildCover(env, now)) }); } catch (e) { report.errors.push("cover3: " + e.message); }
  }
  // 0e. one-off (29 Oct 2026): fill sales saved before the "already saved" check existed go into fillseen too,
  // then listings seen for sale are matched against them (adds rows only; never changes or deletes existing data)
  if (!(await kvGet(env, "seen1", false))) {
    try {
      const fc = await kvGet(env, "fillCats", {}), catOf = {}, rows = [];
      for (const c in fc) for (const k in (fc[c].k || {})) if (!catOf[k]) catOf[k] = c;
      const all = await D.prepare("SELECT pkey, data FROM fillsales").all();
      for (const f of all.results || []) { let list = []; try { list = JSON.parse(f.data); } catch (e) {}
        for (const r of list) if (r && r[0]) rows.push([String(r[0]), catOf[f.pkey] || "", Math.round(((+r[1] || 0) + (+r[2] || 0)) * 100) / 100, +r[3] || null]); }
      await seenAdd(env, rows); const n = await markSold(env, rows); await sellStats(env);
      await kvSet(env, "seen1", { at: now, rows: rows.length, sold: n });
    } catch (e) { report.errors.push("seen1: " + e.message); }
  }
  // 1. auctions that have ended become sold prices (only if they had bids)
  // (the free database allows 5 million rows read a day, so every query here must use an index)
  await D.batch([
    D.prepare("INSERT OR IGNORE INTO sales (id,pkey,cat,price,kind,at) SELECT id,pkey,cat,price+ship,'auction',end_at FROM listings WHERE status='live' AND end_at<? AND end_at>? AND type='AUC' AND bids>0 AND pkey IS NOT NULL").bind(now, now - 2 * DAY),
    D.prepare("UPDATE listings SET status='ended' WHERE status='live' AND end_at<? AND end_at>? AND type='AUC'").bind(now, now - 2 * DAY),
    D.prepare(`INSERT OR REPLACE INTO deal_out (id, at, why, price, title) SELECT id, ${now}, 'expired', json_extract(data,'$.price'), substr(json_extract(data,'$.title'),1,120) FROM deals WHERE expires<?`).bind(now),
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

  // "most I'll spend on one item": eBay only sends listings priced under it (postage and fees are checked when judging)
  const base = ["priceCurrency:GBP", "deliveryCountry:GB", `price:[1..${r.maxSpend > 0 ? Math.ceil(Math.min(3000, r.maxSpend)) : 3000}]`];
  if (cfg.region === "uk") base.push("itemLocationCountry:GB");
  const seen = [];
  for (const c of cats) {
    if (Date.now() > env.__scan.soft) { env.__scan.budget = true; break; } // time budget used: the rest waits for the next scan
    const calls = [];
    // fewer categories ticked = each one searched deeper: 1–2 categories get up to 400 newest Buy It Nows and 200 ending auctions
    const deep = cfg.cats.length <= 2 ? 2 : cfg.cats.length <= 4 ? 1 : 0;
    if (cfg.types.bin || cfg.types.misspelt || cfg.types.spares) {
      // a call costs the same whatever the number of results, so always ask for eBay's maximum (200)
      calls.push(["BIN", "buyingOptions:{FIXED_PRICE}", "newlyListed", 200, 0]);
      if (deep === 2) calls.push(["BIN", "buyingOptions:{FIXED_PRICE}", "newlyListed", 200, 200]);
    }
    if (cfg.types.auction || cfg.types.spares) calls.push(["AUC", "buyingOptions:{AUCTION}", "endingSoonest", deep === 2 ? 200 : 100, 0]);
    // newly listed auctions too, for "Ending later" (high-start auctions days away): 200 at a time, so every 40 minutes is plenty
    if (cfg.types.auction && (manual || Math.floor(now / 600000) % 4 === 0)) calls.push(["AUC", "buyingOptions:{AUCTION}", "newlyListed", 200, 0]);
    for (const [type, f, sort, lim, off] of calls) {
      try {
        const d = await ebay(env, `/buy/browse/v1/item_summary/search?category_ids=${c.id}&limit=${lim}${off ? "&offset=" + off : ""}&sort=${sort}&filter=${encodeURIComponent([...base, f].join(","))}`);
        for (const it of d.itemSummaries || []) { const x = toListing(it, c, type); if (x) seen.push(x); }
        report.checked++;
      } catch (e) { report.errors.push(c.name + ": " + e.message); }
    }
  }
  // full stock check: every listing for sale in your categories, a few pages per scan (see stockStep)
  if ((await quota(env)) + CALLS < EBAY_DAILY * STOCK_UNTIL) {
    try { await stockStep(env, cfg, seen, report); } catch (e) { report.errors.push("stock check: " + e.message); }
  }
  if (!seen.length) { scanNote(env, report); await saveQuota(env); await kvSet(env, "lastReport", { at: now, ...report }); return report; }

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
    "INSERT INTO listings (id,cat,pkey,title,cond,type,price,ship,bids,end_at,first_seen,last_seen,status,data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'live',?) ON CONFLICT(id) DO UPDATE SET price=excluded.price, ship=excluded.ship, bids=excluded.bids, last_seen=excluded.last_seen, end_at=excluded.end_at, status=CASE WHEN listings.status IN ('gone','sold') THEN listings.status ELSE 'live' END, data=excluded.data"
  ).bind(s.id, s.cat, s.pkey, s.title.slice(0, 200), s.bucket, s.type, s.price, s.ship, s.bids, s.end, s.created || now, now, s.learn ? null : JSON.stringify(s)));
  for (let i = 0; i < up.length; i += 50) await D.batch(up.slice(i, i + 50));
  report.saved = up.length;

  // 3b. also re-judge recent live listings from these categories that weren't in this run's results.
  // As sold history grows, listings we couldn't price yesterday can become deals today.
  const seenIds = new Set(ids);
  const why = { noData: 0, risky: 0, fair: 0, over: 0, lowScore: 0 }, close = [];
  const cands = seen.filter((s) => !s.learn);
  {
    const rowsAll = [];
    // when your rules or categories change, look back 3 days so listings skipped under the old rules get a second look
    // (e.g. raising the spending limit from £200 to £500 brings back cards between the two); otherwise the last day
    const sig = JSON.stringify([r, cfg.cats.map((c) => c.id)]), wide = sig !== (await kvGet(env, "rulesSig", ""));
    report.rejudged = wide ? "wide" : "normal";
    const back = wide ? 3 * DAY : DAY, lim = wide ? 1000 : 300;
    for (const c of (wide ? cfg.cats : cats)) {
      const rr = await D.prepare("SELECT id, data, status, end_at, last_seen FROM listings WHERE cat=? AND first_seen>? ORDER BY first_seen DESC LIMIT ?").bind(c.id, now - back, lim).all();
      for (const x of rr.results || []) if (x.status === "live" && x.data && x.last_seen > now - back && (!x.end_at || x.end_at > now + 5 * 60000)) rowsAll.push(x);
    }
    // every deal already on the list is judged again too, so new rules and new prices reach it straight away
    // (an auction listed days ago and ending tonight isn't in the newest or ending-soonest results yet)
    const dl = await D.prepare("SELECT l.id, l.data, l.status, l.end_at, l.last_seen FROM deals d JOIN listings l ON l.id = d.id WHERE d.expires > ? LIMIT ?").bind(now, DEALS_MAX).all();
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
    const br = await D.prepare(`SELECT pkey, avg, st, post, trend, at, src, n, lo, hi, spd, sdays, sn, act, act_at, q FROM prices WHERE pkey IN (${bk.map(() => "?").join(",")}) AND at>?`).bind(...bk, now - BOOK_DAYS * DAY).all();
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
      // more sales behind the price = more trust: 5 sales is a hint, 30+ is solid evidence
      const bn = b.n || 0; ev *= bn >= 30 ? 1 : bn >= 15 ? 0.9 : bn >= 10 ? 0.8 : 0.6;
      if (sold.length >= 3) { const off = Math.abs(median(sold) - med) / med; ev *= off < 0.15 ? 1 : off < 0.3 ? 0.85 : 0.65; } // agrees with what we've seen sell?
      // the cheap end: the real 25th percentile when the fill recorded it (its "sells for" is already careful), else 15% under
      let low = b.lo != null ? Math.min(b.lo + (post || 0), med) : med * 0.85;
      if (b.trend === "falling") low = Math.min(low, med * 0.8);
      if (b.st != null && b.st < 25) low = Math.min(low, med * 0.8); // slow sellers: plan for a lower price
      const bs = b.lo != null && b.hi != null && b.avg > 0 ? (b.hi - b.lo) / b.avg : 0.15;
      return { med, low, n: sold.length, src: "book", fill: b.src === "fill", bookN: b.n || null, spread: bs, ev, st: b.st, post, trend: b.trend, at: b.at, lo: b.lo != null ? b.lo + (post || 0) : null, hi: b.hi != null ? b.hi + (post || 0) : null, lastAt: b.at, row: b };
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
  const deals = [], spares = [], later = [], whyId = {}; // whyId: why each listing isn't a deal (kept for removed deals)
  let hidden = 0;
  for (const s of cands) {
    // postage calculated by eBay without a figure, or not stated: count a careful allowance, never £0 (see postageOf)
    if (postUnknown(s)) { s.ship = POST_ALLOW; s.shipAllow = true; }
    // eBay only charges buyers its protection fee on private sellers' items (business sellers' items have none).
    // If eBay doesn't say which kind of seller it is, the fee is counted, to be safe.
    const pf = !!r.bpf && !(s.seller && s.seller.biz);
    const extra = pf ? bpf(s.price) : 0;
    if (s.bucket === "parts") {
      if (!cfg.types.spares) continue;
      const m = market(s.workKey, s.id, s.workQ || 0.5);
      if (!m || s.price + s.ship > m.med * 0.6) continue;
      if (SCAM_WORDS.test(s.title)) { hidden++; whyId[s.id] = "scam shield"; continue; }
      const sales = m.src === "asking" ? 0 : m.src === "book" ? (m.bookN || m.n || 0) : m.n;
      spares.push({ ...s, kind: "spares", tags: sales === 0 ? ["Price not confirmed by sales"] : sales < MIN_SALES ? ["Few sales behind the price"] : [], score: 0, cost: Math.round((s.price + s.ship + extra) * 100) / 100, workMed: Math.round(m.med), n: m.n, src: m.src, sales, bookN: m.bookN || null });
      continue;
    }
    if (RISK_WORDS.test(s.title)) { why.risky++; whyId[s.id] = "risky"; continue; }
    if (MULTI_VAR.test(s.title)) { why.noData++; whyId[s.id] = "noData"; continue; }
    if (FAKE_SSD(s.title)) { why.risky++; whyId[s.id] = "risky"; continue; }
    if (BOX_END.test(s.title)) { hidden++; whyId[s.id] = "scam shield"; continue; }
    const m = market(s.pkey, s.id, s.matchQ || 0.5);
    if (!m) { why.noData++; whyId[s.id] = "noData"; continue; }
    if (s.shipAllow && m.post > s.ship) s.ship = Math.round(m.post * 100) / 100; // this model usually costs more to post
    // prices from fewer than 8 sales were often wrong (5–9 sales: 37% within 10% in the 29 Oct accuracy test)
    if ((m.src === "book" ? m.bookN || m.n : m.n) < MIN_SALES) { why.noData++; whyId[s.id] = "under " + MIN_SALES + " sales"; continue; }
    if (m.spread > 0.9 && (s.matchQ || 0.5) < 0.8) { why.noData++; whyId[s.id] = "noData"; continue; } // prices all over the place: not confident
    // a loose match (similar title, not a known model) needs tight, consistent prices to be trusted
    if ((s.matchQ || 0.5) < 0.6 && m.spread > 0.5) { why.noData++; whyId[s.id] = "noData"; continue; }
    const cost = s.price + s.ship + extra;
    // over your "most I'll spend on one item" (total incl. postage and buyer fee; for auctions, today's bid + postage)
    if (r.maxSpend > 0 && (s.type === "AUC" ? s.price + s.ship : cost) > r.maxSpend) { why.over++; whyId[s.id] = "over"; continue; }
    if (cost < m.med * 0.4 && (s.seller.fb < 5 || s.seller.pct < 95 || SCAM_WORDS.test(s.title))) { hidden++; whyId[s.id] = "scam shield"; continue; }
    if (SCAM_WORDS.test(s.title)) { hidden++; whyId[s.id] = "scam shield"; continue; }
    // a Buy It Now at under a fifth of what it sells for is almost always a box, a photo, a code or a scam
    // under 40% of the usual price is almost always the wrong item, a fault or a scam (30 Oct audit), so it isn't shown
    if (s.type !== "AUC" && cost < m.med * HIDE_BELOW) { hidden++; whyId[s.id] = "far below usual price"; continue; }
    const po = postOutFor(m.post, r, s.catName), ri = { ...r, post: po.post }; // postage out for this product (see postOutFor)
    // the most to pay in total, never above your spending limit (so max bids and max offers stay under it too)
    const mp = r.maxSpend > 0 ? Math.min(maxPay(m.med, m.low, ri), r.maxSpend) : maxPay(m.med, m.low, ri);
    if (mp <= 0) { why.fair++; whyId[s.id] = "fair"; continue; }
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
      maxBid = Math.floor(((slow ? mp - r.minProfit * 0.5 : mp) - s.ship - (pf ? bpf(mp) : 0)) * 100) / 100;
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
    const speed = m.row ? speedOf(m.row, now) : null;
    const dem = m.st != null ? (m.st >= 60 ? 1 : m.st >= 40 ? 0.8 : m.st >= 25 ? 0.55 : 0.25)
      : speed && speed.band ? ({ fast: 1, normal: 0.7, slow: 0.35, none: 0.6 })[speed.band] : 0.6;
    let score = Math.round(25 * ev + 20 * match + 15 * sel + 20 * mar + 10 * comp + 10 * dem);
    if (m.src === "asking") { score = Math.min(score, r.alertScore - 1, 69); tags.push("Price not confirmed by sales"); }
    const verified = !!VERIFIED_CATS[String(s.cat)];
    if (!verified) { score = Math.min(score, r.alertScore - 1, 69); tags.push("Not verified yet"); }
    // far below the usual price (Buy It Now only; auctions start low): usually the wrong item, a hidden fault, a locked phone
    // or a scam. Still shown, so real bargains aren't missed, but never above Medium and never alerted.
    const veryCheap = s.type === "BIN" && m.med > 0 && (s.price + s.ship) < m.med * VERY_CHEAP;
    if (veryCheap) { score = Math.min(score, r.alertScore - 1, 69); tags.push("Very cheap"); }
    if (m.src === "book") tags.push(m.fill ? "Price from category check" : "Price from price book");
    if (m.src === "book" && m.bookN && m.bookN < 10) tags.push("Few sales behind the price");
    if (po.src === "size") tags.push("Large item to post");
    if (SPECIAL.test(s.title)) tags.push("Special version");
    if (s.shipAllow) tags.push("Postage not known"); else if (s.post === "est") tags.push("Postage estimated");
    if (slow) tags.push("Slow seller");
    if (m.trend === "falling") tags.push("Prices falling");
    if (score < r.minScore) { why.lowScore++; whyId[s.id] = "lowScore"; continue; }
    (s.type === "AUC" && s.end - now > 12 * 3600e3 ? later : deals).push({
      ...s, kind: "deal", bpfOn: pf, cost: Math.round(cost * 100) / 100, extra: Math.round(extra * 100) / 100,
      profit: Math.round(profit * 100) / 100, lowProfit: Math.round(lowProfit * 100) / 100, roi: Math.round(roi),
      maxPay: Math.floor(mp * 100) / 100, maxBid,
      // the most to pay for the item itself (before postage and fee), and profit if you pay exactly that
      maxItem: s.type === "AUC" ? maxBid : Math.floor((mp - s.ship - (pf ? bpf(mp) : 0)) * 100) / 100,
      profitAtMax: (() => { const it = s.type === "AUC" ? maxBid : Math.floor((mp - s.ship - (pf ? bpf(mp) : 0)) * 100) / 100; return Math.round((m.med - sellFee(m.med, r) - out - (it + s.ship + (pf ? bpf(it) : 0))) * 100) / 100; })(),
      med: Math.round(m.med * 100) / 100, low: Math.round(m.low * 100) / 100,
      n: m.n, src: m.src, fill: !!m.fill, bookN: m.bookN || null, score, parts: { evidence: ev, match, seller: sel, margin: mar, competition: comp, demand: dem }, tags,
      sellFee: Math.round(sellFee(m.med, r) * 100) / 100, out: Math.round(out * 100) / 100, postSrc: po.src,
      // comparable sales behind "sells for" (asking-price guesses have none)
      sales: m.src === "asking" ? 0 : m.src === "book" ? (m.bookN || m.n || 0) : m.n,
      st: m.st != null ? m.st : null, trend: m.trend || null, bookAt: m.at || null, speed, speedKey: m.row && m.row.sn >= SPEED_MIN_SALES ? m.row.pkey : null,
      // evidence shown on the deal page: typical price range and how recent the newest evidence is
      rangeLo: m.lo != null ? Math.round(m.lo) : null, rangeHi: m.hi != null ? Math.round(m.hi) : null, lastAt: m.lastAt || null,
      look: lookInfo(s, market(s.pkey, s.id, s.matchQ || 0.5, true)),
    });
  }
  report.hidden = hidden;
  report.why = { ...why, judged: cands.length };
  report.seen = seen.length;
  // today's running totals, so the app can explain "why only N deals?" over the whole day, not just one check
  try {
    const wd = await kvGet(env, "whyDay", null), t = wd && wd.d === today() ? wd : { d: today(), scans: 0, judged: 0, noData: 0, risky: 0, fair: 0, over: 0, lowScore: 0, hidden: 0, deals: 0 };
    t.scans++; t.judged += cands.length; t.hidden += hidden; t.deals += deals.length;
    for (const k of Object.keys(why)) t[k] = (t[k] || 0) + why[k];
    await kvSet(env, "whyDay", t);
  } catch (e) {}
  // ending later: cheap high-start auctions with days left. Shown with a Follow button, never alerted
  try {
    const keep = new Set(cands.map((s) => s.id)), mk = (d) => ({ id: d.id, collect: d.collect, where: d.where, post: d.post, shipAllow: d.shipAllow, title: d.title, img: d.img, url: d.url, cond: d.cond, cat: d.cat, catName: d.catName, type: "AUC",
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

  // 5b. sell speed: count how many of each deal's model are for sale now (official API, a few models per run, each refreshed every 3 days)
  try {
    const need = new Map();
    for (const d of deals) { const b = d.speedKey && bookBy[d.speedKey]; if (b && (!b.act_at || now - b.act_at > 3 * DAY) && !need.has(b.pkey)) need.set(b.pkey, { b, d }); }
    // categories the full stock check has read completely: count the model's live listings straight from the database
    // (the old one-search estimate found 2 of an i7 10th-gen 16GB/256GB laptop where the stock check had 21: 30 Oct audit)
    const stockCats = (await kvGet(env, "stock", { cats: {} })).cats || {};
    for (const [pk, { b, d }] of [...need]) {
      const sc = stockCats[String(d.cat)];
      if (!sc || !sc.done) continue;
      const r0 = await D.prepare("SELECT COUNT(*) n FROM listings WHERE pkey IN (?, ?) AND first_seen>0 AND status='live' AND last_seen>?").bind(d.pkey || pk, pk, now - 4 * DAY).first();
      b.act = r0 ? r0.n : 0; b.act_at = now;
      await D.prepare("UPDATE prices SET act=?, act_at=? WHERE pkey=?").bind(b.act, now, b.pkey).run();
      need.delete(pk);
    }
    const spare = (await quota(env)) + CALLS < EBAY_DAILY * 0.8; // never let this eat into the deal hunt's calls
    for (const { b, d } of spare ? [...need.values()].slice(0, 6) : []) {
      const q = String(b.q || "").split(/\s+/).filter((w) => w && !w.startsWith("-")).join(" ").slice(0, 100);
      if (!q) continue;
      // same as the sold pages FlipScout reads: UK, condition "Used" (3000)
      const f = ["priceCurrency:GBP", "deliveryCountry:GB", "itemLocationCountry:GB", "buyingOptions:{FIXED_PRICE|AUCTION}", "conditionIds:{3000}"];
      const res = await ebay(env, `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&category_ids=${d.cat}&limit=200&filter=${encodeURIComponent(f.join(","))}`);
      const items = res.itemSummaries || [], total = +res.total || items.length;
      // only listings that are really this model, used, and not spares
      const same = items.filter((it) => { if (FILL_SKIP.test(it.title || "") || String(it.conditionId || "3000") !== "3000") return false; const g = groupOf(it, d.cat, d.catName, "used"); return g && g.match >= 0.6 && bareKey(g.key) === bareKey(b.pkey); }).length;
      const act = items.length ? Math.round(total > items.length ? same / items.length * total : same) : 0;
      await D.prepare("UPDATE prices SET act=?, act_at=? WHERE pkey=?").bind(act, now, b.pkey).run();
      b.act = act; b.act_at = now;
    }
    for (const d of deals) if (d.speedKey && bookBy[d.speedKey]) d.speed = speedOf(bookBy[d.speedKey], now);
  } catch (e) { report.errors.push("sell speed: " + e.message); }

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
    // deal diary: first sighting of each deal only (best effort: a diary problem never stops the hunt)
    try {
      const ins = deals.filter((d) => !existing[d.id]).map((d) => D.prepare(`INSERT OR IGNORE INTO ${DIARY_COLS.table} (${DIARY_COLS.cols.join(",")}) VALUES (${DIARY_COLS.cols.map(() => "?").join(",")})`).bind(...diaryRow(d, now)));
      for (let i = 0; i < ins.length; i += 50) await D.batch(ins.slice(i, i + 50));
    } catch (e) { report.errors.push("deal diary: " + e.message); }
    // new deals per day (last 8 days), so Admin can show what share of deals get flagged
    try { const nd = await kvGet(env, "newDealsDay", {}), dd = today(); nd[dd] = (nd[dd] || 0) + report.newDeals;
      for (const k of Object.keys(nd)) if (Date.parse(k) < now - 8 * DAY) delete nd[k]; await kvSet(env, "newDealsDay", nd); } catch (e) {}
  }
  // listings we just judged that are no longer deals (price went up, bids passed our max): take them off the list
  {
    const keep = new Set(all.map((d) => d.id));
    const drop = cands.map((s) => s.id).filter((id) => !keep.has(id));
    for (let i = 0; i < drop.length; i += 90) {
      const chunk = drop.slice(i, i + 90);
      try { await dealOut(env, chunk, (id) => "rules: " + (whyId[id] || "not a deal any more")); } catch (e) {}
      await D.prepare(`DELETE FROM deals WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).run();
    }
  }
  // 7b. make sure the deals on the list are still for sale (a few per run, oldest check first)
  {
    const fresh = deals.filter((d) => !d.old).map((d) => d.id);
    for (let i = 0; i < fresh.length; i += 90) { const part = fresh.slice(i, i + 90); await D.prepare(`UPDATE deals SET checked=? WHERE id IN (${part.map(() => "?").join(",")})`).bind(now, ...part).run(); }
  }
  report.gone = await verifyDeals(env, 6);
  // read every deal's description once (official API, one call each, best deals first): faults written only in the
  // description ("battery won't hold charge", "no charger") tag the deal and cap its score
  if ((await quota(env)) + CALLS < EBAY_DAILY * 0.85) try {
    const nd = await D.prepare("SELECT id FROM deals WHERE expires>? AND json_extract(data,'$.descAt') IS NULL ORDER BY score DESC LIMIT 10").bind(now).all();
    let checked = 0, faulty = 0;
    for (const r0 of nd.results || []) { const v = await checkLive(env, r0.id); checked++; if (v.fault) faulty++; }
    if (checked) report.descChecked = { checked, faulty };
  } catch (e) { report.errors.push("description check: " + e.message); }
  // sold details (upload time, seller, format) for sold items from fills, once the owner has connected their eBay account
  try { await soldDetails(env, report); if (report.soldDetails && report.soldDetails.found) await sellStats(env); } catch (e) { report.errors.push("sold details: " + e.message); }

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
      if (d.kind !== "deal" || !VERIFIED_CATS[String(d.cat)]) continue; // never alert on unchecked categories
      const v = await checkLive(env, d.id);
      if (v.fault) continue; // the description mentions a fault: no alert
      if (!v.live || v.tooDear) continue; // sold, ended or now too dear (and removed): no alert
      // claim it first: if another scan running at the same moment already took it, don't send it again
      const claim = await D.prepare("UPDATE deals SET notified=1 WHERE id=? AND notified=0").bind(d.id).run();
      if (!(claim && claim.meta && claim.meta.changes)) continue;
      const c = v.deal ? { ...d, ...v.deal } : d; // the figures just re-checked, not the ones from before
      const msg = c.type === "AUC"
        ? `Bid up to £${c.maxBid.toFixed(2)} (now £${c.price.toFixed(2)}). Score ${c.score}.`
        : `£${c.cost.toFixed(2)} now, about £${c.profit.toFixed(0)} profit. Score ${c.score}.`;
      await push(env, d.title.slice(0, 80), msg, { url: d.url, id: d.id, kind: "deal" });
    }
    await D.prepare("UPDATE deals SET notified=1 WHERE notified=0").run();
  }
  else if (isQuiet(cfg, now)) await D.prepare("UPDATE deals SET notified=1 WHERE notified=0").run(); // quiet hours: no catch-up flood in the morning
  await saveQuota(env);
  report.ebayToday = await quota(env);
  // listings being tracked: for sale and seen in the last 4 days (the full stock check revisits each category
  // about every 3 days), per category, so the app can show a running total
  // (counted every 30 minutes, not every scan: it reads the whole listings table, and the database struggled under it)
  try {
    const prev = await kvGet(env, "tracked", null);
    if (prev && now - prev.at < 30 * 60000) report.tracked = prev.m;
    else {
      const tr = await D.prepare("SELECT cat, COUNT(*) n FROM listings WHERE status='live' AND last_seen>? GROUP BY cat").bind(now - 4 * DAY).all();
      report.tracked = Object.fromEntries((tr.results || []).map((r) => [String(r.cat), r.n]));
      await kvSet(env, "tracked", { at: now, m: report.tracked });
    }
  } catch (e) {}
  scanNote(env, report);
  await kvSet(env, "lastReport", { at: now, ...report, cats: cats.map((c) => c.name) });
  // remember the rules this scan used: a change triggers the 3-day second look on the next scan
  await kvSet(env, "rulesSig", JSON.stringify([r, cfg.cats.map((c) => c.id)]));
  return report;
  } catch (e) {
    // the hard stop: nothing more can run, so report what happened (with the real env) and let the next scan carry on
    if (!e || !e.scanStop) throw e;
    report.incomplete = "safety limit";
    report.errors = report.errors.filter((x) => !/time budget was used up|safety limit/.test(x));
    report.errors.unshift("Scan stopped early (safety limit reached): the rest is checked next time. Deals already found are kept.");
    try { await kvSet(rawEnv, "lastReport", { at: now, ...report }); } catch (x) {}
    return report;
  } finally { await scanRelease(rawEnv, lease); }
}
// a scan that used up its time budget says so (once), so the app shows it and the next scan carries on
function scanNote(env, report) {
  if (!env.__scan || !env.__scan.budget || report.incomplete) return;
  report.incomplete = "time budget";
  report.errors = report.errors.filter((x) => !/time budget was used up/.test(x));
  report.errors.unshift("Scan stopped early: its time budget was used up, so not everything was checked. The rest is checked next time. Deals already found are kept.");
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
  const r = await xfetch(env, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + head + "." + body + "." + b64url(sig),
  });
  if (!r.ok) throw new Error("alert sign-in failed (" + r.status + ")");
  const d = await timedBody(env, r.json());
  const out = { t: d.access_token, project: sa.project_id, exp: Date.now() + (d.expires_in - 300) * 1000 };
  await kvSet(env, "fcmtok", out);
  return out;
}
/* ---------------- problem log (Stage 4 monitoring, 4 Nov 2026) ----------------
   App crashes and errors, failed Scan service requests, database errors and background-job failures go into the
   "errlog" table of THIS Scan service only (no outside service). Messages are cleaned first: no keys, tokens, e-mail
   addresses or web-address details, and cut short. The same problem counts up rather than adding rows; the newest
   ERR_KEEP problems are kept. A problem that keeps happening sends one phone alert per 6 hours (existing alerts). */
const ERR_KEEP = 300;
function cleanMsg(s) {
  return String(s == null ? "" : s)
    .replace(/((?:^|[?&\s,;:"'({])(?:[\w-]*key|token|code|access_token|refresh_token|sig|password|passwd|pwd|secret|auth)["']?\s*[=:]\s*["']?)[^&\s"',;)}]+/gi, "$1[hidden]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "$1 [hidden]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => u.split(/[?#]/)[0])
    .replace(/[A-Za-z0-9_+\/=-]{24,}/g, "[hidden]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}
// a request's JSON body; garbled data is the sender's mistake (answered "bad request", 400), not a Scan service failure
async function bodyJson(request) { const t = await request.text(); try { return JSON.parse(t); } catch (e) { const x = new Error("bad request: the data sent isn't valid JSON"); x.bad = true; throw x; } }
const endpointOf = (request) => { try { return [...new URL(request.url).searchParams.keys()].find((k) => k !== "key") || "(none)"; } catch (e) { return "?"; } };
async function logProblem(env, src, kind, msg, extra = {}) {
  try {
    if (!env.DB) return;
    const D = env.DB, now = Date.now(), m = cleanMsg(msg), where = cleanMsg(extra.where || "").slice(0, 80), ver = cleanMsg(extra.ver || "").slice(0, 40);
    const k = cleanMsg(kind).slice(0, 60), sig = (src + "|" + k + "|" + where + "|" + m.replace(/\d+/g, "#")).slice(0, 400);
    await D.prepare("CREATE TABLE IF NOT EXISTS errlog (sig TEXT PRIMARY KEY, src TEXT, kind TEXT, msg TEXT, place TEXT, ver TEXT, n INTEGER, first INTEGER, at INTEGER, alerted INTEGER)").run();
    await D.prepare("INSERT INTO errlog (sig,src,kind,msg,place,ver,n,first,at,alerted) VALUES (?,?,?,?,?,?,1,?,?,0) ON CONFLICT(sig) DO UPDATE SET n=n+1, at=excluded.at, ver=excluded.ver, msg=excluded.msg")
      .bind(sig, src, k, m, where, ver, now, now).run();
    const row = await D.prepare("SELECT n, alerted FROM errlog WHERE sig=?").bind(sig).first();
    if (row && !/^notice/.test(k) && row.n >= (src === "app" ? 5 : 3) && now - (row.alerted || 0) > 6 * 3600e3) {
      await D.prepare("UPDATE errlog SET alerted=? WHERE sig=?").bind(now, sig).run();
      try { await push(env, "FlipScout problem", `${k}${where ? " (" + where + ")" : ""}: ${m.slice(0, 120)} · ${row.n} times`, { kind: "problem" }); } catch (e) {}
    }
    await D.prepare(`DELETE FROM errlog WHERE sig NOT IN (SELECT sig FROM errlog ORDER BY at DESC LIMIT ${ERR_KEEP})`).run();
  } catch (e) { /* recording a problem must never cause another one */ }
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
      const r = await xfetch(env, `https://fcm.googleapis.com/v1/projects/${tok.project}/messages:send`, {
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
    try { await dealOut(env, [id], () => (avail === "OUT_OF_STOCK" ? "sold out" : d.notFound ? "listing removed" : "ended")); } catch (e) {}
    await D.batch([
      D.prepare("DELETE FROM deals WHERE id=?").bind(id),
      D.prepare("UPDATE listings SET status='gone', ended_at=COALESCE(ended_at, ?), ended_from=COALESCE(ended_from, last_seen) WHERE id=? AND type='BIN' AND status<>'sold'").bind(end && end < now ? end : now, id),
    ]);
    return { live: false };
  }
  // an auction can also have a Buy It Now price (eBay lists both options until the first bid): it's still an auction,
  // so compare the current bid, not the Buy It Now price (that was deleting good auction deals as "too dear")
  const row = await D.prepare("SELECT data FROM deals WHERE id=?").bind(id).first(), deal0 = row ? JSON.parse(row.data) : null;
  // a deal judged on its Buy It Now price stays a Buy It Now deal (its price must not be swapped for the auction's bid)
  const auction = deal0 ? deal0.type === "AUC" : (d.buyingOptions || []).includes("AUCTION");
  const pr = auction && d.currentBidPrice ? d.currentBidPrice : auction && !d.currentBidPrice && deal0 ? null : d.price;
  const po = postageOf(d);
  const pv = pr ? parseFloat(pr.value) : NaN; // an unreadable price is treated as "no price", never stored as NaN
  const out = { live: true, price: Number.isFinite(pv) && !(pr.currency && pr.currency !== "GBP") ? pv : null, ship: po.ship, post: po.post, bids: +d.bidCount || 0, end };
  if (full) out.info = listingInfo(d);
  if (row && out.price != null) {
    const deal = deal0;
    // postage not known: keep the careful allowance this deal was judged with (never £0)
    if (postUnknown(out)) out.ship = deal.shipAllow ? deal.ship : POST_ALLOW;
    const oldShip = deal.ship || 0;
    // keep the stored listing up to date too, so a later scan can't bring back a removed deal from its old price
    try { await D.prepare("UPDATE listings SET price=?, ship=? WHERE id=?").bind(out.price, out.ship || 0, id).run(); } catch (e) {}
    // too dear now? Buy It Now: the whole cost (price + postage + buyer fee) against the most to pay; auction: the bid against
    // the max bid, lowered first by any extra postage (reprice does the same), so a kept deal never has bid ≥ max bid
    const fee0 = (p) => (deal.bpfOn ? bpf(p) : 0), maxBidNow = deal.maxBid != null ? Math.floor((deal.maxBid + oldShip - out.ship) * 100) / 100 : 0;
    const tooDear = deal.kind === "deal" && (deal.type === "AUC" ? out.price >= maxBidNow : out.price + out.ship + fee0(out.price) > (deal.maxPay || 0) + 0.005);
    if (tooDear) { try { await dealOut(env, [id], () => (deal.type === "AUC" ? "bid passed max bid" : "price went up")); } catch (e) {} await D.prepare("DELETE FROM deals WHERE id=?").bind(id).run(); return { ...out, live: true, tooDear: true }; }
    const moved = deal.price !== out.price || deal.ship !== out.ship;
    Object.assign(deal, { price: out.price, ship: out.ship, post: out.post, shipAllow: postUnknown(out) || undefined, bids: out.bids, end: out.end || deal.end });
    // a new price or postage (e.g. the bid went up): work every money figure out again, so nothing shows an old bid's profit
    if (moved && deal.kind === "deal") reprice(deal, cleanConfig(await kvGet(env, "config", null)).rules, oldShip);
    // the app takes these figures as they are (one source of truth for the money on the card)
    out.deal = { price: deal.price, ship: deal.ship, post: deal.post, shipAllow: deal.shipAllow, bids: deal.bids, cost: deal.cost, extra: deal.extra, profit: deal.profit,
      lowProfit: deal.lowProfit, roi: deal.roi, maxBid: deal.maxBid, maxItem: deal.maxItem, profitAtMax: deal.profitAtMax };
    // the description says it's faulty: keep it visible (with the words) but never above 49 and never alerted
    const f = descFaults(String(d.conditionDescription || "") + "\n" + plainText(d.description || d.shortDescription));
    if (!pre || d.description != null || d.shortDescription != null || d.conditionDescription != null) deal.descAt = now;
    if (f.length) { out.fault = f; deal.faults = f; deal.score = Math.min(deal.score || 0, 49); if (!(deal.tags || []).includes("Fault in description")) deal.tags = [...(deal.tags || []), "Fault in description"]; }
    await D.prepare("UPDATE deals SET data=?, score=?, checked=? WHERE id=?").bind(JSON.stringify(deal), deal.score || 0, now, id).run();
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
  const words = [...new Set([...((note + "\n" + desc).match(RISK_G) || []).map((w) => w.toLowerCase()), ...descFaults(note + "\n" + desc)])].slice(0, 6);
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
// in the minutes between scans, check a couple more deals are still for sale (sold Buy It Nows go quickly),
// but only while today's eBay calls are on pace (used so far is below the share of the day gone by)
async function spareVerify(env) {
  const used = await quota(env), d = new Date(), dayGone = (d.getUTCHours() * 60 + d.getUTCMinutes() + 1) / 1440;
  if (used > EBAY_DAILY * Math.min(0.8, dayGone * 0.9 + 0.05)) return 0;
  const gone = await verifyDeals(env, 2);
  await saveQuota(env);
  return gone;
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
  // 10 a run (eBay calls are limited), least recently checked first, so every followed listing gets its turn
  const rows = await D.prepare("SELECT id, data, max, alerted FROM follows WHERE COALESCE(json_extract(data,'$.status'),'') NOT IN ('ended','sold') ORDER BY COALESCE(json_extract(data,'$.chk'),0) ASC, created DESC LIMIT 10").all();
  for (const row of rows.results || []) {
    const f = JSON.parse(row.data);
    if (f.status === "ended" || f.status === "sold") continue;
    f.chk = now;
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
    } catch (e) { try { await D.prepare("UPDATE follows SET data=? WHERE id=?").bind(JSON.stringify(f), row.id).run(); } catch (x) {} } // still counts as its turn
  }
}

/* ---------------- web requests ---------------- */
export default {
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      // errors here used to vanish; keep the latest one so it can be looked at ("lastCrash" in the kv table)
      const crash = (where) => (e) => Promise.all([kvSet(env, "lastCrash", { at: Date.now(), where, msg: cleanMsg((e && e.message) || e) }).catch(() => {}),
        logProblem(env, /D1_ERROR|SQLITE/i.test(String(e && e.message)) ? "database" : "job", "background job failed", (e && e.message) || e, { where })]);
      const r = await sweep(env, false).catch(async (e) => { await crash("scan")(e); return {}; });
      // a scan that ran but couldn't reach eBay for some categories
      for (const x of ((r && r.errors) || []).slice(0, 3)) await logProblem(env, "job", "scan problem", x, { where: "scan" });
      await weeklyExport(env).catch(crash("weekly price export"));
      if (r && r.skipped) {
        await closing(env).catch(crash("auction learning"));
        await spareVerify(env).catch(crash("deal check"));
      }
    })());
  },

  // every request: any failure (an error, or a 5xx answer) is written to the problem log (see logProblem)
  async fetch(request, env, ctx) {
    let res;
    try { res = await this.handle(request, env, ctx); }
    catch (e) { const m = String((e && e.message) || e); await logProblem(env, /D1_ERROR|SQLITE/i.test(m) ? "database" : "service", "exception", m, { where: endpointOf(request) }); return json({ error: "internal error" }, 500); }
    // eBay calls made by searches, live checks and suggestions count towards the daily limit too (were only saved by scans)
    if (CALLS) { const w = saveQuota(env).catch(() => {}); if (ctx && ctx.waitUntil) ctx.waitUntil(w); else await w; }
    if (res && res.status >= 500) { let m = ""; try { m = (await res.clone().json()).error || ""; } catch (e) {} await logProblem(env, /D1_ERROR|SQLITE/i.test(m) ? "database" : "service", "failed request (" + res.status + ")", m, { where: endpointOf(request) }); }
    return res;
  },
  async handle(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const u = new URL(request.url), P = (k) => u.searchParams.get(k);
    // the app sends the key in a header; older app versions put it in the address, which still works
    // KEY_IN_URL = "off" refuses keys in the web address (only the hidden header works). Until it's switched off, each
    // use of the old way is noted in the Problems list (no alert), so you can see when no old app version uses it any more.
    const hk = request.headers.get("X-FlipScout-Key"), uk = env.KEY_IN_URL === "off" ? "" : P("key");
    if (!env.APP_KEY || !sameKey(hk || uk, env.APP_KEY)) return json({ error: "wrong key" }, 401);
    if (!hk && uk && env.DB && ctx && ctx.waitUntil) ctx.waitUntil(logProblem(env, "service", "notice: key sent in the web address",
      "an old FlipScout version (before 25 Oct 2026) sent the key in the web address; when this stops appearing, the old way can be switched off", { where: endpointOf(request) }));
    // hourly limits on the calls that use eBay or write a lot, far above normal use, so a leaked key can't run up your eBay calls
    const lim = P("q") ? ["search", 300] : P("check") ? ["check", 300] : P("fill") ? ["fill", 120] : P("suggest") ? ["suggest", 300] : P("flag") ? ["flag", 200] : P("report") ? ["report", 120] : null;
    if (lim && env.DB) {
      try {
        await schema(env);
        const h = Math.floor(Date.now() / 3600e3), rl = await kvGet(env, "rate", { h: 0, n: {} });
        if (rl.h !== h) { rl.h = h; rl.n = {}; }
        rl.n[lim[0]] = (rl.n[lim[0]] || 0) + 1;
        if (rl.n[lim[0]] > lim[1]) return json({ error: "Too many requests this hour. Try again later." }, 429);
        await kvSet(env, "rate", rl);
      } catch (e) {}
    }

    // ---- hunting (needs the database) ----
    // problem reports from the app (cleaned again here) and the problem list for admin tools
    if (P("report") && request.method === "POST") {
      let b = {}; try { b = JSON.parse((await request.text()).slice(0, 4000)); } catch (e) { return json({ error: "bad report" }, 400); }
      await logProblem(env, "app", b.kind || "error", b.msg, { where: b.where, ver: [b.ver, b.ua].filter(Boolean).join(" · ") });
      return json({ ok: true });
    }
    if (P("problems")) {
      if (!env.DB) return json({ problems: [] });
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS errlog (sig TEXT PRIMARY KEY, src TEXT, kind TEXT, msg TEXT, place TEXT, ver TEXT, n INTEGER, first INTEGER, at INTEGER, alerted INTEGER)").run();
      const rows = (await env.DB.prepare("SELECT src, kind, msg, place, ver, n, first, at, alerted FROM errlog ORDER BY at DESC LIMIT 100").all()).results || [];
      return json({ problems: rows });
    }
    const huntCall = ["config", "deals", "run", "follows", "follow", "unfollow", "flag", "unflag", "flags", "test", "device", "check", "price", "prices", "unprice", "needs", "lookfor", "fill", "fillstats", "seen", "sales", "ebayconnect", "ebaycode"].some((k) => u.searchParams.has(k));
    if (huntCall) {
      if (!env.DB) return json({ error: "hunting database not set up yet" }, 501);
      try {
        await schema(env);
        if (P("config")) {
          if (request.method === "POST") {
            const c = cleanConfig(await bodyJson(request));
            await kvSet(env, "config", c);
            return json({ ok: true, config: c });
          }
          return json({ config: cleanConfig(await kvGet(env, "config", null)) });
        }
        if (P("run")) {
          const last = await kvGet(env, "lastManual", 0);
          if (Date.now() - last < 45000) return json({ error: "Just scanned. Try again in a minute." }, 429);
          await kvSet(env, "lastManual", Date.now());
          const res = await sweep(env, true);
          if (res && res.busy) { await kvSet(env, "lastManual", last); return json({ error: res.error }, 429); }
          return json(res);
        }
        if (P("deals")) {
          // every live deal goes to the app (was capped at the best-scoring 200, which silently hid hundreds: 3 Nov).
          // The total is sent too, so the app can say so if anything is ever left out.
          const rows = await env.DB.prepare("SELECT data, created FROM deals WHERE expires>? ORDER BY score DESC LIMIT ?").bind(Date.now(), DEALS_MAX).all();
          // one damaged record must not stop every other deal loading: it's skipped and written to the problem log
          let broken = 0; const deals = [];
          for (const r of rows.results || []) { try { deals.push({ ...JSON.parse(r.data), found: r.created }); } catch (e) { broken++; } }
          if (broken) await logProblem(env, "database", "damaged deal record", `${broken} deal record${broken === 1 ? "" : "s"} couldn't be read and ${broken === 1 ? "was" : "were"} skipped`, { where: "deals" });
          const dealsTotal = (await env.DB.prepare("SELECT COUNT(*) n FROM deals WHERE expires>?").bind(Date.now()).first() || {}).n || 0;
          const lc = await kvGet(env, "learnCats", { cats: [] });
          const cnt = (await kvGet(env, "learnedCounts", null)) || (await refreshLearned(env));
          return json({ deals, dealsTotal, report: await kvGet(env, "lastReport", null), learned: cnt.byCat, close: await kvGet(env, "close", []), later: await kvGet(env, "later", []), aucLearn: await kvGet(env, "aucLearn", {}), learning: { cats: lc.cats.length, sales: cnt.total }, lastCrash: await kvGet(env, "lastCrash", null), whyDay: await kvGet(env, "whyDay", null), verified: Object.keys(VERIFIED_CATS) });
        }
        if (P("check")) {
          const id = String(P("check")).replace(/\D/g, "");
          if (!id) return json({ error: "need a listing" }, 400);
          return json(await checkLive(env, id, null, true));
        }
        if (P("price") && request.method === "POST") {
          const b = await bodyJson(request);
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
          const b = await bodyJson(request);
          return json(await fillPrices(env, b));
        }
        if (P("sales")) {
          // every sale behind a model's price, newest first, marked as used in the price or left out (read only)
          const key = bareKey(String(P("sales")).slice(0, 200));
          const f = await env.DB.prepare("SELECT data FROM fillsales WHERE pkey=?").bind(key).first();
          let list = []; try { list = f ? JSON.parse(f.data) : []; } catch (e) {}
          const rows = list.map((r) => ({ id: String(r[0]), price: r[1], post: r[2], at: r[3] || null, src: "fill" }));
          const learned = await env.DB.prepare("SELECT id, price, at FROM sales WHERE pkey IN (?, ?) AND at>? ORDER BY at DESC LIMIT 300").bind(key, String(P("sales")), Date.now() - 90 * DAY).all();
          const have = new Set(rows.map((r) => r.id));
          for (const r of learned.results || []) if (!have.has(String(r.id))) rows.push({ id: String(r.id), price: r.price, post: null, at: r.at, src: "auction" });
          // titles and conditions: from the sale itself (fills from 30 Oct) or from when FlipScout saw it for sale
          const ids = rows.map((r) => r.id), info = {};
          for (let i = 0; i < ids.length; i += 90) {
            const ch = ids.slice(i, i + 90), q = ch.map(() => "?").join(",");
            for (const r of (await env.DB.prepare(`SELECT id, title, cond FROM listings WHERE id IN (${q})`).bind(...ch).all()).results || []) info[r.id] = { title: r.title, cond: r.cond };
            for (const r of (await env.DB.prepare(`SELECT id, title, cond FROM fillseen WHERE id IN (${q}) AND title IS NOT NULL`).bind(...ch).all()).results || []) info[r.id] = { title: r.title, cond: r.cond || (info[r.id] || {}).cond };
            for (const r of (await env.DB.prepare(`SELECT id, start_at, seller, fmt, qty, qty_sold FROM fillseen WHERE id IN (${q}) AND start_at > 0`).bind(...ch).all()).results || [])
              info[r.id] = { ...(info[r.id] || {}), listed: r.start_at, seller: r.seller, fmt: r.fmt === "Chinese" ? "auction" : r.fmt === "FixedPriceItem" ? "Buy It Now" : r.fmt, qty: r.qty, qtySold: r.qty_sold };
          }
          // same rule as the price: 50%–150% of the median; last 30 days when there are 5+ of those
          const now = Date.now(), m = median(rows.filter((r) => r.src === "fill").map((r) => r.price)) || median(rows.map((r) => r.price));
          const ok = (r) => r.price >= m * 0.5 && r.price <= m * 1.5, recentN = rows.filter((r) => r.src === "fill" && ok(r) && r.at && r.at >= now - 30 * DAY).length;
          const out = rows.map((r) => ({ ...r, ...(info[r.id] || {}), used: r.src === "fill" && ok(r) && (recentN < 5 || (r.at && r.at >= now - 30 * DAY)),
            why: r.src !== "fill" ? "auction FlipScout watched (last bid seen)" : !ok(r) ? (r.price < m ? "much lower than usual" : "much higher than usual") : recentN >= 5 && !(r.at && r.at >= now - 30 * DAY) ? "older than 30 days" : "" }))
            .sort((a, c) => (c.at || 0) - (a.at || 0));
          const p = await env.DB.prepare("SELECT label, avg, lo, hi, n, post FROM prices WHERE pkey=?").bind(key).first();
          return json({ key, price: p || null, sales: out });
        }
        if (P("ebayconnect")) {
          // where to send the owner to connect their eBay account, and how the sold-details lookups are going
          const u = await kvGet(env, "ebayUser", null), use = await kvGet(env, "giUse", { n: 0 });
          const c = await env.DB.prepare("SELECT SUM(gi_at > 0) found, SUM(gi_at = 0) missing, SUM(gi_at IS NULL AND at > ?) todo FROM fillseen").bind(Date.now() - 92 * DAY).first();
          return json({ url: ebayConnectUrl(env), connected: !!(u && u.refresh && !u.broken && Date.now() < u.refreshExp), until: u ? u.refreshExp : null,
            broken: u ? u.broken || null : null, today: use.n || 0, found: c ? c.found || 0 : 0, missing: c ? c.missing || 0 : 0, todo: c ? c.todo || 0 : 0 });
        }
        if (P("ebaycode") && request.method === "POST") {
          const b = await bodyJson(request);
          return json(await ebayConnect(env, String(b.code || "").slice(0, 2000)));
        }
        if (P("seen") && request.method === "POST") {
          // which of these sold item numbers a fill has already saved (read only)
          const b = await bodyJson(request), ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => String(x).replace(/\D/g, "").slice(0, 20)).filter(Boolean).slice(0, 300), known = [];
          for (let i = 0; i < ids.length; i += 90) {
            const chunk = ids.slice(i, i + 90), q = await env.DB.prepare(`SELECT id FROM fillseen WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
            for (const r of q.results || []) known.push(r.id);
          }
          return json({ known });
        }
        if (P("fillstats")) {
          const fc = await kvGet(env, "fillCats", {}), out = {};
          for (const c in fc) out[c] = fillStat(fc[c]);
          return json({ stats: out, speedCheck: await kvGet(env, "spdCheck", { n: 0, hit: 0 }) });
        }
        if (P("prices")) {
          await ensureSrc(env);
          const rows = await env.DB.prepare("SELECT pkey, label, q, avg, st, post, trend, at, src, n, lo, hi, spd, sdays, sn, act, act_at FROM prices ORDER BY at DESC LIMIT 20000").all();
          const fc = await kvGet(env, "fillCats", {}), catOf = {}, sell = (await kvGet(env, "sellTime", { m: {} })).m || {};
          for (const c in fc) for (const k in (fc[c].k || {})) if (!catOf[k]) catOf[k] = fc[c].name || "";
          return json({ prices: (rows.results || []).map((r) => ({ ...r, cat: catOf[r.pkey] || "", sell: sell[r.pkey] || null, url: lookupUrl(r.q || ""), fresh: Date.now() - r.at < BOOK_DAYS * DAY, speed: speedOf(r, Date.now()) })) });
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
          const b = await bodyJson(request);
          const id = String(b.id || "").replace(/\D/g, ""), max = parseFloat(b.max);
          if (!id || !(max > 0)) return json({ error: "need a listing and a max price" }, 400);
          const data = { title: String(b.title || "").slice(0, 200), url: "https://www.ebay.co.uk/itm/" + id, type: b.type === "AUC" ? "AUC" : "BIN", price: +b.price || 0, ship: +b.ship || 0, end: +b.end || null, status: "live",
            img: /^https:\/\//.test(String(b.img || "")) ? String(b.img).slice(0, 400) : "", cond: String(b.cond || "").slice(0, 40), med: +b.med || null };
          await env.DB.prepare("INSERT INTO follows (id,data,max,created,alerted) VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET max=excluded.max, alerted=NULL").bind(id, JSON.stringify(data), max, Date.now()).run();
          return json({ ok: true });
        }
        if (P("flag") && request.method === "POST") {
          // one tap on Flag: keep a snapshot of the deal exactly as the Scan service judged it (taken here, not sent by the phone)
          const b = await bodyJson(request), id = String(b.id || "").replace(/\D/g, "").slice(0, 20);
          if (!id) return json({ error: "need a deal" }, 400);
          const reason = ["model", "price", "faulty", "scam", "other"].includes(b.reason) ? b.reason : null;
          const ex = await env.DB.prepare("SELECT deal_id FROM flags WHERE deal_id=?").bind(id).first();
          if (ex) { if (reason) await env.DB.prepare("UPDATE flags SET reason=? WHERE deal_id=?").bind(reason, id).run(); return json({ ok: true }); }
          const d = await env.DB.prepare("SELECT data FROM deals WHERE id=?").bind(id).first() || await env.DB.prepare("SELECT data FROM listings WHERE id=?").bind(id).first();
          await env.DB.prepare("INSERT INTO flags (deal_id, reason, data, at) VALUES (?,?,?,?)").bind(id, reason, d && d.data ? d.data : null, Date.now()).run();
          return json({ ok: true });
        }
        if (P("unflag")) {
          await env.DB.prepare("DELETE FROM flags WHERE deal_id=?").bind(String(P("unflag")).replace(/\D/g, "")).run();
          return json({ ok: true });
        }
        if (P("flags")) {
          const rows = await env.DB.prepare("SELECT deal_id, reason, data, at FROM flags WHERE at>? ORDER BY at DESC LIMIT 100").bind(Date.now() - 30 * DAY).all();
          const list = (rows.results || []).map((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch (e) {}
            return { id: r.deal_id, reason: r.reason, at: r.at, title: d.title || "", matchLabel: d.matchLabel || "", price: d.price, ship: d.ship, med: d.med, profit: d.profit, cat: d.catName || "", url: d.url || "" }; });
          const week = Date.now() - 7 * DAY, nd = await kvGet(env, "newDealsDay", {});
          return json({ flags: list, week: { flagged: list.filter((x) => x.at > week).length, deals: Object.entries(nd).filter(([k]) => Date.parse(k) >= week - DAY).reduce((a, [, v]) => a + v, 0) } });
        }
        if (P("unfollow")) {
          await env.DB.prepare("DELETE FROM follows WHERE id=?").bind(String(P("unfollow")).replace(/\D/g, "")).run();
          return json({ ok: true });
        }
        if (P("device") && request.method === "POST") {
          const b = await bodyJson(request);
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
        return json({ error: e.message }, e && e.bad ? 400 : 500);
      }
    }

    // ---- cloud backup ----
    if (P("backup")) {
      if (!env.BACKUP) return json({ error: "cloud backup not set up" }, 501);
      try {
        if (request.method === "POST") {
          const body = await request.text();
          if (body.length > 5000000) return json({ error: "backup too big" }, 413);
          try { JSON.parse(body); } catch (e) { return json({ error: "bad request: the backup isn't valid JSON (nothing was changed)" }, 400); }
          const prev = await env.BACKUP.get("backup-v1");
          if (prev) await env.BACKUP.put("backup-prev", prev);
          await env.BACKUP.put("backup-v1", body, { metadata: { at: Date.now() } });
          return json({ ok: true, at: Date.now() });
        }
        const r = await env.BACKUP.getWithMetadata("backup-v1");
        if (!r.value) return json({ none: true });
        return json({ at: (r.metadata && r.metadata.at) || null, data: JSON.parse(r.value) });
      } catch (e) {
        return json({ error: e.message }, e && e.bad ? 400 : 500);
      }
    }

    // ---- eBay category list ----
    if (P("tree")) {
      try {
        const token = await getToken(env);
        const r = await xfetch(env, "https://api.ebay.com/commerce/taxonomy/v1/category_tree/3", {
          headers: { Authorization: "Bearer " + token, "Accept-Encoding": "gzip" },
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
        if (!r.ok) return json({ error: "category list failed (" + r.status + ")" }, 502);
        return new Response(r.body, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", ...CORS } });
      } catch (e) {
        return json({ error: e.message }, e && e.bad ? 400 : 500);
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
        return json({ error: e.message }, e && e.bad ? 400 : 500);
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
      return json({ error: e.message }, e && e.bad ? 400 : 500);
    }
  },
};
