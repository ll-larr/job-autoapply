# Progress ledger — job-autoapply, plan 2026-08-27-core-and-first-adapters

Branch: feature/core-and-first-adapters
Plan: docs/superpowers/plans/2026-08-27-core-and-first-adapters.md
Started: 2026-08-28

## Pre-flight decisions (controller)
- Task 10 amended before execution: HTML parsing moved from regex to Playwright
  DOM (`parseSearchPage(page)`), tested offline via `page.setContent(fixture)`.
  Regex HTML parsing would be flagged by review every time and breaks on markup
  changes. Playwright is already a dependency, so no new package.

## Tasks
(append one line per completed task)
- Task 1 (Каркас проекта и модель вакансии): DONE_WITH_CONCERNS — commit ae65ec4. No git identity was configured on the machine; resolved per-commit via `git -c user.name/-c user.email` (not persisted). See task-1-report.md.
Task 1: complete (commits a8b6cd0..ae65ec4, review clean, trailer verified)
  Minor (for final review triage):
  - src/core/vacancy.ts clean() conflates trimming with paragraph normalization;
    newline collapsing is a no-op for title/company/geo.
  - src/core/vacancy.ts new Date(raw.postedAt) does not validate; bad input
    becomes Invalid Date silently. Not mandated to throw by the plan.
Task 2: complete (commits ae65ec4..0283153, review clean, trailer verified)
  No Critical/Important/Minor findings.
Task 3: complete (commits 0283153..c193a9a, review clean, trailer verified)
  Minor (plan-mandated, for final review triage):
  - tests/adapter-contract.test.ts "интерфейс состоит ровно из" asserts
    Object.keys() of one stub object, not the TS interface. Verifies less than
    its name claims; the real guard is strict-mode compilation.
Task 4: complete (commits c193a9a..5bbc0fa, review clean after one fix round)
  Important (plan-mandated) FIXED: cap test used Object.keys() as input, scored
    72, passed even with the cap deleted. Replaced with real per-group keywords
    ('LLM SQL DWH REST BRD ROI BPMN UML Kafka', raw total 102). Mutation-tested:
    removing the cap now fails with "expected 102 to be 100". Plan file updated
    to match so it no longer mandates the vacuous test.
  Minor FIXED: DEFAULT_WEIGHTS made deeply Readonly (compile-time mutation
    guard, verified it does not degrade Object.entries typing to any).
  Minor FIXED: comment recording that weights sum to 102, so the cap is reachable.
