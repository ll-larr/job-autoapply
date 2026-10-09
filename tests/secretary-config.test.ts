import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveSecretaryConfig, loadConfig, DEFAULT_SECRETARY, type Config } from '../src/core/config.js';
import { seedSettings, validateSettings, mergeMissingSections, DEFAULT_CALENDAR } from '../src/core/settings.js';

const withSecretary = (secretary: unknown): Config =>
  ({ bot: { profile: { github: 'g', telegram: 't' }, secretary } }) as unknown as Config;

describe('resolveSecretaryConfig', () => {
  it('нет блока — null (секретарь выключен), нет bot — тоже', () => {
    expect(resolveSecretaryConfig({} as Config)).toBeNull();
    expect(resolveSecretaryConfig(withSecretary(undefined))).toBeNull();
  });

  it('достаточно account: умолчания подставляются, @ и пробелы срезаются', () => {
    const r = resolveSecretaryConfig(withSecretary({ account: ' @HIRE_agent ' }));
    expect(r).toEqual({ ok: true, value: { account: 'HIRE_agent', ...DEFAULT_SECRETARY } });
  });

  it('кривой блок — ошибка значением, а не исключением', () => {
    const bad = (s: unknown) => resolveSecretaryConfig(withSecretary(s));
    expect(bad({})).toMatchObject({ ok: false, error: expect.stringContaining('account') });
    expect(bad({ account: '  ' })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', debounceMs: -1 })).toMatchObject({ ok: false, error: expect.stringContaining('debounceMs') });
    expect(bad({ account: 'a', debounceMs: 5000, maxDebounceMs: 1000 })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', memoryTurns: 31 })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', memoryTurns: 1.5 })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', memoryTtlMinutes: 0 })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', maxRepliesPerChatPerHour: 61 })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', replyWindowHours: 24 })).toMatchObject({ ok: false });
    expect(bad({ account: 'a', debounceMs: '10' })).toMatchObject({ ok: false });
  });

  it('config.json из репозитория подключает секретаря к @HIRE_agent', () => {
    const r = resolveSecretaryConfig(loadConfig());
    expect(r).toMatchObject({ ok: true, value: { account: 'HIRE_agent' } });
  });
});

