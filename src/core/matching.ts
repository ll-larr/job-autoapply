/**
 * Совпадение слова из настроек с живым русским текстом вакансии.
 *
 * Слова задаёт человек в панели: синонимы навыков, слова заголовка,
 * стоп-слова. Пишет он их как обычно — «процессная модель», «1С», «Битрикс», —
 * а текст вакансии склоняет, путает алфавиты и лепит дефисы. Правила ниже —
 * ровно раздел 3.6 спеки 2026-09-18:
 *
 * - регистр не важен, `ё` = `е`;
 * - латиница и кириллица-двойники склеиваются («1C» = «1С»);
 * - слово совпадает с НАЧАЛА слова в тексте («битрикс» ловит «Битрикс24»);
 * - кириллическое слово от 5 букв теряет гласное окончание, до двух букв
 *   («процессная модель» ловит «процессной модели»);
 * - `*` в конце — любые буквы дальше, окончание при этом не трогается;
 * - слово до 3 знаков и аббревиатура заглавными («REST», «ТЗ») — только
 *   целиком: «REST» не ловит «restrictions», «SQL» не ловит «PostgreSQL»;
 * - во фразе пробел значит «любые пробелы», дефис — «дефис или тире».
 *
 * `\b` и `\w` не используются нигде: в JS они не видят кириллицу (см. шапку
 * scorer.ts). Граница слова — явный класс WORD_CHARS по УЖЕ нормализованному
 * тексту, поэтому в нём только строчные буквы.
 */

const WORD_CHARS = '0-9a-zа-я';
/** Дефис и все тире от U+2010 до U+2015: в описаниях вакансий встречаются все. */
const HYPHENS = '\\-\\u2010-\\u2015';
const HYPHEN_RE = new RegExp(`^[${HYPHENS}]$`);
const SPLIT_RE = new RegExp(`(\\s+|[${HYPHENS}])`);

/**
 * Латинская буква → кириллическая, которая выглядит так же. Применяется после
 * toLowerCase, поэтому пары подобраны по заглавным (B/В, H/Н, M/М, T/Т) и
 * строчным (a/а, c/с, e/е, o/о, p/р, x/х, y/у, k/к) начертаниям.
 */
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

const STEMMABLE = /^[а-я]{5,}$/;
const VOWEL_END = /[аеиоуыэюяйь]$/;
const MAX_STRIPPED = 2;
const WHOLE_WORD_MAX = 3;

export function normalizeForMatch(text: string): string {
  let out = '';
  for (const ch of text.toLowerCase()) {
    const c = ch === 'ё' ? 'е' : ch;
    out += HOMOGLYPHS[c] ?? c;
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Аббревиатура: хотя бы две буквы, и ни одной строчной («REST», «ТЗ», «A/B»). */
function isAcronym(raw: string): boolean {
  const letters = raw.replace(/[^A-Za-zА-Яа-яЁё]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
}

function wordPattern(raw: string): string | null {
  const wildcard = raw.endsWith('*');
  const bare = wildcard ? raw.slice(0, -1) : raw;
  if (bare === '') return null;

  let base = bare.toLowerCase().replaceAll('ё', 'е');
  if (!wildcard && STEMMABLE.test(base)) {
    for (let i = 0; i < MAX_STRIPPED && VOWEL_END.test(base); i++) base = base.slice(0, -1);
  }

  const body = escapeRegExp(normalizeForMatch(base));
  const whole = !wildcard && (bare.length <= WHOLE_WORD_MAX || isAcronym(bare));
  return whole ? `${body}(?![${WORD_CHARS}])` : `${body}[${WORD_CHARS}]*`;
}

const cache = new Map<string, RegExp | null>();

export function compileTerm(term: string): RegExp | null {
  const hit = cache.get(term);
  if (hit !== undefined) return hit;

  let pattern = '';
  let words = 0;
  let separator = '\\s+';
  for (const piece of term.trim().split(SPLIT_RE)) {
    if (piece === '') continue;
    if (/^\s+$/.test(piece)) { separator = '\\s+'; continue; }
    if (HYPHEN_RE.test(piece)) { separator = `[${HYPHENS}]`; continue; }
    const wp = wordPattern(piece);
    if (wp === null) continue;
    if (words > 0) pattern += separator;
    pattern += wp;
    words++;
    separator = '\\s+';
  }

  const re = words === 0 ? null : new RegExp(`(?<![${WORD_CHARS}])${pattern}`, 'g');
  cache.set(term, re);
  return re;
}

/** `normalized` обязан быть уже пропущен через normalizeForMatch. */
export function hasInNormalized(normalized: string, term: string): boolean {
  const re = compileTerm(term);
  // search() не смотрит на lastIndex глобального регэкспа — состояние не течёт между вызовами.
  return re !== null && normalized.search(re) !== -1;
}

/** `normalized` обязан быть уже пропущен через normalizeForMatch. */
export function countInNormalized(normalized: string, term: string): number {
  const re = compileTerm(term);
  return re === null ? 0 : [...normalized.matchAll(re)].length;
}

export function containsTerm(text: string, term: string): boolean {
  return hasInNormalized(normalizeForMatch(text), term);
}

export function countTerm(text: string, term: string): number {
  return countInNormalized(normalizeForMatch(text), term);
}
