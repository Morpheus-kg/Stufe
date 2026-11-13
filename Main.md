# German Trainer — Backend Architecture & Technical Guide

Документ описывает серверную часть (бэкенд) проекта **German Trainer**: назначение, архитектуру, стек технологий, схему базы данных, правила изоляции данных, подсистему аутентификации, интеграцию с ИИ, алгоритм интервальных повторений (FSRS), логику работы с карточками, карту API-эндпоинтов и инструкцию по развёртыванию на Railway.

---

## 1. Назначение и контекст проекта

**German Trainer** — специализированное персональное веб-приложение (PWA) для углублённой подготовки к экзамену по немецкому языку **Goethe-Zertifikat B2** (а также уровней B1–C1).

### Основные сценарии и модули:
1. **Лексика и интервальные повторения (FSRS)**: изучение карточек слов в трёх сфокусированных режимах (`ru_de` — прямой перевод, `cloze` — контекстный пропуск в предложении/управлении, `article` — артикли der/die/das для существительных). Устаревший режим диктовки одиночных слов удалён.
2. **Прямое добавление и фоновое обогащение лексики**:
   - Слова добавляются **напрямую в основную колоду `cards`** (из словаря `/api/lookup`, при генерации списков `/api/ai/generate-words` или из анализа ошибок) без промежуточной модерации в Staging.
   - Надёжный фоновый воркер `enrich_worker.js` с защитой от наложения (in-flight lock) и экспоненциальным backoff автоматически обогащает карточки грамматикой, примерами и управлением (Rektion).
3. **Чтение и аудирование (Texts, Reader, Listen, Lab)**:
   - Генерация и импорт текстов и диалогов, интерактивный глоссарий, тестовые вопросы на понимание.
   - **Lesen Teil 2 (Gap-Fill)**: экзаменационный тренажёр восстановления связности текста — вставка предложений с союзами и логическими коннекторами B2 (*deshalb, trotzdem, dennoch*).
   - Двухголосая серверная озвучка диалогов через Microsoft Edge TTS (`de-DE-ConradNeural` и `de-DE-KatjaNeural`) с глобальным аудио-кэшем `tts_cache`.
4. **Продуктивные навыки (Output)**:
   - **Translate (Satzbau)**: перевод предложений RU ↔ DE с фокусом на грамматику. Генератор автоматически подмешивает слабые места пользователя из накопительного профиля ошибок (`user_error_profile`).
   - **Retell**: пересказ русскоязычных текстов на немецком с проверкой ключевых мыслей через ИИ. Ошибки также фиксируются в профиле.
   - **Write**: написание писем и постов на форум в формате экзамена Goethe B2 с экспертной оценкой ИИ по 4 критериям.
   - **Speak**:
     - *Shadowing*: повтор за диктором с локальной аудиозаписью и самоконтролем (без задержек на Whisper).
     - *Free Monologue*: спонтанная речь на экзаменационные темы.
     - *Diskussion (B2)*: интерактивный диалог/дискуссия с ИИ-экзаменатором с отработкой Redemittel.
     - *Gemini Audio Evaluation*: прямая мультимодальная оценка произношения, фонетики и интонации через Gemini Audio.
5. **Числа на слух (Numbers)**: специализированный тренажёр дат, времени, цен, телефонов и дробей с распознаванием типичных ошибок.
6. **Аналитика и дискретный план дня**:
   - Дневной чек-лист конкретных задач (`/api/plan/today`): повторение карточек из очереди FSRS, разбор текста/диалога, перевод предложений (Satzbau) и ротация продуктивных навыков.
   - Радар экзаменационных навыков и аналитика накопленных грамматических ошибок.
7. **Многопользовательская изоляция (Multi-User, CONTRACT v3)**: администрирование пользователей, полная изоляция данных на уровне SQL-запросов (`WHERE user_id = ?`), персональные зашифрованные API-ключи и персональные таймзоны.

---

## 2. Стек технологий бэкенда

