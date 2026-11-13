// Тесты Фазы 3: мульти-примеры, Rektion, Edge TTS кэш/сервис, gap-fill упражнения и профиль ошибок
import assert from 'node:assert/strict';
import test from 'node:test';
import { isEligible, buildQueue } from '../server/srs/queue.js';
import { buildExamplesList, enrichCards } from '../server/ai/enrich.js';
import { resolveVoice, rateToPercent, ttsCacheKey } from '../server/tts_service.js';
import { recordUserErrors, getUserTopErrors } from '../server/error_profile.js';
import { SpeakingAudioEvalAISchema, DiscussionStartAISchema, DiscussionTurnAISchema, DiscussionFinishAISchema } from '../server/ai/schemas_v2c.js';

test('Фаза 3.1: buildExamplesList собирает и валидирует контекстные примеры с пропусками', () => {
  const primaryEx = 'Er wartet auf den Bus.';
  const primaryRu = 'Он ждет автобус.';
  const primaryCloze = 'Er ____ auf den Bus.';
  const primaryAns = 'wartet';
  const rawExamples = [
    { de: 'Wir haben lange auf dich gewartet.', ru: 'Мы долго тебя ждали.', answer: 'auf dich gewartet' },
    { de: 'Worauf wartest du noch?', ru: 'Чего ты еще ждешь?', answer: 'wartest' },
    { de: 'Invalid example without matching answer', ru: '', answer: 'foobar' },
  ];
  const list = buildExamplesList(primaryEx, primaryRu, primaryCloze, primaryAns, rawExamples, 'warten');
  assert.equal(list.length, 3);
  assert.equal(list[0].answer, 'wartet');
  assert.equal(list[1].answer, 'auf dich gewartet');
  assert.equal(list[2].answer, 'wartest');
});

test('Фаза 3.1: isEligible для cloze поддерживает examples_json', () => {
  const cardWithJson = {
    id: 1,
    term: 'warten',
    example_cloze: null,
    cloze_answer: null,
    examples_json: JSON.stringify([{ de: 'Er wartet.', ru: 'Он ждет.', cloze: 'Er ____.', answer: 'wartet' }]),
  };
  assert.equal(isEligible(cardWithJson, 'cloze'), true);
});

test('Фаза 3.1: buildQueue ротирует примеры из examples_json в режиме cloze', () => {
  const card = {
    id: 42,
    term: 'warten',
    pos: 'verb',
    active: 1,
    examples_json: JSON.stringify([
      { de: 'Satz 1.', ru: 'Предложение 1.', cloze: '____ 1.', answer: 'Satz' },
      { de: 'Satz 2.', ru: 'Предложение 2.', cloze: '____ 2.', answer: 'Satz' },
    ]),
  };
  const qDay1 = buildQueue({
    cards: [card],
    states: [{ card_id: 42, mode: 'cloze', due: '2026-03-10T00:00:00Z', reps: 0 }],
    now: '2026-03-10T08:00:00Z',
    localDay: '2026-03-10',
    settings: { max_session_items: 10, ai_enabled: false },
  });
  const qDay2 = buildQueue({
    cards: [card],
    states: [{ card_id: 42, mode: 'cloze', due: '2026-03-11T00:00:00Z', reps: 1 }],
    now: '2026-03-11T08:00:00Z',
    localDay: '2026-03-11',
    settings: { max_session_items: 10, ai_enabled: false },
  });
  assert.equal(qDay1.length, 1);
  assert.equal(qDay2.length, 1);
  assert.ok(qDay1[0].card.example_cloze.includes('____'));
  assert.ok(qDay2[0].card.example_cloze.includes('____'));
});

test('Фаза 3.2: SpeakingAudioEvalAISchema валидирует ответ мультимодального Gemini Audio', () => {
  const sample = {
    transcript: 'Ich möchte über Umweltschutz sprechen.',
    criteria: { content: 4, vocabulary: 4, grammar: 4, coherence: 5, pronunciation: 4 },
    wpm: 110,
    fluency_ru: 'Темп ровный, естественные паузы на границах придаточных предложений.',
    pronunciation_ru: 'Четкие умлауты, правильная долгота гласных в корнях.',
    strengths_ru: ['Хорошая связность', 'Богатый словарный запас'],
    improvements_ru: ['Следить за порядком слов после weil'],
    corrected_sample: 'Ich würde gerne über den Umweltschutz sprechen.',
    note_ru: 'Отличный уровень B2.',
  };
  const parsed = SpeakingAudioEvalAISchema.safeParse(sample);
  assert.ok(parsed.success);
});

