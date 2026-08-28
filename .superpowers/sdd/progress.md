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
Task 5: complete (commits 96e13ad..8f7da77, review clean after TWO fix rounds)
  Round 1 (fe27dd7) — self-reported, all correctness:
  - CRITICAL double-send path: approve/skip/markSent/markFailed had no status
    guards, so approve() on a sent row returned it to approved and the sender
    would apply the vacancy a second time. Guards added; illegal transitions
    throw naming id + actual status.
  - postedAt was typed Date but was a string after the JSON round-trip. Revived.
  - recoverStuck renamed countStuckApproved (it counts, never repairs).
  - vitest bumped 2.1.9 -> 3.2.7: 2.1.9 cannot resolve node:sqlite at all
    (upstream bug). Forced, not optional.
  Round 2 (8f7da77) — from review:
  - IMPORTANT: dedupe tests passed even with the unique index deleted; all work
    was done by insertPending's early return. New test bypasses has() via a
    second raw DatabaseSync connection. Mutation-verified: index removed -> fails.
  - IMPORTANT: skip() guarded to pending only meant an approved-but-unsent
    application could not be cancelled, contradicting human-in-the-loop. Now
    pending|approved; still refused from sent|failed.
  - Minor: three-row countStuckApproved test; nonexistent-id branch test.
  Minor OPEN (final review triage):
  - countStuckApproved's `sent_at IS NULL` clause is not independently
    mutation-killed; no public-API state separates it from status='approved'.
  - queue.ts expectedLabel ternary duplicates the quoting logic per branch.
Task 6: complete (commits 5e38167..f98ef18, review clean, no fix round)
  Implementer improved on the plan: narrowed the brief's whole-request `as never`
  to a cast on `thinking` alone (SDK 0.70.1 has no 'adaptive' variant), and
  replaced the response-parsing cast with a type predicate. Reviewer confirmed
  tsc clean and the cache-ordering tests non-vacuous (swapping blocks or dropping
  cache_control both break a test).
  Minor OPEN (final review triage):
  - generateLetter: a successful call whose content has no text block returns
    letter '' but mode 'hybrid'/'full' rather than 'none'. Stored letterMode is
    then misleading. Inherited from the plan; human outcome is the same.
Task 7: REWRITTEN by controller before dispatch (commit follows).
  I attempted the original manual browser capture myself (browser pane is
  session-scoped, no subagent can reach it). The pane would not render hr.ge
  (viewport 0x0, empty accessibility tree), so no UI-triggered search was
  possible. From the page's own origin I brute-forced the payload shape:
  6 wrapper forms, 9 page-size field names, 4 tenants -- every one returns
  500 "Attempted to divide by zero". The error does not vary with payload,
  so the missing divisor is not a field I can name by guessing.
  Decision: capture the contract with Playwright network interception instead
  (scripts/capture-hrge.ts). Playwright intercepts properly, needs no human,
  and doubles as the seam for the adapter. A negative result -- request only
  works from inside the browser -- is an explicit, allowed outcome that
  escalates to the human, because it would make BOTH first-iteration adapters
  browser-based and destroy the "two extremes" check the iteration exists for.
Task 7: complete (commits 4ea812a..HEAD, review clean after one fix round
  + a controller doc pass)
  DECISIVE ANSWER: plain HTTP replay WORKS. hr.ge stays an HTTP adapter, so the
  iteration's "two extremes" check of the Adapter interface survives.
  Root cause of the long-standing 500 "divide by zero": the request was missing
  `Limit`, the page-size divisor. None of the 9 names guessed in recon.
  Real wire body is PascalCase and structurally unlike the bundle's filter model:
  {"Query":"analyst","CategoryIds":[],"WorkExperience":{from,to},
   "WithoutWorkExperience":false,"AnyExperience":false,"OnlySelectedSalary":false,
   "Start":0,"Limit":100,"IsWorkFromHome":false}
  Keyword field is `Query`. Verified live by two reviewers independently:
  totalCount 3271 unfiltered vs 22 for Query="analyst" -- it genuinely filters,
  and empty string behaves as omitted.
  Trap recorded in docs/hrge-api.md: bundle names do NOT map to wire names by
  case. experienceRange -> WorkExperience, and the remote-work checkbox sends
  EmploymentFormTypeIds:[2], not IsWorkFromHome (both are real, different).
  Task 8 builds against tests/fixtures/hrge-search-response-keyword.json.
  Minor OPEN (final review triage):
  - capture-hrge.ts can no longer regenerate the unfiltered baseline fixture;
    it always types a keyword now.
