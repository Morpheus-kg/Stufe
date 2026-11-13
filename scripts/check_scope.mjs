// scripts/check_scope.mjs
// Static check: verifies all SQL statements in server/ on user-owned tables include user_id
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '../server');

const USER_TABLES = [
  'cards',
  'card_state',
  'review_log',
  'staging_cards',
  'sentences',
  'daily_stats',
  'texts',
  'text_attempts',
  'plan_presets',
  'plan_exceptions',
  'exam_questions',
  'exam_sessions',
  'number_attempts',
  'translation_sets',
  'speaking_attempts',
  'speaking_sessions',
  'writing_tasks',
  'activities',
  'settings',
  'ai_usage',
  'user_keys',
  'user_error_profile',
];

function getFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'migrations') continue; // skip migrations
      files.push(...getFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      if (entry.name === 'migrate.js') continue; // skip migrate.js
      files.push(fullPath);
    }
  }
  return files;
}

const tableRegexes = USER_TABLES.map((t) => ({ name: t, regex: new RegExp(`\\b${t}\\b`, 'i') }));

const files = getFiles(serverDir);
const violations = [];

for (const file of files) {
  const relPath = path.relative(path.resolve(__dirname, '..'), file).replace(/\\/g, '/');
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');

  // Search for query(...) calls
  // Match `query(`, `conn.query(`, `dbQuery(`
  const callRegex = /(?:query|conn\.query|dbQuery)\s*\(/g;
  let match;

  while ((match = callRegex.exec(content)) !== null) {
    const startIndex = match.index;
    const lineNumber = content.slice(0, startIndex).split('\n').length;

    // Find the matching closing parenthesis for the query call or first argument
    let depth = 1;
    let endIndex = startIndex + match[0].length;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let inTemplate = false;

    while (endIndex < content.length && depth > 0) {
      const char = content[endIndex];
      const prev = content[endIndex - 1];

      if (char === "'" && prev !== '\\' && !inDoubleQuote && !inTemplate) inSingleQuote = !inSingleQuote;
      else if (char === '"' && prev !== '\\' && !inSingleQuote && !inTemplate) inDoubleQuote = !inDoubleQuote;
      else if (char === '`' && prev !== '\\' && !inSingleQuote && !inDoubleQuote) inTemplate = !inTemplate;
      else if (!inSingleQuote && !inDoubleQuote && !inTemplate) {
        if (char === '(') depth++;
        else if (char === ')') depth--;
      }
      endIndex++;
    }

    const callText = content.slice(startIndex, endIndex);

    // Check if any user table is mentioned
    const mentionedTables = tableRegexes.filter((t) => t.regex.test(callText));
    if (mentionedTables.length > 0) {
      const hasUserId = /\buser_id\b/i.test(callText);
      const hasScopeOk = /\/\*\s*scope-ok\b/i.test(callText) || /\/\*\s*admin-scope\b/i.test(callText);

      if (!hasUserId && !hasScopeOk) {
        violations.push({
          file: relPath,
          line: lineNumber,
          tables: mentionedTables.map((t) => t.name).join(', '),
          snippet: callText.replace(/\s+/g, ' ').slice(0, 100),
        });
      }
    }
  }
}

console.log(`Проверено файлов: ${files.length}`);
if (violations.length > 0) {
  console.error(`\nОШИБКИ ИЗОЛЯЦИИ (${violations.length}):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [таблицы: ${v.tables}] -> ${v.snippet}`);
  }
  process.exit(1);
} else {
  console.log('Все SQL-запросы в server/ изолированы по user_id (или помечены scope-ok / admin-scope).');
  process.exit(0);
}

