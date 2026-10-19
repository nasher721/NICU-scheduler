# Scheduling workflow

## Import and review

Choose a local XLSX workbook. The importer retains all populated cells across every sheet and extracts supported date-based calendar regions. Headers, aggregate tables, notes, availability offers and capacity scenarios remain source evidence rather than becoming dated assignments automatically.

In **Review queue**, inspect proposed groups and their exact source cells. Confirm aliases explicitly; similar names are not merged automatically. Multi-person labels identify separate participants. Cancelled entries can be excluded while retaining their source formatting. For overlapping dates, choose an authoritative calendar sheet.

The individual-strikethrough setting hides bulk proposals and prevents multi-entry cancellation batches. Other same-date assignments for identified participants are shown as context. A source strikethrough alone does not prove cancellation.

Every review requires a reason, is audited, and can be reopened. Batch writes are atomic and reject stale revisions. Notes and historical change requests require interpretation; acknowledging them does not apply a swap or create availability.

## Clinical credit

**Source workload** displays imported annual targets and reported ledgers separately. **Clinical credits** tracks the workbook categories contributing to week/weekend obligations and shows source evidence for each person.

General day-to-credit conversions start pending. To approve a known quantity independently, choose **Approve credit for specific dates**, select the person/category and exact reviewed source dates, and record the quantity and rationale. Split sources need explicit participant shares first. Explicit approvals replace later derived credit for the same person and dates; they are never added twice. Source changes invalidate approvals, and removing an approval restores applicable derived credit or pending status.

When a department confirms a general policy, configure qualifying weekdays, dates per credit unit, partial-credit treatment, calendar-year scope and moonlighting treatment. Each qualifying date earns its allocated share divided by the approved dates-per-credit rate. These date-based rules do not establish whole-block or holiday policy automatically.

Remaining obligation is the annual target minus valued scheduled credit. It is labeled partial while source work remains unvalued. Imported reported credit is shown separately, never added to derived/explicit credit. CDI, Jeopardy and NMET remain separate exposure counts under the supported annual workbook formulas.

## Scheduling assistance

Confirm staff active dates and eligible services. Select a date/service, or open a resolved calendar entry and choose **Compare replacements**.

Choose a comparison category to use the imported reported shortfall while conversions are pending. Once explicit credit or conversion rules exist, the comparison uses the labeled partial valued subtotal. Missing conversion rules leave proposed assignment credit pending.

Confirmed leave, inactive dates, ineligible services and duplicate same-service work block saving. Unknown timing, rest, compatibility and unstructured availability findings require review. Saving a provisional draft requires acknowledgment and a reason; the server revalidates against the latest revision.

The schedule and ledger use the same draft assignments. Removing a draft restores the original source or removes the new proposal. Source or eligibility changes can invalidate a draft and withhold credit. No draft is published automatically.
