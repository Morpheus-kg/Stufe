# German Trainer — CONTRACT v1

Single source of truth for every module. Personal single-user web app (PWA, mobile-first) for learning German vocabulary toward Goethe B2: spaced repetition over the user's own \~300 cards, AI sentence correction, AI word generation, dictation. Deployed on Railway (Node + MySQL). UI language: Russian. Content: German.

## 0. Rules for every agent

1. Read this whole document. Write ONLY the files listed in your task card (section 8). Never touch other modules' files.
2. Names (tables, columns, endpoints, JSON fields, exported functions, file paths) are fixed. Never rename them or add required fields. If something is missing, choose the simplest option and record it in NOTES.md under "ASSUMPTIONS".
3. Return COMPLETE files (no patches, no "..." placeholders) plus a short NOTES.md: exports, env vars, assumptions, how to test. If you run out of room, stop at a file boundary and list the files not yet written.
4. Defensive code: validate all input (zod on the server), handle null/empty/garbage, never crash the process on a bad request or bad AI output, no secrets in code, no `console.log` of secrets or full user text.
5. Only the dependencies listed in section 1. No build step. No TypeScript (plain JS + JSDoc).
6. Code comments in Russian, short. Identifiers in English.

## 1. Stack and conventions

- Server: Node 20, ESM (`"type":"module"`), express@4, mysql2 (promise pool), zod, ts-fsrs, helmet, express-rate-limit, cookie-parser, dotenv (dev only). Pin exact versions (check current stable). Tests: built-in `node:test`.
- Client: vanilla JS ES modules, hash router, no libraries, no CDN, served statically from `public/`. `shared/` is served at `/shared/` and imported by both server and browser (pure functions, no Node or DOM APIs).
- DB: MySQL 8 or MariaDB 10.4+, utf8mb4. JSON is stored as LONGTEXT and always parsed in try/catch. Pool options: `timezone:'Z'`, `dateStrings:true`; DATETIME values are UTC strings `YYYY-MM-DD HH:MM:SS`. API timestamps are ISO-8601 UTC strings.
- "Today" = calendar day in TZ\_NAME (default `Asia/Bishkek`), day rolls over at 04:00 local time.
- API: JSON under `/api`. Errors: HTTP status plus `{"error":{"code":"CODE","message":"russian text"}}`. Codes: BAD\_REQUEST, UNAUTHORIZED, NOT\_FOUND, RATE\_LIMITED, AI\_UNAVAILABLE, AI\_CAP, CONFLICT, INTERNAL.
- Auth (single user): `POST /api/auth/login {password}` compares with env APP\_PASSWORD (timing-safe), sets cookie `sid` = HMAC-signed token (SESSION\_SECRET), httpOnly, SameSite=Lax, Secure in production, 30 days. Every `/api/*` except `/api/auth/login` and `/api/health` requires it. Login limited to 10 attempts per 15 min per IP. Body limit 5 MB.
- Env: PORT, NODE\_ENV, TZ\_NAME, APP\_PASSWORD, SESSION\_SECRET, MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE, LLM\_CHAIN (default `groq,gemini`), GROQ\_KEY, GROQ\_MODEL\_STRONG, GROQ\_MODEL\_FAST, GEMINI\_KEY, GEMINI\_MODEL\_STRONG, GEMINI\_MODEL\_FAST, OPENROUTER\_KEY, OPENROUTER\_MODEL\_STRONG, OPENROUTER\_MODEL\_FAST, AI\_DAILY\_CAP\_CORRECT (200), AI\_DAILY\_CAP\_GENERATE (40), AI\_DAILY\_CAP\_ENRICH (100). Model names come ONLY from env; `.env.example` marks them "verify in provider console".
- Route auto-mount: every file in `server/routes/*.js` exports `export const mountPath = '/api/...'` and `export default router` (express Router). `server/index.js` imports all of them in alphabetical order and mounts them, so modules never edit `index.js`.
- Shared server helpers (owned by M1, used by all): `server/config.js` (`export const config`), `server/db.js` (`pool`, `query(sql, params) -> rows`, `tx(async conn => {...})`), `server/time.js` (`localDay(dateOrIso) -> 'YYYY-MM-DD'`, `toSql(date) -> string`, `toIso(sqlString) -> string`, `nowUtc()`), `server/settings.js` (`getSettings() -> object with defaults applied`), `server/errors.js` (`class ApiError(status, code, message)`, `asyncHandler`), `server/keys.js` (`normalizeKey(article, term)`).