test('Фаза 3.3: схемы дискуссии B2 валидируют реплики и финальную оценку', () => {
  const start = DiscussionStartAISchema.safeParse({
    persona_ru: 'Коллега, который выступает против работы из дома.',
    opening_de: 'Glaubst du wirklich, dass Homeoffice auf Dauer gut für die Produktivität ist?',
    opening_ru: 'Ты правда веришь, что удаленка полезна для продуктивности в долгосрочной перспективе?',
    suggested_redemittel: ['Meiner Auffassung nach', 'Einerseits ... andererseits'],
  });
  assert.ok(start.success);

  const turn = DiscussionTurnAISchema.safeParse({
    reply_de: 'Das sehe ich anders. Man verliert doch den Kontakt zum Team.',
    reply_ru: 'Я смотрю на это иначе. Теряется ведь контакт с командой.',
    micro_fix_de: 'Ich bin der Meinung, DASS...',
    micro_fix_ru: 'После dass глагол идет в конец.',
    suggested_redemittel: ['Da muss ich widersprechen'],
  });
  assert.ok(turn.success);

  const finish = DiscussionFinishAISchema.safeParse({
    criteria: { argumentation: 4, interaction: 5, vocabulary: 4, grammar: 4 },
    used_redemittel: ['Meiner Meinung nach', 'Einerseits'],
    strengths_ru: ['Уверенно отстаивал позицию'],
    improvements_ru: ['Использовать больше пассивных конструкций'],
    summary_ru: 'Живой и аргументированный диалог.',
  });
  assert.ok(finish.success);
});

test('Фаза 3.4: tts_service разрешает голоса и форматирует скорость', () => {
  assert.equal(resolveVoice('male'), 'de-DE-ConradNeural');
  assert.equal(resolveVoice('female'), 'de-DE-KatjaNeural');
  assert.equal(resolveVoice('de-DE-AmalaNeural'), 'de-DE-AmalaNeural');
  assert.equal(rateToPercent(1.0), '+0%');
  assert.equal(rateToPercent(0.8), '-20%');
  assert.equal(rateToPercent(1.2), '+20%');

  const k1 = ttsCacheKey('Guten Morgen', 'de-DE-KatjaNeural', '+0%');
  const k2 = ttsCacheKey('Guten Morgen', 'de-DE-ConradNeural', '+0%');
  assert.notEqual(k1, k2);
  assert.equal(k1.length, 64);
});

test('Фаза 3.6: recordUserErrors и getUserTopErrors накапливают профиль ошибок', async () => {
  const memoryTable = new Map();
  const fakeDb = async (sql, params = []) => {
    if (sql.includes('INSERT INTO user_error_profile')) {
      const [uid, cat, ex] = params;
      const key = `${uid}:${cat}`;
      const existing = memoryTable.get(key) || { category: cat, hits: 0, last_example: null };
      existing.hits += 1;
      existing.last_example = ex;
      memoryTable.set(key, existing);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SELECT category, hits, last_example FROM user_error_profile')) {
      const rows = [...memoryTable.values()].sort((a, b) => b.hits - a.hits);
      return rows.slice(0, params[1] || 4);
    }
    return [];
  };

  await recordUserErrors(10, [
    { category: 'rektion', original: 'warten an', fix: 'warten auf' },
    { category: 'rektion', original: 'denken an Akk', fix: 'denken an + Akk' },
    { category: 'word_order', original: 'weil ich bin müde', fix: 'weil ich müde bin' },
  ], fakeDb);

  const top = await getUserTopErrors(10, 2, fakeDb);
  assert.equal(top.length, 2);
  assert.equal(top[0].category, 'praeposition');
  assert.equal(top[0].hits, 2);
  assert.equal(top[1].category, 'wortstellung');
  assert.equal(top[1].hits, 1);
});
