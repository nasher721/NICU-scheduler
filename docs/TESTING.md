# Testing

Use Node.js 22.14 or newer and install the pinned dependencies with `npm ci`.

## Unit and integration checks

Run `npm test`. The suite contains 21 checks spanning the original demo model, import preservation/limits, SQLite persistence, HTTP request boundaries, atomic review batches, revisions, scheduling restrictions, partial/split credits, explicit approvals, credit invalidation and source restoration.

Synthetic workbook fixtures are generated in memory. The three tests requiring the original audited workbook are skipped explicitly if it is unavailable. To include them, set `WORKBOOK_FIXTURE` to the local source path. The fallback looks for the analyzed filename in the current user's Downloads folder. Golden tests verify that workbook's hash and audited sheet/cell counts; a revised workbook needs a new baseline.

## Browser acceptance

Run `npm run test:browser` with the audited workbook available. Both workflows create isolated temporary SQLite databases and avoid changing the main workspace.

- Import and inspect all worksheets; review ambiguous entries; check source downloads and exports; verify duplicate imports, original demo preservation, mobile layout and restart persistence.
- Preview atomic review groups; compare candidates using source-reported workload; approve explicit source-scoped credit with conversions pending; configure test-only rates; allocate split credit; confirm eligibility/leave restrictions; add/remove/replace drafts; verify ledger impacts, source preservation, invalidation safeguards and exported evidence.

The second workflow verifies that explicit credit survives restart and is not counted twice after a general rule is introduced. Removing that approval restores applicable derived credit.

Microsoft Edge is the default browser on Windows. Set `BROWSER_CHANNEL` for another installed Playwright channel. For Playwright Chromium, install it first with `npx playwright install chromium`.

Screenshots are written to ignored `test-results/`. Temporary test databases are removed after normal completion. Neither the source workbook nor personnel-specific reports are distributed with the repository.

## Publication validation

Before the initial application merge, all 21 checks and both acceptance workflows passed against the original workbook on Windows. Department clinical policy, exact shift times/rest enforcement, official publication, automatic swaps, payroll and shared access are outside these checks.
