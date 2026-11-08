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

## 2026-11-08 — ChatGPT — coordination setup
Branch: `testing`. This entry documents the repository safety review and collaboration arrangement.
- Production deployment workflow runs tests before publishing, but `main` was reported unprotected.
- Weekly KV price export is not a verified full database backup.
- Cloud backup exists for app data; full disaster recovery is not yet proven.
- Testing branch includes enhanced problem logging and alerts not present in the same form on main.
- Claude is proposed as primary implementer; ChatGPT as independent reviewer and second developer.
- No production changes are authorized. No application code changes are included in this coordination setup.
- Recommended next step: review and agree a safe release/rollback design, with owner approval before implementation.

## Handover template
### YYYY-MM-DD — AI / task
- Branch and starting commit:
- Goal and owner approval:
- Files changed:
- Tests and evidence:
- Issues / risks:
- What remains:
- Suggested next action:
