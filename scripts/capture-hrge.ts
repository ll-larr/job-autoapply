import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = 'tests/fixtures';
const TARGET = 'announcement-search';

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

let captured = false;

page.on('request', (req) => {
  if (!req.url().includes(TARGET)) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/hrge-search-request.json`, JSON.stringify({
    url: req.url(),
    method: req.method(),
    headers: req.headers(),
    body: req.postData(),
  }, null, 2), 'utf8');
  console.log('captured request:', req.method(), req.url());
});

page.on('response', async (res) => {
  if (!res.url().includes(TARGET) || res.status() !== 200) return;
  try {
    const json = await res.json();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/hrge-search-response.json`, JSON.stringify(json, null, 2), 'utf8');
    captured = true;
    console.log('captured response:', res.status());
  } catch (e) {
    console.error('response not JSON:', e);
  }
});

await page.goto('https://www.hr.ge/search-posting', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// The initial listing on this route is rendered from data the app already has
// (no announcement-search XHR fires just from loading the route — confirmed by
// network-logging every request during load: only refresh-favorites and
// get-banners hit api.p.hr.ge). The app only calls announcement-search when the
// user actually searches, so we click the visible "ძებნა" (Search) button to
// fire it with the app's default filter.
await page.click('button.search-btn');
await page.waitForTimeout(5000);

console.log(captured ? 'OK: fixtures written' : 'FAILED: no 200 response seen');
await browser.close();
process.exit(captured ? 0 : 1);