- **Среда выполнения**: Node.js (>= 20.x, нативные ES Modules `"type": "module"`).
- **HTTP-фреймворк**: Express 4.x (`express`, `cookie-parser`).
- **СУБД**: MySQL 8.0+ / MariaDB 10.4+ через пул соединений `mysql2/promise`.
- **Алгоритм SRS**: `ts-fsrs` (Free Spaced Repetition Scheduler v5).
- **Озвучка (TTS)**: `msedge-tts` (нейросетевые голоса Microsoft Conrad/Katja) + глобальный кэш `tts_cache` в MySQL.
- **Мультимодальный анализ речи**: Google Gemini Audio API (прямой анализ аудио через `inline_data` и структурированный JSON).
- **Валидация схем**: `zod` для всех входящих HTTP-запросов, параметров и структурированных ответов LLM.
- **Безопасность**:
  - `helmet` (Content Security Policy, безопасные заголовки).
  - Node `crypto` (`scrypt` с индивидуальной солью для паролей, AES-256-GCM для пользовательских ключей API, HMAC-SHA256 для cookie-сессий).
  - In-memory rate limiting для логина и маршрутов ИИ.
- **Тестирование и проверка скоупа**:
  - Нативный тест-раннер `node --test`.
  - `scripts/check_scope.mjs` — статический анализатор изоляции SQL-запросов (`npm run check:scope`).

---

## 3. Архитектура и структура каталогов `server/`

```text
server/
├── index.js              # Точка входа: ожидание БД, миграции, запуск воркера обогащения, роуты, HTTP-сервер
├── config.js             # Конфигурация из переменных окружения (порты, БД, лимиты, TZ)
├── db.js                 # Пул MySQL, помощники query() и tx() (транзакции)
├── auth.js               # Аутентификация, scrypt-хеши, HMAC-токены, requireAuth, requireAdmin
├── cards_service.js      # Единый сервис upsertCards(): пакетная вставка, нормализация ключей, cloze, очередь обогащения
├── crypto_keys.js        # AES-256-GCM шифрование пользовательских API-ключей (HKDF от KEYS_SECRET)
├── keys.js               # Нормализация dedupe_key (по pos, артиклям, отделяемым приставкам)
├── error_profile.js      # Накопление и получение профиля типичных ошибок пользователя (user_error_profile)
├── tts_service.js        # Двухголосая озвучка диалогов через Edge TTS с кэшированием в таблице tts_cache
├── errors.js             # Класс ApiError, стандартный формат ответа { error: { code, message, extra } }
├── migrate.js            # Движок миграций (GET_LOCK, schema.sql, schema_v2.sql, migrations/001-010)
├── time.js               # Работа со временем: персональные таймзоны (req.tz), getUserTz, граница суток (04:00)
├── settings.js           # Чтение/запись настроек пользователя в таблицу settings
├── activities.js         # Фиксация активности по навыкам (таблица activities)
├── srs/
│   ├── engine.js         # Интеграция с ts-fsrs: пересчёт stability, difficulty, state, due
│   └── queue.js          # Сборка очереди FSRS (due + ladder + new), ротация примеров cloze, noun-only article, sibling burying
├── workers/
│   └── enrich_worker.js  # Фоновый воркер обогащения карточек (in-flight lock, exponential backoff)
├── ai/
│   ├── llm.js            # Ядро LLM: fallback-цепочка, chatAudioJSON, hardened ai_cache (schema+tier), квоты
│   ├── providers.js      # Адаптеры провайдеров (Gemini, Groq, OpenRouter)
│   ├── batchcheck.js     # Проверка пакетов предложений (translate / transform / basket)
│   ├── textgen.js        # Генерация и анализ текстов (чтение, диалоги, вопросы, глоссарий, gaps)
│   ├── enrich.js         # Обогащение карточек: примеры, Rektion, формы множественного числа
│   ├── schemas.js        # Zod-схемы валидации ответов LLM (enrich, correct, generate)
│   ├── schemas_v2.js     # Zod-схемы текстов, глоссария, анализа и словаря
│   ├── schemas_v2b.js    # Zod-схемы пакетного перевода и пересказа
│   ├── schemas_v2c.js    # Zod-схемы речи, письма, аудио-оценки и дискуссии B2
│   └── prompts/          # Текстовые шаблоны системных и пользовательских промптов
├── migrations/           # Идемпотентные миграции:
│   ├── 001_staging_provider.js
│   ├── 002_users.js
│   ├── 003_multiuser.js
│   ├── 004_text_glossary.js
│   ├── 005_srs_cleanup.js           # Удаление dictation, чистка article, cards.source_batch, перенос pending
│   ├── 006_enrich_queue.js          # cards.enrich_attempts, cards.enrich_next_at
│   ├── 007_cards_rektion_examples.js # cards.examples_json, cards.rektion, review_log.variant
│   ├── 008_speaking_discussion.js   # speaking_sessions, speaking_attempts.kind = 'discussion'
│   ├── 009_error_profile.js         # user_error_profile (накопление слабых грамматических тем)
│   └── 010_tts_cache.js             # глобальная таблица tts_cache (кэш озвучки)
└── routes/               # Express-роуты:
    ├── auth.js           # POST /api/auth/login, POST /api/auth/logout
    ├── me.js             # GET /api/me (с отдачей tz), PUT /api/me/password, ключи API
    ├── admin.js          # Управление пользователями, статистика использования ИИ
    ├── ai.js             # Генерация слов, проверка предложений, статус провайдеров
    ├── cards.js          # CRUD карточек, /from-lookup, /from-errors, /bulk, /undo-batch, /:id/learned
    ├── session.js        # GET /api/session/today (очередь FSRS с sibling burying и ротацией примеров)
    ├── reviews.js        # POST /api/reviews (приём ответов FSRS, gentle due shift для ru_de)
    ├── texts.js          # Тексты, вопросы, попытки, POST /api/texts/:id/gaps (Lesen Teil 2)
    ├── aitexts.js        # Генерация и анализ текстов через LLM
    ├── translate.js      # Перевод предложений (Satzbau) с инъекцией ошибок из user_error_profile
    ├── writing.js        # Письменные задания Goethe B2 и оценка ИИ
    ├── retell.js         # Пересказ текстов с фиксацией грамматических ошибок
    ├── speaking.js       # Говорение: shadow, free, evaluate-audio (Gemini Audio), discussion/*
    ├── tts.js            # GET /api/tts/speak (двухголосая озвучка через Edge TTS)
    ├── numbers.js        # Тренажёр чисел на слух
    ├── plan.js           # GET /api/plan/today (дискретный дневной чек-лист задач)
    ├── skills.js         # Аналитика навыков Goethe B2 за 30 дней
    ├── stats.js          # Статистика, retention, streak
    ├── exam.js           # Журнал пробных экзаменов
    ├── enrich.js         # Ручной запуск и статус обогащения
    ├── lookup.js         # Контекстный словарь и быстрое добавление слов
    ├── import.js         # Импорт колод (gt-deck v2, card1.json, v1) с Zod-валидацией и batch upsert
    ├── export.js         # Экспорт колод (gt-deck v2) с/без прогресса, безопасный merge-restore
    ├── settings.js       # Настройки (включая settings.timezone)
    ├── log.js            # Логирование активности
    └── health.js         # GET /api/health (проверка связи с БД)
```

