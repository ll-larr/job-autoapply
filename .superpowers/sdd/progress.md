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
Task 8: complete (commits 337ccd9..17300c1, review clean after one fix round)
  Plan was REWRITTEN by controller first: the old task text was built on the
  bundle-derived filter model that Task 7 proved wrong.
  Three substantive discoveries baked in:
  - Search response carries NO description, and the scorer reads
    title + description -- every hr.ge vacancy would have scored ~0 and been
    dropped at minScore. Adapter now fetches announcement/{id} per result.
    Description path: data.announcement.description, HTML with numeric
    character references.
  - apply() is deliberately NOT implemented: capturing its contract means
    sending a real application from the user's account to a real employer.
    Returns an honest `failed` with the vacancy URL. USER DECISION PENDING.
  - Fix round: entity-decode test that actually fails without decoding
    (mutation-verified); single-pass decoder killing the &amp;lt; double-decode
    bug; multi-item resilience test (first item's detail fetch fails, second
    succeeds); and REAL THIRD-PARTY PII redacted from the committed detail
    fixture (contactEmail/phones/name from a live listing) -- this repo is
    private but the user has published previously-private repos before.
  ITERATION HYPOTHESIS HOLDING: src/adapters/types.ts unchanged since c193a9a.
  Minor OPEN (final review triage):
  - decoder's hex-entity branch and `apos` named entity are untested additions.

CONTROLLER REORDER: Tasks 9 and 10 (hh.ru) need the user's own manual login
  and cannot proceed without them. Tasks 11 and 12 depend only on Queue and
  the Adapter interface, so they run first. Task 13 needs everything.
Task 11: complete (commits 17300c1..ba23b68, THREE rounds; round-3 review done
  by the controller directly after two session-limit interruptions)
  Round 1 (c5ab8d3): implementer proactively strengthened two vacuous tests
    (sleep-ordering, auth_required halt) and added a persisted-counter test.
    Also fixed a real strict-mode narrowing bug in the plan's own code.
  Round 2 (f80ab74): review found throttling FAILED OPEN -- a source in
    `adapters` with no config.throttle entry sent with no cap and no delay.
    Fixed, but by aborting the whole run.
  Round 3 (ba23b68): review judged the abort over-scoped -- one typo in a new
    adapter's config would stop sending for every correctly-configured source,
    turning a config mistake into a total outage of an unattended tool.
    Rescoped to a per-source skip: rows stay `approved`, other sources keep
    sending, and `SendReport.unthrottledSources` keeps the gap loud.
    Mutation-proved: restoring the Infinity-cap fallback fails two tests.
  Controller verification of round 3, by reading the code not the tests:
    no queue transition on a halting result; cap-reached rows stay approved;
    no captcha retry path; no path where a rule-less source reaches apply().
    unthrottledSources is Set-deduped, sorted, and set on all three exits.
  IMPORTANT OPEN (for final review) -- found by controller, missed by review:
  - sender.ts marks a row `failed` when no adapter is registered for its
    source. `failed` is a dead end (queue has no transition out of it), so a
    missing adapter destroys the application permanently. This is the same
    class of bug as the throttle fail-open just fixed, and it is inconsistent
    with how the missing-throttle-rule case is now handled. Untested.
  Recommendation carried forward from the implementer: config.ts (or the CLI
    wiring in Task 13, which knows the adapter list) should validate that every
    wired adapter has a throttle rule, so the gap is caught at startup.
Task 12: complete (commits ba23b68..9fc41a7, review by controller directly)
  Implementer self-caught a real defect in the PLAN's own bulk-approve code:
  "Одобрить всё" re-fetched /api/pending and approved using the STORED letter,
  silently discarding any unsaved textarea edit -- violating the task's own
  "the textarea is authoritative" constraint. Fixed to read live DOM.
  Extended beyond the brief per controller instruction: approved-but-unsent
  rows are listed and cancellable, since Queue.skip now accepts them and the
  sender's long pauses leave a real window to change one's mind.
  Illegal transitions surface as 409 with the guard's message, never an
  unhandled 500. Genuine server faults still return 500.
  Controller verification: binds 127.0.0.1 (not 0.0.0.0); tests prove the
  edited letter persists, that a duplicate approve does NOT overwrite the
  letter, and that a request to the machine's external IPv4 is refused.
