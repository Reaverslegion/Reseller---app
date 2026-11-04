// FOR DEVELOPING TESTS ON A COMPUTER ONLY (GitHub runs the real Cloudflare simulator instead).
// Runs the real worker.js in Node with a throwaway in-memory database and a throwaway backup store, on 127.0.0.1:8787.
// Every eBay / Google address is sent to the fake eBay (tests/e2e/fake-ebay.mjs on 8788). No real keys, nothing live.
// Also answers the same test-only endpoints as the GitHub test copy: ?__testseed=1 and ?__testquery=1 (POST).
// Run: TEST_APP_KEY=... node tests/integrity/local-service.mjs
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const KEY = process.env.TEST_APP_KEY, PORT = +(process.env.PORT || 8787), FAKE = "http://127.0.0.1:8788";
if (!KEY) { console.error("TEST_APP_KEY needed"); process.exit(1); }
if (process.env.CLOUDFLARE_API_TOKEN) { console.error("REFUSED: real Cloudflare key present"); process.exit(1); }
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => { let s = typeof u === "string" ? u : u.url;
  for (const h of ["https://api.ebay.com", "https://auth.ebay.com", "https://fcm.googleapis.com", "https://oauth2.googleapis.com", "https://www.googleapis.com"])
    if (s.startsWith(h)) s = FAKE + "/" + h.slice(8) + s.slice(h.length);
  if (/^https:/.test(s)) return Promise.reject(new Error("blocked in tests: " + s));
  return realFetch(s, o); };

const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async (col) => { const r = db.prepare(sql).get(...args) || null; return col && r ? r[col] : r; } });
const kv = new Map();
const env = { APP_KEY: KEY, EBAY_ID: "fake", EBAY_SECRET: "fake",
  DB: { prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; } },
  BACKUP: { get: async (k) => (kv.has(k) ? kv.get(k).v : null), put: async (k, v, o) => { kv.set(k, { v, m: o && o.metadata }); }, getWithMetadata: async (k) => (kv.has(k) ? { value: kv.get(k).v, metadata: kv.get(k).m } : { value: null, metadata: null }), delete: async (k) => kv.delete(k) } };
const worker = (await import(new URL("../../worker.js", import.meta.url))).default;

http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const u = new URL(req.url, "http://127.0.0.1:" + PORT), cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
  try {
    if (u.searchParams.has("__testseed") || u.searchParams.has("__testquery")) {
      if (req.headers["x-flipscout-key"] !== KEY) { res.writeHead(401, cors); return res.end('{"error":"wrong key"}'); }
      await worker.fetch(new Request("http://x/?config=1", { headers: { "X-FlipScout-Key": KEY } }), env, { waitUntil() {} }); // makes the tables
      const b = JSON.parse(body || "{}");
      if (u.searchParams.has("__testseed")) { for (const s of b.sql || []) db.prepare(s[0]).run(...(s[1] || []));
        for (const [k, v] of Object.entries(b.kv || {})) db.prepare("INSERT OR REPLACE INTO kv (k,v) VALUES (?,?)").run(k, JSON.stringify(v));
        res.writeHead(200, { "content-type": "application/json", ...cors }); return res.end(JSON.stringify({ ok: true, ran: (b.sql || []).length })); }
      if (!/^\s*(select|with)\b/i.test(b.q)) { res.writeHead(400, cors); return res.end('{"error":"read-only"}'); }
      const rows = db.prepare(b.q).all(...(b.args || [])); res.writeHead(200, { "content-type": "application/json", ...cors }); return res.end(JSON.stringify({ rows }));
    }
    const r = await worker.fetch(new Request(u, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env, { waitUntil() {} });
    const h = Object.fromEntries(r.headers); res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { if (res.headersSent) return res.end(); res.writeHead(500, { "content-type": "application/json", ...cors }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
}).listen(PORT, "127.0.0.1", () => console.log("local test Scan service on " + PORT));
