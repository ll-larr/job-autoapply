import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'tests/fixtures';
const TARGET = 'announcement-search';

// Keyword typed into the search box before clicking search. This is what
// isolates the wire field name for `filters.query` in Task 8's `search()` —
// the original Task 7 capture clicked search with an empty box, so no
// query/keyword field ever appeared in the captured body. Override via CLI
// arg: `npx tsx scripts/capture-hrge.ts <keyword>`.
const KEYWORD = process.argv[2] ?? 'analyst';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

let keywordCaptured = false;

page.on('request', (req) => {
  if (!req.url().includes(TARGET)) return;
  console.log('request seen:', req.method(), req.url());
  console.log('  body:', req.postData());
  if (!keywordCaptured) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/hrge-search-request-keyword.json`, JSON.stringify({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      body: req.postData(),
    }, null, 2) + '\n', 'utf8');
  }
});

page.on('response', async (res) => {
  if (!res.url().includes(TARGET) || res.status() !== 200) return;
  try {
    const json = await res.json();
    console.log('  response totalCount:', json?.data?.announcements?.totalCount);
    if (!keywordCaptured) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/hrge-search-response-keyword.json`, JSON.stringify(json, null, 2) + '\n', 'utf8');
      keywordCaptured = true;
      console.log('captured response:', res.status());
    }
  } catch (e) {
    console.error('response not JSON:', e);
  }
});

await page.goto('https://www.hr.ge/search-posting', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Type the keyword into the search box (`input.search-query`, placeholder
// "საძიებო სიტყვა" = "search word") before clicking search, so the captured
// body actually contains the query field.
await page.fill('input.search-query', KEYWORD);
await page.click('button.search-btn');
await page.waitForTimeout(5000);

console.log(keywordCaptured ? 'OK: keyword fixtures written' : 'FAILED: no 200 response seen for keyword search');

// Second, cheap interaction in the same session: toggle the "remote work"
// filter checkbox (`#workFromHome`) on top of the same keyword and search
// again. Not written to a fixture file (the keyword-only capture above is
// the canonical one) — this is just to evidence a second UI-filter -> wire
// field mapping from a real request rather than assuming it from the client
// bundle. (Turns out this checkbox sends `EmploymentFormTypeIds`, not the
// `IsWorkFromHome` field already present in the body — see docs/hrge-api.md.)
// The diff vs. the keyword-only capture is visible in the console output
// from the request/response listeners above.
await page.check('#workFromHome');
await page.click('button.search-btn');
await page.waitForTimeout(5000);

await browser.close();
process.exit(keywordCaptured ? 0 : 1);
