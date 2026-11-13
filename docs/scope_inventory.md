# Инвентарь области (Фаза 0) — German Trainer

Дата: 2026-11-08

## 1. SQL-выражения в server/ (таблицы пользовательских данных)

Таблицы с `user_id` (A2): cards, card_state, review_log, sentences, staging_cards, settings, daily_stats, import_runs, texts, text_attempts, translation_sets, writing_tasks, writing_attempts, speaking_attempts, number_attempts, exam_log, activities.

Глобальные (без `user_id`): ai_cache, schema_migrations, users.

| # | Файл:строка | Таблица | user_id? | Статус |
|---|------------|---------|----------|--------|
| 1 | routes/cards.js:184 | cards | НЕТ | НАРУШЕНИЕ R2 |
| 2 | routes/cards.js:185 | cards | НЕТ | НАРУШЕНИЕ R2 |
| 3 | routes/cards.js:145 | cards | НЕТ | нарушение (createCard) |
| 4 | routes/cards.js:151 | cards | НЕТ | нарушение |
| 5 | routes/cards.js:155 | cards | НЕТ | нарушение |
| 6 | routes/cards.js:160 | cards | НЕТ | нарушение |
| 7 | routes/cards.js:164 | cards | НЕТ | нарушение |
| 8 | routes/cards.js:205 | cards | НЕТ | нарушение |
| 9 | routes/cards.js:220 | cards | НЕТ | нарушение |
| 10 | routes/cards.js:227 | cards | НЕТ | нарушение |
| 11 | routes/cards.js:234 | cards | НЕТ | нарушение |
| 12 | routes/cards.js:240-242 | cards | НЕТ | нарушение |
| 13 | routes/session.js:56 | cards | НЕТ | нарушение |
| 14 | routes/session.js:57 | card_state | НЕТ | нарушение |
| 15 | routes/session.js:60-62 | review_log | НЕТ | нарушение |
| 16 | routes/session.js:64-67 | review_log | НЕТ | нарушение |
| 17 | routes/session.js:69 | review_log | НЕТ | нарушение |
| 18 | routes/session.js:70 | review_log | НЕТ | нарушение |
| 19 | routes/reviews.js:100 | cards | НЕТ | нарушение |
| 20 | routes/reviews.js:111 | review_log | НЕТ | нарушение |
| 21 | routes/reviews.js:122 | card_state | НЕТ | нарушение |
| 22 | routes/reviews.js:137 | card_state | НЕТ | нарушение |
| 23 | routes/reviews.js:155 | daily_stats | НЕТ | нарушение |
| 24 | routes/reviews.js:161 | daily_stats | НЕТ | нарушение |
| 25 | routes/settings.js:88 | settings | НЕТ | нарушение |
| 26 | routes/settings.js:104 | settings | НЕТ | нарушение |
| 27 | routes/stats.js:87-141 | review_log,cards,card_state,daily_stats,sentences | НЕТ | нарушение |
| 28 | routes/export.js:35-40 | cards,card_state,review_log,sentences,daily_stats | НЕТ | нарушение |
| 29 | routes/export.js:103 | (DELETE) review_log,sentences,daily_stats,card_state,cards,settings | НЕТ | нарушение |
| 30 | routes/import.js:121 | cards | НЕТ | нарушение |
| 31 | routes/import.js:152 | cards | НЕТ | нарушение |
| 32 | routes/import.js:157 | cards | НЕТ | нарушение |
| 33 | routes/import.js:176 | import_runs | НЕТ | нарушение |
| 34 | routes/enrich.js:16 | cards | НЕТ | нарушение |
| 35 | routes/enrich.js:38 | cards | НЕТ | нарушение |
| 36 | routes/staging.js:32 | staging_cards | НЕТ | нарушение |
| 37 | routes/staging.js:47 | staging_cards | НЕТ | нарушение |
| 38 | routes/staging.js:64 | cards | НЕТ | нарушение |
| 39 | routes/staging.js:78-85 | cards | НЕТ | нарушение |
| 40 | routes/staging.js:87 | staging_cards | НЕТ | нарушение |
| 41 | routes/staging.js:114 | staging_cards | НЕТ | нарушение |
| 42 | routes/log.js:23 | daily_stats | НЕТ | нарушение |
| 43 | routes/texts.js | texts,text_attempts | НЕТ | нарушение |
| 44 | routes/plan.js | activities,daily_stats,card_state,cards,texts | НЕТ | нарушение |
| 45 | routes/skills.js | activities,writing_attempts,review_log,daily_stats | НЕТ | нарушение |
| 46 | routes/exam.js | exam_log | НЕТ | нарушение |
| 47 | routes/translate.js | translation_sets | НЕТ | нарушение |
| 48 | routes/retell.js | writing_tasks,writing_attempts | НЕТ | нарушение |
| 49 | routes/speaking.js | speaking_attempts | НЕТ | нарушение |
| 50 | routes/writing.js | writing_tasks,writing_attempts | НЕТ | нарушение |
| 51 | routes/numbers.js | number_attempts | НЕТ | нарушение |
| 52 | routes/lookup.js | staging_cards,cards | НЕТ | нарушение |
| 53 | routes/aitexts.js | texts,staging_cards | НЕТ | нарушение |
| 54 | routes/ai.js:58 | cards | НЕТ | нарушение |
| 55 | routes/ai.js:81 | sentences | НЕТ | нарушение |
| 56 | routes/ai.js:106 | cards,staging_cards | НЕТ | нарушение |
| 57 | routes/ai.js:200-215 | staging_cards | НЕТ | нарушение |
| 58 | ai/llm.js:87 | ai_usage | НЕТ | нарушение |
| 59 | ai/llm.js:99 | ai_usage | НЕТ | нарушение |
| 60 | ai/llm.js:111 | ai_usage | НЕТ | нарушение |
| 61 | ai/enrich.js | cards | НЕТ | нарушение |

