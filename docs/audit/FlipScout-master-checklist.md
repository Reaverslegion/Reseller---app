# FlipScout — master inventory and 11-phase evidence checklist

Version 1 · 4 Nov 2026 · saved BEFORE new gap-filling changes (Step 3).
Sequencing note: the original audit asked for this inventory and plan before any coding. Stages 1–4 happened first because
the original prompt was never delivered; that work is kept, and this inventory/plan now governs all NEW gap work.
Environments: E = Android emulator (API 33, plus 30/35 compatibility), C = computer browser, S = isolated test Scan service
+ fake eBay + throwaway database, U = unit test, R = source review, P = physical phone (not yet). Result labels:
PASS / FAIL / PARTLY / NOT TESTED / N/A. Evidence IDs refer to test files and runs 41795613187 (Stage 4) and 41802248435.

## A. Inventory (generated from the code by tests/ci/inventory.mjs, then checked by hand)
13 screens · 116 button/control actions · 15 settings · 33 Scan service endpoints · 14 database tables · 12 integrations.
Not applicable: user accounts, passwords, payments, file uploads (the app has none; one private key per Scan service).
Hidden/admin features (7 taps on the version number): admin tools, Scan now, Fill prices, price list, Problems, manual backup.
Unfinished/placeholder text found: none marked TODO/FIXME; "Not verified yet" categories are a deliberate safety cap.

| Feature / screen | How a user reaches it | Evidence | Env | Result | Gap |
|---|---|---|---|---|---|
| Welcome guide | first start | journeys: First-time welcome guide; compat (API 30/35) | E | PASS | — |
| Connect (setup code) | welcome / Menu | journeys: Connect; Stage 3 set-up | E | PASS | wrong-key fix in Menu: emulator limit (P) |
| Deals list, filters, search, sort, counts | Deals tab | journeys; audit (250 data checks, 13–1,500 deals); sort probe | E,S | PASS | data changing while scrolling (G7) |
| Deal page, live re-check | tap a card | journeys: Deal details; audit bid changes; harmful-data test | E,S | PASS | — |
| Spend limit | Deals / Menu | audit: set/change/remove/reopen | E | PASS | — |
| Postage kinds and £5 allowance | cards | audit postage kinds; unit fixes-stage3 | E,U | PASS (maths) | limits of £5 (G10) |
| Sales list (From N sales ›) | card / deal page | journeys ×3 | E | PASS | — |
| Hunting categories (My categories) | Menu › Change categories | only "popular categories" button tested | E | PARTLY | add/remove/tick categories (G2) |
| Hunting rules: fees, packaging, seller type, alert score, quiet hours | Menu | rules set by script in tests, not by the screen | E | PARTLY | set through the screen, check service (G2) |
| Following (follow, change max, unfollow) | deal card / Following tab | journeys: Following tab (view only) | E | PARTLY | follow → change max → unfollow (G3) |
| Flag a deal | deal page | unit flag.test (service) | U | PARTLY | through the screen (G3) |
| Stock / Sell items, bought, sold, edit, delete, photos | Sell tab | unit finance/stock tests; restore test adds an item by script | U | PARTLY | full journey on emulator + money totals (G1) |
| Money dashboard | Money | unit finance.test | U | PARTLY | totals on screen vs independent sums (G1) |
| Price book: check sold prices / type prices / save | Prices | Fill journeys (fake eBay) | E | PARTLY | type-your-own prices (G4) |
| Price list (admin) | admin tools | none | — | NOT TESTED | open + search (G4) |
| Scan eBay for an item (calculator) | Scan | none | — | NOT TESTED | G4 |
| Alerts (push) | Menu › Turn on alerts | needs Firebase on a real phone | — | NOT TESTED | P |
| Connect eBay account | admin | needs real eBay sign-in | — | NOT TESTED (N/A in test env) | P / owner |
| Cloud backup / restore | automatic + Menu | backup→wipe→restore on emulator; service tests | E,S | PASS | — |
| Manual backup copy/paste (admin) | admin tools | none | — | NOT TESTED | G5 |
| Appearance (auto/light/dark) | Menu | accessibility light/dark; phone dark mode | E | PASS | — |
| Problems list, alerts for repeats | admin tools | Stage 4 monitoring (app, service, DB, job, native crash) | E,S,U | PASS | Java-detail crash path PARTLY |
| Background scan job | Cloudflare schedule | service-checks (failure + next run) | S | PASS | concurrency (G6), eBay errors (G8) |
| Scan service endpoints (33) | app / admin | security (16 endpoints × keys), smoke, unit | S,U | PARTLY | per-endpoint behaviour for rarely used ones (G9) |
| Database tables (14) | service | audit, unit, security | S,U | PARTLY | migrations from an older schema (G6) |
| Install / update / release build | phone | release build on emulator; update from old build NOT tested | E | PARTLY | debug→release update keeps data (G11) |

