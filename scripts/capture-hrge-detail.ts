import { readFileSync, writeFileSync } from 'node:fs';

// Step 1 of Task 8: capture the hr.ge vacancy detail contract. The search
// response has no description field (confirmed in docs/hrge-api.md), so the
// adapter must call this per-vacancy detail route to get one. This script
// takes the first announcementId out of the already-committed keyword search
// fixture, does a plain unauthenticated GET against the live detail route,
// and writes the raw response to tests/fixtures/hrge-detail-response.json
// for tests/hrge.test.ts to read. Read-only call, no side effects.
//
// Run: npx tsx scripts/capture-hrge-detail.ts

const BASE = 'https://api.p.hr.ge/public-portal/tenant/1/api/v3';

const searchFixture = JSON.parse(
  readFileSync('tests/fixtures/hrge-search-response-keyword.json', 'utf8'),
);
const firstId = searchFixture?.data?.announcements?.items?.[0]?.announcementId;
if (typeof firstId !== 'number') {
  console.error('FAILED: could not find announcementId of first item in the keyword search fixture');
  process.exit(1);
}

const url = `${BASE}/announcement/${firstId}`;
console.log('GET', url);

const res = await fetch(url);
console.log('status:', res.status);

if (res.status !== 200) {
  console.error(`FAILED: expected 200, got ${res.status}. Stopping — not guessing at a fallback.`);
  console.error(await res.text());
  process.exit(1);
}

const json = await res.json();
writeFileSync('tests/fixtures/hrge-detail-response.json', JSON.stringify(json, null, 2) + '\n', 'utf8');
console.log('OK: wrote tests/fixtures/hrge-detail-response.json');
console.log('description path data.announcement.description present:', typeof json?.data?.announcement?.description === 'string');
