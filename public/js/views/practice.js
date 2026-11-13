// Экран «Практика» — хаб всех режимов, красивые карточки с иконками
import { navigate } from '../app.js';

const STYLE_ID = 'gt-practice-style';
const CSS = `
.gt-pr { padding: var(--s1) 0 var(--s6); }
.gt-pr h1 { font-size: var(--fs-xl); margin: 0 0 var(--s1); font-weight: 700; }
.gt-pr-sub { color: var(--text-2); font-size: var(--fs-sm); margin: 0 0 var(--s4); }
.gt-pr-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--s3);
}
.gt-pr-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--s4) var(--s3);
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--s2);
  cursor: pointer; text-decoration: none; color: inherit;
  transition: transform var(--dur), border-color var(--dur), background var(--dur);
  -webkit-tap-highlight-color: transparent;
}
.gt-pr-card:hover { background: var(--surface-2); }
.gt-pr-card:active { transform: scale(.98); }
.gt-pr-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.gt-pr-card.wide {
  grid-column: span 2;
  flex-direction: row; align-items: center; gap: var(--s4);
}
.gt-pr-icon {
  font-size: 1.8rem; line-height: 1;
  width: 48px; height: 48px;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.gt-pr-card.wide .gt-pr-icon { width: 44px; height: 44px; }
.gt-pr-info { min-width: 0; }
.gt-pr-title { font-weight: 600; font-size: var(--fs-md); margin: 0 0 2px; }
.gt-pr-desc { font-size: var(--fs-xs); color: var(--text-2); margin: 0; line-height: 1.4; }
.gt-pr-section { font-size: var(--fs-xs); font-weight: 600; color: var(--text-3); letter-spacing: .08em; text-transform: uppercase; margin: var(--s5) 0 var(--s2); }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

const ITEMS = [
  {
    section: 'Основное',
    cards: [
      {
        icon: '📖', title: 'Тексты', desc: 'Читайте адаптированные тексты на немецком',
        href: '#/texts', wide: false,
      },
      {
        icon: '🎧', title: 'Аудирование', desc: 'Слушайте и отвечайте на вопросы',
        href: '#/listen', wide: false,
      },
      {
        icon: '🔢', title: 'Числа', desc: 'Числа и даты на слух по-немецки',
        href: '#/numbers', wide: false,
      },
      {
        icon: '🌐', title: 'Перевод', desc: 'Переводите предложения RU ↔ DE',
        href: '#/translate', wide: false,
      },
    ],
  },
  {
    section: 'Речь и письмо',
    cards: [
      {
        icon: '🎤', title: 'Говорение', desc: 'Монологи и диалоги на свободную тему',
        href: '#/speak', wide: false,
      },
      {
        icon: '✍️', title: 'Письмо', desc: 'Эссе и письма с проверкой ИИ',
        href: '#/write', wide: false,
      },
      {
        icon: '📝', title: 'Пересказ', desc: 'Прочитайте текст и перескажите его',
        href: '#/retell', wide: true,
      },
    ],
  },
  {
    section: 'Дополнительно',
    cards: [
      {
        icon: '🧪', title: 'Лаборатория текста', desc: 'Анализ, словарь и работа с любым текстом',
        href: '#/lab', wide: true,
      },
    ],
  },
];

export async function mount(container) {
  ensureStyle();

  const root = document.createElement('div');
  root.className = 'gt-pr';

  const h1 = document.createElement('h1');
  h1.textContent = 'Практика';
  root.append(h1);

  const sub = document.createElement('p');
  sub.className = 'gt-pr-sub';
  sub.textContent = 'Выберите вид практики';
  root.append(sub);

  for (const { section, cards } of ITEMS) {
    const sec = document.createElement('div');
    sec.className = 'gt-pr-section';
    sec.textContent = section;
    root.append(sec);

    const grid = document.createElement('div');
    grid.className = 'gt-pr-grid';

    for (const item of cards) {
      const card = document.createElement('a');
      card.href = item.href;
      card.className = 'gt-pr-card' + (item.wide ? ' wide' : '');
      card.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(item.href);
      });

      const icon = document.createElement('div');
      icon.className = 'gt-pr-icon';
      icon.textContent = item.icon;
      icon.setAttribute('aria-hidden', 'true');

      const info = document.createElement('div');
      info.className = 'gt-pr-info';

      const title = document.createElement('div');
      title.className = 'gt-pr-title';
      title.textContent = item.title;

      const desc = document.createElement('p');
      desc.className = 'gt-pr-desc';
      desc.textContent = item.desc;

      info.append(title, desc);
      card.append(icon, info);
      grid.append(card);
    }

    root.append(grid);
  }

  container.replaceChildren(root);
}

export default mount;