**Допустимые исключения (scope-ok):**
- admin.js: cross-user (/* admin-scope */)
- schema.sql, schema_v2.sql: схема (/* scope-ok: schema */)
- migrations/*: миграции (/* scope-ok: migration */)
- ai_cache: глобальный (/* scope-ok: global */)
- users: таблица пользователей (/* scope-ok: users */)

## 2. Маршруты и middleware

| Метод | Путь | Middleware | Статус |
|-------|------|-----------|--------|
| POST | /api/auth/login | loginLimiter | ОК |
| POST | /api/auth/logout | — | ОК |
| GET | /api/auth/me | — | ОК |
| GET | /api/admin/users | requireAuth,requireAdmin | ОК |
| POST | /api/admin/users | requireAuth,requireAdmin | ОК |
| PUT | /api/admin/users/:id | requireAuth,requireAdmin | ОК |
| DELETE | /api/admin/users/:id | requireAuth,requireAdmin | ОК |
| GET | /api/cards | — | НАРУШЕНИЕ (нет requireAuth) |
| POST | /api/cards | — | НАРУШЕНИЕ |
| PATCH | /api/cards/:id | — | НАРУШЕНИЕ |
| DELETE | /api/cards/:id | — | НАРУШЕНИЕ |
| GET | /api/session/today | — | НАРУШЕНИЕ |
| POST | /api/reviews | — | НАРУШЕНИЕ |
| GET | /api/settings | — | НАРУШЕНИЕ |
| PUT | /api/settings | — | НАРУШЕНИЕ |
| GET | /api/stats/summary | — | НАРУШЕНИЕ |
| GET | /api/export | — | НАРУШЕНИЕ |
| POST | /api/export/restore | — | НАРУШЕНИЕ |
| POST | /api/import | — | НАРУШЕНИЕ |
| POST | /api/enrich/run | — | НАРУШЕНИЕ |
| GET | /api/enrich/status | — | НАРУШЕНИЕ |
| GET | /api/staging | — | НАРУШЕНИЕ |
| POST | /api/staging/:id/accept | — | НАРУШЕНИЕ |
| POST | /api/staging/:id/reject | — | НАРУШЕНИЕ |
| POST | /api/log/external | — | НАРУШЕНИЕ |
| GET | /api/texts | — | НАРУШЕНИЕ |
| POST | /api/texts | — | НАРУШЕНИЕ |
| GET | /api/texts/:id | — | НАРУШЕНИЕ |
| DELETE | /api/texts/:id | — | НАРУШЕНИЕ |
| POST | /api/texts/:id/attempts | — | НАРУШЕНИЕ |
| GET | /api/plan/today | — | НАРУШЕНИЕ |
| GET | /api/skills/summary | — | НАРУШЕНИЕ |
| GET | /api/exam | — | НАРУШЕНИЕ |
| POST | /api/exam | — | НАРУШЕНИЕ |
| DELETE | /api/exam/:id | — | НАРУШЕНИЕ |
| POST | /api/ai/correct-sentence | — | НАРУШЕНИЕ |
| POST | /api/ai/generate-words | — | НАРУШЕНИЕ |
| GET | /api/ai/providers | — | ОК (публичный) |
| GET | /api/ai/usage | — | НАРУШЕНИЕ |
| POST | /api/ai/generate-text | — | НАРУШЕНИЕ |
| POST | /api/ai/analyze-text | — | НАРУШЕНИЕ |
| POST | /api/lookup | — | НАРУШЕНИЕ |
| POST | /api/staging/from-lookup | — | НАРУШЕНИЕ |
| POST | /api/staging/bulk | — | НАРУШЕНИЕ |
| POST | /api/staging/from-errors | — | НАРУШЕНИЕ |
| POST | /api/translate/set | — | НАРУШЕНИЕ |
| POST | /api/translate/set/:id/check | — | НАРУШЕНИЕ |
| GET | /api/translate/sets | — | НАРУШЕНИЕ |
| GET | /api/translate/sets/:id | — | НАРУШЕНИЕ |
| POST | /api/retell/task | — | НАРУШЕНИЕ |
| POST | /api/retell/evaluate | — | НАРУШЕНИЕ |
| POST | /api/speaking/transcribe | — | НАРУШЕНИЕ |
| POST | /api/speaking/prompt | — | НАРУШЕНИЕ |
| POST | /api/speaking/evaluate | — | НАРУШЕНИЕ |
| POST | /api/writing/task | — | НАРУШЕНИЕ |
| POST | /api/writing/evaluate | — | НАРУШЕНИЕ |
| POST | /api/numbers/attempts | — | НАРУШЕНИЕ |
| GET | /api/numbers/stats | — | НАРУШЕНИЕ |

## 3. Итоги

- Таблицы с user_id, подлежащие изоляции: 18 таблиц
- SQL-нарушений R2 (нет user_id фильтра): ~61
- Роутов без requireAuth: ~44 из ~52 защищаемых
- Новых таблиц нужно создать: user_keys
