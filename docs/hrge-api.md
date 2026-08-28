# hr.ge `announcement-search` API — captured contract

Captured 2026-08-28 by intercepting the real `www.hr.ge` Angular app with Playwright
(`scripts/capture-hrge.ts`), then verified against the API directly with `curl`.
This document is the durable reference for building the `hrge` adapter (Task 8).

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
filter state the UI always sends but the server does not require — this matches
(and confirms) the filter field list already extracted from the bundle in the prior
recon (`localityIds[]`, `categoryIds[]`, `specializationCodes[]`, etc. — same
fields, just PascalCased and sent even when empty/default).

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
`tests/fixtures/hrge-search-response.json`.

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

- The `apply` route's request shape is unknown — this task did not attempt it.
  Same recon method (Playwright interception) should work if/when Task 8 needs it.
- `search-field`, `announcement-view`, and `announcement-stats/{id}` (other
  neighbor routes noted in prior recon) were not investigated.
- Filter fields beyond `Limit`/`Start` (`CategoryIds`, `localityIds`, etc.) were
  not individually round-tripped against real filtered results — only confirmed
  that the server accepts them and doesn't require them to be non-empty.

## Fixtures

- `tests/fixtures/hrge-search-request.json` — the real request as captured
  (URL, method, full header set, exact body string).
- `tests/fixtures/hrge-search-response.json` — the real response, trimmed to 2
  vacancy items, wrapper structure (`success`/`data`/`announcements`/`totalCount`/
  `metaData`) kept intact and unmodified.
