// The three app problems the emulator tests found on 3-4 Nov 2026, so they can't come back.
// Run: node tests/fixes-2026-11-04.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");

await t("a brand-new database has every price-book column after the start-up check (sales list worked only after a first Fill)", async () => {
  const W = new Function(src + "\nreturn { schema };")();
  const db = new DatabaseSync(":memory:");
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: db.prepare(sql).all(...args) }), first: async () => db.prepare(sql).get(...args) || null });
  const env = { DB: { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); return []; } } };
  await W.schema(env);
  // the exact query the sales list runs, and the stock check's columns
  assert.doesNotThrow(() => db.prepare("SELECT label, avg, lo, hi, n, post FROM prices WHERE pkey=?").get("gpu:rtx 3070"));
  assert.doesNotThrow(() => db.prepare("SELECT pkey, spd, sdays, sn, src, act, act_at FROM prices").all());
});
await t("Menu always has the connection box, so a wrong address or key can be fixed without admin tools", async () => {
  assert.match(html, /\n  \$\{connCard\(\)\}\n/);
  assert.doesNotMatch(html, /connected\(\)\?"":connCard\(\)/);
});
await t("a failed deals load offers Try again (and Check address and key for a wrong key), and never also says Loading deals…", async () => {
  // Fliptimize redesign: loading shows skeleton cards; still nothing at all when the load failed
  assert.match(html, /HD\.deals===null\?\(HD\.err\?"":`<div class="mu" role="status"[^`]*>Loading deals…<\/div>`\+/);
  assert.match(html, /onclick="HD\.err='';render\(\)">Try again<\/button>/);
  assert.match(html, /\/wrong key\/i\.test\(HD\.err\)\?`<button class="s" onclick="goConnect\(\)">Check address and key ›<\/button>`/);
});
console.log(`\n${n} checks passed`);
