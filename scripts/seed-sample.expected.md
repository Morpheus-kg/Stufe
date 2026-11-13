# Ожидаемый результат импорта scripts/seed-sample.json

Тестовый набор данных `scripts/seed-sample.json` содержит ровно 25 элементов для проверки эндпоинта `POST /api/import` согласно контракту §3, §5 и примечаниям модуля M1 (`Notes_M1.md`, пункты 6–9).

---

## 1. Сводные показатели

### Первая загрузка (на пустую базу данных)
```json
{
  "total": 25,
  "added": 14,
  "merged": 4,
  "flagged": 8
}
```
*Примечание:* сумма `added + merged + flagged = 14 + 4 + 8 = 26`, что больше `total = 25`. Это строго соответствует п. 7 `Notes_M1.md`: элемент #7 содержит оборот в скобках и делится на 2 карточки, каждая из которых учитывается в `added`.

### Вторая загрузка (того же файла повторно)
```json
{
  "total": 25,
  "added": 0,
  "merged": 18,
  "flagged": 8
}
```
*Пояснение:* Все ранее созданные карточки (18 штук, включая 2 от разделения скобок) распознаются как дубликаты по `dedupe_key` и сливаются (`merged = 18`), новых не добавляется (`added = 0`), а 8 невалидных элементов снова отбрасываются (`flagged = 8`).

---

## 2. Поэлементный разбор (25 элементов)

| # | Термин / Элемент | Run 1 Статус | Run 2 Статус | dedupe_key | Причина и правила обработки |
|---|---|---|---|---|---|
| 1 | `"das Haus"` (старый формат, type: word) | **added** | **merged** | `das haus` | Артикль `das` отделяется в `article`, `pos='noun'`, `term='Haus'`. Карточка создана. |
| 2 | `"Guten Morgen"` (старый формат, type: phrase) | **added** | **merged** | `guten morgen` | `pos='phrase'`, артикля нет. Карточка создана. |
| 3 | `"Katz und Maus spielen"` (старый формат, type: idiom) | **added** | **merged** | `katz und maus spielen` | `type: idiom` -> `pos='idiom'`. Артикль не отделяется. Карточка создана. |
| 4 | `"Herausforderung"` (новый формат, все поля) | **added** | **merged** | `die herausforderung` | Полная карточка: `article='die'`, `pos='noun'`, `plural`, `example_cloze`, `cloze_answer`. Карточка создана. |
| 5 | `"  DIE  HERAUSFORDERUNG  "` (дубликат #4) | **merged** | **merged** | `die herausforderung` | Регистр и пробелы нормализуются, артикль `die` выделяется -> ключ совпадает с #4. Слияние (заполняются пустые поля). |
| 6 | `"  Haus  "` с `article: "das"`, `plural: "Häuser"` | **merged** | **merged** | `das haus` | Ключ совпадает с #1. Поле `plural` отсутствовало у #1 и теперь заполняется (`merged`). |
| 7 | `"die Armut (in Armut aufwachsen)"` | **added** (2 карточки) | **merged** (2 карточки) | Карточка 7a: `die armut`<br>Карточка 7b: `in armut aufwachsen` | В скобках оборот из 3 слов без запятых и помет (п. 6 `Notes_M1.md`). Создаются 2 карточки: слово (`term='Armut'`, `article='die'`, `pos='noun'`) и фраза (`term='in Armut aufwachsen'`, `pos='phrase'`). |
| 8 | `"laufen (lief, ist gelaufen)"` | **added** (1 карточка) | **merged** | `laufen (lief, ist gelaufen` | Скобки НЕ делятся: содержат запятую и служебное слово `ist` (попадает под `NOT_PHRASE_RE`). Создаётся 1 карточка. |
| 9 | `"fahren (ist gefahren)"` | **added** (1 карточка) | **merged** | `fahren (ist gefahren` | Скобки НЕ делятся: оборот начинается с `ist` (`NOT_PHRASE_RE`). Создаётся 1 карточка. |
| 10 | `"schön"` (с умляутом) | **added** | **merged** | `schön` | Немецкое прилагательное. `dedupe_key` в `utf8mb4_bin` сохраняет `ö`. Карточка создана. |
| 11 | `"schon"` (без умляута) | **added** | **merged** | `schon` | Наречие. В бинарной коллации `utf8mb4_bin` НЕ является дубликатом `"schön"`. Создаётся отдельная карточка. |
| 12 | `"der Bär"` (с умляутом) | **added** | **merged** | `der bär` | Существительное мужского рода. Ключ `der bär`. Карточка создана. |
| 13 | `"die Bar"` (без умляута) | **added** | **merged** | `die bar` | Существительное женского рода. НЕ является дубликатом `"der Bär"`. Создаётся отдельная карточка. |
| 14 | `""` (пустой термин) | **flagged** | **flagged** | — | `term.length < 2`. Пропускается и инкрементирует `flagged`. |
| 15 | `"a"` (термин из 1 символа) | **flagged** | **flagged** | — | `term.length < 2` (слишком короткий, п. 7 `Notes_M1.md`). Пропускается (`flagged`). |
| 16 | `"der Tisch"` с `translation: ""` | **flagged** | **flagged** | — | `translation.length < 2`. Пропускается (`flagged`). |
| 17 | `"das Buch"` с `translation: "к"` | **flagged** | **flagged** | — | `translation.length < 2` (слишком короткий перевод). Пропускается (`flagged`). |
| 18 | `null` | **flagged** | **flagged** | — | Не является объектом (п. 7 `Notes_M1.md`). Пропускается (`flagged`). |
| 19 | `"невалидный элемент (строка)"` | **flagged** | **flagged** | — | Примитив строка вместо объекта карточки. Пропускается (`flagged`). |
| 20 | `[{ "term": "im Array", ... }]` | **flagged** | **flagged** | — | Вложенный массив вместо объекта карточки. Пропускается (`flagged`). |
| 21 | Термин из 300 символов | **flagged** | **flagged** | — | `term.length > 255` (п. 7 `Notes_M1.md`). Пропускается (`flagged`). |
| 22 | `"jemandem auf die Nerven gehen"` (идиома с артиклем внутри) | **added** | **merged** | `jemandem auf die nerven gehen` | `type: idiom` -> `pos='idiom'`. Артикль `die` находится внутри фразы и не отделяется. Карточка создана. |
| 23 | `"das Herz"` с кириллицей и эмодзи в переводе | **added** | **merged** | `das herz` | Корректная обработка utf8mb4: перевод `"сердце ❤️ — символ любви и жизни"`. Карточка создана. |
| 24 | `"  guten   morgen  "` (дубликат #2) | **merged** | **merged** | `guten morgen` | Дубликат #2 с лишними пробелами и другим регистром. Сливается с существующей карточкой (`merged`). |
| 25 | `"!SCHON!"` (дубликат #11) | **merged** | **merged** | `schon` | Внешняя пунктуация `!` удаляется функцией `clean()`, регистр приводится к нижнему. Дубликат #11. Слияние (`merged`). |

