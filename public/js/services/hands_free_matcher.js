// Чистая логика нормализации речи, перехвата команд и сравнения ответов для Hands-Free режима.
// Без Node и DOM API — безопасно импортируется и в браузере, и в unit-тестах.

const ARTICLES = new Set(['der', 'die', 'das']);
const NON_WORD_RE = /[^\p{L}\p{N}\s]+/gu;
const WS_RE = /\s+/g;

/**
 * Нормализация немецкой речи: NFC, нижний регистр, без пунктуации, ß -> ss, единые пробелы.
 * @param {string} text
 * @returns {string}
 */
export function normalizeGermanSpeech(text) {
  if (text == null) return '';
  return String(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(NON_WORD_RE, ' ')
    .replace(WS_RE, ' ')
    .trim();
}

/** Сворачивание умляутов поверх normalizeGermanSpeech (ä/ö/ü -> ae/oe/ue) для мягкого сравнения */
export function foldGermanSpeech(text) {
  return normalizeGermanSpeech(text)
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue');
}

const COMMAND_MAP = new Map([
  ['weiter', 'weiter'],
  ['nochmal', 'nochmal'],
  ['noch mal', 'nochmal'],
  ['schwer', 'schwer'],
  ['stopp', 'stopp'],
  ['stop', 'stopp'],
]);

/**
 * Перехват голосовых команд до проверки ответа.
 * Срабатывает только на целую команду (чтобы слово вроде «die Weiterbildung» не сработало как «weiter»).
 * @param {string | string[]} input
 * @returns {'weiter'|'nochmal'|'schwer'|'stopp'|null}
 */
export function detectVoiceCommand(input) {
  const candidates = Array.isArray(input) ? input : [input];
  for (const raw of candidates) {
    const norm = normalizeGermanSpeech(raw);
    if (!norm) continue;
    const hit = COMMAND_MAP.get(norm);
    if (hit) return hit;
  }
  return null;
}

/**
 * Ожидаемая произносимая немецкая фраза для карточки.
 * Для карточек с артиклями (`article`) и существительных в `ru_de` ВСЕГДА полная фраза ("der Tisch").
 * @param {{mode?: string, card?: object}} item
 * @returns {string}
 */
export function expectedSpeechFor(item) {
  const card = (item && item.card) || {};
  const mode = item && item.mode;
  const term = String(card.term ?? '').trim();
  const article = ARTICLES.has(card.article) ? card.article : null;

  if (mode === 'article') {
    return article && term ? `${article} ${term}` : term;
  }
  if (mode === 'cloze') {
    return String(card.cloze_answer ?? '').trim();
  }
  // ru_de и запасной вариант
  if (card.pos === 'noun' && article && term) {
    return `${article} ${term}`;
  }
  return term;
}

/**
 * Подготовка озвучки и текста подсказки для экрана Hands-Free по типу карточки.
 * @param {{mode?: string, card?: object}} item
 */
export function promptForHandsFree(item) {
  const card = (item && item.card) || {};
  const mode = item && item.mode;
  const term = String(card.term ?? '').trim();
  const translation = String(card.translation ?? '').trim();

  if (mode === 'article') {
    return {
      mode,
      speakText: term,
      speakLang: 'de-DE',
      displayTitle: term,
      displaySubtitle: translation,
      hint: 'Назовите артикль и слово целиком (например, «der Tisch»)',
    };
  }
  if (mode === 'cloze') {
    const cloze = String(card.example_cloze ?? '').trim();
    const ru = String(card.example_translation ?? '').trim();
    return {
      mode,
      speakText: ru || '',
      speakLang: 'ru-RU',
      displayTitle: cloze || translation,
      displaySubtitle: ru,
      hint: 'Назовите пропущенное слово или всё предложение',
    };
  }
  // ru_de
  const isNoun = card.pos === 'noun' && ARTICLES.has(card.article);
  return {
    mode: mode || 'ru_de',
    speakText: translation,
    speakLang: 'ru-RU',
    displayTitle: translation,
    displaySubtitle: isNoun ? 'существительное · с артиклем' : '',
    hint: isNoun ? 'Скажите по-немецки с артиклем' : 'Переведите на немецкий вслух',
  };
}

/**
 * Сравнение одной расшифровки с эталоном.
 * Строго требует совпадения артикля для существительных и карточек `article`.
 */
function matchesSingle(candidate, expectedPhrase, mode) {
  const cNorm = normalizeGermanSpeech(candidate);
  const eNorm = normalizeGermanSpeech(expectedPhrase);
  if (!cNorm || !eNorm) return false;
  if (cNorm === eNorm) return true;

  const cFold = foldGermanSpeech(candidate);
  const eFold = foldGermanSpeech(expectedPhrase);
  if (cFold === eFold) return true;

  const eTokens = eFold.split(' ');
  const cTokens = cFold.split(' ');

  // Если эталон начинается с артикля (der/die/das + слово) — артикль обязателен и проверяется строго,
  // а составные слова допускают склейку/разбиение пробелами (частая особенность Android ASR для длинных B2-слов).
  if (eTokens.length >= 2 && ARTICLES.has(eTokens[0])) {
    if (cTokens.length < 2 || cTokens[0] !== eTokens[0]) return false;
    const eRest = eTokens.slice(1).join('');
    const cRest = cTokens.slice(1).join('');
    return eRest.length > 0 && cRest === eRest;
  }

  // Для длинных составных слов без артикля допускаем пробельное разбиение ASR
  if (eTokens.length === 1 && cTokens.length >= 2 && cTokens.join('') === eTokens[0]) {
    return true;
  }

  // Для cloze засчитываем также, если пользователь произнёс предложение целиком с точным пропущенным словом
  if (mode === 'cloze' && cTokens.length > eTokens.length) {
    const paddedC = ` ${cFold} `;
    const paddedE = ` ${eFold} `;
    if (paddedC.includes(paddedE)) return true;
  }

  return false;
}

/**
 * Полная оценка голосового ответа: сначала перехват команд, затем сравнение с эталоном по всем альтернативам ASR.
 * @param {{mode?: string, card?: object}} item
 * @param {string | string[]} transcripts
 * @returns {{command: 'weiter'|'nochmal'|'schwer'|'stopp'|null, matched: boolean, transcript: string, normalizedTranscript: string, expectedPhrase: string}}
 */
export function evaluateVoiceAnswer(item, transcripts) {
  const list = (Array.isArray(transcripts) ? transcripts : [transcripts])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean);
  const primary = list[0] || '';
  const expectedPhrase = expectedSpeechFor(item);
  const normalizedTranscript = normalizeGermanSpeech(primary);

  // 1. Команды перехватываются ДО проверки ответа
  const command = detectVoiceCommand(list);
  if (command) {
    return { command, matched: false, transcript: primary, normalizedTranscript, expectedPhrase };
  }

  // 2. Сравнение по всем альтернативам распознавания
  const mode = item && item.mode;
  const matched = list.some((alt) => matchesSingle(alt, expectedPhrase, mode));

  return {
    command: null,
    matched,
    transcript: primary,
    normalizedTranscript,
    expectedPhrase,
  };
}