---

## 4. Многопользовательская изоляция (CONTRACT v3, R1–R5)

Все пользовательские данные строго изолированы в рамках единой БД:
1. **R1 (Единственный источник личности)**: `req.user.id` из валидированной сессии. Никакие `user_id` из тела запроса или query-параметров не принимаются (кроме `/api/admin/*`).
2. **R2 (Обязательная фильтрация каждого запроса)**: Любой SQL-запрос к пользовательской таблице обязан содержать `WHERE user_id = ?` (или эквивалентное условие в `JOIN`/`INSERT`).
3. **R3 (Поведение 404 вместо 403)**: Запрос чужого ресурса (`WHERE id = ? AND user_id = ?`) возвращает `404 NOT FOUND`.
4. **R4 (Отсутствие DEFAULT у user_id)**: В схеме БД поле `user_id INT UNSIGNED NOT NULL` не имеет дефолтного значения.
5. **R5 (Автоматический аудит)**: Тест `npm run check:scope` статически анализирует все SQL-запросы в `server/` и требует 0 нарушений.

---

## 5. Схема базы данных

### Глобальные таблицы (без `user_id`):
- `users`: учётные записи, пароли, роли, `disabled`, `ai_mode`, `token_version`.
- `ai_cache`: контент-адресуемый кэш ответов ИИ. Ключ: `SHA256(CACHE_VERSION + feature + schemaFingerprint + requestedTier + prompt)`. Ответы fallback-моделей низкого уровня (`degraded: true`) в кэш не записываются.
- `tts_cache`: кэш аудиофайлов озвучки диалогов (`hash CHAR(64) PK`, `mime`, `audio MEDIUMBLOB`, `bytes`, `created_at`).
- `schema_migrations`: журнал выполненных миграций.

