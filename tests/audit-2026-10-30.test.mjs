// Wrong deals found in the 30 Oct audit of all 178 live deals. Each must stay rejected (no model, or a risk word).
// Run: node tests/audit-2026-10-30.test.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
const src = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8").replace(/export default\s*\{[\s\S]*$/, "");
const W = new Function(src + "\nreturn { groupOf, RISK_WORDS, SCAM_WORDS, BOX_END, HIDE_BELOW };")();
let n = 0; const t = (name, fn) => { fn(); n++; console.log("✓", name); };
const C = { con: ["139971", "Video Game Consoles"], ph: ["9355", "Mobile & Smart Phones"], gpu: ["27386", "Graphics/Video Cards"], lap: ["177", "PC Laptops & Netbooks"], tab: ["171485", "Tablets & eBook Readers"] };
const rejected = (title, c) => W.RISK_WORDS.test(title) || W.SCAM_WORDS.test(title) || W.BOX_END.test(title) || !W.groupOf({ title }, ...C[c], "used");
const WRONG = {
  con: ["Minecraft PS4 Edition PAL PlayStation 4 Disc with Case", "Red Dead Redemption 2 Ps4", "God of War Ragnarök (PS5)", "PS5 Wireless Racing Wheel APEX - PS5",
    "Brand New In Box Sony PlayStation 5 Disk Drive PS5 Upgrade", "ps5 portalblack Edition", "PlayStation 5 Portable Handheld Console In Black PS5 Used 1 Time Good Condition",
    "Portable PlayStation 5", "Thrustmaster T-GT II Servo Base Only Y-350CPX.71 Powered By Blackbow, PC PS4 PS5", "Tekken Heihachi Version Figure Namcom PS4 Japanese",
    "playstation 4 VR virtual reality headset with cables and carry case - NO CAMERA", "ASTRO Gaming Astro Mix Amp Pro MAPTR-002 PS4 PC MAC  MixAmp Pro TR",
    "Ukonic Xbox Series X 85cm Tall Large 91L Fridge", "Wi-Fi Bluetooth Card for Xbox One S",
    "Xbox One S RF/Front Board PCB", "Xbox One Fan & Heatsink – Cleaned, Complete & Ready to Connect", "Nintendo Switch Bundle", "Nintendo Switch RingFit Adventure Boxed Full Set In Excellent Condition",
    "White Nintendo Switch Backbone", "Nintendo Switch - Pokemon Scarlet and Violet Limited Edition - Console Dock Only", "Nintendo Virtual Boy for Nintendo Switch 2  New and Unopened",
    "Satisfye ZenGrip Ronin Mythic edition - for Nintendo Switch and Switch OLED", "Nintendo Switch 32GB Home Console - Black (HAC-001(01 )*SCRATHED SCREEN*",
    "Nintendo Switch Games Console 128GB, Slight Fault On Screen, Boxed, Free P&P", "Nintendo Switch OLED Handheld Console 64GB Pink/Green Chipped Screen",
    "Sony PlayStation 2 Fat Powerboards Tested and Working", "Genuine Original Nintendo Game Boy DMG-01 Clear Shell Housing Buttons Screws", "Acetronic MPU 1000 motherboard",
    "Nintendo 3ds XL - Box, insert and leaflets Only - VGC", "New Nintendo 3DS Xl Motherboard WORKING JP", "SONY PlayStation 5 Console Cover Cosmic Red Disk Edition Gaming Faceplate",
    "Steam Link Model 1003 With AC cable International Adapters And HDMI", "NINTENDO 64 - N64 - BOMBERMAN HERO - CART ONLY", "Nintendo 64 bag/carry case"],
  ph: ["Samsung Galaxy S20 5G 128GB Blue Unlocked **Screen Flickers**", "Samsung Galaxy S22 Ultra 128GB Needs New Screen", "Unlocked iPhone 11 New Screen Needed - Working Condition Green 64gb",
    "Apple iPhone SE (PRODUCT)RED Box with Inserts, Stickers & Paperwork"],
  gpu: ["Nvidia Quadro RTX 4000 8GB GDDR6 Video Card for Dell Precision 7740, N19E-Q3-A1", "DELL Precision 7730/7740 Nvidia RTX 4000 GPU"],
  lap: ["Lenovo ThinkPad X13 i5-10210U 8GB 128GB SSD Win 11 Pro - USB-C Fault", "Dell Latitude 5410 14\" Laptop Core i5-10310U 16GB RAM 256GB SSD LOW BATTERY"],
  tab: ["Apple iPad 9th Generation 64GB Wi-Fi Space Grey Tested - Screen Bar Fault"],
};
for (const [c, list] of Object.entries(WRONG)) t(`${c}: ${list.length} wrong deals from the audit stay rejected`, () => { for (const x of list) assert.ok(rejected(x, c), x); });
t("real consoles still match", () => {
  const k = (x) => (W.groupOf({ title: x }, ...C.con, "used") || {}).key;
  assert.equal(k("Sony PS4 PRO 1TB Console - Black"), "con:ps4 pro|used");
  assert.equal(k("Nintendo Switch OLED Console Tablet HEG-001 (64GB)"), "con:switch oled|used");
  assert.equal(k("Nintendo Switch Console Bare Unit with 1x Left Joy-Con Only - Tested Working"), "con:switch bare|used");
  assert.equal(k("Microsoft Xbox One X 1TB Black Home Console 4K UHD Blu-ray Wi‑Fi"), "con:xbox one x|used");
  assert.equal(k("Microsoft Xbox One S Console 1TB With Extras - Not Xbox Series X Or S"), "con:xbox one s|used"); // was priced as a Series X
  assert.equal(k("Nintendo Switch Non Oled"), undefined);                                                       // was priced as an OLED
  assert.ok(k("Sony PlayStation 2 SCPH-30003 Fat Phat PS2 Gaming CONSOLE ONLY Black"));
});
t("Buy It Nows under 40% of the usual price are hidden", () => { assert.equal(W.HIDE_BELOW, 0.4); });
console.log(`\n${n} checks passed`);
