import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAudioPlayer, normalizeAudioKey } from '../public/js/services/audio_player.js';

test('normalizeAudioKey: идентично Python normalize_audio_key (NFC, ß, умляуты, пунктуация)', () => {
  const cases = [
    ['  Die   Gebrauchsanweisung! ', 'die gebrauchsanweisung'],
    ['Das Wetter ist heute einfach widerlich.', 'das wetter ist heute einfach widerlich'],
    ['„Hallo“, Welt…', 'hallo, welt'],
    ['der Bär', 'der bär'],
    ['die Straße', 'die straße'],
    ['jemandem zuwider sein', 'jemandem zuwider sein'],
    ['  ', ''],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeAudioKey(input), expected);
  }

  // Кросс-проверка 1-в-1 с scripts/generate_audio.py
  const pyOut = execFileSync(
    'python',
    [
      '-c',
      'import json, sys; sys.path.insert(0, "scripts"); from generate_audio import normalize_audio_key; '
      + 'arr = json.loads(sys.argv[1]); print(json.dumps([normalize_audio_key(x) for x in arr], ensure_ascii=False))',
      JSON.stringify(cases.map(([x]) => x)),
    ],
    { encoding: 'utf8' },
  );
  const pyKeys = JSON.parse(pyOut);
  assert.deepEqual(
    cases.map(([x]) => normalizeAudioKey(x)),
    pyKeys,
  );
});

test('AudioPlayerService: воспроизводит локальный файл из manifest.json и резолвится строго по ended', async () => {
  const events = [];
  let audioInst = null;

  const player = createAudioPlayer({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        version: 1,
        basePath: '/audio/de/',
        entries: {
          'der tisch': { normal: 'aaa.mp3', slow: 'aaa_slow.mp3' },
        },
      }),
    }),
    createAudio: () => {
      audioInst = {
        src: '',
        muted: false,
        playbackRate: 1,
        onended: null,
        onerror: null,
        onloadedmetadata: null,
        pause() { events.push('pause'); },
        load() { events.push(`load:${this.src}`); },
        play() {
          events.push(`play:${this.src}`);
          return Promise.resolve();
        },
      };
      return audioInst;
    },
    getSynth: () => null,
  });

  await player.loadManifest();
  assert.equal(player.hasStatic('Der Tisch!'), true);
  assert.equal(player.hasStatic('der Stuhl'), false);

  let resolved = false;
  const p = player.play('Der Tisch!').then((r) => {
    resolved = true;
    return r;
  });

  // Пока onended не вызван, Promise НЕ резолвится (критично для синхронизации с микрофоном)
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(resolved, false);
  assert.equal(player.isPlaying(), true);

  audioInst.onended();
  const res = await p;
  assert.deepEqual(res, { ok: true, source: 'static' });
  assert.equal(player.isPlaying(), false);
  assert.ok(events.includes('play:/audio/de/aaa.mp3'));

  // Замедленная версия при slow: true
  const pSlow = player.play('der Tisch', { slow: true });
  await new Promise((r) => setTimeout(r, 10));
  audioInst.onended();
  const resSlow = await pSlow;
  assert.deepEqual(resSlow, { ok: true, source: 'static' });
  assert.ok(events.includes('play:/audio/de/aaa_slow.mp3'));
});

test('AudioPlayerService: fallback на speechSynthesis при отсутствии файла или ошибке загрузки аудио', async () => {
  const spoken = [];
  const synth = {
    getVoices: () => [{ name: 'Anna', lang: 'de-DE' }],
    cancel() { spoken.push('cancel'); },
    speak(u) {
      spoken.push(`speak:${u.text}:${u.lang}`);
      setTimeout(() => u.onend && u.onend(), 10);
    },
  };

  let audioInst = null;
  const player = createAudioPlayer({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        basePath: '/audio/de/',
        entries: { 'broken word': { normal: 'broken.mp3' } },
      }),
    }),
    createAudio: () => {
      audioInst = {
        src: '',
        muted: false,
        playbackRate: 1,
        onended: null,
        onerror: null,
        pause() {},
        load() {},
        play() {
          setTimeout(() => this.onerror && this.onerror(new Error('404')), 5);
          return Promise.resolve();
        },
      };
      return audioInst;
    },
    getSynth: () => synth,
    createUtterance: (text) => ({ text, lang: '', rate: 1, voice: null, onend: null, onerror: null }),
  });

  // 1) Файла нет в манифесте -> сразу speechSynthesis
  const r1 = await player.play('die Lampe');
  assert.deepEqual(r1, { ok: true, source: 'speechSynthesis' });
  assert.ok(spoken.includes('speak:die Lampe:de-DE'));

  // 2) Файл есть в манифесте, но onerror -> graceful fallback на speechSynthesis
  const r2 = await player.play('broken word');
  assert.deepEqual(r2, { ok: true, source: 'speechSynthesis' });
  assert.ok(spoken.includes('speak:broken word:de-DE'));
});

