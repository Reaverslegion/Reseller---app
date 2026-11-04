# FlipScout — consolidated audit report (Stage 4 follow-up + 11-phase master audit)

4 Nov 2026 · testing branch only · main, live app, live Scan service, live database, secrets, Google Cloud/Firebase and
GitHub settings untouched. Companion documents: FlipScout-master-checklist (inventory + 11 phases, saved before new gap work),
FlipScout-stage4-followup-findings (Step 1 detail), FlipScout-decisions-and-phone-checklist (decisions + phone plan), FlipScout-audit-ledger.

## 1. Counts, reconciled with the Stage 4 baseline
| Run | What | PASS | FAIL | PARTLY | NOT TESTED |
|---|---|---|---|---|---|
| 41795613187 (bdb46ee) | Stage 4 baseline | 562 | 6 | 17 | 3 |
| 41871526163 (e3fc588) | **Final full regression** (Stages 1–4 + all new checks) | **627** | **6** | **20** | **15** |
| 41877307607 (06b0c4b) | Targeted re-run of the jobs that failed for test/emulator reasons (main emulator suites skipped on purpose) | 137 | 1 | 7 | 9 |

Why the totals moved: +65 passes are new checks (independent-review fixes, back-end gap tests, release build, compatibility on
Android 11/15, native crash, sort probe, deals-list behaviour test) — no passed test was re-counted to inflate the total.
Baseline failures now gone on testing: debug build, Android backup, Wrangler 3 warnings. The two baseline 2-second sorts were
replaced by fresh emulator timings (below). The 15 NOT TESTED = 3 wrong-key steps (emulator limit) + 12 Android 15 steps that
never started because the emulator didn't open the app in time; those 12 all passed in the targeted re-run.

