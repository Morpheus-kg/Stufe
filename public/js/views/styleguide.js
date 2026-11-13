// Гид по стилям и компонентам (CONTRACT v3, B5)
import { h } from '../app.js';
import { ICON_CHECK, ICON_CHEVRON_RIGHT, ICON_AUDIO } from '../ui/icons.js';

export async function mount(container) {
  const root = h('div', { class: 'stack' });

  // Заголовок и переключатель темы для превью
  const themeToggle = h('button', {
    class: 'btn sm ghost',
    type: 'button',
    text: 'Переключить тему (превью)',
    onclick: () => {
      const cur = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
    },
  });

  root.append(
    h('div', { style: 'display: flex; justify-content: space-between; align-items: center;' },
      h('h1', { text: 'Гид по стилям' }),
      themeToggle,
    ),
    h('p', { class: 'muted', text: 'Каталог компонентов дизайн-системы (спокойный минимализм, CONTRACT v3 B2–B5).' }),
  );

  // 1. Типографика
  root.append(
    h('div', { class: 'section-header', text: '1. Типографика' }),
    h('div', { class: 'card-box stack' },
      h('div', { class: 'big-term', text: 'das Haus' }),
      h('h1', { text: 'Заголовок H1 (28px)' }),
      h('h2', { text: 'Заголовок H2 (20px)' }),
      h('h3', { text: 'Заголовок H3 (16px semi-bold)' }),
      h('p', { text: 'Основной текст body (16px, line-height 1.5). Спокойный чернильный цвет, достаточный контраст в обеих темах.' }),
      h('p', { class: 'muted', text: 'Вторичный текст (.muted / --text-2).' }),
      h('p', { class: 'muted-3', text: 'Третичный текст (.muted-3 / --text-3).' }),
    ),
  );

  // 2. Кнопки
  root.append(
    h('div', { class: 'section-header', text: '2. Кнопки' }),
    h('div', { class: 'card-box stack' },
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', type: 'button', text: 'Primary (ink fill)' }),
        h('button', { class: 'btn accent', type: 'button', text: 'Accent (терракота)' }),
        h('button', { class: 'btn', type: 'button', text: 'Secondary / default' }),
        h('button', { class: 'btn ghost', type: 'button', text: 'Ghost' }),
        h('button', { class: 'btn danger', type: 'button', text: 'Danger' }),
        h('button', { class: 'btn', type: 'button', disabled: true, text: 'Disabled' }),
      ),
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', type: 'button', text: 'Small (32px)' }),
        h('button', { class: 'btn', type: 'button', text: 'Medium (44px tap target)' }),
        h('button', { class: 'btn lg primary', type: 'button', text: 'Large (52px)' }),
      ),
    ),
  );

  // 3. Поля ввода
  root.append(
    h('div', { class: 'section-header', text: '3. Поля ввода' }),
    h('div', { class: 'card-box stack' },
      h('div', { class: 'field' },
        h('label', { for: 'sg-inp-1', class: 'field-label', text: 'Текстовое поле ввода' }),
        h('input', { id: 'sg-inp-1', class: 'input', placeholder: 'Начните ввод…' }),
      ),
      h('div', { class: 'field' },
        h('label', { for: 'sg-inp-2', class: 'field-label', text: 'Многострочный ввод (Textarea)' }),
        h('textarea', { id: 'sg-inp-2', class: 'input', placeholder: 'Текст для пересказа или письма…' }),
      ),
      h('div', { class: 'field' },
        h('label', { for: 'sg-inp-3', class: 'field-label', text: 'Выпадающий список (Select)' }),
        h('select', { id: 'sg-inp-3', class: 'input' },
          h('option', { value: '1', text: 'Опция 1' }),
          h('option', { value: '2', text: 'Опция 2' }),
        ),
      ),
    ),
  );

  // 4. Бейджи и чипы
  root.append(
    h('div', { class: 'section-header', text: '4. Бейджи и чипы' }),
    h('div', { class: 'card-box row wrap' },
      h('span', { class: 'badge', text: 'Нейтральный' }),
      h('span', { class: 'badge accent', text: 'Акцентный' }),
      h('span', { class: 'badge success', text: 'Успех' }),
      h('span', { class: 'badge danger', text: 'Ошибка' }),
      h('span', { class: 'badge warn', text: 'Внимание' }),
      h('span', { class: 'chip', text: 'Обычный чип' }),
      h('span', { class: 'chip accent', text: 'Акцентный чип' }),
    ),
  );

  // 5. Сегментированный переключатель
  root.append(
    h('div', { class: 'section-header', text: '5. Сегментированный контроль' }),
    h('div', { class: 'card-box' },
      h('div', { class: 'seg', role: 'group' },
        h('button', { type: 'button', 'aria-pressed': 'false', text: 'Лёгкая' }),
        h('button', { type: 'button', 'aria-pressed': 'true', text: 'Средняя' }),
        h('button', { type: 'button', 'aria-pressed': 'false', text: 'Сложная' }),
      ),
    ),
  );

  // 6. Прогресс-бар
  root.append(
    h('div', { class: 'section-header', text: '6. Прогресс-бар' }),
    h('div', { class: 'card-box stack' },
      h('div', { class: 'progress' },
        h('div', { class: 'progress-fill', style: 'width: 65%' }),
      ),
    ),
  );

  // 7. Обратная связь и рейтинг
  root.append(
    h('div', { class: 'section-header', text: '7. Блоки обратной связи (Review)' }),
    h('div', { class: 'stack' },
      h('div', { class: 'feedback correct' },
        h('div', { class: 'fb-title', text: 'Верно' }),
        h('div', { class: 'fb-note', text: 'Отличный ответ! Интервал повторения увеличен.' }),
      ),
      h('div', { class: 'feedback almost' },
        h('div', { class: 'fb-title', text: 'Почти верно (опечатка)' }),
        h('div', { class: 'diff' },
          h('span', { class: 'd-del', text: 'Hause' }),
          h('span', { class: 'd-ins', text: 'Haus' }),
        ),
      ),
      h('div', { class: 'feedback wrong' },
        h('div', { class: 'fb-title', text: 'Неверно' }),
        h('div', { class: 'fb-expected', text: 'Правильный ответ: das Haus' }),
      ),
      h('div', { class: 'rating-row' },
        h('button', { class: 'btn rate r1', type: 'button', text: 'Снова (1)' }),
        h('button', { class: 'btn rate r2', type: 'button', text: 'Трудно (2)' }),
        h('button', { class: 'btn rate r3', type: 'button', text: 'Хорошо (3)' }),
        h('button', { class: 'btn rate r4', type: 'button', text: 'Легко (4)' }),
      ),
    ),
  );

  // 8. Строка списка
  root.append(
    h('div', { class: 'section-header', text: '8. Строки списка (Words / Staging)' }),
    h('ul', { class: 'list' },
      h('li', { class: 'list-item' },
        h('div', { class: 'li-head' },
          h('span', { class: 'li-term', text: 'die Entscheidung' }),
          h('span', { class: 'badge accent', text: 'B1' }),
        ),
      ),
      h('li', { class: 'list-item' },
        h('div', { class: 'li-head' },
          h('span', { class: 'li-term', text: 'sich erinnern an' }),
          h('span', { class: 'badge success', text: 'A2' }),
        ),
      ),
    ),
  );

  // 9. Пустое состояние и скелетон
  root.append(
    h('div', { class: 'section-header', text: '9. Пустое состояние и Скелетон' }),
    h('div', { class: 'card-box stack' },
      h('div', { class: 'skeleton', style: 'height: 20px; width: 60%;' }),
      h('div', { class: 'skeleton', style: 'height: 14px; width: 90%;' }),
      h('div', { class: 'empty-state' },
        h('p', { text: 'Нет активных карточек на сегодня.' }),
        h('button', { class: 'btn primary sm', type: 'button', text: 'Добавить слова' }),
      ),
    ),
  );

  container.replaceChildren(root);
}

export default mount;