### Пользовательские таблицы (`user_id INT UNSIGNED NOT NULL`):
1. **Карточки и SRS**:
   - `cards`: слова и выражения. Уникальный ключ `uq_user_dedupe (user_id, dedupe_key)`. Поля: `term`, `article`, `plural`, `pos`, `translation`, `grammar`, `example`, `example_cloze`, `cloze_answer`, `examples_json` (массив до 3 примеров), `rektion` (управление глагола/прилагательного), `level`, `topic`, `check_flag`, `enriched`, `enrich_attempts`, `enrich_next_at`, `source_batch`, `active`.
   - `card_state`: состояние FSRS (`card_id`, `mode`, `user_id`, `state`, `due`, `stability`, `difficulty`, `reps`, `lapses`, `last_review`). Допустимые режимы: `ru_de`, `cloze`, `article`.
   - `review_log`: журнал ответов (`user_id`, `card_id`, `mode`, `variant`, `rating`, `correct`, `response_ms`, `answered_at`, `local_day`).
2. **Обучающие активности**:
   - `texts`: тексты и диалоги (`user_id`, `kind`, `title`, `body`, `questions`, `glossary`, `word_count`).
   - `text_attempts`: попытки прохождения квизов и упражнений на связность.
   - `translation_sets`: наборы предложений для перевода (Satzbau).
   - `writing_tasks`, `writing_attempts`: письменные работы Goethe B2.
   - `speaking_sessions`: активные сессии дискуссии B2 (`user_id`, `topic`, `stance`, `redemittel`, `turns`, `status`, `score`).
   - `speaking_attempts`: результаты говорения (монологи, дискуссии, аудио-оценки).
   - `number_attempts`: распознавание чисел на слух.
3. **Профиль ошибок и аналитика**:
   - `user_error_profile`: накопленные грамматические ошибки пользователя (`user_id`, `category`, `hits`, `last_example`, `updated_at`).
   - `settings`: настройки пользователя (`key_name`, `value`), включая `timezone`.
   - `daily_stats`: дневная статистика (повторения, новые карточки, время).
   - `ai_usage`: учёт вызовов ИИ по дням.
   - `activities`: трекинг активности по навыкам.
   - `exam_log`: результаты пробных экзаменов.
   - `import_runs`: история импорта колод.

---

## 6. Логика карточек: почему повторялось одно и то же и как устроена колода

### 1. Почему раньше карточки повторялись по кругу:
- **Низкий порог выученности (`LEARNED_STABILITY = 21 день`)**: ранее карточки с `stability >= 21` считались полностью «выученными» и исключались из лесенки режимов. В результате пользователь застревал только на повторении одних и тех же нескольких слов в режиме `ru_de`, а более глубокие контекстные режимы (`cloze` и `article`) для них не создавались.
- **Отсутствие разнесения родственных режимов (Sibling Interference)**: если у одного слова на сегодня выпадали и `cloze`, и `ru_de`, пользователь проходил сложное предложение в `cloze`, а через 2 минуты ему снова выпадал элементарный перевод того же слова в `ru_de`.
- **Ошибочные артикли для не-существительных**: в базу попадали состояния `article` для глаголов и фраз, что засоряло сессию бессмысленными вопросами.
- **Бюрократия модерации в Staging**: сгенерированные слова и слова из словаря застревали в таблице `staging_cards` и не попадали в реальную очередь повторения, пока пользователь вручную не подтвердит каждое слово на отдельной странице.

### 2. Как теперь работает логика карточек:
1. **Порог выученности поднят до 60 дней (`LEARNED_STABILITY = 60`)**:
   - Карточка считается «Выученной» (`learned`), когда её стабильность FSRS достигает 60 дней (что соответствует уверенному долговременному запоминанию).
   - При этом лесенка режимов открывает `cloze` и `article` при `stability >= 3` в `ru_de` без искусственного верхнего лимита 21 день.