### Exactly what is still not passing (final regression, after the targeted re-run)
| Result | Check | Evidence | Cause | Next |
|---|---|---|---|---|
| FAIL | Dependencies › phone build: `tar` (critical) via Capacitor CLI 6 | supply job | build tool on GitHub's machines, not in the app | Capacitor 8 (decision D3b) |
| FAIL | Speed › 200 deals: screen start → deals 5.6 s (aim 5) | emulator | emulator variation (same check 3.9 s in the previous run) | phone check |
| FAIL | Speed › 1,000 deals: 5.2 s (aim 5) | emulator | same (4.3 s previously) | phone check |
| FAIL | Speed › 1,500 deals: one sort 2.1 s | emulator | 54 timed sorts in the same run were all ≤ 0.7 s | phone check |
| ~~FAIL~~ fixed | Test service › "a scan runs" | final run | the test never set a category, so it had **never really scanned** (false pass found by the test review's stricter check) | fixed; passes in 41877307607 |
| ~~FAIL~~ fixed | Android 15 › app opened | final run | emulator slow to open the page | retry added; passes in 41877307607 |
| PARTLY (20) | admin connection box; wrong-key typed in Menu (emulator limit) · GitHub's own Actions pinned by tag · target API 34 · signing · key in web address · CORS * · single-user design · Java-crash detail path · 44×44 targets (light, dark) · scrolling smoothness ×7 (software graphics) · release web-view socket (emulator is a developer build) · Capacitor 8 trial connect (trial, passed in re-run) | | | phone / decisions |
| NOT TESTED (3) | wrong-key recovery after the emulator limit: "wrong key" shown · "Check address and key ›" · right key fixes Deals | | emulator can't type in the folded box | **phone check — never verified end to end** |

## 2. New findings and fixes (all on testing, each with a regression check)
Independent review (3 fresh-context reviewers, after the first three were interrupted with no report): 12 Scan service, 15 app, 15 test/CI findings.
**Money and data (fixed):** Buy It Now "too dear" re-check ignored eBay's buyer fee (a deal could stay listed £12+ over your max at £300) ·
auction max bid not lowered for extra postage before comparing (kept deals with bid ≥ max bid) · a Buy It Now deal on an auction listing could take the auction's bid as its price ·
non-GBP or unreadable prices read as pounds (found by my currency gap test) · alert sent for a deal the alert check had just removed · double alerts when scans overlap ·
money settings not checked by the Scan service (text/negative values gave NaN or inflated max pay) · followed listings after the 10th never checked · eBay calls from searches/checks not counted toward the daily limit ·
stored listing price not updated on re-check · keys like "X-FlipScout-Key: …" not hidden in the problem log ·
**cloud backup wiped after tapping "Not now" on the restore offer** · deals never refreshed when returning to the app · settings changed offline lost · alert tap while loading did nothing ·
"Change max" left a fake £0 deal page · Settings redrew while typing (input lost) · late sales list reopened after closing · sheet closed in the same instant stayed visible ·
words typed as numbers saved as 0 · deal page hid a failed "still for sale" check · incomplete backups restored · £5 postage help text promised "profit isn't overstated" (untrue over 2 kg).
**Test/CI honesty (fixed):** a crashed job could show PASS · 3 jobs missing from the report · results lost when a script crashed · the 200-deal-cap test only read source (now runs the real handler; fails with the old cap) ·
smoke scan accepted errors (and never scanned) · "shown twice" and "expired" audit checks could never fail · release checks forced PASS · retried steps counted PASS · crash rows in the wrong area · trial results turned the report red · dead fake servers not detected.
**Not fixed (recorded):** spares not re-priced on re-check (low) · other sellers' usernames kept forever in fill history (privacy decision D11) · read-then-write races in rate limits/scan state (manual lock + alert claim reduce impact) · whole list redrawn on every tap (check on phone first) · ended-auction countdowns don't tick (list now refreshes on return) · ~half of unit tests still check source text rather than behaviour (worst ones replaced).

## 3. Security, ranked
1. High — live app is a debug build, Android backup on, debug-type signing key with password "android" → prepared fix (D1, D1b, D2).
2. Medium — Capacitor CLI 6 build-tool advisory (`tar`) → D3b. (Wrangler 3 advisories cleared on testing → D3.)
3. Medium — the key is the only lock (CORS *); rate limits cap misuse; keep the key private.
4. Low/medium — key accepted in the web address for old app versions → notice + switch prepared (D4).
5. Low — Firebase key unrestricted → D5. Low — retention of other sellers' usernames → D11.
Checked sound: no secrets in 163 commits; SQL always parameterised; key comparison constant-time; harmful listing text never runs; links only open real web addresses; 96 wrong-key tries refused; injection inputs harmless.

## 4–8. Release, backup, dependencies, key migration, Firebase/monitoring
See FlipScout-stage4-followup-findings §3–§7 (unchanged conclusions): release build with the **same key** (updates in place, data kept); Android backup off, FlipScout cloud backup + setup code instead;
Wrangler 4 done on testing, Capacitor 8 trial only; key-in-address notice then switch-off; Firebase restriction recommended; **own native crash capture works** (real test crash recorded and shown; Java-detail path not yet exercised).

## 9. Independent review and master-audit gaps
Reviewers were separate fresh-context agents (no access to my earlier conversation); their scopes: (1) backend/calculations + security/privacy, (2) app functionality/UX + performance/reliability, (3) tests/CI — all five Phase 9 domains covered.
Their leads were reproduced before fixing. Remaining gaps by phase: Phase 2 — stock/Sell, categories, follow/flag, price book, manual backup screens still only partly exercised on the emulator (G1–G5 planned, not done this round);
Phase 6 — tablet size, TalkBack; Phase 7 — long-run soak and Cloudflare cost under load; Phase 8 — mutation checks only for the cap and the review fixes. Database migration from an older schema (G6b) not done.

## 10. Phone readiness
"FlipScout TEST" built (package com.reaverslegion.flipscout.test, can't replace your app). Needs D9 (where it connects) + D10 (install). Checklist in the decisions document.

## Confidence and readiness
- **Controlled test on your phone (TEST app): ready**, once you choose D9. Money, data and safety fixes are tested on the emulator and service; nothing touches your real app.
- **Updating your real app to the testing version: ready after D1/D2/D3 approval and a merge you approve** — strong emulator evidence, but the release-build switch and phone timings have not been seen on a real phone.
- **Public release: not ready** — Capacitor upgrade (Play target), signing/password, branch protection, unexercised screens (G1–G5), TalkBack and phone timings still outstanding.
Confidence: high for money maths, data handling and security on the test setup; medium for real-phone behaviour and speed; low for anything listed as NOT TESTED.

Sources: Evri parcel prices (evri.com/our-services/our-prices) · Capacitor 8 upgrade notes (capgo.app) · Wrangler v3→v4 migration (developers.cloudflare.com) · CVE-2026-47430 (osv.dev).
