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