describe('разделы настроек секретаря', () => {
  it('умолчания: секретарь включён, календарь без слотов, дожимы и hh выключены', () => {
    const s = seedSettings(undefined, null);
    expect(s.secretary).toEqual({ enabled: true });
    expect(s.calendar).toEqual(DEFAULT_CALENDAR);
    expect(s.calendar.slotsEnabled).toBe(false);
    expect(s.followups).toEqual({ enabled: false, afterDays: 4, maxAgeDays: 14 });
    expect(s.hhInbox).toEqual({ enabled: false, replyEnabled: false, intervalMinutes: 30, maxRepliesPerDay: 20 });
  });

  it('старый файл без разделов — умолчания', () => {
    const { secretary: _a, calendar: _b, followups: _c, hhInbox: _d, ...old } = seedSettings(undefined, null);
    void _a; void _b; void _c; void _d;
    const r = validateSettings(old);
    expect(r.ok && r.settings.secretary.enabled).toBe(true);
    expect(r.ok && r.settings.calendar.timeZone).toBe('Europe/Moscow');
  });

  const check = (patch: Record<string, unknown>) => validateSettings({ ...seedSettings(undefined, null), ...patch });
  const cal = (c: Record<string, unknown>) => check({ calendar: { ...DEFAULT_CALENDAR, ...c } });

  it('календарь: каждая ошибка называет причину по-русски', () => {
    const err = (r: ReturnType<typeof cal>): string => (r.ok ? 'ok' : r.error);
    expect(err(cal({ timeZone: 'Mars/Base' }))).toContain('часовой пояс');
    expect(err(cal({ workDays: [] }))).toContain('рабочие дни');
    expect(err(cal({ workDays: [1, 1] }))).toContain('рабочие дни');
    expect(err(cal({ workDays: [0] }))).toContain('рабочие дни');
    expect(err(cal({ workStart: '9:00' }))).toContain('время вида');
    expect(err(cal({ workStart: '19:00', workEnd: '10:00' }))).toContain('рабочий день');
    expect(err(cal({ workStart: '10:00', workEnd: '10:30', slotMinutes: 60 }))).toContain('рабочий день');
    expect(err(cal({ slotMinutes: 10 }))).toContain('длительность');
    expect(err(cal({ bufferMinutes: 200 }))).toContain('отступ');
    expect(err(cal({ horizonDays: 0 }))).toContain('горизонт');
    expect(err(cal({ minLeadHours: 200 }))).toContain('запас');
    expect(err(cal({ remindMinutes: 1 }))).toContain('напоминание');
  });

  it('календарь: верные значения сохраняются, дни сортируются', () => {
    const r = cal({ slotsEnabled: true, timeZone: 'Europe/Berlin', workDays: [3, 1, 2], workStart: '09:30', remindEnabled: false });
    expect(r.ok && r.settings.calendar).toMatchObject({
      slotsEnabled: true, timeZone: 'Europe/Berlin', workDays: [1, 2, 3], workStart: '09:30', remindEnabled: false,
    });
  });

  it('дожимы и hh: границы; ответы hh только при включённом чтении', () => {
    expect(check({ followups: { enabled: true, afterDays: 0 } })).toMatchObject({ ok: false });
    expect(check({ followups: { enabled: true, afterDays: 10, maxAgeDays: 5 } })).toMatchObject({ ok: false });
    expect(check({ followups: { enabled: true, afterDays: 3, maxAgeDays: 20 } })).toMatchObject({ ok: true });
    expect(check({ hhInbox: { enabled: false, replyEnabled: true } })).toMatchObject({
      ok: false, error: 'Ответы на hh.ru работают только при включённом чтении ящика',
    });
    expect(check({ hhInbox: { enabled: true, replyEnabled: true, intervalMinutes: 5 } })).toMatchObject({ ok: false });
    expect(check({ hhInbox: { enabled: true, replyEnabled: true, maxRepliesPerDay: 101 } })).toMatchObject({ ok: false });
    expect(check({ hhInbox: { enabled: true, replyEnabled: true } })).toMatchObject({ ok: true });
  });

  it('тумблеры не включаются сами: «enabled: "true"» строкой — это выключено', () => {
    const r = check({ followups: { enabled: 'true' }, hhInbox: { enabled: 1 } });
    expect(r.ok && r.settings.followups.enabled).toBe(false);
    expect(r.ok && r.settings.hhInbox.enabled).toBe(false);
  });
});

describe('mergeMissingSections', () => {
  it('страница, не знающая новых разделов, их не стирает', () => {
    const current = seedSettings(undefined, null);
    current.followups.enabled = true;
    current.hhInbox.enabled = true;
    current.calendar.slotsEnabled = true;
    const { followups: _f, hhInbox: _h, calendar: _c, secretary: _s, ...fromOldPage } = current;
    void _f; void _h; void _c; void _s;
    const merged = validateSettings(mergeMissingSections(current, fromOldPage));
    expect(merged.ok && merged.settings.followups.enabled).toBe(true);
    expect(merged.ok && merged.settings.hhInbox.enabled).toBe(true);
    expect(merged.ok && merged.settings.calendar.slotsEnabled).toBe(true);
  });

  it('раздел, который страница прислала, главнее; не-объект возвращается как есть', () => {
    const current = seedSettings(undefined, null);
    const merged = mergeMissingSections(current, { ...current, followups: { enabled: false, afterDays: 7, maxAgeDays: 20 } }) as typeof current;
    expect(merged.followups.afterDays).toBe(7);
    expect(mergeMissingSections(current, 5)).toBe(5);
  });

  it('config.json в репозитории читается как JSON с блоком secretary', () => {
    const parsed = JSON.parse(readFileSync('config.json', 'utf8')) as { bot: { secretary: { account: string } } };
    expect(parsed.bot.secretary.account).toBe('HIRE_agent');
  });
});
