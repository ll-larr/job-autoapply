/**
 * Специальность — то, что человек ищет: «Бизнес-аналитик», «Менеджер продукта».
 * Хранится в data/settings.json и правится во вкладке «Настройки» (спека 3.2).
 */

export interface Skill {
  /**
   * Стабильный ключ навыка. Идёт в `matched` очереди, в письмо («совпавшие
   * темы»); до 2026-10-08 он же выбирал скелет письма ('ai-llm', 'product'),
   * поэтому у перенесённых навыков БА он равен прежнему ключу
   * группы из DEFAULT_WEIGHTS, а не русскому названию.
   */
  id: string;
  name: string;
  /** Совпадение любого синонима — навык совпал. Правила — core/matching.ts. */
  synonyms: string[];
  /** Целое 0–100. Ноль выключает навык, не удаляя его. */
  weight: number;
  /** Вакансия без единого совпавшего навыка-ядра отсекается (нынешний noCoreMatch). */
  core: boolean;
}

/**
 * Параметры «Фильтра автоматического поиска» (редизайн настроек 2026-11-19):
 * то же, что человек выбирает в фильтре вакансий hh.ru. Значения — ровно
 * словарь параметров URL поиска hh.ru (adapters/hh.ts#buildSearchUrl): так
 * их не надо переводить, а проверены они живыми запросами 2026-11-19.
 */
export type EmploymentForm = 'FULL' | 'PART' | 'PROJECT' | 'INTERNSHIP';
export type ContractType = 'LABOR' | 'GPH';
export type WorkSchedule = 'FIVE_ON_TWO_OFF' | 'TWO_ON_TWO_OFF' | 'SIX_ON_ONE_OFF' | 'FLEXIBLE' | 'WEEKEND' | 'OTHER';
export type WorkingHours = 'HOURS_4' | 'HOURS_6' | 'HOURS_8' | 'HOURS_10' | 'HOURS_12' | 'FLEXIBLE';
export type WorkFormat = 'ON_SITE' | 'HYBRID' | 'REMOTE';

/** Допустимые значения — для валидации настроек и тестов. */
export const EMPLOYMENT_FORMS: readonly EmploymentForm[] = ['FULL', 'PART', 'PROJECT', 'INTERNSHIP'];
export const CONTRACT_TYPES: readonly ContractType[] = ['LABOR', 'GPH'];
export const WORK_SCHEDULES: readonly WorkSchedule[] = [
  'FIVE_ON_TWO_OFF', 'TWO_ON_TWO_OFF', 'SIX_ON_ONE_OFF', 'FLEXIBLE', 'WEEKEND', 'OTHER',
];
export const WORKING_HOURS: readonly WorkingHours[] = ['HOURS_4', 'HOURS_6', 'HOURS_8', 'HOURS_10', 'HOURS_12', 'FLEXIBLE'];
export const WORK_FORMATS: readonly WorkFormat[] = ['ON_SITE', 'HYBRID', 'REMOTE'];

export interface VacancyFilters {
  /** Рубли в месяц; null — не задано. */
  salaryFrom: number | null;
  salaryTo: number | null;
  /** «Не указана» в форме: показывать вакансии без зарплаты. По умолчанию true. */
  includeNoSalary: boolean;
  /** Пустой массив = «любое» (фильтра нет). То же для всех списков ниже. */
  employment: EmploymentForm[];
  contract: ContractType[];
  schedule: WorkSchedule[];
  /** null = любые. */
  workingHours: WorkingHours | null;
  workFormat: WorkFormat[];
}

/**
 * Потолок зарплаты в фильтре: отсекает опечатку в лишний ноль-другой, а не
 * реальные суммы. Живёт здесь, а не в settings.ts: им же ИИ-заполнение
 * (core/suggest.ts) отбраковывает зарплату, которую валидация не пропустит.
 */
export const MAX_FILTER_SALARY = 100_000_000;

/**
 * Пустой фильтр — ровно поведение до появления фильтров: URL поиска hh.ru не
 * меняется, локальный отсев ничего нового не режет. Им заполняются старые
 * файлы настроек, где раздела filters нет.
 */
export const DEFAULT_FILTERS: Readonly<VacancyFilters> = Object.freeze({
  salaryFrom: null,
  salaryTo: null,
  includeNoSalary: true,
  employment: [],
  contract: [],
  schedule: [],
  workingHours: null,
  workFormat: [],
});

/** Независимая копия: массивы DEFAULT_FILTERS общие, и правка одной специальности не должна задеть другие. */
export function defaultFilters(): VacancyFilters {
  return {
    ...DEFAULT_FILTERS,
    employment: [], contract: [], schedule: [], workFormat: [],
  };
}

export interface Specialty {
  /** Стабильный ключ: пишется в колонку specialty очереди. */
  id: string;
  name: string;
  enabled: boolean;
  /** Фразы поиска для hh, careerist, hr.ge. */
  queries: string[];
  /** Вакансия проходит, только если заголовок содержит одно из них. */
  titleWords: string[];
  skills: Skill[];
  /** «Мой опыт, лет» — гейт опыта (спека 3.4). */
  experienceYears: number;
  /** Абсолютный путь к PDF резюме; null — берётся резюме БА. */
  resumePdf: string | null;
  /**
   * Письма по-старому: скелеты templates/*.md, выбор hybrid/full по скору и
   * текст резюме из CV …Бизнес-аналитик.md. true только у двух засеянных
   * специальностей — чтобы их письма не поменялись (спека 3.7). В панели не
   * показывается и при сохранении сохраняется как было.
   */
  legacyLetters: boolean;
  /**
   * Зарплата, занятость, график, формат (редизайн 2026-11-19). hh.ru получает их
   * параметрами URL поиска, прочие площадки — локальной проверкой там, где у
   * вакансии есть данные (core/screening.ts). После валидации есть всегда.
   */
  filters: VacancyFilters;
}