test('AudioPlayerService: stop() мгновенно прерывает воспроизведение и резолвит Promise с interrupted=true', async () => {
  let audioInst = null;
  const player = createAudioPlayer({
    fetch: async () => ({
      ok: true,
      json: async () => ({ basePath: '/audio/de/', entries: { hallo: { normal: 'h.mp3' } } }),
    }),
    createAudio: () => {
      audioInst = {
        src: '',
        muted: false,
        playbackRate: 1,
        onended: null,
        onerror: null,
        pause() {},
        load() {},
        play: () => Promise.resolve(),
      };
      return audioInst;
    },
    getSynth: () => ({ cancel() {}, getVoices: () => [], speak() {} }),
  });

  await player.loadManifest();
  const p = player.play('Hallo');
  await new Promise((r) => setTimeout(r, 10));
  player.stop();
  const res = await p;
  assert.equal(res.ok, false);
  assert.equal(res.interrupted, true);
  assert.equal(player.isPlaying(), false);
});

test('generate_audio.py: E2E (mp3 + slow + idempotency + --force + ogg + manifest.json)', () => {
  const td = fs.mkdtempSync(path.join(os.tmpdir(), 'stufe-piper-test-'));
  try {
    const model = path.join(td, 'de_DE-thorsten-high.onnx');
    fs.writeFileSync(model, 'dummy-onnx');

    const fakePy = path.join(td, 'fake_piper.py');
    fs.writeFileSync(
      fakePy,
      [
        'import argparse, sys, wave',
        'p = argparse.ArgumentParser()',
        'p.add_argument("--model")',
        'p.add_argument("--output_file", required=True)',
        'p.add_argument("--length_scale", type=float, default=1.0)',
        'a = p.parse_args()',
        '_ = sys.stdin.read()',
        'with wave.open(a.output_file, "wb") as w:',
        '    w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)',
        '    w.writeframes(b"\\x00\\x00" * int(2205 * a.length_scale))',
      ].join('\n'),
      'utf8',
    );

    const isWin = process.platform === 'win32';
    const fakeBin = path.join(td, isWin ? 'piper.cmd' : 'piper.sh');
    fs.writeFileSync(
      fakeBin,
      isWin ? `@echo off\r\npython "${fakePy}" %*\r\n` : `#!/bin/sh\nexec python3 "${fakePy}" "$@"\n`,
      'utf8',
    );
    if (!isWin) fs.chmodSync(fakeBin, 0o755);

    const cardsJson = path.join(td, 'cards.json');
    fs.writeFileSync(
      cardsJson,
      JSON.stringify([
        { term: 'Tisch', article: 'der', pos: 'noun', translation: 'стол', example: 'Der Tisch ist groß.' },
        { term: 'widerlich', article: 'null', pos: 'adj', translation: 'отвратительный' },
      ]),
      'utf8',
    );

    const outMp3 = path.join(td, 'out_mp3');
    const r1 = execFileSync(
      'python',
      ['scripts/generate_audio.py', '--input', cardsJson, '--model', model, '--piper-bin', fakeBin, '--output-dir', outMp3, '--slow'],
      { encoding: 'utf8' },
    );
    assert.match(r1, /generated=8, skipped=0, failed=0/);
    const manifest = JSON.parse(fs.readFileSync(path.join(outMp3, 'manifest.json'), 'utf8'));
    assert.ok(manifest.entries['der tisch']);
    assert.ok(manifest.entries.tisch);
    assert.ok(manifest.entries['der tisch ist groß']);
    assert.ok(manifest.entries.widerlich);
    assert.ok(manifest.entries['der tisch'].normal.endsWith('.mp3'));
    assert.ok(manifest.entries['der tisch'].slow.endsWith('_slow.mp3'));

    // Идемпотентность: повторный запуск пропускает все 8 файлов
    const r2 = execFileSync(
      'python',
      ['scripts/generate_audio.py', '--input', cardsJson, '--model', model, '--piper-bin', fakeBin, '--output-dir', outMp3, '--slow'],
      { encoding: 'utf8' },
    );
    assert.match(r2, /generated=0, skipped=8, failed=0/);

    // --force: перегенерирует все 8 файлов
    const r3 = execFileSync(
      'python',
      ['scripts/generate_audio.py', '--input', cardsJson, '--model', model, '--piper-bin', fakeBin, '--output-dir', outMp3, '--slow', '--force'],
      { encoding: 'utf8' },
    );
    assert.match(r3, /generated=8, skipped=0, failed=0/);

    // --format ogg
    const outOgg = path.join(td, 'out_ogg');
    const r4 = execFileSync(
      'python',
      ['scripts/generate_audio.py', '--input', cardsJson, '--model', model, '--piper-bin', fakeBin, '--output-dir', outOgg, '--format', 'ogg'],
      { encoding: 'utf8' },
    );
    assert.match(r4, /generated=4, skipped=0, failed=0/);
    const mOgg = JSON.parse(fs.readFileSync(path.join(outOgg, 'manifest.json'), 'utf8'));
    assert.ok(mOgg.entries['der tisch'].normal.endsWith('.ogg'));
  } finally {
    fs.rmSync(td, { recursive: true, force: true });
  }
});
