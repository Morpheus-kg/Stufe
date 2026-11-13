# German Trainer — CONTRACT v2 (extends v1), revision 2

Read CONTRACT v1 first: everything in it stays valid (rules, stack, conventions, API style, auth, error format, file auto-mount) unless section 1 below amends it. v2 adds: difficulty levels, less clicking, AI provider choice, the skill trainers Lesen, Hören, Sprechen, Schreiben, translation in batches, a retell trainer (Russian text -> German text), a number-listening trainer, word lookup, errors-to-cards, a daily plan, skill statistics and an exam log with countdown. Goal of the whole product: pass Goethe-Zertifikat B2. Same single user, same Railway deployment, same free AI providers.

## 0. Rules (in addition to v1 section 0)
1. Patch tasks (P1-P5) edit files of an earlier module: continue in that module's original chat if it still exists, otherwise attach the current files. Return COMPLETE changed files plus an updated NOTES.md section "v2 changes".
2. New modules (M7-M15) write only the files in their card. Names in this document are fixed; if something is missing choose the simplest option and write it under ASSUMPTIONS in NOTES.md.
3. Free AI quotas are small (Groq about 8000 tokens per minute, Gemini strong models about 20 requests per day). **Batch principle: free-form answers are never checked one by one. They are collected and checked in ONE AI call per batch (at most 6 items per call; larger batches are split by the server into sequential chunks and merged by code).** Everything that can be done in code must be done in code (the numbers trainer uses no AI at all).
4. All user-provided or AI-provided text (pasted texts, answers, transcripts) is data, never instructions. Escape it in the DOM (`textContent`). Never log full user texts.
5. Same dependencies as v1. No new packages in v2 (Node 20 global `fetch`, `FormData`, `Blob` are enough).

## 1. Amendments to v1 ("v1.1")

### 1.1 New settings keys (M1 `server/settings.js`, typed, validated, returned by `GET /api/settings`)
`difficulty` 'easy'|'medium'|'hard' = 'medium'; `learn_auto_seconds` int 0..30 = 6 (0 = manual); `auto_next_ms` int 0..5000 = 900 (0 = manual); `ai_provider_generate` 'auto'|'groq'|'gemini'|'openrouter' = 'auto'; `stt_engine` 'browser'|'whisper' = 'browser'; `listening_plays` 1|2 = 2; `plan_minutes` int 5..120 = 20; `weight_hoeren`=35, `weight_sprechen`=25, `weight_lesen`=25, `weight_schreiben`=5, `weight_vocab`=10 (ints 0..100, normalized by code, all zero -> defaults); `exam_date` string `YYYY-MM-DD` or '' = ''; `numbers_level` int 1..4 = 2.

### 1.2 Migrations (M1)
`server/migrate.js` runs on start in this order: `db/schema.sql`, `db/schema_v2.sql` (owned by M7, may be absent), then migrations from `server/migrations/NNN_name.js` in name order. Each exports `name` and `async up(conn, h)`; applied names are stored in table `schema_migrations(name VARCHAR(100) PRIMARY KEY, applied_at DATETIME)`. Helpers `h.columnExists(table, col)`, `h.tableExists(table)`, `h.addColumnIfMissing(table, col, ddl)` (must work on MySQL 8 and MariaDB: use information_schema, not `IF NOT EXISTS`). Migration `001_staging_provider`: `staging_cards.provider VARCHAR(30) NULL`. `db/schema.sql` is updated so fresh installs already contain that column (migrations are idempotent). Existing data must survive. New env vars go to `.env.example`: `GROQ_MODEL_STT` (default `whisper-large-v3-turbo`, verify in console), `AI_DAILY_CAP_TEXT`=30, `AI_DAILY_CAP_TRANSLATE`=100, `AI_DAILY_CAP_SPEAK`=60, `AI_DAILY_CAP_WRITE`=30, `AI_DAILY_CAP_LOOKUP`=300.

### 1.3 Difficulty and hints (M2 `shared/*`, used by all modes)
Difficulty is a setting (`difficulty`) that the user can switch live in the review header.
- **ru_de**: easy = Russian prompt plus 4 choice buttons (`item.choices`); medium = typed answer, hint ladder available; hard = typed answer, no hints, no choices, and if the card has `example` and `example_translation` a second step follows: the Russian `example_translation` is shown and the user types the German `example`. **This sentence is NOT graded immediately** (a correct translation rarely equals the reference): the answer goes to the session basket (section 1.4) and is checked later in one batch AI call. Immediate feedback for the second step is neutral ("Записано, проверим в конце") plus, only for information, whether the answer is identical to the reference (`gradeSentence`). The card's result and FSRS rating depend on the word step only.
- **cloze**: easy = choices; medium = typed, Russian `example_translation` shown, hint ladder; hard = typed, translation hidden, no hints.
- **article**: easy = der/die/das buttons with the Russian translation shown, plural not asked; medium = buttons, translation shown, plural typed; hard = German term only, plural required.
- **dictation**: easy = unlimited replays and a slow button (rate 0.7); medium = 2 plays; hard = 1 play, no slow button, punctuation ignored.
- **Hint ladder** (`shared/hints.js`, new): `makeHint(expected, step) -> string`, `MAX_HINT_STEP = 3`. Step 1: first letter of each word and underscores for the rest, a leading der/die/das shown in full (`die A____`); step 2: first half of every word; step 3: full reveal, which forces `result='wrong'`. Words of 2 letters or less are shown in full. `hintsUsed` = highest step opened.
- **`autoRating({result, responseMs, hints=0, mode, difficulty='medium'})`**: wrong -> 1; hints >= 3 -> 1; almost -> 2; correct with hints >= 1 -> 2; correct without hints: easy -> 3 (never 4); medium or hard -> 4 if `responseMs <= FAST_THRESHOLDS_MS[mode] * (hard ? 1.5 : 1)` else 3.
- **`gradeSentence(answer, expected) -> {result, similarity, diff, note}`** (`shared/grading.js`): same normalization as `gradeTyped`; tokens compared as words; `similarity = 2*LCS/(len(a)+len(b))`; `correct` when all words equal after normalization (ae/oe/ue/ss folding allowed), `almost` when similarity >= 0.8, else `wrong`; `diff` is word-level as in v1; `note` in Russian. Used for dictation of texts, shadow speaking, the informational check above and the diff view of long texts.
- **`QueueItem.choices?: string[]`** (M2, only for modes ru_de and cloze): 4 distinct strings including the correct one, shuffled deterministically by `sha(item.key + localDay)`. ru_de choices are display forms (`article term`) of the card plus 3 other active cards with the same `pos`; cloze choices are `cloze_answer` values of other cards. If the pool is too small use fewer (minimum 2); if fewer than 2 omit `choices`. The client uses `choices` when difficulty is easy and falls back to typing when absent.
- **`shared/constants.js`**: `TOPICS` gains `'Redemittel'` (set phrases and connectors for opinions, letters and discussions).