## 2. Database (`db/schema.sql`, idempotent, copy verbatim)

```sql
CREATE TABLE IF NOT EXISTS cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  term VARCHAR(255) NOT NULL,
  article ENUM('der','die','das') NULL,
  plural VARCHAR(255) NULL,
  pos ENUM('noun','verb','adj','adv','phrase','idiom','collocation') NOT NULL DEFAULT 'phrase',
  translation VARCHAR(500) NOT NULL,
  grammar TEXT NULL,
  example TEXT NULL,
  example_translation TEXT NULL,
  example_cloze TEXT NULL,
  cloze_answer VARCHAR(255) NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NOT NULL DEFAULT 'Sonstiges',
  source VARCHAR(255) NULL,
  check_flag TINYINT(1) NOT NULL DEFAULT 0,
  enriched TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  dedupe_key VARCHAR(300) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dedupe (dedupe_key),
  KEY idx_pos (pos), KEY idx_topic (topic), KEY idx_enriched (enriched)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS card_state (
  card_id INT NOT NULL,
  mode ENUM('ru_de','cloze','article','dictation') NOT NULL,
  state TINYINT NOT NULL DEFAULT 0,
  due DATETIME NOT NULL,
  stability DOUBLE NOT NULL DEFAULT 0,
  difficulty DOUBLE NOT NULL DEFAULT 0,
  elapsed_days INT NOT NULL DEFAULT 0,
  scheduled_days INT NOT NULL DEFAULT 0,
  learning_steps INT NOT NULL DEFAULT 0,
  reps INT NOT NULL DEFAULT 0,
  lapses INT NOT NULL DEFAULT 0,
  last_review DATETIME NULL,
  PRIMARY KEY (card_id, mode),
  KEY idx_due (due),
  CONSTRAINT fk_state_card FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS review_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  client_uuid CHAR(36) NOT NULL,
  card_id INT NOT NULL,
  mode ENUM('ru_de','cloze','article','dictation') NOT NULL,
  rating TINYINT NOT NULL,
  correct TINYINT(1) NOT NULL,
  response_ms INT NULL,
  user_answer TEXT NULL,
  hints_used TINYINT NOT NULL DEFAULT 0,
  answered_at DATETIME NOT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_uuid (client_uuid),
  KEY idx_day (local_day), KEY idx_card (card_id, mode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sentences (
  id INT AUTO_INCREMENT PRIMARY KEY,
  card_id INT NULL,
  text TEXT NOT NULL,
  corrected TEXT NOT NULL,
  errors LONGTEXT NOT NULL,
  is_correct TINYINT(1) NOT NULL DEFAULT 0,
  provider VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS staging_cards (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id VARCHAR(36) NOT NULL,
  term VARCHAR(255) NOT NULL,
  article ENUM('der','die','das') NULL,
  plural VARCHAR(255) NULL,
  pos ENUM('noun','verb','adj','adv','phrase','idiom','collocation') NOT NULL DEFAULT 'phrase',
  translation VARCHAR(500) NOT NULL,
  grammar TEXT NULL,
  example TEXT NULL,
  example_translation TEXT NULL,
  example_cloze TEXT NULL,
  cloze_answer VARCHAR(255) NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NOT NULL DEFAULT 'Sonstiges',
  check_flag TINYINT(1) NOT NULL DEFAULT 0,
  dedupe_key VARCHAR(300) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_status (status), KEY idx_batch (batch_id), KEY idx_key (dedupe_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key CHAR(64) PRIMARY KEY,
  feature VARCHAR(30) NOT NULL,
  response MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_usage (
  day DATE NOT NULL,
  provider VARCHAR(30) NOT NULL,
  feature VARCHAR(30) NOT NULL,
  calls INT NOT NULL DEFAULT 0,
  failures INT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, feature)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  key_name VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS daily_stats (
  day DATE PRIMARY KEY,
  reviews INT NOT NULL DEFAULT 0,
  correct INT NOT NULL DEFAULT 0,
  new_cards INT NOT NULL DEFAULT 0,
  active_seconds INT NOT NULL DEFAULT 0,
  ext_audio_min INT NOT NULL DEFAULT 0,
  ext_speaking_min INT NOT NULL DEFAULT 0,
  ext_reading_min INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS import_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filename VARCHAR(255) NULL,
  total INT NOT NULL, added INT NOT NULL, merged INT NOT NULL, flagged INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

Settings keys and defaults (`getSettings()` applies them; values stored as text, returned typed): `new_per_day`=10, `max_reviews_per_day`=150, `max_session_items`=40, `request_retention`=0.9, `tts_rate`=0.9, `tts_voice`='', `theme`='auto', `daily_goal_minutes`=15, `ai_enabled`=true.

## 3. Shared constants, shapes, grading

`shared/constants.js` exports: `MODES = ['ru_de','cloze','article','dictation']`, `RATING = {AGAIN:1,HARD:2,GOOD:3,EASY:4}`, `POS`, `LEVELS`, `TOPICS = ['Arbeit','Bildung','Gesellschaft','Umwelt','Medien','Gesundheit','Wirtschaft','Alltag','Reisen','Politik','Familie','Sonstiges']`, `ERROR_CATEGORIES = ['artikel','kasus','wortstellung','praeposition','konjugation','rechtschreibung','wortschatz','sonstiges']`.

**Card JSON** (API shape = table columns minus dedupe\_key; booleans as true/false): `{id, term, article, plural, pos, translation, grammar, example, example_translation, example_cloze, cloze_answer, level, topic, source, check_flag, enriched, active}`. Nouns store `term` WITHOUT article; the displayed form is `article + ' ' + term`.

**dedupe\_key** = `normalizeKey(article, term)`: NFC, lowercase, trim, collapse spaces, strip outer punctuation, `article` prefix included when present.

**Old import shape** `{term, translation, example, example_translation, type}` and the new shape are both accepted. Mapping: a term starting with der/die/das gets article split off and `pos='noun'`; `type` idiom -> idiom; other word/phrase -> `pos='phrase'` (enrichment fixes it later); `enriched=0`. A term like `die Armut (in Armut aufwachsen)` becomes TWO cards: the word and the phrase, same example. Unknown fields are ignored; max 5000 items per request. Empty or too-short `term`/`translation` rows are skipped and counted in `flagged`. If a duplicate key exists, fill only the empty fields of the existing card (`merged`).

**Eligibility per mode**: `ru_de` any card; `cloze` needs `example_cloze` and `cloze_answer`; `article` only `pos='noun'` with article; `dictation` needs `example`.

**Prompt/answer per mode** (built client-side): `ru_de`: show translation (and pos hint), expect `article term` for nouns else `term`. `cloze`: show `example_cloze` plus `example_translation` as hint, expect `cloze_answer`. `article`: show `term`, expect der/die/das and, if `plural` exists, then the plural. `dictation`: speak `example` via TTS, expect `example`.

**shared/grading.js** (pure): `normalizeAnswer(s)`, `gradeTyped(answer, expected) -> {result:'correct'|'almost'|'wrong', note:string(ru), diff:[{t:'same'|'del'|'ins', w:string}]}`. Comparison is case-insensitive, ignores trailing punctuation and extra spaces, treats `ae/oe/ue/ss` as equal to `ä/ö/ü/ß` (result `correct`, note mentions it). `almost` = exactly one typo (Levenshtein 1) on words of 5+ letters. A wrong article is always `wrong` with note. `diff` is word-level. `autoRating({result, responseMs, hints, mode}) -> 1..4`: wrong->1; almost->2; correct with hints>=1->2; correct without hints and responseMs <= fast threshold -> 4 else 3. Fast thresholds (ms): ru\_de 4000, cloze 5000, article 2500, dictation 25000. The user may override the rating after the answer (button row, default = auto).

## 4. SRS contract (`server/srs/engine.js`, `server/srs/queue.js`)

- Uses `ts-fsrs` with default parameters, fuzz on, `request_retention` from settings. A card is scheduled separately per mode (table `card_state`).
- `createEmptyState(cardId, mode, now)`; `applyReview(state, rating, now) -> newState` (pure, same field names as `card_state`).
- `buildQueue({cards, states, introducedToday, doneToday, now, settings}) -> QueueItem[]`: (1) due items (`due <= now`) ordered by due, capped by `max_reviews_per_day - doneToday`; (2) new cards (no state in any mode) ordered by level asc then id, count = `new_per_day - introducedToday`; each new card yields two items: `ru_de` first, then one of cloze/article/dictation (first eligible in that order); (3) interleave so the same card\_id is never within 3 positions; (4) cap total at `max_session_items`; (5) mode ladder: for each card that has an ru\_de state with state >= 2 (Review) or stability >= 3 days and lacks an eligible mode, emit ONE item for the next missing mode in the order cloze, article, dictation (kind review, due null), after the due items and before new cards, at most 5 such items per day in total (constant NEW\_MODES\_PER\_DAY, minus ladderDoneToday passed by session.js = number of (card\_id, mode) pairs whose first review\_log row is today for cards first reviewed before today); (6) append at most one `sentence` task (see below).
- **QueueItem**: `{key:'<card_id>:<mode>', card_id, mode, kind:'new'|'review'|'sentence', card:Card, due:ISO|null}`; `mode` may be `'sentence'` only for kind `sentence` (not scheduled, no card\_state row): one card from today's lapsed or newest-introduced cards; if none, none.
- A new item shows a "learn" screen first (term, translation, example, TTS) then the test; the client handles this (`kind:'new'` and the item's first appearance).
- Introduced today = distinct card\_ids whose first review\_log row has `local_day` = today.

## 5. API (all under `/api`, JSON)

Auth: `POST /auth/login {password}` -> 204; `POST /auth/logout` -> 204; `GET /auth/me` -> `{ok:true}`; `GET /health` -> `{ok:true}` (public, no data).

Cards (M1): `GET /cards?query=&topic=&pos=&check=1&limit=50&offset=0` -> `{items:Card[], total}`; `PATCH /cards/:id` (partial fields, zod) -> Card; `DELETE /cards/:id` (soft: `active=0`) -> 204.

Add card (M1): `POST /cards {term, translation, article?, plural?, pos?, grammar?, example?, example_translation?, level?, topic?}` -> Card (201). `enriched=0` unless all enrichable fields are sent. A duplicate `dedupe_key` -> 409 `CONFLICT` with `existing_id` in the error body.

Import/Export (M1): `POST /import` body `{filename?, cards:[...]}` -> `{run_id,total,added,merged,flagged}`; `GET /export` -> `{version:1, exported_at, cards, card_state, review_log, sentences, settings, daily_stats}` (attachment-friendly JSON); `POST /export/restore?mode=merge|replace` same body as export -> `{restored:{cards,card_state,review_log,...}}` (replace asks for header `X-Confirm: yes`).

Settings and logging (M1): `GET /settings` -> object; `PUT /settings` partial, validated -> object; `POST /log/external {kind:'audio'|'speaking'|'reading', minutes:1..600}` -> `{ok:true}` (adds to daily\_stats for today).

Session (M2): `GET /session/today` -> `{date, queue:QueueItem[], counts:{due,new,total}, done_today:{reviews,new_cards}}`.

Reviews (M2): `POST /reviews {reviews:[{client_uuid, card_id, mode, rating, correct, response_ms?, user_answer?, hints_used?, answered_at(ISO)}], active_seconds?:int}` -> `{applied:[client_uuid], duplicates:[client_uuid], rejected:[{client_uuid,reason}]}`. Server sorts by `answered_at`, runs in one transaction, `INSERT IGNORE` on `client_uuid` (idempotent for offline sync), creates/updates `card_state`, increments `daily_stats` for the local day of `answered_at` (`new_cards` increments when the card had no state in any mode).

AI (M3): `POST /ai/correct-sentence {card_id?, text(1..400)}` -> `{id, corrected, is_correct, uses_target_word, errors:[{category, original, fix, explanation_ru}], alternative}`; `POST /ai/generate-words {topic(1..60), count(1..15, default 10), pos_mix:'nouns_first'|'balanced'}` -> `{batch_id, items:StagingCard[], dropped_duplicates:int}`; `GET /staging?status=pending` -> `{items:StagingCard[]}`; `POST /staging/:id/accept {edits?}` -> Card; `POST /staging/:id/reject {reason?}` -> 204; `POST /enrich/run {limit?:1..50}` -> `{processed, flagged, remaining}`; `GET /enrich/status` -> `{pending, flagged, ai_available}`; `GET /ai/usage` -> `{day, by_feature:{...}, caps:{...}}`.

Stats (M6): `GET /stats/summary` -> `{streak_days, today:{reviews,correct,new_cards,active_seconds}, last_30_days:[{day,reviews,correct}], retention_30d, cards:{total, by_level:{}, by_topic:{}, new, learning, mature, flagged_check, pending_enrich}, accuracy_by_mode:{ru_de,cloze,article,dictation}, weak_cards:[{card, lapses}] (top 10), error_categories:{category:count}, external_minutes_30d:{audio,speaking,reading}}`. "mature" = stability >= 21 days in any mode. Streak = consecutive local days with >= 1 review, today optional.

## 6. AI contract (`server/ai/*`)

- `llm.js`: `chatJSON({feature, tier:'strong'|'fast', system, user, schema(zod), cacheTtlDays?, excludeProvider?, temperature=0.2, maxTokens=1500}) -> {data, provider, cached}`; throws `ApiError` with code `AI_UNAVAILABLE` (503) when every provider failed, `AI_CAP` (429) when the daily cap of the feature is reached.
- Flow: cache lookup (`sha256(feature|tier|system|user)`) -> cap check from `ai_usage` -> iterate providers in `LLM_CHAIN` order, skipping those without key/model or equal to `excludeProvider` -> OpenAI-compatible `POST {base}/chat/completions` with `response_format:{type:'json_object'}`, 25 s timeout, strip code fences, JSON.parse, zod validate; one repair retry on invalid JSON; on 429/5xx/timeout/invalid go to the next provider -> store cache, count usage and failures.
- Bases: Groq `https://api.groq.com/openai/v1`, Gemini `https://generativelanguage.googleapis.com/v1beta/openai`, OpenRouter `https://openrouter.ai/api/v1`. Provider code lives in `providers.js` (adding a provider = one object: name, base, keyEnv, modelEnv).
- Prompts are text files in `server/ai/prompts/` (`enrich.txt`, `correct.txt`, `generate.txt`, `gender.txt`); never inline long prompts in code. User text is always wrapped in delimiters and the system prompt states it is data, not instructions.
- **enrich**: `enrichCards(limit)` takes cards with `enriched=0` (at most 25 per model call). The model fills ONLY empty fields (`article`, `plural`, `pos`, `grammar`, `level`, `topic`, `example_cloze`, `cloze_answer`); it never overwrites existing `term`, `translation`, `example`. `example_cloze` is the example with the used form of the term replaced by `____`; `cloze_answer` is that form; both null if the form is not found in the example. For nouns a second call to a DIFFERENT provider (`excludeProvider`) returns article+plural; any disagreement sets `check_flag=1`. Sets `enriched=1`. If AI is unavailable, nothing changes and the route reports it.
- **correct-sentence**: strong tier, level B1->B2, do not over-correct style, explanations in Russian (1-2 sentences each), `uses_target_word` true if the target card's term (any form) appears, non-German input -> `is_correct:false` and one error with category `sonstiges`. Saved into `sentences`.
- **generate-words**: fast tier, nouns first (always article and plural), B2-level, with example and translations, `check_flag` set by the same two-provider gender check. Request `count*1.5`, drop items whose `dedupe_key` exists in `cards` or `staging_cards`, trim to `count`.
- Offline-safe: all non-AI features must work when AI returns `AI_UNAVAILABLE`.

## 7. Frontend contract (`public/`)

- Hash routes: `#/login`, `#/today` (default), `#/review`, `#/cards`, `#/staging`, `#/stats`, `#/settings`. `js/app.js` is the router and shell (bottom tab bar on mobile). Unauthorized API response -> redirect to `#/login`.
- `js/api.js` exports one function per endpoint: `login, logout, me, getToday, postReviews, correctSentence, generateWords, getStaging, acceptStaging, rejectStaging, getStats, getSettings, putSettings, importCards, exportAll, restoreAll, getCards, patchCard, deleteCard, createCard, logExternal, enrichRun, enrichStatus, getAiUsage`. They return parsed JSON or throw `ApiError {status, code, message}`.
- **Mode component interface** (`js/modes/<mode>.js`): `export async function mount(container, item, ctx)` -> resolves `{result:'correct'|'almost'|'wrong', userAnswer, responseMs, hints}` after the user has answered (the review runner handles rating, saving, next item). `ctx = {speak, grade: gradeTyped, settings, hintsUsed()}`. Modes: `ru_de`, `cloze`, `article`, `dictation`, `sentence` (sentence mode calls `correctSentence` and resolves `result:'correct'` if `is_correct` else `'wrong'`; it is not rated into FSRS).
- `js/tts.js`: `speak(text, {rate}) -> Promise` (Web Speech API, `de-DE` voice, prefers `settings.tts_voice`), `hasGermanVoice()`, `listGermanVoices()`. No voice -> show a one-line hint to install a German voice.
- Review runner (`views/review.js`): shows the "learn" screen for `kind:'new'`, the mode component, feedback with diff and note, rating row (auto-selected, overridable), appends the review to the offline queue then flushes; wrong answers are re-queued once later in the same session.
- Offline (`js/offline.js`): IndexedDB stores `pending_reviews` and `session_cache`; `enqueueReview(r)`, `flush()` (called after each answer, on `online`, on app start), `cacheSession(s)`, `loadSession()`. Every review has `client_uuid = crypto.randomUUID()`.
- Service worker (`sw.js`): versioned cache, cache-first for static files, network-only for `/api`; update on new version.
- Design: mobile-first single column, tap targets >= 44 px, light and dark via CSS variables (`prefers-color-scheme`, overridable by `settings.theme`), system fonts, Russian strings, no external resources. Escape all text from cards and AI before inserting into the DOM (use `textContent`).

## 8. Files and task cards

Ownership (no one edits another module's file): see the card of each module. Everything else not listed is owned by the integrator.

**M1 Backend core**: `package.json`, `.env.example`, `Procfile` (`web: node server/index.js`), `db/schema.sql`, `server/index.js` (route auto-mount, helmet, auth guard, static `public/` and `/shared/`, error handler, migration on start), `server/config.js`, `db.js`, `time.js`, `settings.js`, `errors.js`, `keys.js`, `auth.js`, `server/routes/{auth,health,import,export,cards,settings,log}.js`, `tests/import.test.js` (mapping, parentheses split, dedupe, merge). Budget about 700 lines.

M1 also: `POST /cards` from section 5, with a test for the 409 case.

**M2 SRS and grading**: `shared/constants.js`, `shared/grading.js`, `server/srs/engine.js`, `server/srs/queue.js`, `server/routes/{session,reviews}.js`, `tests/{grading,srs,queue}.test.js`.

**M3 AI**: `server/ai/{llm,providers,schemas,enrich}.js`, `server/ai/prompts/*.txt`, `server/routes/{ai,enrich,staging}.js`, `tests/ai.test.js` (mocked fetch: provider fallback, invalid JSON repair, cap, cache, gender disagreement).

**M4 Frontend core**: `public/index.html`, `public/css/app.css`, `public/js/{app,api,tts}.js`, `public/js/views/{login,today,review,cards}.js`, `public/js/modes/{ru_de,cloze,article}.js`.

M4 also: the `cards` view has an "Add word" form (term, translation, optional article, plural, example) calling `createCard`; on 409 show "Такая карточка уже есть".

**M5 Frontend extras**: `public/js/modes/{dictation,sentence}.js`, `public/js/views/staging.js`, `public/js/ui/diff.js` (renders `diff` from grading with colors and text labels, not color alone).

**M6 Stats, settings, PWA**: `server/routes/stats.js`, `public/js/views/{stats,settings}.js`, `public/js/offline.js`, `public/sw.js`, `public/manifest.webmanifest`, `public/icons/icon.svg`, `README.md` (Railway deploy: service, MySQL plugin, Variables, first login, weekly export).

M6 also: the `settings` view contains the settings form plus: a file picker for a JSON array of cards -> `importCards`, with the returned counts shown; Export (download via `exportAll`) and Restore (file -> `restoreAll`, `replace` only after a confirm dialog, sends `X-Confirm: yes`); "Enrich new cards" (`enrichRun` in a loop until `remaining` is 0, progress from `enrichStatus`); AI usage (`getAiUsage`).

**G Audit (Gemini, report only, no rewrites)**: given this contract and all module files, output a table `file | line | contract says | found | fix` for every mismatch (names, fields, endpoints, exports, imports, missing files, env vars); plus `scripts/seed-sample.json` with 25 test cards (old and new shapes, duplicates, parentheses case, empty fields, odd `type` values).

**I Integration (Sonnet thinking)**: given the contract, all module files and the audit table: fix every mismatch, make `npm start` boot against an empty database, check imports/exports across modules, then walk the smoke tests below on paper and fix what would fail. Output only changed or new files in full plus a short change list.

## 9. Smoke tests (must pass after integration)

1. Empty DB: server boots, schema created, `/api/health` ok.
2. Login with wrong password -> 401; right password -> cookie; `/api/cards` without cookie -> 401.
3. Import `seed-sample.json` twice: second run adds 0, merged > 0; parentheses terms become two cards.
4. `GET /session/today` returns a queue; new cards produce `ru_de` plus a second mode.
5. `POST /reviews` with a repeated `client_uuid` -> reported in `duplicates`, no double count in `daily_stats`.
6. With no AI keys: `/ai/*` -> 503 `AI_UNAVAILABLE`, the rest of the app works.
7. Enrich with a mocked provider: article disagreement sets `check_flag=1`.
8. Staging accept creates a card and it appears in tomorrow's new items; reject keeps it out; duplicates are dropped.
9. Offline: answer 3 cards with the network off, reconnect, all 3 sync once.
10. `/stats/summary` matches counts in `review_log`.

## 10. Out of scope for v1 (planned v2)

Speaking (recording + Whisper), reading texts with Goethe-style questions, Hören from texts, weekly Schreiben task, mock exams, push notifications, grammar drills (Präpositionen/Nomen-Verb-Verbindungen as a separate mode).
