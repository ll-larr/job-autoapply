// Запускается из tests/hh.test.ts отдельным процессом tsx — см. комментарий там.
import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeUnconfirmed, detectCaptcha } from '../../src/adapters/hh.ts';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent('<html><head><title>Проверка</title></head><body><div role="alert">Слишком много откликов</div></body></html>');
  const described = await describeUnconfirmed(page, '1', mkdtempSync(join(tmpdir(), 'jaa-probe-')));
  await page.setContent('<div role="dialog"><h2>Complete the CAPTCHA</h2><input placeholder="Text from the picture"></div>');
  const captcha = await detectCaptcha(page);
  await page.setContent('<html><body><h1>Бизнес-аналитик</h1></body></html>');
  const plain = await detectCaptcha(page);
  console.log(JSON.stringify({ described, captcha, plain }));
} finally {
  await browser.close();
}
