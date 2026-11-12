# Fliptimize — AI handover log

Purpose: shared asynchronous handovers for Claude and ChatGPT. GitHub is the shared record, not a live chat between AIs.

## Current handover — read first (12 Nov 2026, v1.2)
*Fliptimize — Android app currently named FlipScout.* Prepared by Claude on branch `docs/knowledge-system-v1`
(documentation only). v1.0 was reviewed by ChatGPT; **v1.1–v1.2 corrections await final review and owner approval.**

> **Architecture and scope — do not misread:** Fliptimize's confirmed vision is a broad resale opportunity discovery and
> distribution platform: find products available to buy for less than their realistically achievable resale value,
> wherever they are sold, judged with **historical eBay sold-price and sales-speed evidence**. The **existing eBay engine is
> the foundation — do not propose replacing or rebuilding it.** The **nine categories are an initial test selection, not a
> limit.** Buying sources (where items are bought) are separate from resale evidence (eBay sold history). Recommend a deal
> only with sufficient trustworthy comparable sales; never invent a price, confidence or profit. Broad coverage, other
> buying sources and the shared subscriber pool are **agreed directions, not approved development.** Details:
> [docs/VISION.md §0](docs/VISION.md#0-confirmed-long-term-vision-owner-12-nov-2026--read-this-first).
This section replaces nothing below it: older dated entries and Claude's earlier handoffs are history — when they
disagree with this section or with newer evidence, the newer evidence wins.

| Question | Answer now |
|---|---|
| 1. What is implemented? | `main` 1620653: app 2.0.132 (Release A) + Scan service Release B (deployed 11 Nov). `testing` d7efb7a adds app 2.0.133 ("Back up now" feedback), BUILT, NOT RELEASED. Prediction Lab: separate branch only. Full list: [docs/FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md) |
| 2. What is tested and verified? | See [PROJECT_STATUS.md](PROJECT_STATUS.md). 2.0.133: corrected update test 121/0; full regression 676 pass / 7 known fails; phone checks 7/7 (owner-reported). Known failures are reported, never relabelled as passes |
| 3. What has the owner approved? | [DECISIONS.md](DECISIONS.md). **No feature is currently APPROVED FOR DEVELOPMENT** |
| 4. What is only planned or discussed? | AGREED PRODUCT DIRECTION and FUTURE CONCEPT items (broad category coverage, additional buying sources, shared opportunity pool, business model, inventory/finance, dashboards, insights, Repair & Flip, more marketplaces, Backup V2, pagination, improved light theme). Intentionally not designed yet |
| 5. What is uncertain? | eBay data licensing; no verified full database restore; signing-key, Firebase-key and key-in-URL settings; cause of the emulator Back-button failure |
| 6. What is rejected or superseded? | FEATURES_AND_ROADMAP.md §7; DECISIONS.md "Superseded decisions" |
| 7. What action is authorised right now? | Only documentation corrections on `docs/knowledge-system-v1`. **Not authorised:** merging this branch, releasing 2.0.133, any code, deploy, production, database or paid-service change, building any feature |

- **Open defect:** intermittent emulator Back-button failure — cause unknown; do not mark fixed.
- **Direction:** broad resale opportunity discovery and distribution platform built on the existing eBay engine (VISION §0); commercially viable and professional; professional tools first; gamification deferred;
  Reuse Before Build is permanent policy. Engine first — business design is a later, separate phase.
- **Waiting on the owner:** approval of this documentation set; whether to release 2.0.133; open conflicts C3, C4, C7, C8
  and C10 in DECISIONS.md.

| Need | Read |
|---|---|
| Technical state, releases, defects, risks | [PROJECT_STATUS.md](PROJECT_STATUS.md) |
| Decisions, superseded decisions, open conflicts | [DECISIONS.md](DECISIONS.md) |
| Rules for both AIs | [SAFETY_RULES.md](SAFETY_RULES.md) |
| Vision, product rules, business directions, architecture, data licensing | [docs/VISION.md](docs/VISION.md) |
| Feature register, status words and suggested order | [docs/FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md) |
| Backup, disaster recovery, rollback, Backup V2 inputs | [docs/RECOVERY.md](docs/RECOVERY.md) |
| Reuse Before Build policy and research register | [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md) |
| History (not authoritative) | `docs/ENGINEERING_LOG.md` (26 Oct), `docs/audit/` (4 Nov), `docs/capacitor-8-upgrade.md`, dated entries below |

### Evidence labels
Evidence labels say **how we know** something. They are separate from the implementation/approval **status words**
(RELEASED, BUILT NOT RELEASED, APPROVED FOR DEVELOPMENT, AGREED PRODUCT DIRECTION, FUTURE CONCEPT, DEFERRED, REJECTED,
SUPERSEDED, UNVERIFIED/DISPUTED), defined in [docs/FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md#status-words-implementation--approval-status).
If a claim has no label, treat it as `UNVERIFIED`.

| Label | Meaning |
|---|---|
| `VERIFIED` | Checked in the repository or GitHub records (commit, file or run named), on the date stated |
| `OWNER-REPORTED` | The owner reported it (e.g. physical-phone tests, settings, decisions, earlier discussions) |
| `DEV-REPORTED` | Recorded by Claude or ChatGPT earlier; not re-checked when this was written |
| `PROPOSED` | Suggested by an AI; not approved by the owner |
| `UNVERIFIED` / `DISPUTED` | Not checked, or the records disagree |

### Not designed yet (intentional) vs missing records
- **Intentionally not designed (do not invent):** subscription tier names and prices, guarantees, recipient limits,
  first-look windows, allocation algorithms, revenue or subscriber projections, launch dates, detailed future features.
  Concept-level directions are recorded in docs/VISION.md §3 and docs/FEATURES_AND_ROADMAP.md §4.
- **Missing records (exist outside GitHub):**
  - Open-source research done in ChatGPT conversations — outstanding.
  - PDFs delivered in Claude chats: Fliptimize consolidation review (46 pages), visual proposals v1 and v2 (only short
    summaries exist in Claude's project notes).
  - ZIP: `soldprices` sold-price research system (code never committed).
  - The 24 Oct roadmap document (a Claude document, outside GitHub); "MY APP PROGRESS.txt" (earlier project).
  - Claude-only project notes: 39 documents in the Claude Project (22 Oct–12 Nov), visible to Claude only; key content
    is summarised in these GitHub files and the originals stay there as history.

## Operating procedure
1. At session start read `PROJECT_STATUS.md`, `AI_HANDOVER.md`, `DECISIONS.md` and `SAFETY_RULES.md`, plus the relevant code and recent commits. (Added 12 Nov, pending approval: also the relevant file in `docs/`, and the continuity procedure below.)
2. State the branch, exact commit SHA and whether the evidence comes from source inspection, tests or live systems.
3. Work only within the owner's explicit approval. Never treat a suggestion or this document as authorization to edit, deploy, buy or access sensitive data.
4. Add a dated handover entry after authorized work. Preserve earlier entries; don't rewrite another AI's conclusions silently.
5. Include what changed, tests performed, failures, risks, open questions and a single recommended next step. Distinguish confirmed facts from assumptions.
6. Never include secrets, access tokens, customer personal information or credentials in handovers.
7. If concurrent work risks conflicts, use separate task branches and agree ownership before edits. Never force-push or overwrite someone else's work.
8. **GitHub Actions minutes and test scope** (owner-approved 8 Nov 2026; wording reconciled 12 Nov 2026, v1.2 — pending owner approval): commit locally and upload once per finished task, not after every small step. Uploads to test branches get the quick check. Before any test app is built for the owner's phone, and before any merge into `main`, run the test scope the owner has approved for that change — **by default the FULL suite** (Actions > Test changes > Run workflow, level "full"); a narrower, focused scope only with the owner's explicit approval for that change. Requests to merge into `main` still run the full suite automatically. **Every failure is reported and assessed** — never hidden, ignored or relabelled as a pass. A phone build or merge with known failures needs the owner's explicit acceptance of those named failures, recorded with the decision; historical known failures do not automatically block every future phone build, and new or unexplained failures are investigated before proceeding. Any change to this policy beyond this wording needs separate owner approval.
   *Superseded wording, kept for history — 8 Nov 2026:* "GitHub Actions minutes (owner-approved 8 Nov 2026): commit locally and upload once per finished task, not after every small step. Uploads to test branches get the quick check; run the FULL test suite by hand (Actions > Test changes > Run workflow, level "full") before any test app is built for the owner's phone. Every request to merge into main runs the full suite automatically, and it must pass."
   *Superseded wording, kept for history — 12 Nov 2026 (v1.1):* the project's history includes full regression suites, focused tests, known intermittent emulator failures, corrected update tests and owner-approved physical-phone checks. Test scope and release acceptance criteria must be appropriate to the change, documented and explicitly approved by the owner. Known failures are always reported and assessed — never hidden or relabelled as passes — and do not automatically block every future phone build. Any change to this test or release policy beyond clarification needs separate owner approval.

## 2026-11-08 — ChatGPT — coordination setup
Branch: `testing`. This entry documents the repository safety review and collaboration arrangement.
- Production deployment workflow runs tests before publishing, but `main` was reported unprotected.
- Weekly KV price export is not a verified full database backup.
- Cloud backup exists for app data; full disaster recovery is not yet proven.
- Testing branch includes enhanced problem logging and alerts not present in the same form on main.
- Claude is proposed as primary implementer; ChatGPT as independent reviewer and second developer.
- No production changes are authorized. No application code changes are included in this coordination setup.
- Recommended next step: review and agree a safe release/rollback design, with owner approval before implementation.

## 2026-11-08 — Claude — deployment safety lock released (PR #1)
- Branch and starting commit: `main` at `f76fcd8597306190558d725ec892f72e86c0b268`; PR head `eaaf80e4cd4e15c11e87732e19f4f707ee46654d` (branch `claude/deployment-safety`).
- Goal and owner approval: merge the 2-line deploy lock into `main` without a live redeploy. Owner explicitly approved "Option A" on 2026-11-08 at 07:37 UK, after ChatGPT's review.
- Files changed: `.github/workflows/deploy-worker.yml` (+2 lines: comment + `if: github.ref == 'refs/heads/main'`). No other files.
- Result: `main` is now `465d26b5fc8b77b8edda64779d141183cc3121a2`, a 2-parent merge (`f76fcd8` + `eaaf80e`) with `[skip ci]` in its message. It was a normal fast-forward push with no force. PR #1 automatically shows merged (07:37:39Z).
- Tests and evidence (before the push): diff vs main = exactly the 2 lines, and the tree is identical to the PR head. `node tests/run-all.mjs` passed 17/17 files. `actionlint` 1.7.7 passed on all workflows.
- Tests and evidence (after the push): the Actions runs API for `465d26b` shows 0 runs, and 0 runs were created after the push (re-checked at 07:40:01Z, about 2.5 min later: still 0). The latest `Deploy Scan worker` run is still 42389304827 (7 Nov, `f76fcd8`). The lock is present in `main`'s file.
- Earlier the same day (owner-approved): locks were added to `test/ebay-ratelimit` (`b90ec87`) and `check/live-version` (`6f1b9b2`). The owner deleted `deploy/ebay-ratelimit` (`f841138`) and `hotfix/d1-query-main` (`71cd17e`) manually; both are contained in `main`. ChatGPT verified both.
- Not verified by Claude: the actual Cloudflare deployment list for `flipscout-search` (no Cloudflare access). The owner should confirm the latest deployment is still from 7 Nov.
- Issues / risks:
  - Secrets are repo-wide (free plan: no branch protection or environment secrets on private repos).
  - `build.yml` on `main` is unlocked: it produces a signed APK artifact from any branch it's manually run on, but deploys nothing.
  - Direct pushes to `main` are not blocked by GitHub.
- What remains: owner's Cloudflare check; ChatGPT's independent inspection of the result.
- Suggested next action: (needs approval) lock `build.yml` on `main` to main/testing, as `testing` already does.

## 2026-11-09 — Claude — testing improvements and scan-safety fixes merged into `testing`
- Owner-approved merges into `testing` only. Evidence: GitHub PR, merge and Actions records; local test runs.
- PR #2 merged at `4e51986`: GitHub Actions QUICK/FULL levels.
  - QUICK on every upload to a test branch.
  - FULL on every PR into `main` and on manual runs.
  - Capacitor 8 trial is manual only; Markdown-only uploads are skipped.
  - The report shows skipped emulator suites as NOT TESTED, never PASS.
- PR #3 merged at `8d3e323`:
  - deal-card reopen comparison ignores only time labels;
  - atomic scan lock: one scan at a time, released after every scan, expires after 15 min;
  - 20 s network timeouts, an 8-min scan budget and a 10-min hard stop;
  - incomplete scans are reported, keep existing deals and release the lock;
  - stalled-response tests (no answer, and headers then a stalled body).
- Merged code is identical to the tested commits. Both merges used `[skip ci]`; no workflows ran.
- Last QUICK check ([run 42544602887](https://github.com/Reaverslegion/Reseller---app/actions/runs/42544602887)): 111 passed, 2 failed (known), 14 not tested (emulator, by design).
- Outstanding issues:
  - dependency security warnings (phone build);
  - paused D9 phone-test build check;
  - intermittent emulator "journeys" failures.

  The corrected reopen test still needs confirming in a future FULL run.
- Production has **not** received these fixes. `main` is unchanged at `465d26b`, and the last live deploy was 7 Nov. Do not change `main` or the live deployment without separate owner approval.
- Next priorities: release-readiness testing; investigate the security warnings; backup and disaster recovery; research suitable open-source additions.

## 2026-11-10 to 11-11 — Claude — gap entry (recovered 12 Nov from Claude's project records)
These were not logged here at the time.
- Release A merged into `main` (`9e7269a`, 11 Nov): app 2.0.132 with Capacitor 8.6.0 and the Fliptimize redesign; build run
  42975706497. Owner installed it; phone checks incl. push alerts passed (owner-reported).
- Release B merged into `main` (`1620653`, `[skip ci]`) and deployed by hand on owner approval (run 43011291965) → live
  version ec61ce36, 11 Nov 11:22 UTC. Deploy workflow disabled again afterwards. 60-minute monitoring: 0 errors
  (developer-reported). Deal count fell 758 → 44 because every deal is now re-judged against the owner's spending limit.
- Rollback target recorded: 0d44aa43 (docs/RECOVERY.md).

## 2026-11-11 to 11-12 — Claude — Android phase (testing only)
- Branch `testing`, from `1620653` to `d7efb7a`. Owner-approved: Back-button investigation, "Back up now" feedback,
  regression checks, update test, phone verification. No merge to main, no deploy.
- Changes: `index.html` backup feedback (d8e1e4a, 59c4133); tests (`tests/backup-feedback.test.mjs`,
  `tests/android/back-check.mjs`, update-test fix 577c591).
- Evidence: unit tests 9/9; focused Back run 43157675925 36/36; full regression 43159909815 676 pass / 7 fail (known);
  corrected update test 43165667086 121 PASS / 0 FAIL; build #133 run 43159922572 (same app ID and certificate as 2.0.132).
  Owner-reported: 2.0.133 installed, 7/7 phone checks passed.
- Open: emulator Back-button failure (cause unknown). About 237 GitHub minutes used in this phase.
- Next (needs approval): decide whether to release 2.0.133 to main.

## 2026-11-12 — Claude — project knowledge system v1.0 (documentation only)
- Branch `docs/knowledge-system-v1` from `main` `1620653`. Owner approved preparing documentation on a dedicated branch;
  **no merge into main or testing without explicit approval**; no code, deploy or production change.
- Files: updated `AI_HANDOVER.md`, `PROJECT_STATUS.md`, `DECISIONS.md`, `SAFETY_RULES.md`, `README.md`; new
  `docs/VISION.md`, `docs/FEATURES_AND_ROADMAP.md`, `docs/RECOVERY.md`, `docs/OPEN_SOURCE.md`. Historical entries and
  files kept; nothing moved or deleted.
- Sources: repository (`main`, `testing`, branches, Actions records), Claude's 39 project notes, Claude's memory of owner
  statements, the owner's 12 Nov instructions. ChatGPT records were **not** available.
- Workflows checked before committing: documentation-only pushes to a non-main branch start no workflow (test.yml ignores
  `docs/**` and `**.md`; build, deploy and Pages run only from `main`; phone/update tests only for their request files).
- Needs: owner approval; ChatGPT independent review; the missing records listed at the top.

## 2026-11-12 — Claude — knowledge system v1.2 (confirmed product vision, documentation only)
- Branch `docs/knowledge-system-v1`, from `acbc8ae`. Owner's confirmed vision (given to ChatGPT) recorded.
- Changes: VISION §0 (central principle; eBay engine as foundation; eBay sold history as valuation evidence; nine categories
  = test selection; eligibility principles; buying sources vs resale evidence; shared pool; current / agreed / not-approved
  table); feature register rows for coverage, buying sources, shared pool and the category safeguard; DECISIONS principles
  and two superseded entries; this handover's scope box; procedure 8 reconciled (old wording kept).
- C3, C4, C7, C8 and C10 deliberately left open. No application, workflow or configuration file changed; no workflow ran.
- Needs: final independent review; owner approval before any merge.

## 2026-11-12 — Claude — knowledge system v1.1 (ChatGPT review corrections, documentation only)
- Branch `docs/knowledge-system-v1`, from `d5d0007`. Owner-approved limited corrections after ChatGPT's independent review.
- Changes: one consistent status scheme (separate from evidence labels); business model recorded as agreed directions and
  concepts only (no prices, tiers, limits, algorithms or projections; £4.99 one-time purchase noted as not approved);
  future features re-labelled (nothing is approved for development); spares rule kept, with a proposed Repair & Flip
  clarification awaiting the owner (C10); Backup V2 design inputs recorded; false conflicts C5, C6, C9 marked "not a
  conflict"; testing/release acceptance clarified; risks list completed; open-source register marked as a starting point.
- No application, workflow or configuration file changed. No workflows triggered (docs-only push to a non-main branch).
- Needs: final independent review; owner approval before any merge.

## Context continuity procedure (`PROPOSED` 12 Nov 2026 — needs owner approval)
**Start of every session (Claude or ChatGPT):**
1. Read "Current handover" at the top of this file.
2. Read `PROJECT_STATUS.md` and `SAFETY_RULES.md`; check recent entries in `DECISIONS.md`.
3. Confirm the branch and exact commit you are looking at; compare with the commits named here.
4. Treat older handovers as history when newer evidence exists. Look for stale or conflicting records (a "Last reviewed" date older than the latest release or 7 days; anything marked
   `DISPUTED`). Say so before relying on them.

**After each meaningful milestone (a release, a test phase, an owner decision):**
1. Update `PROJECT_STATUS.md` (state, evidence, defects).
2. Update `docs/FEATURES_AND_ROADMAP.md` (status of affected features).
3. Record owner-approved decisions in `DECISIONS.md`, with the owner's words where possible and the reason. Never delete a
   superseded decision — move it to "Superseded".
4. Refresh "Current handover" above and add a short dated entry below.
5. One documentation commit per milestone, on a branch, with no workflow triggered; merging needs owner approval.

**Review and disagreements:**
- ChatGPT independently reviews major changes and adds a dated review entry. Disagreements go into DECISIONS.md
  ("Conflicts awaiting the owner") or are marked `DISPUTED` — **neither AI silently overwrites a disputed decision or
  another AI's conclusion.**
- The owner has final authority. No AI may grant itself standing approval.

## Handover template
### YYYY-MM-DD — AI / task
- Branch and starting commit:
- Goal and owner approval:
- Files changed:
- Tests and evidence:
- Issues / risks:
- What remains:
- Suggested next action:
