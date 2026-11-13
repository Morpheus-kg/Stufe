// Общие константы (чистый модуль: без Node и DOM API)

export const MODES = ['ru_de', 'cloze', 'article'];

export const RATING = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

export const POS = ['noun', 'verb', 'adj', 'adv', 'phrase', 'idiom', 'collocation'];

export const LEVELS = ['B1', 'B2', 'C1'];

// Redemittel: готовые фразы и связки для мнения, писем и дискуссий
export const TOPICS = [
  'Arbeit', 'Bildung', 'Gesellschaft', 'Umwelt', 'Medien', 'Gesundheit',
  'Wirtschaft', 'Alltag', 'Reisen', 'Politik', 'Familie', 'Sonstiges', 'Redemittel',
];

export const ERROR_CATEGORIES = [
  'artikel', 'kasus', 'wortstellung', 'praeposition',
  'konjugation', 'rechtschreibung', 'wortschatz', 'sonstiges',
];

// Уровни сложности (настройка difficulty)
export const DIFFICULTIES = ['easy', 'medium', 'hard'];