2. **Кнопка ручной отметки «✓ Уже знаю (Выучено)» (`POST /api/cards/:id/learned`)**:
   - Доступна в один клик прямо во время повторения карточек (`#/review`) и в каталоге (`#/cards`).
   - Сразу устанавливает `state = 2, stability = 90, due = +90 дней` по всем режимам карточки и мгновенно убирает это слово из текущей сессии.
3. **Разнесение повторов родственных карточек (Sibling Burying)**:
   - Если пользователь сегодня успешно (`rating >= 3`) ответил на карточку в режиме `cloze` или `article`, режим `ru_de` для этого же слова автоматически откладывается на следующий день (`reviews.js` выполняет мягкий сдвиг `due`, а `queue.js` исключает его из сегодняшней очереди). Это исключает эффект зубрёжки одного и того же слова подряд.
4. **Режим `article` — строго для существительных**:
   - Карточки с `pos != 'noun'` или без артикля (`der`/`die`/`das`) никогда не получают режим `article`.
5. **Ротация контекстных примеров и Rektion**:
   - Каждая карточка хранит до 3 реальных примеров (`examples_json`). При каждом выпадении режима `cloze` алгоритм динамически ротирует предложения.
   - Для глаголов и прилагательных с управлением (например, *warten auf + Akk*) генерируются пропуски связки предлога и артикля, исключая заучивание единственной фразы.
6. **Прямое добавление слов без задержек**:
   - Слова из словаря (`/api/lookup`), генератора (`/api/ai/generate-words`) и разбора ошибок мгновенно попадают в таблицу `cards` через `upsertCards()`.
   - Дедупликация выполняется по `dedupe_key` (слово не задваивается, а обогащается).
   - Карточки без примера или грамматики получают `enriched = 0` и фоново дообогащаются воркером `enrich_worker.js`.

---

## 7. Алгоритм интервальных повторений (FSRS)

- **Библиотека**: `ts-fsrs` (Free Spaced Repetition Scheduler v5).
- **Режимы карточек**:
  - `ru_de`: перевод с русского на немецкий (спряжение/форма).
  - `cloze`: заполнение пропуска в одном из предложений `examples_json` или проверка предложного управления (`rektion`).
  - `article`: выбор артикля (`der`, `die`, `das`) — только для существительных.
- **Шкала оценок (`Rating`)**:
  - `1` — Again (Снова): интервал сбрасывается, карточка повторяется в конце сессии.
  - `2` — Hard (Трудно): минимальный прирост интервала.
  - `3` — Good (Хорошо): нормальный интервал FSRS.
  - `4` — Easy (Легко): увеличенный интервал.
- **Смена дня (04:00 по персональной таймзоне пользователя)**:
  - Время смены суток берётся из `settings.timezone` пользователя (с фолбэком на `config.tzName`). Занятия после полуночи не сбивают серию (Streak) и не портят статистику.

---

## 8. Карта API-эндпоинтов

### 1. Авторизация и профиль
- `POST /api/auth/login` — вход по `{ username, password }`, установка HttpOnly-cookie `sid`.
- `POST /api/auth/logout` — выход, очистка cookie.
- `GET /api/me` — профиль текущего пользователя, включая `tz` (таймзона), `role`, `ai_mode`.
- `PUT /api/me/password` — смена пароля.
- `GET /api/me/keys`, `PUT /api/me/keys`, `DELETE /api/me/keys/:provider` — персональные ключи ИИ (AES-256-GCM).

### 2. Карточки и FSRS-сессия
- `GET /api/cards` — список карточек с фильтрами, пагинацией и статусом (`new | learning | learned`).
- `POST /api/cards` — создание карточки с авто-генерацией cloze и постановкой в очередь обогащения.
- `POST /api/cards/from-lookup`, `POST /api/cards/from-errors`, `POST /api/cards/bulk` — прямое добавление слов.
- `POST /api/cards/undo-batch` — отмена последнего пакета добавления карточек по `source_batch`.
- `POST /api/cards/:id/learned` — отметка карточки как выученной (`learned: true/false`).
- `PATCH /api/cards/:id` — редактирование карточки (обновление примеров, Rektion).
- `DELETE /api/cards/:id` — мягкое удаление карточки (`active = 0`).
- `GET /api/session/today` — сбор очереди FSRS на сегодня с исключением пройденного (`doneKeysToday`), sibling burying и ротацией примеров.
- `POST /api/reviews` — приём пакета ответов, обновление FSRS, сдвиг родственных карточек.

