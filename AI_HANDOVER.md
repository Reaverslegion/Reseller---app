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

## Handover template
### YYYY-MM-DD — AI / task
- Branch and starting commit:
- Goal and owner approval:
- Files changed:
- Tests and evidence:
- Issues / risks:
- What remains:
- Suggested next action:
