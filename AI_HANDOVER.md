# Fliptimize — AI handover log

Purpose: shared asynchronous handovers for Claude and ChatGPT. GitHub is the shared record, not a live chat between AIs.

## Operating procedure
1. At session start read `PROJECT_STATUS.md`, `AI_HANDOVER.md`, `DECISIONS.md` and `SAFETY_RULES.md`, plus the relevant code and recent commits.
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

## Handover template
### YYYY-MM-DD — AI / task
- Branch and starting commit:
- Goal and owner approval:
- Files changed:
- Tests and evidence:
- Issues / risks:
- What remains:
- Suggested next action:
