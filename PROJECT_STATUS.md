# Fliptimize — project status

**Fliptimize — Android app currently named FlipScout.**
Last reviewed: 2026-11-12 (Claude, documentation phase v1.0, branch `docs/knowledge-system-v1`; awaiting owner approval and ChatGPT review)
Status: WORKING DRAFT — verify against current GitHub and Cloudflare before relying on it.
Owner: single nontechnical operator. Explain everything in plain English.
Evidence labels: see [AI_HANDOVER.md](AI_HANDOVER.md#evidence-labels).

## Product
Android eBay reseller opportunity app, intended to become a commercially viable professional reseller platform
(owner, 12 Nov 2026). Core capabilities include eBay scanning, sold-price analysis, estimated profit and sell-through,
deals and alerts. Subscription tiers, fair deal distribution and multi-user business operations are planned, not built.
Vision, rules and architecture: [docs/VISION.md](docs/VISION.md). Features: [docs/FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md).

## Environments (checked 12 Nov 2026)
| Item | State | Evidence |
|---|---|---|
| `main` (production code) | `1620653` (11 Nov): Release A app 2.0.132 + Release B Scan service | `VERIFIED` git |
| Live Scan service | Version ec61ce36 (code upload b4e3e4a7), deployed 11 Nov 11:22 UTC with wrangler 4.157.0; rollback target 0d44aa43 | `DEV-REPORTED` (Release B record); not re-checked today |
| Deploy workflow ("Deploy Scan worker") | **Disabled** (manually) | `VERIFIED` Actions API |
| Build workflow | Enabled; signed builds only for `main`, or `testing` when started by hand | `VERIFIED` build.yml |
| `testing` | `d7efb7a`: main + "Back up now" feedback (app 2.0.133) + test fixes | `VERIFIED` git |
| Owner's phone | App **2.0.133** from the testing build (run 43159922572), installed over 2.0.132 | `OWNER-REPORTED` 12 Nov |
| `feature/prediction-lab` | `812dae5`, 1 commit not in main; built on older testing code; not deployed | `VERIFIED` git |
| Other unmerged branches | `claude/capacitor-compare`, `test/d1-query-fix`, `test/ebay-ratelimit`, `check/live-version` — believed superseded (their fixes reached main by other merges) | `UNVERIFIED` |

## Releases
| Release | What | Evidence |
|---|---|---|
| Release A — app 2.0.132 | Capacitor 8.6.0, Fliptimize redesign, tested app fixes; release build, same key, Android backup off | `VERIFIED` main 9e7269a, build run 42975706497; phone checks incl. push alerts `OWNER-REPORTED` 11 Nov |
| Release B — Scan service | Deal limit 3,000, scan lease and time limits, Problems list, postage/profit fixes, D1 query fix, eBay rate-limit protection; additive problem-log table | `VERIFIED` main 1620653; deployment and 60-minute monitoring (0 errors) `DEV-REPORTED` |
| 2.0.133 (testing, **not released**) | "Back up now" feedback (busy state, success only after the service confirms, failure + Try again, 20-second limit, screen-reader status) | `VERIFIED` testing; unit tests 9/9; corrected update test 121 PASS / 0 FAIL (run 43165667086); full regression 676 pass / 7 fail, all known (run 43159909815); phone checks 7/7 `OWNER-REPORTED` |

Physical-phone results for 2.0.133 (`OWNER-REPORTED`, 12 Nov): installation and version confirmed; items, settings and
categories preserved; Back navigation, sales sheets and theme changes passed; backup success and offline failure handling
passed; deals and Scan service connection working; test notification received. A successful phone test does **not** mean
every open defect is fixed.

## Known defects and risks
1. **Intermittent emulator Back-button failure** on deal pages — root cause unknown; only seen in long emulator suites;
   36/36 in a focused long-session run; passed on the physical phone. A one-off Android "not responding" (input dispatch
   5 s) warning on the emulator is a *possible* explanation, **not confirmed**. Keep open. (`VERIFIED` test runs)
2. Two emulator speed results slightly over target (filter 2.8 s; 1,500 deals 5.5 s vs 5 s aim). (`VERIFIED` run 43159909815)
3. **Data licensing** for sold-price modelling unresolved — blocks commercial launch (docs/VISION.md §6).
4. **No verified full database backup or tested restore** (docs/RECOVERY.md).
5. Single-user design (one shared key, no accounts) — not suitable for paid users as-is.
6. eBay call limit (about 5,000/day recorded) is shared by the whole service; multi-user scale needs a plan.
7. `main` has no branch protection (free GitHub plan); secrets are repository-wide.
8. Unverified security items: signing-key password change (D1b), key-in-address switch-off (D4), Firebase key restriction (D5).
9. Cosmetic: an update-test label says "build #120" when the previous version is 2.0.132.

## Current priorities (`PROPOSED`, needs owner approval)
1. Owner and ChatGPT review of this documentation set; decide on merging it.
2. Decide whether to release 2.0.133 to `main`.
3. Verify database backup options and a restore in a test database.
4. Resolve data-licensing questions before any commercial work.
5. Then the active product priorities in docs/FEATURES_AND_ROADMAP.md.

## Verification limitations (12 Nov 2026)
Based on the repository, GitHub Actions records and Claude's project records. Not checked today: live Cloudflare
configuration and deployments, actual backup objects, billing and remaining GitHub minutes, secrets, Firebase settings.
Phone results are owner-reported. Do not claim those are healthy without checking.

---

## Superseded snapshot — status as reviewed on 2026-11-08 (kept unchanged for history)

### Environments
- `main`: production code. Never push, merge, deploy or change production without explicit owner approval.
- `testing`: nonproduction development and tests. Test infrastructure must remain separate from production.
- `feature/prediction-lab`: experimental Prediction Lab work; do not assume merged or deployed.

### Verified source-level observations (2026-11-08)
- Production Worker deployment is triggered by changes to `worker.js` or its deployment workflow on `main`; automated tests run before deployment.
- `main` was reported unprotected by the GitHub branch API. Recheck before taking action.
- Production weekly KV export covers resale price data and optionally fill sales, not a complete D1 disaster-recovery snapshot. Live backup success and restore are unverified.
- Android app has local and cloud backup logic; end-to-end disaster recovery remains unverified.
- Production error monitoring is less developed than `testing`, which contains a Problems log and repeated-error alerts.
- Existing production app/service authentication is not suitable as-is for independent paid user accounts.
- Testing branch includes substantial changes not yet integrated into main. Reconcile current production fixes before any future merge.

### Current priorities (8 Nov)
1. Agree on and test a safe, owner-approved production release process.
2. Verify full backups and restore in an isolated environment.
3. Document and test rollback without overwriting newer customer data.
4. Add independent service health monitoring and understandable owner alerts.
5. Review multi-user authentication, permissions and signing before paid launch.

### Verification limitations (8 Nov)
This status is based on repository inspection, not access to live Cloudflare configuration, actual backup objects, billing, current secrets or physical-phone testing. Do not claim those are healthy without checking.

### Next step (8 Nov)
Claude and ChatGPT should read all four coordination documents, compare them with the latest repository state, and propose the first small safety improvement. No implementation or deployment is authorized by these documents.

What changed since 8 Nov: deployment now runs only by hand (workflow disabled between releases); the Problems log
reached production in Release B; testing's changes were integrated into main as Releases A and B.
