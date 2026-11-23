import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGermanSpeech,
  detectVoiceCommand,
  expectedSpeechFor,
  evaluateVoiceAnswer,
} from '../public/js/services/hands_free_matcher.js';
import { createHandsFreeEngine, HF_STATES } from '../public/js/services/hands_free_engine.js';

const NOUN_ITEM = {
  key: '1:article',
  card_id: 1,
  mode: 'article',
  kind: 'review',
  card: { id: 1, term: 'Tisch', article: 'der', pos: 'noun', translation: 'стол' },
};

const STRASSE_ITEM = {
  key: '2:ru_de',
  card_id: 2,
  mode: 'ru_de',
  kind: 'review',
  card: { id: 2, term: 'Straße', article: 'die', pos: 'noun', translation: 'улица' },
};

const COMPOUND_ITEM = {
  key: '3:ru_de',
  card_id: 3,
  mode: 'ru_de',
  kind: 'review',
  card: { id: 3, term: 'Weiterbildung', article: 'die', pos: 'noun', translation: 'повышение квалификации' },
};

test('hands_free_matcher: нормализация ß/ss, пунктуации и полная фраза для артиклей', () => {
  assert.equal(normalizeGermanSpeech('  Die Straße! '), 'die strasse');
  assert.equal(expectedSpeechFor(NOUN_ITEM), 'der Tisch');

  // Голый артикль "der" НЕ засчитывается — нужна полная фраза "der Tisch"
  assert.equal(evaluateVoiceAnswer(NOUN_ITEM, 'der').matched, false);
  assert.equal(evaluateVoiceAnswer(NOUN_ITEM, 'der Tisch!').matched, true);
  assert.equal(evaluateVoiceAnswer(NOUN_ITEM, 'die Tisch').matched, false);

  // Варианты ß / ss и альтернативы ASR
  assert.equal(evaluateVoiceAnswer(STRASSE_ITEM, 'die Strasse').matched, true);
  assert.equal(evaluateVoiceAnswer(STRASSE_ITEM, ['die Strafe', 'die Straße']).matched, true);

  // Составное слово со словом "weiter" внутри НЕ должно перехватываться как команда "weiter"
  const ev = evaluateVoiceAnswer(COMPOUND_ITEM, 'die Weiterbildung');
  assert.equal(ev.command, null);
  assert.equal(ev.matched, true);
});

test('hands_free_matcher: перехват всех 4 голосовых команд до проверки ответа', () => {
  assert.equal(detectVoiceCommand('weiter!'), 'weiter');
  assert.equal(detectVoiceCommand('nochmal'), 'nochmal');
  assert.equal(detectVoiceCommand('noch mal'), 'nochmal');
  assert.equal(detectVoiceCommand('Schwer.'), 'schwer');
  assert.equal(detectVoiceCommand('Stopp!'), 'stopp');
  assert.equal(detectVoiceCommand('die Weiterbildung'), null);

  const ev = evaluateVoiceAnswer(NOUN_ITEM, 'weiter');
  assert.equal(ev.command, 'weiter');
  assert.equal(ev.matched, false);
});

/** Хелпер мок-окружения для проверки FSM и инвариантов защиты от эха */
function makeMockEnv(scriptedRecognitions) {
  const timeline = [];
  let micOpen = false;
  let recIdx = 0;

  class MockSR {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
    }
    start() {
      timeline.push('mic:start');
      assert.equal(micOpen, false, 'Микрофон не должен открываться повторно без закрытия');
      micOpen = true;
      const step = scriptedRecognitions[recIdx++] || { type: 'no-speech' };
      setTimeout(() => {
        if (!micOpen) return;
        if (step.type === 'result') {
          const alts = step.alts.map((t) => ({ transcript: t }));
          alts.isFinal = true;
          this.onresult && this.onresult({ results: [alts] });
          micOpen = false;
          this.onend && this.onend();
        } else if (step.type === 'error') {
          this.onerror && this.onerror({ error: step.error });
          micOpen = false;
          this.onend && this.onend();
        } else {
          this.onerror && this.onerror({ error: 'no-speech' });
          micOpen = false;
          this.onend && this.onend();
        }
      }, 5);
    }
    abort() {
      timeline.push('mic:abort');
      micOpen = false;
      this.onend && this.onend();
    }
    stop() {
      timeline.push('mic:stop');
      micOpen = false;
      this.onend && this.onend();
    }
  }

  const audioPlayer = {
    unlock() { timeline.push('audio:unlock'); },
    stop() { timeline.push('audio:stop'); },
    async play(text, opts) {
      assert.equal(micOpen, false, 'ЗАЩИТА ОТ ЭХА: микрофон обязан быть остановлен перед play()');
      timeline.push(`audio:play:${opts?.lang || 'de-DE'}:${text}`);
      await new Promise((r) => setTimeout(r, 8));
      timeline.push(`audio:ended:${text}`);
      return { ok: true, source: 'static' };
    },
  };

  const soundFx = {
    unlock() {},
    async beepSuccess() { assert.equal(micOpen, false, 'микрофон закрыт на beepSuccess'); timeline.push('fx:success'); },
    async beepError() { assert.equal(micOpen, false, 'микрофон закрыт на beepError'); timeline.push('fx:error'); },
    async beepTick() { assert.equal(micOpen, false, 'микрофон закрыт на beepTick'); timeline.push('fx:tick'); },
  };

  let wakeActive = false;
  const wakeLock = {
    async acquire() { wakeActive = true; timeline.push('wake:acquire'); return true; },
    async release() { wakeActive = false; timeline.push('wake:release'); },
    isActive: () => wakeActive,
  };

  return { timeline, MockSR, audioPlayer, soundFx, wakeLock };
}