### 3. Импорт и экспорт колод
- `GET /api/cards/export?progress=0|1` — надёжный экспорт колоды в формате `gt-deck` v2.
- `POST /api/cards/import?dry_run=1` — валидация и предпросмотр импорта (поддерживает `gt-deck` v2, старый v1, формат `card1.json`).
- `POST /api/cards/import` — пакетный импорт через `upsertCards()` с авто-cloze и постановкой на обогащение.
- `GET /api/export` — скачивание полного бэкапа данных.
- `POST /api/export/restore` — безопасное слияние колоды (`mode = 'merge'`).

### 4. Обучающие модули Goethe B2
- **Тексты и упражнения на связность (`/api/texts`)**:
  - `GET /api/texts`, `GET /api/texts/:id`, `POST /api/texts`, `DELETE /api/texts/:id`.
  - `POST /api/texts/:id/gaps` — тренажёр `Lesen Teil 2` (восстановление логических связок и союзов B2).
  - `POST /api/texts/:id/attempts` — сохранение результатов попыток.
- **Озвучка диалогов (`/api/tts`)**:
  - `GET /api/tts/speak?text=...&voice=male|female&rate=...` — синтез речи через Edge TTS с серверным кэшированием в `tts_cache`.
- **Перевод и Satzbau (`/api/translate`)**:
  - `POST /api/translate/set` — генерация набора предложений с автоматической инъекцией слабых мест из `user_error_profile`.
  - `POST /api/translate/set/:id/check`, `POST /api/ai/check-batch` — проверка перевода с записью ошибок в профиль.
- **Письмо и пересказ (`/api/writing`, `/api/retell`)**:
  - `POST /api/writing/task`, `POST /api/writing/evaluate` — эссе Goethe B2 с оценкой по 4 критериям.
  - `POST /api/retell/task`, `POST /api/retell/evaluate` — пересказ текста RU -> DE с фиксацией грамматических ошибок.
- **Говорение (`/api/speaking`)**:
  - `POST /api/speaking/prompt` — получение тем для монолога или фраз для shadowing.
  - `POST /api/speaking/evaluate-audio` — прямая мультимодальная оценка аудио через Gemini Audio.
  - `POST /api/speaking/discussion/start` — запуск дискуссии B2 с ИИ-экзаменатором (выдача темы и Redemittel).
  - `POST /api/speaking/discussion/:id/turn` — ход в дискуссии (анализ реплики, ответ ИИ, отслеживание Redemittel).
  - `POST /api/speaking/discussion/:id/finish` — итоговая оценка диалога по критериям экзамена.
- **Числа на слух (`/api/numbers`)**:
  - `POST /api/numbers/attempt`, `GET /api/numbers/stats`.

### 5. План, аналитика и настройки
- `GET /api/plan/today` — дневной дискретный чек-лист (карточки, текст, Satzbau, ротация навыков).
- `GET /api/skills/summary` — радар 4 экзаменационных навыков за 30 дней.
- `GET /api/stats` — общая статистика, retention, streak.
- `GET /api/settings`, `PUT /api/settings` — настройки интервалов, таймзоны (`settings.timezone`).
- `GET /api/health` — проверка работоспособности сервера и базы данных.

---

## 9. Пошаговая инструкция по деплою на Railway

Проект полностью оптимизирован для работы на **Railway** с использованием среды **Nixpacks** и управляемой базы данных **MySQL**.

### Шаг 1. Подготовка репозитория GitHub
1. Убедитесь, что все изменения зафиксированы в ветке `main`.
2. Файл `.env` должен быть в `.gitignore`.
3. Файлы конфигурации Railway в корне репозитория:
   - `railway.json` — конфигурация сборки Nixpacks и параметров перезапуска.
   - `nixpacks.toml` — указание версии Node.js 20.
   - `package.json` — `"engines": { "node": ">=20" }`, `"scripts": { "start": "node server/index.js" }`.