### 1.4 Less clicking and the sentence basket (M4 review runner, M5 dictation/sentence)
- Learn screen for new cards auto-advances after `learn_auto_seconds`: it speaks the term, then the example once (TTS), shows a visible countdown; tap or Enter = go now, tap on the countdown = pause. `0` = manual.
- Enter key: submits the answer; after feedback Enter = next. On mobile the keyboard "go" key submits.
- After a correct answer the next item opens after `auto_next_ms` (tap cancels the timer and keeps the feedback). After `almost`, `wrong` or a reveal, wait for Enter or tap.
- The 4-button rating row is collapsed: show a chip with the auto rating and a small "change" control that expands the 4 buttons. No rating click is required.
- Header chips Easy / Medium / Hard switch `difficulty` immediately (`putSettings`, debounced).
- **Sentence basket**: hard-mode sentence answers are stored in `localStorage['sentence_basket']` as `[{card_id, source (example_translation), answer, reference (example), added_at}]`, one entry per card, at most 12 (oldest dropped), entries older than 3 days dropped. The end-of-session screen shows "Проверить N предложений (1 запрос ИИ)". The button calls `checkBatch({kind:'basket', items})`; on success the basket is cleared and the result is shown with `renderBatchResult` (M10 `ui/batch_result.js`); on failure the basket is kept. Nothing is checked automatically. The v1 `sentence` micro-task stays an immediate single check (one call per day at most).

### 1.5 AI provider choice (M3, M5)
- `GET /api/ai/providers` -> `{chain:[{name, available:bool, models:{strong, fast}}], default_generate}`; `available` = key and model are set.
- `POST /api/ai/generate-words` adds optional `provider:'auto'|<name>` (default = setting `ai_provider_generate`) and `level:'B1'|'B2'|'C1'` (default 'B2', passed to the prompt as the target difficulty of words). The user observed that Groq returns harder words than Gemini, so the UI exposes both selects. With topic `Redemittel` the prompt asks for useful B2 set phrases and connectors (opinion, concession, contrast, formal letters) instead of single words.
- `chatJSON` gets `preferProvider` (tried first, then the normal chain) and `strictProvider` (no fallback; 503 `AI_UNAVAILABLE` if it fails). `generate-words` uses `preferProvider` unless the body has `strict:true`.
- `staging_cards.provider` stores the provider that produced each card; StagingCard JSON gains `provider`; the staging UI shows it as a badge and remembers the last selection via `putSettings({ai_provider_generate})`.
- Daily caps become generic: cap for feature F = env `AI_DAILY_CAP_<F uppercased>`, default 100 when unset. Features: correct, generate, enrich, text, translate, speak, write, lookup.
- On HTTP 429 with a `Retry-After` header of 15 s or less, wait once and retry the same provider before falling back.