## B. The 11 phases
| Phase | Requirement | Evidence so far | Result | Planned gap work |
|---|---|---|---|---|
| 1 Understand the app | full inventory, flows, hidden/unfinished | section A; tests/ci/inventory.mjs | PARTLY → this document | keep generated inventory in CI |
| 2 Functional testing | every control, persistence, states, journeys on real Android UI | 41 journeys + 250 data checks + Stage 4 | PARTLY | G1–G5 |
| 3 Adversarial edge cases | bad inputs, duplicates, double taps, interruptions, simultaneous ops, malformed responses | rapid taps, server errors, cut connection, harmful data, 90 injection inputs, damaged record | PARTLY | G6 races, G7 data changes while scrolling, G8 malformed/throttled eBay |
| 4 Database and backend | schema, migrations, concurrency, corruption, calculations, access, backup, rollback | audit, damaged-record, restart, backup tests | PARTLY | G6 migrations + concurrent scans; rollback plan written, not rehearsed |
| 5 Security | auth, isolation, secrets, injection, logs, dependencies, rate limits, privacy, retention | security suite, secret scan, dependency audit, XSS tests, key-in-address | PASS (testing) / decisions pending | reviewer findings |
| 6 UI/UX and accessibility | every screen; contrast, targets, readers, scaling, dark, phones/tablets, Android versions | axe + own checker light/dark; font ×1.3/×2; 320-wide; sideways; API 30/33/35 | PARTLY | G12 tablet; TalkBack = P |
| 7 Performance and reliability | timings 0–1,500+, memory, background, costs | speed at 8 sizes, sort probe, memory, low-memory, offline, restart | PARTLY | long-run use and Cloudflare cost NOT TESTED (estimate only); phone timings = P |
| 8 Automated tests | meaningful assertions, fail on broken code, honest CI | 21 unit files, CI report labels; reviewer pending | PARTLY | G13 deliberately broken code (mutation) checks; reviewer findings |
| 9 Independent review | fresh contexts, 5 domains | 3 reviewers relaunched 16:2x (backend+security; app function/UX+performance/reliability; tests/CI). First 3 were interrupted with no report | IN PROGRESS | triage findings |
| 10 Fix and retest | fix within authority, regression checks | Stages 2–4 fixes; Stage 4 follow-up | IN PROGRESS | after G-work and review |
| 11 Final report | everything labelled with evidence; checklist saved | this file + ledger | IN PROGRESS | Step 8 |

## C. Planned gap tests (priority: money/data → security → reliability → coverage)
- G1 Sell/stock journey on the emulator: add an item, edit, mark bought and sold (with fees/postage), delete; reopen; Money totals checked against independent sums.
- G2 Categories and hunting rules set through the screens; check the Scan service received exactly that.
- G3 Follow a deal with a max, change the max, unfollow; flag a deal; check the service tables.
- G4 Price book: type sold prices, save, see the price used; Price list and Scan screens open and work.
- G5 Manual backup copy → paste restore (admin).
- G6 Two scans at the same moment (manual + background): no duplicate deals, quota counted once each; database created by an older Scan service version, then the new version runs: data kept, columns added.
- G7 Deals change on the service while the list is scrolled/filtered/sorted: refresh shows the new data, no duplicates, position sensible.
- G8 eBay misbehaving (fake eBay): 429 throttling, 500, malformed JSON, missing price, non-GBP currency → no crash, no wrong deals, problem recorded.
- G9 Rarely used endpoints get a behaviour check each (inventory list).
- G10 £5 unknown-postage allowance: independent analysis of when it understates real postage; make the uncertainty clear on the card (already says "postage not stated · £5.00 allowed"; check wording + deal page).
- G11 Update path: an old-style debug build installed with data, then the release build installed over it with the same test key → data kept (proves the live switch won't force a reinstall).
- G12 Tablet-sized screen on the emulator.
- G13 Deliberately broken copies of key functions (fees, postage, spend limit) must make the tests fail.
- Not planned (recorded as NOT TESTED with reason): push alert delivery, TalkBack, real eBay sign-in, physical-phone timings (need the phone/accounts); multi-hour soak and Cloudflare cost under load (minutes/cost).
