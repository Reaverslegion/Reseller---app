// The Flag button's endpoint on the Scan service, with a small pretend database. Run: node tests/flag.test.mjs
import assert from "node:assert/strict";
const W = (await import(new URL("../worker.js", import.meta.url))).default;
const flags = new Map(), deals = { "123": JSON.stringify({ title: "Gigabyte GTX 1050 PARTS ONLY", matchLabel: "GTX 1050 (any brand)", med: 33, catName: "Graphics Cards" }) }, kv = new Map();
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a),
  first: async () => { if (/FROM flags WHERE deal_id/.test(sql)) return flags.has(args[0]) ? { deal_id: args[0] } : null; if (/FROM deals WHERE id/.test(sql)) return deals[args[0]] ? { data: deals[args[0]] } : null; if (/FROM listings/.test(sql)) return null; if (/FROM kv/.test(sql)) return kv.has(args[0]) ? { v: kv.get(args[0]) } : null; return null; },
  run: async () => { if (/^INSERT INTO flags/.test(sql)) flags.set(args[0], { reason: args[1], data: args[2], at: args[3] }); else if (/^UPDATE flags/.test(sql)) flags.get(args[1]).reason = args[0]; else if (/^DELETE FROM flags/.test(sql)) flags.delete(args[0]); else if (/INSERT INTO kv/.test(sql)) kv.set(args[0], args[1]); return {}; },
  all: async () => /FROM flags/.test(sql) ? { results: [...flags].map(([deal_id, f]) => ({ deal_id, ...f })) } : { results: [] } });
const env = { APP_KEY: "K", DB: { prepare: (s) => stmt(s), batch: async () => [] } };
const call = async (q, body) => { const r = await W.fetch(new Request("https://x/?" + q, { method: body ? "POST" : "GET", headers: { "X-FlipScout-Key": "K" }, body: body ? JSON.stringify(body) : undefined }), env, {}); return [r.status, await r.json()]; };
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
await t("one tap saves a snapshot taken by the Scan service, not sent by the phone", async () => {
  const [st] = await call("flag=1", { id: "123", title: "something the phone made up" });
  assert.equal(st, 200); assert.match(flags.get("123").data, /PARTS ONLY/); assert.equal(flags.get("123").reason, null);
});
await t("the optional reason is added to the same flag", async () => {
  await call("flag=1", { id: "123", reason: "faulty" }); assert.equal(flags.get("123").reason, "faulty"); assert.equal(flags.size, 1);
});
await t("unknown reasons are ignored", async () => {
  await call("flag=1", { id: "123", reason: "<script>" }); assert.equal(flags.get("123").reason, "faulty");
});
await t("Admin list shows the flagged deal", async () => {
  const [, d] = await call("flags=1"); assert.equal(d.flags[0].title, "Gigabyte GTX 1050 PARTS ONLY"); assert.equal(d.flags[0].reason, "faulty");
});
await t("Undo removes the flag", async () => { await call("unflag=123"); assert.equal(flags.size, 0); });
await t("wrong key is refused", async () => {
  const r = await W.fetch(new Request("https://x/?flags=1", { headers: { "X-FlipScout-Key": "nope" } }), env, {}); assert.equal(r.status, 401);
});
console.log(`\n${n} checks passed`);