## 2. New tables (`db/schema_v2.sql`, M7, idempotent, utf8mb4, InnoDB; copy verbatim)
```sql
CREATE TABLE IF NOT EXISTS texts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('reading','listening','dialogue') NOT NULL,
  title VARCHAR(200) NOT NULL,
  body LONGTEXT NOT NULL,
  speakers LONGTEXT NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NOT NULL DEFAULT 'Sonstiges',
  source ENUM('ai','pasted') NOT NULL DEFAULT 'ai',
  target_card_ids LONGTEXT NULL,
  questions LONGTEXT NULL,
  word_count INT NOT NULL DEFAULT 0,
  provider VARCHAR(30) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_kind (kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS text_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  text_id INT NOT NULL,
  mode ENUM('read','listen','dictation') NOT NULL,
  answers LONGTEXT NULL,
  correct INT NOT NULL DEFAULT 0,
  total INT NOT NULL DEFAULT 0,
  plays_used TINYINT NOT NULL DEFAULT 0,
  seconds INT NOT NULL DEFAULT 0,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_text (text_id), KEY idx_day (local_day),
  CONSTRAINT fk_att_text FOREIGN KEY (text_id) REFERENCES texts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS translation_sets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('ru_de','de_ru','transform','basket') NOT NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  topic VARCHAR(50) NULL,
  focus VARCHAR(50) NULL,
  items LONGTEXT NOT NULL,
  target_card_ids LONGTEXT NULL,
  provider VARCHAR(30) NULL,
  answers LONGTEXT NULL,
  result LONGTEXT NULL,
  score TINYINT NULL,
  local_day DATE NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_at DATETIME NULL,
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS writing_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_type VARCHAR(30) NOT NULL,
  topic VARCHAR(80) NULL,
  level ENUM('B1','B2','C1') NOT NULL DEFAULT 'B2',
  prompt_ru TEXT NULL,
  prompt_de TEXT NULL,
  key_points LONGTEXT NULL,
  model_text LONGTEXT NULL,
  hint_card_ids LONGTEXT NULL,
  min_words INT NULL,
  provider VARCHAR(30) NULL,
  attempt_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS writing_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  task_id INT NULL,
  task_type VARCHAR(30) NOT NULL,
  prompt TEXT NOT NULL,
  text TEXT NOT NULL,
  words INT NOT NULL DEFAULT 0,
  seconds INT NOT NULL DEFAULT 0,
  result LONGTEXT NULL,
  score TINYINT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS speaking_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('shadow','free') NOT NULL,
  prompt TEXT NOT NULL,
  expected TEXT NULL,
  transcript TEXT NOT NULL,
  engine VARCHAR(20) NOT NULL,
  duration_s INT NOT NULL DEFAULT 0,
  result LONGTEXT NULL,
  score TINYINT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS number_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  category ENUM('cardinal','year','date','time','price','phone','percent','decimal') NOT NULL,
  level TINYINT NOT NULL DEFAULT 1,
  expected VARCHAR(60) NOT NULL,
  answer VARCHAR(60) NOT NULL,
  correct TINYINT(1) NOT NULL,
  pattern VARCHAR(30) NULL,
  response_ms INT NULL,
  plays TINYINT NOT NULL DEFAULT 1,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_day (local_day), KEY idx_cat (category, local_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS exam_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  taken_on DATE NOT NULL,
  skill ENUM('lesen','hoeren','schreiben','sprechen','gesamt') NOT NULL,
  points DECIMAL(5,1) NOT NULL,
  max_points DECIMAL(5,1) NOT NULL DEFAULT 100,
  source VARCHAR(100) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_taken (taken_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activities (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('reading','listening','dictation_text','numbers','translation','speaking','writing','lookup') NOT NULL,
  ref_id INT NULL,
  seconds INT NOT NULL DEFAULT 0,
  score TINYINT NULL,
  local_day DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_day_kind (local_day, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```
Skill mapping used by plan and stats: reading -> lesen; listening, dictation_text, numbers -> hoeren; speaking -> sprechen; writing, translation -> schreiben; card reviews -> vocab (dictation-mode reviews also feed the hoeren accuracy figure). `server/activities.js` (M7) exports `logActivity({kind, refId, seconds, score}, db?)`; every attempt route calls it.

## 3. Shared shapes
- **Question** `{id:'q1', type:'tf'|'mc', text, options:string[], answer:int, explanation_ru, evidence}`: tf options are exactly `['Richtig','Falsch']`; mc has exactly 3 options; `answer` is the index of the single correct option; `evidence` is an exact substring of the text body (the server verifies and drops questions where it is not).
- **TextItem** `{id, kind, title, body, speakers:[{name}]|null, level, topic, source, target_card_ids:int[], questions:Question[], word_count, provider, created_at}`. Dialogue `body` is lines `Name: text` separated by newlines.
- **LookupResult** `{word, lemma, article, plural, pos, translation_ru, example, example_ru, in_cards: Card|null}`.
- **ErrorItem** `{category, original, fix, explanation_ru}`; `category` from `ERROR_CATEGORIES`.
- **BatchResult** `{id, score:0..100, items:[{idx, answered:bool, is_acceptable:bool, score:0..100, corrected, model_translation, errors:ErrorItem[], used_target_words:[card_id], comment_ru}], summary:{patterns:[{category, count, tip_ru}], strengths_ru:[], focus_ru:[] (max 3 things to practise next), words_to_review:[card_id], overall_ru}}`. `summary.patterns[].count` and `words_to_review` are computed in CODE from the item errors and `used_target_words`, never trusted from the AI. `tip_ru` and `focus_ru` come from the AI (one extra field in the same call). Unanswered items: `answered:false`, score 0, no AI judgement.
- **RetellResult** `{id, score:0..100, criteria:{content,coherence,vocabulary,grammar} (each 0..5), key_points:[{text_ru, conveyed:bool, comment_ru}], errors:ErrorItem[], corrected_text, model_text, improvements_ru:[] (max 3), words:int}`. Internal scale, not the official Goethe scale.
- **WritingResult** (free Schreiben tasks) `{score:0..100, criteria:{task,coherence,vocabulary,grammar} (each 0..5), errors:ErrorItem[], corrected_text, improvements_ru:[]}`.
- **SpeakingResult** `{score:0..100, criteria:{content,vocabulary,grammar,coherence} (each 0..5), strengths_ru:[], improvements_ru:[], used_target_words:[card_id], corrected_sample, diff?, note_ru}`. For `shadow` the score and `diff` come from `gradeSentence` without AI. `note_ru` always states that pronunciation is not assessed because evaluation uses the transcript.
- **NumberItem** `{category, level:1..4, spoken, expected, informal:bool, hint_ru, trap_ru:string|null}`; `spoken` is the German text for TTS written in words; `expected` is canonical: cardinal digits only (`1250`), year `1989`, date `DD.MM.YYYY`, time `HH:MM` 24h, price `12,50`, phone digits only, percent `30` or `2,5`, decimal `3,5`.
- **ExamItem** `{id, taken_on, skill, points, max_points, pct, source, note}`.
- **PlanItem** `{id, kind:'cards'|'listening'|'dictation_text'|'numbers'|'reading'|'speaking'|'translation'|'retell'|'writing', title, minutes, route, params:{}, done:bool, reason_ru}`.

## 4. API v2 (all under `/api`, JSON, same auth and error format as v1)