### Шаг 2. Создание проекта и базы данных в Railway
1. Перейдите в [Railway Dashboard](https://railway.app/) и нажмите кнопку **New Project**.
2. Выберите **Deploy from GitHub repo** и выберите ваш репозиторий `German_learning`.
3. Внутри созданного проекта нажмите кнопку **+ New** → **Database** → **Add MySQL**.
4. Дождитесь инициализации контейнера MySQL (обычно 15–30 секунд).

### Шаг 3. Подключение базы данных к сервису приложения
1. Откройте сервис приложения (Node.js) в проекте Railway.
2. Перейдите на вкладку **Variables**.
3. Нажмите кнопку **Add Reference** (или откройте **Raw Editor**) и свяжите переменные с базой данных MySQL:
   ```env
   MYSQLHOST=${{MySQL.MYSQLHOST}}
   MYSQLPORT=${{MySQL.MYSQLPORT}}
   MYSQLUSER=${{MySQL.MYSQLUSER}}
   MYSQLPASSWORD=${{MySQL.MYSQLPASSWORD}}
   MYSQLDATABASE=${{MySQL.MYSQLDATABASE}}
   ```

### Шаг 4. Настройка обязательных переменных окружения
В том же разделе **Variables** сервиса приложения укажите:

```env
# Окружение и таймзона по умолчанию
NODE_ENV=production
TZ_NAME=Asia/Bishkek

# Пароль системного администратора (логин: owner создастся автоматически)
APP_PASSWORD=Придумайте_Сложный_Пароль_Администратора

# Секретные ключи (минимум 32 случайных символа в каждом)
SESSION_SECRET=длинная_случайная_строка_минимум_32_символа_для_кук
KEYS_SECRET=вторая_случайная_строка_минимум_32_символа_для_шифрования

# Цепочка ИИ-моделей
LLM_CHAIN=gemini,groq,openrouter
GEMINI_KEY=ваш_ключ_Google_AI_Studio
GEMINI_MODEL_STRONG=gemini-2.5-pro
GEMINI_MODEL_FAST=gemini-2.5-flash

# Опционально: резервный провайдер Groq
GROQ_KEY=ваш_ключ_Groq
GROQ_MODEL_STRONG=llama-3.3-70b-versatile
GROQ_MODEL_FAST=llama-3.1-8b-instant

# Дневные лимиты ИИ на пользователя (по умолчанию 100-200)
AI_DAILY_CAP_CORRECT=200
AI_DAILY_CAP_GENERATE=50
AI_DAILY_CAP_ENRICH=100
AI_DAILY_CAP_TEXT=30

# Воркер фонового обогащения карточек (1 = включён)
ENRICH_WORKER=1
```

### Шаг 5. Сеть, публичный домен и Healthcheck
1. В настройках сервиса приложения откройте вкладку **Settings**.
2. В разделе **Networking** нажмите **Generate Domain** (будет выдан адрес вида `https://<проект>.up.railway.app`).
3. В разделе **Deploy** настройте **Healthcheck Path**: `/api/health`. Сервер вернёт статус 200 только после успешной проверки соединения с MySQL.
4. Railway автоматически начнёт деплой:
   - Скрипт `waitForDb` дождётся готовности MySQL.
   - Механизм `migrate.js` автоматически и идемпотентно накатит базовую схему (`schema.sql`, `schema_v2.sql`) и все миграции `001`–`010`.
   - Будет автоматически создан администратор `owner` с паролем из `APP_PASSWORD`.
   - Запустится фоновый воркер обогащения `enrich_worker.js`.

### Шаг 6. Первый вход и загрузка карточек
1. Откройте выданный домен в браузере.
2. Войдите под логином `owner` и паролем, указанным в `APP_PASSWORD`.
3. Перейдите в раздел **Настройки**:
   - Нажмите кнопку «Определить автоматически» рядом с таймзоной, чтобы синхронизировать смену суток с вашим часовым поясом.
   - Перейдите во вкладку **Импорт** и загрузите ваш файл колоды карточек (поддерживаются форматы `gt-deck` v2, старый экспорт или список `card1.json`). Все слова мгновенно добавятся в основную колоду и автоматически начнут обогащаться примерами и грамматикой.
