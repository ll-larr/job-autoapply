# hr.ge `announcement-search` API — captured contract

Captured 2026-08-28 by intercepting the real `www.hr.ge` Angular app with Playwright
(`scripts/capture-hrge.ts`), then verified against the API directly with `curl`.
This document is the durable reference for building the `hrge` adapter (Task 8).

A second capture pass, same day, closed two review findings on the first draft:
it captured a real keyword search (the first pass had clicked search with an
empty box, so no query field ever appeared) and corrected an overstated claim
about how well the bundle-guessed filter field list had been confirmed. See
"Keyword search — the `Query` field" and the correction note in "Request body"
below.

## Decisive question: does plain HTTP replay work?

**Yes.** The captured request replays successfully outside a browser with a bare
`curl -X POST -H "Content-Type: application/json"` — no cookies, no auth token, no
User-Agent, no WAF token. This was verified twice: once with this machine's
`HTTP_PROXY`/`HTTPS_PROXY` (`127.0.0.1:10801`) set, and once with both unset
(`env -u HTTP_PROXY -u HTTPS_PROXY curl ...`). Both returned `HTTP 200` with
identical data. The proxy makes no difference for this endpoint.

**Conclusion for Task 8:** the `hrge` search adapter can be a plain `fetch`/HTTP
adapter, as originally planned. It does not need to drive a browser. (The `apply`
route was out of scope for this task and has not been verified the same way —
see "Open items" below.)

## Why prior recon attempts all got `500 "Attempted to divide by zero"`

The real client sends **`Limit`** — a field name nobody had guessed (9 variants were
tried: `pageSize`, `take`, `rowCount`, `numberOfItemsOnPage`, `itemsOnPage`,
`numberOfListItemsOnPage`, `listItemsOnPage`, `pageItemCount`, `numberOfItems` — none
of them `Limit`). Confirmed directly:

```
POST .../announcement-search  body: {}                → 500 "Attempted to divide by zero."
POST .../announcement-search  body: {"limit":0}        → 500 "Attempted to divide by zero."
POST .../announcement-search  body: {"limit":3}        → 200, 3 real items returned
```

So the server almost certainly computes something like `totalPages = totalCount /
Limit` server-side, and a missing or zero `Limit` divides by zero. This fully
explains the recon dead end — the divisor was a field whose name was never tried,
not a payload-shape issue.

## Endpoint

```
POST https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement-search
```

Tenant `1` is hr.ge's own tenant (confirmed — this is the live production tenant,
not a guess).

### Minimal required headers

```
Content-Type: application/json
```

That's it. Confirmed:
- Omitting `Content-Type` → `415 Unsupported Media Type`.
- `Content-Type: application/json` alone (no `Accept`, `User-Agent`, `Referer`,
  `Accept-Language`, cookies, or auth) → `200`, full real results.

The real browser also sends `accept`, `accept-language`, `referer`, `sec-ch-ua*`,
and `user-agent` (see `tests/fixtures/hrge-search-request.json` for the exact
captured set), but none of them are load-bearing for this endpoint.

### Request body

Exact body sent by the real app for the default (unfiltered) search, first page,
100 results per page (captured verbatim, see
`tests/fixtures/hrge-search-request.json`):

```json
{
  "CategoryIds": [],
  "WorkExperience": { "from": null, "to": null },
  "WithoutWorkExperience": false,
  "AnyExperience": false,
  "OnlySelectedSalary": false,
  "Start": 0,
  "Limit": 100,
  "IsWorkFromHome": false
}
```

Field names are **case-insensitive** on the server (verified: an all-lowercase
`camelCase` version of the same body, e.g. `{"categoryIds":[],...,"start":0,"limit":5,...}`,
also returns `200` with the same shape of data). Use the PascalCase names above for
fidelity with the real client, but camelCase is safe if that's more natural for a
TypeScript adapter.

