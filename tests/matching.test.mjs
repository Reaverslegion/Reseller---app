// Product matching on REAL eBay titles (taken from live deals, 26 Oct 2026). Each one was checked by hand.
// If a change makes any of these match differently, the change is wrong or this list needs a reasoned update.
// Run: node tests/matching.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { groupOf, RISK_WORDS, MULTI_VAR };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const key = (title, cat, catName) => { const g = W.groupOf({ title }, cat, catName, "used"); return g ? g.key : null; };
const GPU = ["27386", "Graphics/Video Cards"], CON = ["139971", "Video Game Consoles"], TAB = ["171485", "Tablets & eBook Readers"], LAP = ["177", "PC Laptops & Netbooks"];

t("graphics cards match their exact model", () => {
  assert.equal(key("MSI GeForce RTX 3060 Ti 8 GB GAMING X TRIO Graphics Card", ...GPU), "gpu:rtx 3060 ti|used");
  assert.equal(key("EVGA 11G-P4-6390-KR GeForce GTX 1080 Ti Founders Edition 11GB Graphics Card", ...GPU), "gpu:gtx 1080 ti|used");
  assert.equal(key("XFX AMD Radeon RX 5700 XT THICC III Ultra 8GB GDDR6 PCIe 4.0 FreeSync", ...GPU), "gpu:rx 5700 xt|used");
});
t("laptop GPU chips are not graphics cards (was priced as a desktop RTX 5000)", () => {
  // it may only be compared with listings of the same chip code, never with RTX 5000 cards
  assert.doesNotMatch(String(key("NVIDIA Quadro RTX 5000 Mobile GPU - N19E-Q5-A1", ...GPU)), /^gpu:/);
});
t("laptops: Intel 10th and 11th gen are told apart (were both '1th gen')", () => {
  assert.match(key("Lenovo V14-IIL 82C4 Laptop Intel i5-1035G1, 8GB DDR4 RAM, 256GB NVMe, Win 11 Pro", ...LAP), /^lap:intel-i5-g10\|r8\|s256/);
  assert.match(key("Dell Vostro 3520 / Intel i5-1135G7 @2.40GHz / 8GB RAM / 256GB NVMe", ...LAP), /^lap:intel-i5-g11\|/);
  assert.match(key("Lenovo L15, Intel Core i5-10210U, 8GB RAM, 256GB SSD", ...LAP), /^lap:intel-i5-g10\|/);
  assert.match(key("lenovo v130-14ikb I5-7200u, 8GB Ram, 250GB SSD Windows 11", ...LAP), /^lap:intel-i5-g7\|/);
});
t("consoles: tablet-only Switch and All Digital Xbox are separate from complete/disc models", () => {
  assert.equal(key("Nintendo Switch Tablet - Improved Battery HAC-001(-01) - Great Condition", ...CON), "con:switch bare|used");
  assert.equal(key("Nintendo Switch HAC-001(-01) 32GB 720p 2020 Console Blue/Yellow Joy-Con", ...CON), "con:switch|used");
  assert.equal(key("Microsoft Xbox One S All Digital Edition 1TB White Console", ...CON), "con:xbox one s digital|used");
  assert.equal(key("Microsoft Xbox One S white Console model 1681 - 400GB", ...CON), "con:xbox one s|used");
});
t("a size alone never groups different products (all '32GB' tablets were priced together)", () => {
  assert.equal(key("Samsung Galaxy Tab a 32GB Black", ...TAB), null);
  assert.equal(key("Nintendo Wii U 32GB Black Console Only PAL Tested Reads Discs", ...CON), null);
  assert.equal(key("Xteink X3 White 16GB with Crosspoint Firmware", ...TAB), null);
  // "10th gen" alone was grouping Kindles with every other 10th-generation product
  assert.equal(key("Kindle paper white 10th gen", ...TAB), null);
});
t("risky and multi-size listings are kept out", () => {
  assert.ok(W.RISK_WORDS.test("Samsung Galaxy A40 - 64GB - Unlocked - fully working with small damage"));
  assert.ok(!W.RISK_WORDS.test("Samsung Galaxy A40 64GB Unlocked, no damage, great condition"));
  assert.ok(W.MULTI_VAR.test("Fanxiang 500GB 1TB 2TB 4TB SSD M.2 NVMe Internal PCIe 4.0"));
  assert.ok(W.MULTI_VAR.test("Kingston NV2 250GB/500GB/1TB NVMe"));
  assert.ok(!W.MULTI_VAR.test("Lenovo L15, Intel Core i5-10210U, 8GB RAM, 256GB SSD"));
});
t("accessories and games aren't consoles (live deals, 29 Oct)", () => {
  // "Console Covers" describes the covers; "bundle" alone doesn't prove a console is included
  assert.equal(key("PS5 Galactic Purple Bundle - Official Console Covers, Controller & Games", ...CON), null);
  assert.equal(key("Xbox Series S Console Skin and Controller Bundle", ...CON), null);
  assert.equal(key("Nintendo Switch 128GB MicroSD Mushroom UHS-I", ...CON), null);
  // "For £20" was read as a model name
  assert.equal(key("PS4 Games , Will Sell Separately Or In a Bundle For £20, hardly used", ...CON), null);
  // real console listings that mention accessories still match
  assert.equal(key("PS5 Console Bundle with 2 controllers and games", ...CON), "con:ps5 disc|used");
  assert.equal(key("PS4 Slim 500GB Console with Controller and Games Bundle", ...CON), "con:ps4 slim|used");
  assert.equal(key("Nintendo Switch OLED with 128GB microSD card", ...CON), "con:switch oled|used");
  assert.equal(key("PS5 Disc Console with Cover Plates", ...CON), "con:ps5 disc|used");
  assert.equal(key("Xbox Series X 1TB Bundle", ...CON), "con:xbox series x|used");
});
console.log(`\n${n} checks passed`);
