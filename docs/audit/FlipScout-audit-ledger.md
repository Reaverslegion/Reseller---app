# FlipScout audit — task ledger (living document)

Branch: testing only. Main, live Scan service, live database, secrets and Google/Firebase settings untouched.
Source of instructions: "FlipScout Definitive Master Audit Instructions" (2026-11-04) + Stage 4 follow-up (sections 1–9).
Baseline: Stage 4 final run 41795613187 (commit bdb46ee): 562 PASS · 6 FAIL · 17 PARTIALLY TESTED · 3 NOT TESTED.

## Step 1 — Stage 4 follow-up

| # | Task | Status | Evidence / commit | Next |
|---|---|---|---|---|
| 1 | Exact 6 FAIL / 17 PARTIAL / 3 NOT TESTED | Done (list below) | run 41795613187 report job | — |
| 1b | Slow emulator sorts | Running in CI run 41802248435 (part=stage4) | sort probe added to tests/stage4/app-checks.mjs (every sort option ×3 at 13/1,000/1,500 deals; app-code time, freezes, emulator idle %) | run on emulator |
| 2 | Release build security | In progress | build.yml (testing): Crash capture + Release settings steps, assembleRelease, same signing key file/alias (update path kept), backup off + extraction rules, web view debugging off; throwaway CI key; tests/android/release-check.mjs | run in CI |
| 3 | Capacitor 8 / Wrangler 4 | Wrangler 4: DONE on testing (all checks + deploy dry run passed, run 41802248435; commit 26cfb3a). Capacitor 8: trial build + Android 15 check running | Capacitor 8 = high risk (minSdk 24, Java 21, target 36 edge-to-edge; app has no top safe-area handling) | read cap8 + compat results |
| 4 | Key in web address | Done (testing) | worker.js KEY_IN_URL switch (default unchanged) + "notice" in Problems; tests/key-in-url.test.mjs 5/5 | — |
| 5 | Firebase / Crashlytics / native crashes | In progress | project flipscout-bc19a, package com.reaverslegion.flipscout; own native capture: android-native/CrashInfoPlugin.java + app reporting; emulator test with `am crash` | run in CI |
| 6 | Phone test readiness | In progress | "FlipScout TEST" build job (package com.reaverslegion.flipscout.test, TEST label, alerts off, artifact FlipScout-TEST-for-phone) | write plan; options for a test Scan service need owner approval |

### Stage 4 non-passing checks (run 41795613187)
FAIL (6): Dependencies › phone build vulnerabilities; Dependencies › Scan service deploy vulnerabilities; Phone app build › debug mode;
Phone app build › Android backup; Performance › 13 deals sort/filter (sort 2,259 ms); Performance › 1,000 deals sort/filter (sort 2,002 ms).
PARTIALLY TESTED (17): admin connection box (emulator limit); wrong-key setup code in Menu (emulator limit); GitHub's own Actions pinned by tag;
Android target 34; signing; key in web address; CORS *; single-user design; 44×44 targets light; 44×44 targets dark; scrolling smoothness ×7.
NOT TESTED (3): wrong-key recovery steps after the emulator limit (Deals shows 'wrong key'; 'Check address and key ›'; right key fixes Deals).
Owner verified on phone: only that the keyboard opens and stays open in the connection box — NOT the full wrong-key journey.

## Steps 2–8 — master audit
| Step | Status |
|---|---|
| 2 Inventory + 11-phase map | Started: tests/ci/inventory.mjs (13 screens, 116 actions, 15 settings, 33 endpoints, 14 tables, 12 integrations; ~64 actions with no test mention — must be checked by hand) |
| 3 Gap analysis saved before new fixes | Not started |
| 4 Gap tests + safe fixes | Not started |
| 5 Independent review | 3 fresh-context reviewers running (Scan service; phone app; test quality). Domains not yet assigned: functionality/UX, performance/reliability |
| 6 Audit the audit / CI | Not started |
| 7 Final regression | Not started |
| 8 Report + decision table + phone checklist | Not started |

## GitHub Actions minutes
~815 job-minutes used 1–4 Nov before this work (free plan allowance 2,000/month for private repos, if on the free plan). Full run ≈130.
Recoverable commits pushed with [skip ci] to avoid spending minutes; full runs only when a batch is ready.