test('HandsFreeEngine: верный ответ -> SPEAKING -> LISTENING -> EVALUATING -> FEEDBACK -> Good (3), без эха', async () => {
  const states = [];
  const env = makeMockEnv([{ type: 'result', alts: ['der Tisch'] }]);
  const engine = createHandsFreeEngine(
    { onStateChange: (s) => states.push(s) },
    {
      audioPlayer: env.audioPlayer,
      soundFx: env.soundFx,
      wakeLock: env.wakeLock,
      getSRCtor: () => env.MockSR,
      postSpeakMs: 5,
      correctPauseMs: 5,
      wrongPauseMs: 5,
      hardPauseMs: 5,
    },
  );

  await engine.start();
  const outcome = await engine.runCard({ item: NOUN_ITEM });
  assert.equal(outcome.action, 'rated');
  assert.equal(outcome.rating, 3);
  assert.equal(outcome.correct, true);
  assert.deepEqual(states, [
    HF_STATES.IDLE,
    HF_STATES.SPEAKING,
    HF_STATES.LISTENING,
    HF_STATES.EVALUATING,
    HF_STATES.FEEDBACK,
    HF_STATES.IDLE,
  ]);
  // Микрофон стартует строго ПОСЛЕ audio:ended
  const endedIdx = env.timeline.indexOf('audio:ended:Tisch');
  const micIdx = env.timeline.indexOf('mic:start');
  assert.ok(endedIdx >= 0 && micIdx > endedIdx);
  assert.ok(env.timeline.includes('fx:success'));
  engine.dispose();
});

test('HandsFreeEngine: ошибка -> beepError -> озвучка правильного ответа -> Again (1)', async () => {
  const env = makeMockEnv([{ type: 'result', alts: ['die Tisch'] }]);
  const engine = createHandsFreeEngine(
    {},
    {
      audioPlayer: env.audioPlayer,
      soundFx: env.soundFx,
      wakeLock: env.wakeLock,
      getSRCtor: () => env.MockSR,
      postSpeakMs: 5,
      wrongPauseMs: 5,
    },
  );

  await engine.start();
  const outcome = await engine.runCard({ item: NOUN_ITEM });
  assert.equal(outcome.action, 'rated');
  assert.equal(outcome.rating, 1);
  assert.equal(outcome.correct, false);
  assert.ok(env.timeline.includes('fx:error'));
  assert.ok(env.timeline.includes('audio:play:de-DE:der Tisch'));
  engine.dispose();
});

test('HandsFreeEngine: команды nochmal -> повтор, schwer -> Hard (2), weiter -> skip', async () => {
  const env = makeMockEnv([
    { type: 'result', alts: ['nochmal'] },
    { type: 'result', alts: ['schwer'] },
    { type: 'result', alts: ['weiter'] },
  ]);
  const engine = createHandsFreeEngine(
    {},
    {
      audioPlayer: env.audioPlayer,
      soundFx: env.soundFx,
      wakeLock: env.wakeLock,
      getSRCtor: () => env.MockSR,
      postSpeakMs: 5,
      hardPauseMs: 5,
    },
  );

  await engine.start();
  const r1 = await engine.runCard({ item: NOUN_ITEM });
  assert.equal(r1.action, 'rated');
  assert.equal(r1.rating, 2);
  // Должна была быть повторная озвучка после "nochmal"
  const playCount = env.timeline.filter((x) => x === 'audio:play:de-DE:Tisch').length;
  assert.equal(playCount, 2);

  const r2 = await engine.runCard({ item: NOUN_ITEM });
  assert.equal(r2.action, 'skip');
  engine.dispose();
});

test('HandsFreeEngine: no-speech делает до 2 автоперезапусков и затем переходит в PAUSED (НЕ Again)', async () => {
  const states = [];
  const env = makeMockEnv([
    { type: 'error', error: 'no-speech' },
    { type: 'error', error: 'no-speech' },
    { type: 'error', error: 'no-speech' },
    { type: 'result', alts: ['der Tisch'] },
  ]);
  const engine = createHandsFreeEngine(
    {
      onStateChange: (s) => {
        states.push(s);
        // Как только вошли в PAUSED после тишины, сразу возобновляем, чтобы убедиться, что цикл оживает
        if (s === HF_STATES.PAUSED) {
          setTimeout(() => engine.resume(), 10);
        }
      },
    },
    {
      audioPlayer: env.audioPlayer,
      soundFx: env.soundFx,
      wakeLock: env.wakeLock,
      getSRCtor: () => env.MockSR,
      postSpeakMs: 5,
      correctPauseMs: 5,
    },
  );

  await engine.start();
  const outcome = await engine.runCard({ item: NOUN_ITEM });
  assert.ok(states.includes(HF_STATES.PAUSED), 'После 2 автоперезапусков тишины должен войти в PAUSED');
  assert.equal(outcome.action, 'rated');
  assert.equal(outcome.rating, 3);
  engine.dispose();
});
