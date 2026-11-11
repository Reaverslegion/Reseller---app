# Fliptimize — mandatory collaboration safety rules

These rules document the owner's preferences; they do not grant new permissions.

1. **Production is off limits without explicit approval.** Never merge, push, deploy or modify `main`, live app, live Worker, live D1/KV, live credentials, production account settings or customer data without the owner's specific approval for that action.
2. **Testing must stay isolated.** Use the `testing` branch or a dedicated task branch, fake eBay responses, separate test database/KV/Worker and emulator for approved testing. Never use production credentials or real customer data in tests.
3. **Ask before spending.** Do not create paid resources, upgrade plans, start subscriptions or enable chargeable features without explicit permission.
4. **Protect secrets.** Never commit, paste into logs, or hand over API keys, passwords, service account files, signing keys or personal data. Use approved secret stores and least-privilege access.
5. **No destructive shortcuts.** Do not delete databases, wipe storage, overwrite backups, force-push, disable security checks or alter signing keys without separate explicit approval and a recovery plan.
6. **Independent review.** Claude and ChatGPT must challenge each other's assumptions, verify against actual code and test results, and distinguish unverified claims from evidence.
7. **Safe releases.** Before proposing a production release, show tests, changed files, migration and rollback plan, customer impact and owner approval requirements. Do not assume a successful build proves safety.
8. **Plain English.** Give the owner one practical step at a time, clear risks and costs, and avoid jargon. The owner has no coding experience.
9. **No unrequested prompts.** Discuss and agree work with the owner first. Do not generate instructions to send to Claude until the owner asks for them.
10. **Asynchronous coordination only.** GitHub files are a shared status record, not a live direct link between AI conversations. Read current files before work; append dated handovers and avoid overwriting concurrent changes.
11. **Stop on uncertainty.** If the target environment, permission, impact or recovery path is unclear, stop and ask rather than guessing.