## Resume point (saved 08:55, usage limit 91%)
Commits on testing: 19eec1c, a05e07c, 26cfb3a (all [skip ci]). CI run in progress: 41802248435 (Stage 4 emulator part + new jobs, Wrangler 3 in that run).
Background reviewers (fresh context, read-only): Scan service; phone app; test quality — results arrive as notifications.
Next actions, in order:
1. Read run 41802248435: sort probe, native crash test, release check, compat (Android 11/15/Cap8), phone build, supply-chain (in-app browser 6.0.1 + pins).
2. Collect the 3 reviewers' findings; reproduce; fix safely on testing.
3. Finish Step 1 write-up (signing, backup, key migration, Firebase/Crashlytics, phone plan).
4. Step 2–3: finish inventory + 11-phase checklist and gap plan; save BEFORE new gap fixes.
5. Step 4–6 gap tests/fixes, CI audit; Step 7 one full regression (~230 job-min); Step 8 report + decision table + phone checklist.

## Results of run 41802248435 (Stage 4 part + new jobs), read 09:1x
- Sort probe: 54 timed sorts on the emulator, none slow (13 deals max 54 ms; 1,000 max 310 ms; 1,500 max 513 ms; app code ≤ ~300 ms median). The two earlier ~2 s sorts did not recur → most likely emulator hiccups; not proven, recheck on phone.
- Native crash: real test crash (adb `am crash`) recorded once and shown in Problems as "native-crash (C/C++)" with version 2.0.41. Java-detail path not exercised (Android logged it as native).
- Release build on emulator: installs, starts, run-as refused (not debuggable), backup flags off. Web view debugging socket present — expected on emulator developer images; app's own setting is false (build log). Check corrected (commit 5676b36).
- Compatibility: Android 11, Android 15 and Capacitor 8 trial on Android 15 all start the app area at 72 px (below status bar), no overflow, all screens drawn.
- Capacitor 8 trial build: builds (targetSdk 36).
- Phone test build: package com.reaverslegion.flipscout.test, name "FlipScout TEST".
- Slow/cut connection checks failed only because the Scan-now step replaced the seeded deals (test fixed).
- Dependencies: still flagged (Capacitor CLI 6 via tar; wrangler 3 in that run). Testing now uses Wrangler 4.157.0.

## Session 2 (4 Nov, 16:15 onwards)
- First three reviewers were interrupted with no report (their partial leads kept); relaunched with fresh contexts covering all five Phase 9 domains:
  (1) backend + money maths + security/privacy — 12 findings; (2) app function/UX + performance/reliability — 15 findings; (3) tests/CI — 15 findings.
- Master checklist saved before new gap work (commit ebee43e): claude/FlipScout-master-checklist.md, docs/audit/.
- Fixed with regression tests (commits 76cdb77, b97390b, + this one): Buy It Now too-dear ignoring buyer fee; auction max bid vs extra postage; BIN on auction listing; non-GBP/unreadable prices; alert for removed deal; double alerts; server-side settings validation; follows starvation; eBay call counting; listing price on re-check; header-style keys in logs; 10 app fixes (backup wipe after 'Not now', no refresh on return, unsent settings, alert tap while loading, Change max ghost page, typing lost, stale sales sheet, sheet open/close race, words as numbers, silent check failure); test/CI honesty (crashed job could show PASS; jobs missing from report; results lost on crash; cap test was source-only; smoke accepted 4xx; expired/duplicate checks couldn't fail; release checks forced PASS; retried steps counted PASS; crash rows in wrong area; trial FAIL turned report red; start script ignored dead fake servers; hand-worked fee examples).
- Gap tests added: backend-gaps (currencies, simultaneous scans, eBay 429/500/garbage keep deals), deals-list (1,500 + expired, real handler; fails with the old cap), app review-fix journey.
- Not fixed (recorded): spares not re-priced on re-check (low); data retention of other sellers' usernames in fill history (needs owner decision); scan/rate-limit read-modify-write races (manual-scan lock + alert claim reduce impact); full-list redraw cost on every tap (performance, phone check first); ended-auction countdowns frozen (list now refreshes on return).
- Next: final full regression run, then Step 8 report.