Only `Limit` is actually required to avoid the divide-by-zero 500. A body of just
`{"Limit": 5}` returns `200` with real results; `Start` defaults to `0` when
omitted. Everything else in the shape above (`CategoryIds`, `WorkExperience`,
`WithoutWorkExperience`, `AnyExperience`, `OnlySelectedSalary`, `IsWorkFromHome`) is
filter state the UI always sends but the server does not require.

**Correction (2026-08-28, closing a review finding on this doc's first draft):**
this paragraph originally claimed the captured fields "matches (and confirms)
the filter field list already extracted from the bundle... same fields, just
PascalCased." That overstated the evidence. What is actually true, broken out
by how each field name was actually established:

- **Observed in a real request, wire name confirmed as a case-only PascalCase
  of the bundle name:** `CategoryIds` (bundle: `categoryIds`),
  `WithoutWorkExperience` (`withoutWorkExperience`), `AnyExperience`
  (`anyExperience`), `OnlySelectedSalary` (`onlySelectedSalary`),
  `IsWorkFromHome` (`isWorkFromHome`), `Query` (`query`),
  `EmploymentFormTypeIds` (`employmentFormTypeIds[]`) — the last two added by
  the second capture pass, see below.
- **Observed in a real request, but the wire name is *not* a case change of
  the bundle name — a different identifier entirely:** `WorkExperience{from,to}`.
  The bundle's field for this is `experienceRange{from,to}`. Had the "just
  PascalCased" claim been trusted literally, an adapter would have sent
  `ExperienceRange` and silently gotten nothing (the server ignores unknown
  fields rather than erroring). This is the concrete counterexample: **a
  bundle field name cannot be converted to a wire name by guessing at a case
  change.**
- **Observed in a real request, not present anywhere in the bundle's 22-field
  list:** `Start`, `Limit` — the pagination fields, including the one whose
  absence caused every prior recon attempt's `500`.
- **Never observed in any real request — name known only from the client
  bundle, unconfirmed:** `localityIds`, `specializationCodes`,
  `industryCodes`, `workScheduleCodes`, `announcementTypeId`,
  `publishDateRangeOptionId`, `seniorityLevelCodes`, `transportTypeIds`,
  `drivingLicenceIds`, `worldLanguageIds`, `educationLevelCodes`,
  `experienceRangeOptionIds`, `employmentFormIds` (a *different* bundle field
  from the confirmed `employmentFormTypeIds` — do not conflate the two),
  `salaryRangeOptionId`, `currentPage`.

8 of the bundle's ~22 filter-related fields were actually seen in a wire
request by this task — the 7 case-match names above plus `WorkExperience`;
the rest remain bundle-only guesses. Anyone
building the adapter should not derive a wire field name from the bundle by
guessing — only the first bullet's names are confirmed, and even among those,
`WorkExperience` shows confirmation still requires seeing the exact string on
the wire, not just recognizing the concept.

### Keyword search — the `Query` field

The capture above was of an **empty search** (search button clicked with
nothing typed into the search box), which is why no query/keyword field
appears in it. `search(filters)` needs `filters.query` to reach the wire —
that required a second, separate capture with a keyword actually typed in.

Re-ran the capture (`scripts/capture-hrge.ts analyst`) with `analyst` typed
into the search box (`input.search-query`, placeholder `"საძიებო სიტყვა"` =
"search word") before clicking search. Diffing the new request body against
the empty-search body above isolates exactly one new field, inserted as the
first key:

```diff
+ "Query": "analyst",
  "CategoryIds": [],
  "WorkExperience": { "from": null, "to": null },
  "WithoutWorkExperience": false,
  "AnyExperience": false,
  "OnlySelectedSalary": false,
  "Start": 0,
  "Limit": 100,
  "IsWorkFromHome": false
```

**The keyword field is `Query`.** Same case-insensitivity as the rest of the
body (`query` also works, confirmed by `curl`). Full captured request/response
pair: `tests/fixtures/hrge-search-request-keyword.json` /
`tests/fixtures/hrge-search-response-keyword.json`.

Verified independently by plain `curl` (no browser involved), both with this
machine's proxy (`HTTP_PROXY`/`HTTPS_PROXY=127.0.0.1:10801`) and with it
unset — identical results either way:

```
POST .../announcement-search  {"Query":"analyst","Start":0,"Limit":100}  → 200, totalCount: 22
POST .../announcement-search  {"Start":0,"Limit":5}                      → 200, totalCount: 3271
POST .../announcement-search  {"Query":"","Start":0,"Limit":5}           → 200, totalCount: 3271
```

The keyword genuinely filters — 22 results vs. 3271 unfiltered, not
accepted-but-silently-ignored. An empty `Query` string behaves the same as
omitting it entirely (sanity-checked, not assumed).

**This is the fixture Task 8 should build the adapter's request against.**
`hrge-search-request.json` / `hrge-search-response.json` (the original,
empty-search capture) remain useful as the "no filters" baseline, but they do
not exercise the field a keyword-search adapter actually needs — see
"Fixtures" at the bottom of this doc.

### A second filter mapping, captured the same way: `EmploymentFormTypeIds`

While re-capturing, the "remote work" checkbox in the UI (`#workFromHome`) was
also toggled on top of the same keyword search — one more UI-filter → wire-field
mapping taken from a real request instead of assumed from the bundle, since it
was cheap to do in the same session. Diffing that request against the
keyword-only one above:

```diff
  "Query": "analyst",
+ "EmploymentFormTypeIds": [2],
  "CategoryIds": [],
  "WorkExperience": { "from": null, "to": null },
  "WithoutWorkExperience": false,
  "AnyExperience": false,
  "OnlySelectedSalary": false,
  "Start": 0,
  "Limit": 100,
  "IsWorkFromHome": false
```

Two things worth flagging:

1. The field is `EmploymentFormTypeIds` (case-only match of the bundle's
   `employmentFormTypeIds[]`) — **not** `IsWorkFromHome`, even though
   `IsWorkFromHome` was already sitting right there in the body (as `false`,
   unchanged by the checkbox) and looks like the obvious candidate for "remote
   work."
2. `IsWorkFromHome` is not a dead or fake field, either — `curl` confirms it
   independently filters: `{"IsWorkFromHome":true}` → totalCount 33 (vs. 3271
   unfiltered baseline). `{"EmploymentFormTypeIds":[2]}` alone → totalCount 37
   — a different, overlapping-but-not-identical set from the same baseline.
   Both fields are real and functional; only a live capture shows which one a
   specific UI control actually sends.

This mapping was not required for Task 8 (which only needs `query`), but is
recorded here as a second, concrete illustration of why a bundle field name
cannot be trusted to predict either the wire name or which UI control drives
it.

**Pagination:** `Start` is a zero-based **item offset**, not a page number
(`currentPage`, guessed in the earlier bundle recon, is not what's sent — or if it
exists it's not required). To page through results: `Start: 0, Limit: 100`, then
`Start: 100, Limit: 100`, etc., stopping once `Start >= totalCount` (see response
shape below).

## Response shape

Top level:

```json
{
  "success": true,
  "data": {
    "announcements": {
      "items": [ /* array of vacancy summaries, see below */ ],
      "totalCount": 3271
    },
    "metaData": { "seoData": { ... }, "openGraphData": { ... } }
  }
}
```

`totalCount` is the total number of matching vacancies (not the count of `items`
in this page) — use it to drive pagination.

### Vacancy summary fields (`data.announcements.items[]`)

Full trimmed example (2 real items, wrapper structure intact): see
`tests/fixtures/hrge-search-response-keyword.json` — **this is the fixture
Task 8 should build and test the adapter against**, because it is the one
produced by a keyword search, which is what `search(filters)` actually does.

`tests/fixtures/hrge-search-response.json` is the unfiltered baseline capture,
kept for comparison. The field paths in the table below were verified to hold
identically in both fixtures.

| Adapter field | JSON path                         | Type            | Notes |
|---|---|---|---|
| id            | `announcementId`                  | number          | e.g. `490990` |
| title         | `title`                           | string          | job title |
| company       | `customerName`                    | string          | employer display name |
| city          | `locations`                       | string[]        | e.g. `["თბილისი"]` — array, can have >1 entry; there is no singular `city` field |
| publishDate   | `publishDate`                     | string (ISO, no TZ) | e.g. `"2026-08-27T16:20:44.143"` |
| description   | **not present in this response**  | — | see "Description" below |

Other fields present but not needed for the adapter: `customerId`, `logoFilename`,
`deadlineDate`, `renewalDate`, `extendedLocations` (structured location breakdown),
`isSalaryAvailable`, `employmentForm`, `applicationMethod`, `status` (Georgian
human-readable status string, e.g. `"აქტიური"` = "active"), `isFavorite`,
`isBeenApplied`, and various display/branding flags. Full field list is visible in
the fixture.

### Description — requires a second call

`announcement-search` (the list/search endpoint) does **not** return a
description. To get it, call the detail endpoint hinted at in the prior recon's
bundle route list:

```
GET https://api.p.hr.ge/public-portal/tenant/1/api/v3/announcement/{announcementId}
```

Verified live (`curl`, no auth, no proxy needed, plain GET, `HTTP 200`):

```json
{
  "data": {
    "announcement": {
      "announcementId": 490990,
      "title": "...",
      "customerName": "...",
      "description": "<div>&#4309;&#4312;&#4316; ...</div>",
      "addresses": ["თბილისი"],
      "publishDate": "2026-08-27T16:20:44.143",
      "deadlineDate": "2026-09-25T23:59:00",
      ...
    }
  }
}
```

- `description` is an **HTML string with numeric character references**
  (`&#4309;...`), not plain text — decode HTML entities and (likely) strip tags
  before using it (e.g. in a cover-letter prompt).
- `addresses` mirrors `locations` from the search response (array of strings).
- This endpoint was not part of this task's required scope beyond identifying it,
  but since Task 8 will need `description`, this is enough to build on: same host,
  same tenant path convention, plain GET, no auth.

### Building the public vacancy URL

Real anchors captured from the rendered page:

```
https://www.hr.ge/announcement/{announcementId}/{slug}
e.g. https://www.hr.ge/announcement/490990/gayidvebis-ambasadori
```

`{slug}` is a transliterated, kebab-cased version of the Georgian title, generated
client-side — the API does not return it, so the adapter cannot reconstruct it
exactly. **This does not matter**: the slug is cosmetic. Confirmed live:

```
GET https://www.hr.ge/announcement/490990          → 301 → /announcement/490990/gayidvebis-ambasadori
GET https://www.hr.ge/announcement/490990/anything  → 200 (any slug, or none, is accepted)
```

**Recommendation for the adapter:** build vacancy URLs as
`https://www.hr.ge/announcement/{id}` (no slug). It 301-redirects to the canonical
URL and is trivial to construct from `announcementId` alone.

## WAF and CAPTCHA — observed, not bypassed

- `www.hr.ge` (the main site, not the API host) loads an AWS WAF challenge script
  from `<hash>.edge.sdk.awswaf.com/.../challenge.js` on every page load, and the
  page makes background `POST .../mp_verify` and `POST .../telemetry` calls to the
  same WAF endpoint while browsing.
- This ran automatically during capture with **no interactive CAPTCHA or blocking
  challenge presented** — it behaves like a standard AWS WAF JS/fingerprint
  challenge that passes transparently for a normal browser session. No CAPTCHA was
  solved or evaded; none appeared.
- `GET /api/v3/public/configs` (found in prior recon) exposes a `recaptchaSiteKey`,
  which implies reCAPTCHA is used somewhere in the app — most likely on
  registration/apply forms, not on search. This task did not touch the `apply`
  route, so this is unconfirmed for that flow.
- Critically: **the `announcement-search` and `announcement/{id}` API calls were
  replayed directly via `curl` — no browser, no WAF cookie, no token of any kind —
  and both returned `200` with real data.** The AWS WAF instrumentation observed is
  wired to `www.hr.ge` (the Angular app host); it does not appear to gate
  `api.p.hr.ge` for these two endpoints, as of this capture (2026-08-28). This
  could change, and is a live third-party service, not a guarantee — Task 8's
  adapter should still handle an unexpected `403`/CAPTCHA response defensively,
  but no CAPTCHA-solving or WAF-evasion logic is needed for the search flow as it
  stands today.

## Open items for Task 8 (not answered by this task, scope was search only)

Two different states get conflated easily if not kept separate: a field name
seen on the wire but not exercised with a non-default value, versus a field
name never seen on the wire at all.

**Name known from a real request; value/effect not fully round-tripped:**
- `CategoryIds`, `WithoutWorkExperience`, `AnyExperience`, `OnlySelectedSalary`,
  `WorkExperience{from,to}` — all seen in the real captured body, but only ever
  at their empty/default values (`[]`, `false`, `false`, `false`,
  `{null,null}`). The server accepts them and doesn't require non-default
  values, but no capture has set any of these to a non-default value and
  confirmed the results actually change (unlike `Query` and
  `EmploymentFormTypeIds`, both confirmed above to filter for real).
- `IsWorkFromHome` — name confirmed on the wire (seen as `false` in every
  capture to date) and independently confirmed by `curl` to be a real,
  functioning filter (`true` → totalCount 33 vs. 3271 baseline). Not
  confirmed to be wired to any specific UI control — the one control that
  looked like an obvious match, `#workFromHome`, turned out to send
  `EmploymentFormTypeIds` instead.

**Name never observed in any real request — known only from the client
bundle, unconfirmed:**
`localityIds`, `specializationCodes`, `industryCodes`, `workScheduleCodes`,
`announcementTypeId`, `publishDateRangeOptionId`, `seniorityLevelCodes`,
`transportTypeIds`, `drivingLicenceIds`, `worldLanguageIds`,
`educationLevelCodes`, `experienceRangeOptionIds`, `employmentFormIds`,
`salaryRangeOptionId`, `currentPage`. **Do not build adapter code against any
of these names without capturing them first** — `experienceRange` →
`WorkExperience` (see "Request body" above) shows a bundle name is not a
reliable predictor of the wire name.

**Other routes, unrelated to filter fields:**
- The `apply` route's request shape is unknown — this task did not attempt it.
  Same recon method (Playwright interception) should work if/when Task 8 needs it.
- `search-field`, `announcement-view`, and `announcement-stats/{id}` (other
  neighbor routes noted in prior recon) were not investigated.

## Fixtures

- `tests/fixtures/hrge-search-request.json` / `hrge-search-response.json` —
  the original empty-search capture (search button clicked with nothing typed
  in). Useful as the "no filters" baseline, but does not exercise the keyword
  field.
- `tests/fixtures/hrge-search-request-keyword.json` /
  `hrge-search-response-keyword.json` — captured with `Query: "analyst"`
  actually set (search box filled before clicking search). **This is the
  fixture Task 8's adapter should be built and tested against**, since it's
  the one that exercises keyword search. Response trimmed to 2 vacancy items
  the same way as the original (full header set and exact body string kept
  intact in the request fixture); wrapper
  (`success`/`data`/`announcements`/`totalCount`/`metaData`) kept intact, with
  `totalCount` (22) preserved from the real, untrimmed response.
