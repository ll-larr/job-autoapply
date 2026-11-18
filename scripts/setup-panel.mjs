import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function runNode(label, args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} завершилось с ошибкой (${result.status ?? result.signal}).`);
  }
}

function setup() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Запусти установку командой npm run setup:panel.');

  const runtime = '.runtime';
  mkdirSync(runtime, { recursive: true });
  // Два запуска не должны одновременно менять общий node_modules.
  const lock = new DatabaseSync(join(runtime, 'setup.db'));
  try {
    lock.exec('PRAGMA busy_timeout = 300000; BEGIN IMMEDIATE;');

    const manifest = readFileSync('package.json', 'utf8');
    const { dependencies, devDependencies } = JSON.parse(manifest);
    const stamp = join('node_modules', '.panel-dependencies');
    const playwrightCli = join('node_modules', 'playwright', 'cli.js');
    const fingerprint = createHash('sha256')
      .update(`${process.platform}:${process.arch}:${process.versions.modules}\n`)
      .update(manifest)
      .update(readFileSync('package-lock.json'))
      .digest('hex');
    const packages = [...Object.keys(dependencies), ...Object.keys(devDependencies)];
    const dependenciesReady = existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint
      && existsSync(playwrightCli)
      && packages.every(name => existsSync(join('node_modules', name, 'package.json')));

    if (!dependenciesReady) {
      rmSync(stamp, { force: true });
      console.log('Устанавливаю npm-пакеты из package-lock.json…');
      runNode('Установка npm-пакетов', [
        npm, 'ci', '--include=dev', '--include=optional', '--no-audit', '--no-fund',
      ]);
      writeFileSync(stamp, fingerprint);
    }

    // Playwright сам проверяет ревизию и кеш браузера для текущей ОС.
    console.log('Проверяю Chromium для Playwright…');
    runNode('Подготовка Chromium', [playwrightCli, 'install', 'chromium']);
  } finally {
    lock.close();
  }
}

try {
  setup();
} catch (error) {
  console.error(`Не удалось подготовить панель. ${error.message}`);
  process.exitCode = 1;
}
