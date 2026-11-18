/**
 * ВСЕ селекторы и маркеры ящика откликов hh.ru — в одном файле (спека
 * 2026-10-09, 6.10), чтобы поправить их после пробы чата, не трогая логику.
 *
 * Что проверено живьём и что нет:
 *  - страница откликов, карточка отклика, кнопка «Открыть чат» и адрес фрейма
 *    чата — снято 2026-08-29 (docs/hh-selectors.md);
 *  - список откликов `topicList` в разметке — подтверждён настоящей фикстурой;
 *  - **селекторы сообщений и поля ввода внутри фрейма чата — НЕ проверены**:
 *    чат не рисуется при заблокированных POST, а снимать блокировку ради
 *    разведки без человека нельзя. Ниже — кандидаты; пока владелец не прошёл
 *    пробу (`npm run hh:inbox -- --probe-chat`), ответы работодателям не уходят.
 */

export const NEGOTIATIONS_URL = 'https://hh.ru/applicant/negotiations';

/** Карточка отклика на странице откликов. */
export const NEGOTIATION_ITEM = '[data-qa="negotiations-item"]';
/** Кнопка «Открыть чат» внутри карточки. */
export const OPEN_CHAT = '[data-qa="open_chat"]';
/** Чат лежит в iframe с таким адресом: chatik.hh.ru/chat/<topicId>. */
export const CHAT_FRAME_URL_PART = 'chatik.hh.ru/chat/';

/** Кандидаты на селектор сообщения во фрейме: выигрывает первый, у которого есть совпадения. */
export const CHAT_MESSAGE_CANDIDATES: readonly string[] = [
  '[data-qa="chat-message"]',
  '[data-qa^="chat-bubble"]',
  '[data-qa*="message"]',
  '[class*="message-bubble" i]',
  '[class*="MessageBubble"]',
  '[class*="chat-message" i]',
];

/** Атрибуты, в которых может лежать id сообщения. Нет — ключом служит хэш. */
export const CHAT_MESSAGE_ID_ATTRS: readonly string[] = ['data-message-id', 'data-id', 'id'];

/** Кандидаты на поле ввода и кнопку отправки во фрейме. */
export const CHAT_INPUT_CANDIDATES: readonly string[] = [
  '[data-qa="chat-input"]',
  'textarea',
  '[contenteditable="true"]',
  'input[type="text"]',
];
export const CHAT_SEND_CANDIDATES: readonly string[] = [
  '[data-qa="chat-send-button"]',
  'button[type="submit"]',
  'button[aria-label*="тправ" i]',
];

/** Служебные строки чата, которые не сообщение человека. */
export const SYSTEM_MESSAGE_RE =
  /(вы откликнулись|ваш отклик|работодатель (?:посмотрел|просмотрел)|резюме просмотрено|приглашение на собеседование|вам отказали|отказ по отклику)/i;

/** Страницу чата открывает не чаще раза в столько мс подряд: не похоже на человека иначе. */
export const HH_REPLY_PAUSE_MS: readonly [number, number] = [30_000, 90_000];

/** Не больше ответов в один чат за сутки (спека 6.10). */
export const HH_REPLIES_PER_TOPIC_PER_DAY = 2;

/** Проба чата живёт 14 дней, потом ответы снова просят пройти её. */
export const HH_PROBE_VALID_DAYS = 14;