### 4.1 Texts, plan, skills, exam (M7: `server/routes/texts.js`, `plan.js`, `skills.js`, `exam.js`)
- `GET /texts?kind=&limit=&offset=` -> `{items:TextItem[], total}`; `GET /texts/:id` -> TextItem; `POST /texts {kind, title, body(50..20000), level?, topic?}` (pasted text, `source:'pasted'`, `questions:[]`, word_count computed) -> TextItem; `DELETE /texts/:id` -> 204; `POST /texts/:id/attempts {mode:'read'|'listen'|'dictation', answers?:(int|null)[], plays_used?, seconds, correct?, total?}` -> `{id, correct, total}` (for read/listen the server computes correct/total from `questions`; for dictation the client sends them); logs an activity (read -> reading, listen -> listening, dictation -> dictation_text).
- `GET /plan/today` -> `{date, minutes_target, done_minutes, items:PlanItem[]}`.
- `GET /skills/summary` -> `{by_skill:{hoeren,lesen,sprechen,schreiben,wortschatz: {minutes_7d, minutes_30d, accuracy_30d (0..1|null), trend:'up'|'flat'|'down'|null}}, numbers:{accuracy_30d}, activity_days_30:[{day, minutes, kinds:[]}], error_categories_30d:{category:count}, weakest}`. `error_categories_30d` aggregates ErrorItems found in `sentences.errors`, `translation_sets.result` and `writing_attempts.result` (parse defensively, ignore broken JSON).
- `GET /exam` -> `{exam_date, days_left:int|null, items:ExamItem[], latest_by_skill:{skill:{pct, taken_on}}, pass_pct:60}`; `POST /exam {taken_on, skill, points, max_points=100, source?, note?}` -> ExamItem; `DELETE /exam/:id` -> 204. `pass_pct` is a constant shown as a reference line (the UI says "проверь актуальные правила на сайте Goethe-Institut").
- **Plan algorithm (deterministic, unit-tested)**: normalize the five weights; deficit(skill) = weight share minus actual minutes share over the last 7 days (activities plus review seconds from `daily_stats`); item minutes defaults: cards 8, listening 7, dictation_text 5, numbers 5, reading 6, speaking 5, translation 8, retell 12, writing 10 (only if none in the last 7 days and `weight_schreiben` > 0); always put `cards` first when there are due or new cards; then add items by descending deficit until `plan_minutes` is reached (at most 5 items); skill -> kind: hoeren -> rotate listening, numbers, dictation_text (the least recently done first); lesen -> reading; sprechen -> speaking; schreiben -> alternate translation and retell (writing when due). `done` = an activity of that kind exists today (cards: today's review count >= min(due+new, 10)). `route`/`params`: listening and reading point to an unattempted saved text of that kind if one exists (`#/listen/<id>`, `#/text/<id>`), otherwise to a generation screen (`#/listen`, `#/texts?new=1`); numbers `#/numbers`; speaking `#/speak`; translation `#/translate`; retell `#/retell`; writing `#/write`; cards `#/review`. Cache nothing; compute per request.

### 4.2 AI texts, lookup, staging helpers (M8a: `server/routes/aitexts.js`, `lookup.js`)
- `POST /ai/generate-text {kind, topic(1..60), level='B2', length:'short'|'medium'|'long' (about 120/220/350 words), question_count=5 (3..8), use_due_words=true, provider?}` -> TextItem (saved). Target words: up to 8 cards that are due or lapsed (fallback: most recently added); the prompt requires them to appear naturally; after generation the server checks which target terms (or `cloze_answer` forms) occur in the body and stores only those in `target_card_ids`. Question validation: tf/mc shape, one correct option, `evidence` substring present; drop invalid ones; fewer than 3 valid -> one regeneration of the questions only, then 502 `AI_BAD_OUTPUT`. Dialogue: 2-3 speakers, `speakers` filled, body as `Name: text` lines. Tier strong, feature `text`.
- `POST /ai/analyze-text {text_id}` -> `{level_estimate, summary_ru, coverage_pct, unknown_words:LookupResult[] (max 30), staged:int}`. `coverage_pct` is computed in code (share of word tokens found among known forms: card terms, plurals, cloze answers, a small stopword list in `shared/stopwords.js`), approximate by design. One AI call (fast tier, feature `lookup`) turns the most frequent unknown words (not in cards, 4+ letters) into LookupResults; they are inserted into `staging_cards` (dedupe against cards and staging).
- `POST /lookup {word(1..60), context?(<=200)}` -> LookupResult. Order: exact card match by `normalizeKey` (also matches stored plurals and cloze answers) -> else one AI call (fast tier, feature `lookup`, cached 30 days). Never adds anything by itself.
- `POST /staging/from-lookup {word, lemma, article?, plural?, pos, translation_ru, example?, example_ru?, topic?, level?}` -> StagingCard (dedupe -> 409 with `existing_id`). `POST /staging/bulk {items:[...same shape]}` -> `{added, duplicates}`.
- **Errors to cards (no AI)**: `POST /staging/from-errors {items:[{category, original, fix, explanation_ru, sentence?}] (1..10)}` -> `{added, duplicates}`. Each item becomes a staging card: `term` = `fix` (max 255), `pos` 'phrase', `translation` = `explanation_ru` (max 500), `example` = `sentence` if given, `topic` 'Sonstiges', `batch_id` = `errors-YYYYMMDD`, dedupe by `normalizeKey`. The user still accepts or rejects them in the staging screen.

### 4.3 Translation batches, transform drills, retell (M8b: `server/routes/translate.js`, `retell.js`)
- `POST /translate/set {kind:'ru_de'|'de_ru'|'transform', count=5 (3..10), level='B2', topic?, focus?, card_ids?:int[<=8], provider?}` -> `{id, kind, items:[{idx, source_text, instruction_ru?, hint_words:[{card_id, display}]}]}`. One AI call (fast tier, feature `translate`). `ru_de`: a natural Russian sentence (12-25 words) that needs the meaning of one target card; `de_ru`: German source; `transform` (Satzbau): a German sentence or two plus `instruction_ru` for one B2 structure, `focus` one of `nebensatz` (weil/obwohl/dass/damit/indem/während/sodass), `passiv`, `konjunktiv2`, `relativsatz`, `nominalisierung`, `indirekte_rede`, `konnektoren` (default: mix). The AI also returns a hidden `reference` per item; it is stored in `items` but NOT sent to the client until the set is checked. Without `card_ids` the server picks up to 3 due or lapsed cards.
- `POST /translate/set/:id/check {answers:[{idx, answer(0..600)}]}` -> BatchResult. One AI call per chunk of up to 6 items (strong tier, feature `translate`, chunks sequential, merged by code). Empty answers are `answered:false`. A set can be checked once (409 afterwards). Saves answers, result, score, `local_day`; logs activity `translation` with the seconds the client sends in header `X-Seconds` (optional). The prompt states: alternative correct translations are valid, judge meaning, grammar and vocabulary, never penalize deviation from `reference`.
- `POST /ai/check-batch {kind:'basket', items:[{idx, source(1..400), answer(1..600), reference?(<=600), card_id?}] (1..12)}` -> BatchResult. Creates a `translation_sets` row (kind 'basket') and uses the same internal `checkBatch()` as above.
- `GET /translate/sets?limit=20` -> `{items:[{id, kind, score, n, created_at, checked_at}]}`; `GET /translate/sets/:id` -> `{id, kind, items (with reference only if checked), answers, result}`.
- **Retell (Schreiben: Russian text -> German text)**: `POST /retell/task {topic?:string|'random', level='B2', sentences=7 (5..10), use_due_words=false, provider?}` -> `{id, topic, level, prompt_ru, hint_words:[{card_id, display}] (empty unless use_due_words), min_words}`. One AI call (fast tier, feature `write`): a coherent Russian text of exactly the requested number of sentences about the topic at the chosen level (level controls the complexity of ideas and structures), plus hidden `key_points` (3-6 short Russian statements) and a hidden German `model_text`; both stored in `writing_tasks`, not returned. `'random'` picks a topic from a server list covering typical B2 themes (Arbeit und Bewerbung, Wohnen, Umwelt, Medien und Social Media, Gesundheit, Bildung, Reisen, Konsum und Werbung, Integration und Gesellschaft, Technik, Freizeit, Familie, Stadt und Land). `min_words` = about 12 per sentence.
- `POST /retell/evaluate {task_id, text(30..3000), seconds?}` -> RetellResult. One AI call (strong tier, feature `write`); the task can be evaluated once (409 afterwards). The prompt: the user was asked to convey the main meaning (not a literal translation); check each key point (conveyed or not), then coherence (connectors, structure), vocabulary range and grammar; return minimal corrections of the user's own text in `corrected_text`; reveal `model_text`. Saves a `writing_attempts` row (`task_type:'retell'`, `prompt` = the Russian text), links `writing_tasks.attempt_id`, logs activity `writing`.

### 4.4 Speaking and free writing (M8c: `server/routes/speaking.js`, `writing.js`)
- `POST /speaking/transcribe` raw audio body (`express.raw` mounted only on this route, `audio/webm|audio/mp4|audio/ogg|audio/wav`, max 10 MB, header `X-Duration-S`) -> `{transcript, engine:'whisper', duration_s}`. Server sends it to Groq `POST https://api.groq.com/openai/v1/audio/transcriptions` as multipart `FormData` with model from `GROQ_MODEL_STT`, `language=de`; errors map to `AI_UNAVAILABLE`. Feature `speak`, counted in `ai_usage`.
- `POST /speaking/prompt {kind:'shadow'|'free', topic?, level='B2'}` -> `{kind, prompt_ru, prompt_de, expected:string|null, target_card_ids, time_limit_s}`. `shadow`: expected = 1-3 example sentences of due cards (no AI call); `free`: one AI call (fast tier) returning a B2 speaking task (a short talk with an introduction and an opinion, or a pro/contra discussion) with 3 useful target words, `time_limit_s` 120.
- `POST /speaking/evaluate {kind, prompt, expected?, transcript(0..4000), duration_s, engine, target_card_ids?}` -> SpeakingResult. `shadow`: no AI, uses `gradeSentence`; `free`: strong tier, feature `speak`. Saves a `speaking_attempts` row and logs activity `speaking`. Empty transcript -> 400 with a Russian message.
- `POST /writing/task {type:'forum'|'letter_formal'|'letter_informal'|'opinion', topic?}` -> `{id, type, prompt_de, bullets_de:[], min_words}` (fast tier, feature `write`; saved in `writing_tasks`). `POST /writing/evaluate {task_id, text(30..3000), seconds?}` -> WritingResult (strong tier, feature `write`; once per task; saved; activity `writing`). The prompts follow Goethe-style tasks (a forum post with an opinion, a formal letter or e-mail); the user is told to check the current exam format on the official site.

### 4.5 Numbers (M13: `shared/numbers_de.js`, `server/routes/numbers.js`; NO AI)
- `shared/numbers_de.js` (pure ESM, no DOM/Node APIs) exports: `CATEGORIES`, `MAX_LEVEL = 4`, `makeRng(seed)`, `numberToGerman(n)` (integers 0..999999999; standalone forms: 1 `eins`, 100 `einhundert`, 1000 `eintausend`, 1000000 `eine Million`, 2000000 `zwei Millionen`; no "und" after hundreds; `einundzwanzig`), `yearToGerman(y)` (1100-1999 as hundreds: 1989 `neunzehnhundertneunundachtzig`; 2000+ `zweitausendvierundzwanzig`), `ordinalToGerman(n, form)` (`der fünfzehnte`, `am fünfzehnten`), `dateToGerman(d, m, y, {form})`, `timeToGerman(h, m, {style:'formal'|'informal'})` (formal `fünfzehn Uhr dreißig`; informal `Viertel nach drei`, `halb vier` = 3:30, `fünf vor halb vier` = 3:25, `Viertel vor vier` = 3:45), `priceToGerman(euros, cents)` (`zwölf Euro fünfzig`), `phoneToGerman(digits, {grouping:'single'|'pairs', zwo:bool})`, `percentToGerman(str)` (`zwei Komma fünf Prozent`), `decimalToGerman(str)`, `generateItem(category, level, rng) -> NumberItem`, `normalizeNumberAnswer(category, text) -> string|null`, `gradeNumber(item, answer) -> {correct, normalized, note_ru, pattern|null}`, `pickCategory(statsByCategory, rng)` (categories with accuracy under 70% are twice as likely), `nextLevel(level, recentResults)` (up after 8 of the last 10 correct, down after 4 or fewer, within 1..MAX_LEVEL).
- Levels: cardinal 1 = 0-20, 2 = up to 100, 3 = up to 1000, 4 = up to 1000000 (also quantities); year 1900-2099 (level 3-4 adds 1100-1899); date level 2 = day and month, 3 = with year, 4 = with "am"/"der" forms and ordinals; time level 1-2 formal, 3-4 informal (`halb`, `Viertel`); price up to 999,99; phone 3-4 groups of digits in pairs or singles (both `zwei` and `zwo`); percent integers then halves and tenths; decimal numbers like `drei Komma fünf` and simple fractions (`ein Viertel` accepts `1/4` or `0,25`).
- Grading accepts thousands separators (`.`, space, `'`), decimal comma or point, `15:30` / `15.30` / `1530`, dates `D.M.`, `DD.MM.`, `DD.MM.YYYY`, phone digits with spaces, dashes, slashes or `+`, ordinals with or without a trailing dot, percent with or without `%`. Informal times are ambiguous between morning and afternoon: accept the same minutes and hour modulo 12 when `item.informal`. `pattern` tags for statistics: `tens_units_swap` (25 vs 52), `teen_ty` (16 vs 60, 13 vs 30), `digit_drop`, `digit_swap`, `magnitude` (wrong number of zeros), `ampm`, `halb_trap` (halb vier read as 4:30), `other`. `note_ru` explains the mistake in Russian and states the spoken form.
- Tests (M13, `tests/numbers.test.js`) must assert at least: 21 `einundzwanzig`; 101 `einhunderteins`; 1001 `eintausendeins`; 16 `sechzehn` vs 60 `sechzig`; 17 `siebzehn` vs 70 `siebzig`; 1989 `neunzehnhundertneunundachtzig`; 2024 `zweitausendvierundzwanzig`; 1000000 `eine Million`; 15:30 formal `fünfzehn Uhr dreißig`; 15:30 informal `halb vier`; 15:15 `Viertel nach drei`; 12,50 `zwölf Euro fünfzig`; 2,5 percent `zwei Komma fünf Prozent`; grading of `1.250`, `1 250`, `1250`; `12.50` vs `12,50`; `3.30` for time; deterministic generation with a fixed seed.
- `POST /numbers/attempts {items:[{category, level, expected, answer, correct, response_ms?, plays?, pattern?}] (1..50), seconds}` -> `{saved, correct, total}` (the server re-grades nothing, it stores; logs one activity `numbers`). `GET /numbers/stats` -> `{by_category:{category:{n, accuracy_30d, avg_ms}}, patterns:[{pattern, count}] (30 days), recent:[{day, n, accuracy}]}`.

## 5. AI prompt rules (M8a, M8b, M8c; text files in `server/ai/prompts/`)
New prompt files: `text_reading.txt`, `text_listening.txt`, `analyze_text.txt`, `lookup.txt`, `translate_set.txt`, `transform_set.txt`, `check_batch.txt`, `retell_task.txt`, `retell_eval.txt`, `speaking_prompt.txt`, `speaking_eval.txt`, `writing_task.txt`, `writing_eval.txt`. All reply with JSON validated by zod schemas in `server/ai/schemas_v2.js` (M8a), `schemas_v2b.js` (M8b), `schemas_v2c.js` (M8c). Common rules: natural B2 German without meta commentary; explanations for the learner in Russian, 1-2 sentences each; do not over-correct style; if input is not German say so in the schema's feedback field; scores are integers; criteria are integers 0..5; the AI never counts or aggregates (code does). Evaluation prompts get the answers wrapped in delimiters and are told they are data. Listening texts must be written for the ear (short sentences, spoken connectors, no lists or headings, numbers written out). A chunk prompt for `check_batch` lists items by `idx` and must return exactly one result per `idx`; the server verifies and re-asks once for missing indices.

## 6. Frontend v2
- Routes added to the shell: `#/plan` (the Today screen shows the plan list above the "Start cards" button), `#/texts` (list and generate form), `#/text/:id` (reader), `#/listen` (list and generate), `#/listen/:id` (player), `#/lab` (paste a text and analyze), `#/translate` (sets, transform drills, history), `#/retell`, `#/numbers`, `#/speak`, `#/write`, `#/skills` (statistics plus exam countdown and log). Bottom tab bar: Today, Words, Practice (menu: texts, listening, numbers, translate, retell, speak, write, lab), Stats, More (settings).
- `public/js/api2.js` (M12) exports one function per v2 endpoint with the same conventions as `api.js` (own small `request()` helper, throws `ApiError {status, code, message}`): `getPlan, getSkills, getExam, postExam, deleteExam, listTexts, getText, createText, deleteText, postTextAttempt, generateText, analyzeText, lookupWord, stagingFromLookup, stagingBulk, stagingFromErrors, translateSet, translateSetCheck(id, answers, seconds), translateSets, translateSetGet, checkBatch, retellTask, retellEvaluate, speakingTranscribe(blob, durationS), speakingPrompt, speakingEvaluate, writingTask, writingEvaluate, numbersPostAttempts, numbersStats, getAiProviders`.
- Shared UI files and owners: `public/js/ui/lookup.js` (M10) exports `openLookup(word, context)`, a bottom sheet with article/plural/translation/example, a TTS button and "Add to my words" (`stagingFromLookup`) or "Already in cards"; `public/js/ui/batch_result.js` (M10) exports `renderBatchResult(container, result, {sources?})` (per-item cards with the user's answer, correction, model translation, errors, comment; summary block with score, error patterns, focus advice, words to review as links, and a "В карточки" action for errors); `public/js/ui/error_list.js` (M15) exports `renderErrors(container, errors, {sentence?})` with a per-error "В карточку" button (`stagingFromErrors`), used by M10 and M15; `public/js/ui/quiz.js` (M9) exports `mountQuiz(container, questions, {revealAfter:'each'|'end'}) -> Promise<{answers, correct, total}>`; `public/js/tts_player.js` (M9): `playText(text, {rate, onProgress})`, `playDialogue(lines:[{speaker,text}], {rate, onLine})`, `stop()`, `canPlay()` (a different German voice per speaker if at least two exist, otherwise one voice with different pitch; the view enforces the plays counter); `public/js/stt.js` and `recorder.js` (M11): `createStt(engine)` returns `{start(), stop() -> Promise<{transcript, duration_s, engine}>, supported}` (engine `browser` = `SpeechRecognition` `de-DE` with interim results; engine `whisper` = `MediaRecorder` plus `speakingTranscribe`; if unsupported offer the other; audio is never stored).
- Listening flow (M9): the text is hidden; plays limited by `listening_plays` (a "training" toggle allows unlimited); rate control 0.8-1.1; after the quiz show the transcript with tappable words (`openLookup`), then offer sentence-by-sentence dictation (`gradeSentence` diff, summary accuracy -> attempt with `mode:'dictation'`). Reading flow: text visible, tappable words, questions below, optional timer, attempt saved with seconds.
- Translate flow (M10): choose kind/count/level/topic, answer all sentences one after another (previous/next, progress bar, draft autosaved in `localStorage` per set id, no feedback in between), one "Проверить всё" button -> loading -> `renderBatchResult`; history list of past sets with scores. Transform sets show `instruction_ru`.
- Retell flow (M15): setup (topic or "random", level B1/B2/C1, 5-10 sentences, show hint words toggle), writing screen (Russian text on top, textarea, word counter against `min_words`, timer, autosave draft), "Завершить и проверить" -> `retellEvaluate` -> result screen (score, 4 criteria bars, key points checklist, word-level diff of the user text vs `corrected_text`, `renderErrors`, model text toggle). Free writing (`write.js`): task type select, same screen layout, `writingEvaluate`.
- Numbers flow (M14): setup (category or mixed, level auto or 1-4, 10 items), big play button speaking `item.spoken` via `speak` at the rate allowed by difficulty (easy: unlimited plays and rate 0.8 available; medium: 2 plays; hard: 1 play), numeric keyboard (`inputmode` decimal or tel by category), Enter submits, feedback shows expected vs typed, the spoken words (to learn the pattern), the `note_ru` and a replay button; session summary with accuracy by category and top error patterns; attempts posted with `numbersPostAttempts`; `pickCategory` and `nextLevel` drive the session; no AI calls anywhere.
- Exam widget (M12, on `#/skills`): exam date picker (setting `exam_date`), days left, latest result per skill with a 60% reference line, a small form to log a practice test result, list with delete.
- Design rules as v1 (mobile-first, 44 px targets, light/dark, no external resources, Russian UI). Every AI call shows a loading state and handles 429/503 with a clear Russian message while preserving what the user typed.
- Service worker: same-origin GET of `/js/`, `/css/`, `/shared/` uses stale-while-revalidate (no fixed file list), `/api` stays network-only, cache version bumped.

## 7. Files and task cards
**Patch tasks** (each returns complete changed files plus a NOTES.md "v2 changes" section; budget in lines in brackets):
- **P1 (M1)** [~350]: settings keys (1.1), `server/migrate.js` + `server/migrations/001_staging_provider.js`, `db/schema.sql` update, `server/index.js` calls migrate, `.env.example`, tests for migrations and settings validation.
- **P2 (M2)** [~450]: `shared/hints.js` (new), `shared/grading.js` (`gradeSentence`, `autoRating` with difficulty), `shared/constants.js` (`TOPICS` + 'Redemittel'), `choices` in `buildQueue`/`session.js`, `tests/{hints,grading,queue}.test.js`.
- **P3 (M3)** [~450]: section 1.5 in full (`chatJSON` options, generic caps, Retry-After, `GET /ai/providers`, `generate-words` provider and level, 'Redemittel' prompt branch, staging provider column in queries and JSON), tests.
- **P4 (M4)** [~750]: difficulty-aware `review.js` (learn auto-advance, Enter flow, auto-next, collapsed rating, difficulty chips, hint ladder UI, hard two-step ru_de with the sentence basket and the end-of-session "check" card using `checkBatch` and `renderBatchResult`), `modes/{ru_de,cloze,article}.js` for all three difficulties, `choices` rendering.
- **P5 (M5)** [~350]: `modes/dictation.js` difficulty rules, `views/staging.js` provider and level selects with badges and remembered choice (`getAiProviders`, `generateWords`), keeps `sentence.js` working with the new runner.

**New modules** (any order; they code against names in this document):
- **M7 Backend v2 core** [~700]: `db/schema_v2.sql`, `server/activities.js`, `server/routes/{texts,plan,skills,exam}.js`, `tests/plan.test.js` (allocation with fixed activity sets, deficit logic, skill mapping, rotation), `tests/texts.test.js` (correct count computation), `tests/exam.test.js` (days_left, pct).
- **M8a AI texts and lookup** [~700]: `server/ai/schemas_v2.js`, prompts `text_reading.txt`, `text_listening.txt`, `analyze_text.txt`, `lookup.txt`, `server/ai/textgen.js`, `server/routes/{aitexts,lookup}.js` (including `/staging/from-lookup`, `/staging/bulk`, `/staging/from-errors`), `shared/stopwords.js`, `tests/aitexts.test.js`.
- **M8b Translation batches and retell** [~750]: `server/ai/schemas_v2b.js`, prompts `translate_set.txt`, `transform_set.txt`, `check_batch.txt`, `retell_task.txt`, `retell_eval.txt`, `server/ai/batchcheck.js` (`checkBatch(items, ctx)` with chunking by 6, merge, code-side aggregation of patterns and words_to_review, missing-index re-ask), `server/routes/{translate,retell}.js`, `tests/batch.test.js` (chunking, merging, aggregation, unanswered items, 409 on second check, mocked AI).
- **M8c Speaking and free writing** [~600]: `server/ai/schemas_v2c.js`, prompts `speaking_prompt.txt`, `speaking_eval.txt`, `writing_task.txt`, `writing_eval.txt`, `server/routes/{speaking,writing}.js`, `tests/speaking.test.js` (mocked AI and mocked Whisper fetch, shadow evaluation without AI).
- **M9 Lesen and Hören UI** [~800]: `views/{texts,reader,listen,lab}.js`, `ui/quiz.js`, `tts_player.js`.
- **M10 Translation UI and lookup** [~700]: `views/translate.js`, `ui/lookup.js`, `ui/batch_result.js`.
- **M11 Speaking UI** [~500]: `views/speak.js`, `stt.js`, `recorder.js`.
- **M12 Shell, plan, skills, exam, settings** [~850]: receives the current `app.js`, `views/today.js`, `views/settings.js`, `sw.js` and returns them complete (routes and tab bar, plan list on Today, settings section for all new keys with provider/STT/difficulty/exam date/numbers level controls, stale-while-revalidate worker), plus new `api2.js`, `views/{plan,skills}.js` (including the exam widget).
- **M13 Numbers logic and route** [~700]: `shared/numbers_de.js`, `server/routes/numbers.js`, `tests/numbers.test.js` (section 4.5).
- **M14 Numbers UI** [~450]: `views/numbers.js`.
- **M15 Schreiben UI** [~650]: `views/{retell,write}.js`, `ui/error_list.js`.

**G2 Audit (Gemini)**: same method as the v1 audit, now against v1 plus v2: file inventory, empty files (0 bytes), imports/exports, endpoints and field names, SQL against `schema.sql` plus `schema_v2.sql`, env names, secrets, and the smoke tests below. **I2 Integration (Sonnet thinking)**: fix the audit table, boot against a v1 database that contains data, walk the smoke tests.

**Order**: all modules can be written in parallel; P1-P3 first is preferable for testing; then G2, then I2.

## 8. Smoke tests v2
1. Start on an existing v1 database with data: new tables and column created, no data lost, second start clean.
2. `PUT /settings {difficulty:'hard'}` persists; an invalid value -> 400.
3. Session items for ru_de and cloze carry `choices` (2-4 distinct, correct included).
4. Review: learn screen auto-advances, Enter flow works, correct answers auto-advance, wrong ones wait; difficulty chips change behavior live; hard ru_de asks the sentence and stores it in the basket without judging it.
5. End of a hard session: "Проверить N предложений" -> exactly one AI call per 6 items -> BatchResult with patterns computed in code; basket cleared; on failure basket kept.
6. `generate-words` with `provider:'gemini'` hits Gemini first (visible in `/ai/usage`); `strict:true` with a dead provider -> 503; topic `Redemittel` returns set phrases.
7. `generate-text` returns a TextItem with at least 3 valid questions whose evidence is in the body.
8. Reading attempt: server-computed score, activity logged, plan item turns done.
9. Listening: plays limited by setting, transcript hidden until the quiz ends, dialogue uses distinct voices or pitches, dictation attempt saved.
10. Lookup: a card word returns `in_cards`; an unknown word calls AI once and can be added to staging; duplicates -> 409.
11. Translate set (5 items): generation = 1 AI call, answers collected with no feedback in between, check = 1 AI call, second check -> 409, reference hidden before the check; a transform set renders `instruction_ru`.
12. Retell: task returns only the Russian text (no key points or model text), evaluation returns criteria, key points, corrected text and model text; second evaluation -> 409; activity logged.
13. Errors to cards: "В карточку" creates staging cards, duplicates are skipped, nothing reaches `cards` until accepted.
14. Numbers: 10-item session works with no network except saving; `gradeNumber` accepts the formats of section 4.5; stats show per-category accuracy and patterns; no AI usage rows are created.
15. Speaking: `stt_engine='browser'` works with no server STT; `whisper` returns a transcript for a short clip; shadow evaluation makes no AI call.
16. Exam: set a date, `days_left` correct; log a result, `latest_by_skill` and the 60% line shown.
17. `GET /plan/today` returns at most 5 items summing to `plan_minutes` within 3 minutes; hoeren rotates listening, numbers, dictation_text; changing weights changes the order.
18. `/skills/summary` matches `activities`, `number_attempts` and `review_log` for a seeded day and aggregates `error_categories_30d` from broken and valid JSON without crashing.
19. No secrets and no full user texts in logs; no new dependencies in `package.json`.

## 9. Out of scope (later)
Reminders (web push or a WhatsApp message through the Evolution instance), grammar drills for prepositions and Nomen-Verb-Verbindungen as a scheduled card mode, word families (Wortbildung), a weekly written report, full Goethe mock exams with timers, import of real audio with timestamps, Anki export.
