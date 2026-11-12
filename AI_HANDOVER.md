# Fliptimize — AI handover log

Purpose: shared asynchronous handovers for Claude and ChatGPT. GitHub is the shared record, not a live chat between AIs.

## Current handover — read first (12 Nov 2026)
*Fliptimize — Android app currently named FlipScout.* Prepared by Claude on branch `docs/knowledge-system-v1`
(documentation only). **Not yet approved by the owner or reviewed by ChatGPT.**

- **Production (`main` 1620653):** app 2.0.132 (Release A) + Scan service Release B, deployed 11 Nov. Deploy workflow disabled.
- **Testing (`d7efb7a`):** app 2.0.133 = "Back up now" feedback. Installed on the owner's phone; 7/7 phone checks passed
  (owner-reported). **Not merged into main or released.**
- **Open defect:** intermittent emulator Back-button failure — cause unknown; do not mark fixed.
- **Direction:** commercially viable professional reseller platform; professional tools first; gamification deferred;
  Reuse Before Build is permanent policy.
- **Biggest risks:** eBay data licensing for price modelling; no tested full database restore; single-user design.
- **Waiting on the owner:** approval of this documentation set; whether to release 2.0.133; conflicts C3–C9 in DECISIONS.md;
  the missing records below.

| Need | Read |
|---|---|
| Technical state, releases, defects | [PROJECT_STATUS.md](PROJECT_STATUS.md) |
| Decisions, superseded decisions, open conflicts | [DECISIONS.md](DECISIONS.md) |
| Rules for both AIs | [SAFETY_RULES.md](SAFETY_RULES.md) |
| Vision, product rules, architecture, data licensing | [docs/VISION.md](docs/VISION.md) |
| Feature register and roadmap | [docs/FEATURES_AND_ROADMAP.md](docs/FEATURES_AND_ROADMAP.md) |
| Backup, disaster recovery, rollback | [docs/RECOVERY.md](docs/RECOVERY.md) |
| Reuse Before Build policy and research register | [docs/OPEN_SOURCE.md](docs/OPEN_SOURCE.md) |
| History (not authoritative) | `docs/ENGINEERING_LOG.md` (26 Oct), `docs/audit/` (4 Nov), `docs/capacitor-8-upgrade.md`, dated entries below |

### Evidence labels
Used in every document. If a claim has no label, treat it as `UNVERIFIED`.

| Label | Meaning |
|---|---|
| `VERIFIED` | Checked in the repository or GitHub records (commit, file or run named), on the date stated |
| `OWNER-REPORTED` | The owner reported it (e.g. physical-phone tests, settings, decisions) |
| `DEV-REPORTED` | Recorded by Claude or ChatGPT earlier; not re-checked when this was written |
| `APPROVED` | Approved by the owner but not implemented yet |
| `PROPOSED` | Proposed or being researched; not approved |
| `DEFERRED` / `REJECTED` | Kept for later / decided against |
| `SUPERSEDED` | Replaced by a later decision (kept for history) |
| `UNVERIFIED` / `DISPUTED` | Not checked, or the records disagree |

### Missing records (exist outside GitHub; do not invent their contents)
- **ChatGPT conversations:** business-model details — subscription tiers and prices, one-time purchase, round-robin
  allocation rules, priority windows, redistribution, limited recipients, worldwide toolkit, potential/secured/realised
  profit definitions, market insights, Repair & Flip, Backup V2 contents, any open-source research.
- **PDFs delivered in Claude chats:** Fliptimize consolidation review (46 pages), visual proposals v1 and v2 (only short
  summaries exist in Claude's project notes).
- **ZIP:** `soldprices` sold-price research system (code never committed).
- **Other:** the 24 Oct roadmap document (a Claude document, outside GitHub); "MY APP PROGRESS.txt" (earlier project).
- **Claude-only project notes:** 39 documents in the Claude Project (22 Oct–12 Nov), visible to Claude only. Their key
  content is summarised in these GitHub files; the originals stay there as history.

## Operating procedure
1. At session start read `PROJECT_STATUS.md`, `AI_HANDOVER.md`, `DECISIONS.md` and `SAFETY_RULES.md`, plus the relevant code and recent commits. (Added 12 Nov, pending approval: also the relevant file in `docs/`, and the continuity procedure below.)
2. State the branch, exact commit SHA and whether the evidence comes from source inspection, tests or live systems.
3. Work only within the owner's explicit approval. Never treat a suggestion or this document as authorization to edit, deploy, buy or access sensitive data.
4. Add a dated handover entry after authorized work. Preserve earlier entries; don't rewrite another AI's conclusions silently.
5. Include what changed, tests performed, failures, risks, open questions and a single recommended next step. Distinguish confirmed facts from assumptions.
6. Never include secrets, access tokens, customer personal information or credentials in handovers.
7. If concurrent work risks conflicts, use separate task branches and agree ownership before edits. Never force-push or overwrite someone else's work.
8. GitHub Actions minutes (owner-approved 8 Nov 2026): commit locally and upload once per finished task, not after every small step. Uploads to test branches get the quick check; run the FULL test suite by hand (Actions > Test changes > Run workflow, level "full") before any test app is built for the owner's phone. Every request to merge into main runs the full suite automatically, and it must pass.

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

## Context continuity procedure (`PROPOSED` 12 Nov 2026 — needs owner approval)
**Start of every session (Claude or ChatGPT):**
1. Read "Current handover" at the top of this file.
2. Read `PROJECT_STATUS.md` and `SAFETY_RULES.md`; check recent entries in `DECISIONS.md`.
3. Confirm the branch and exact commit you are looking at; compare with the commits named here.
4. Look for stale or conflicting records (a "Last reviewed" date older than the latest release or 7 days; anything marked
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
