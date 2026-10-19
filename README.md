# NICU scheduler

A local scheduling workspace for importing irregular Excel staff calendars, reviewing ambiguous source entries, comparing coverage candidates, and tracking clinical credit.

## Run locally

Use Node.js **22.14 or newer**.

```sh
npm ci
npm start
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The server binds to loopback. Node 22 may print an experimental SQLite warning.

## Features

- Import every worksheet and retain populated source cells, formatting, formulas and original workbook bytes.
- Display recognized date-based calendar entries without inventing shift times.
- Review aliases, multiple participants, strikethroughs, conflicting source dates, availability, notes and accounting differences.
- Preview grouped decisions; save each batch atomically with individual audit records and stale-write protection. Strikethroughs can require individual review.
- Compare replacement or new-coverage candidates using confirmed eligibility, active dates, availability and workload evidence.
- Save provisional assignments and restore their source entries when removing a draft.
- Compare annual targets, imported reported credit and separately valued scheduled credit.
- Record explicitly approved credit against selected source dates without adopting a general conversion rule.
- Configure clinical category/day conversions when department policy is confirmed, including fractional allocation and moonlighting treatment.
- Export source schedules and credit/review evidence.

See [the workflow guide](docs/WORKFLOW.md) and [testing notes](docs/TESTING.md).

## Data and backups

The app stores workbook bytes, source evidence, review decisions, rules, eligibility profiles, drafts and audit events in `.data/workspace.sqlite`. It does not overwrite the original workbook. Re-importing identical bytes retains existing decisions and workspace state. Changed workbook bytes create a separate snapshot; cross-file merging is not implemented.

For a restorable backup, stop the server and copy the entire `.data` directory. Restore while the server is stopped. The JSON evidence export supports inspection; there is no JSON restore interface.

Set `PORT` to change the local port or `SCHEDULE_DB` to choose another database path.

Workbooks, databases, screenshots, local exports and workbook-specific reports are excluded from this repository. Import your workbook locally. The original demo uses separate browser localStorage and remains available through **Original demo**.

## Validation

```sh
npm test
npm run test:browser
```

Unit/integration tests use synthetic fixtures. Three additional regression checks run when the original audited workbook is available; otherwise they are explicitly skipped. Set `WORKBOOK_FIXTURE` to its local path for those checks and the browser workflows. Browser testing uses installed Microsoft Edge on Windows; `BROWSER_CHANNEL` can select another installed Playwright channel.

## Operational limits

This is a local scheduler tool. Source schedules and app drafts are not published or approved clinical rosters. Blank source cells do not establish required coverage. Clinical eligibility, credit definitions, rest requirements and shift times must be confirmed by the department.

Imported reported credit is kept separate from derived/explicit credit because they may describe the same work. Unresolved participants, unallocated splits, duplicate sources and unsupported conversions remain unvalued. Explicit approvals are invalidated when their source interpretation changes.

Shared authentication, exact shift-time/rest enforcement, automated swaps, publication, employee messaging, payroll, completed-work accounting and whole-year optimization are not implemented.

## Import boundaries

Uploads are limited to 10 MB, 64 MB expanded archive content, 2,000 ZIP entries, 50 sheets, 20,000 rows per sheet, 200 columns and 200,000 populated cells. Parsing runs in a worker with a 20-second timeout. Encrypted and macro-enabled archives are rejected. Formulas are retained as evidence rather than executed. Writes require a local workspace token and expected revision.
