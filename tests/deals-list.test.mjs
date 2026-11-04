// The deals list exactly as the Scan service sends it, by running its real request handler (not by reading its source):
// every live deal (no hidden cap — the 3 Nov 2026 bug capped it at 200), none expired, none twice, and the right total.
// Plus eBay UK buyer protection fee examples worked out by hand from eBay's published rates (not from the app's code):
// £0.10 + 7% of the first £20 + 4% of £20–£300 + 2% of £300–£4,000. Run: node tests/deals-list.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const worker = (await import(new URL("../worker.js", import.meta.url))).default;
const db = new DatabaseSync(":memory:");
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
const env = { APP_KEY: "deals-list-test-key-0123456789", DB: { prepare: (sql) => stmt(sql), batch: async (l) => { for (const s of l) await s.run(); return []; } } };
const get = async (q) => { const r = await worker.fetch(new Request("https://svc.test/?" + q, { headers: { "X-FlipScout-Key": env.APP_KEY } }), env, { waitUntil() {} }); return { status: r.status, body: await r.json() }; };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await get("config=1"); // makes the tables
const now = Date.now(), ins = db.prepare("INSERT INTO deals (id,data,score,created,expires) VALUES (?,?,?,?,?)");
for (let i = 0; i < 1500; i++) { const id = String(700000000000 + i); ins.run(id, JSON.stringify({ id, kind: "deal", type: "BIN", title: "deal " + i, price: 100, ship: 5, profit: 20 + (i % 50), score: i % 100 }), i % 100, now - 1000, now + 864e5); }
for (let i = 0; i < 10; i++) { const id = String(710000000000 + i); ins.run(id, JSON.stringify({ id, kind: "deal", title: "expired " + i, price: 1, profit: 99, score: 100 }), 100, now - 864e5 * 3, now - 1000); }

await t("all 1,500 live deals are sent (no hidden cap), with the right total", async () => {
  const r = await get("deals=1");
  assert.equal(r.status, 200); assert.equal(r.body.deals.length, 1500, "every live deal"); assert.equal(r.body.dealsTotal, 1500);
});
await t("no expired deal is sent, and none is sent twice", async () => {
  const ids = (await get("deals=1")).body.deals.map((d) => d.id);
  assert.ok(!ids.some((id) => id.startsWith("71")), "expired deals left out"); assert.equal(new Set(ids).size, ids.length, "no duplicates");
});
await t("best deals first (highest score at the top)", async () => {
  const s = (await get("deals=1")).body.deals.map((d) => d.score);
  assert.ok(s.every((x, i) => i === 0 || s[i - 1] >= x));
});
await t("buyer protection fee: hand-worked examples from eBay UK's published rates", async () => {
  let src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
  const bpf = new Function(src + "\nreturn bpf;")();
  // £10: 0.10 + 7%×10 = 0.80 · £100: 0.10 + 7%×20 + 4%×80 = 4.70 · £500: 0.10 + 1.40 + 4%×280 + 2%×200 = 16.70
  // £5,000: the 2% band stops at £4,000 → 0.10 + 1.40 + 11.20 + 2%×3,700 = 86.70
  for (const [p, fee] of [[10, 0.8], [20, 1.5], [100, 4.7], [300, 12.7], [500, 16.7], [4000, 86.7], [5000, 86.7]]) assert.equal(Math.round(bpf(p) * 100) / 100, fee, `£${p}`);
});
console.log(`\n${n} checks passed`);
