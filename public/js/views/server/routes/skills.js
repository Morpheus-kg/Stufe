// Сводка по навыкам за 30 дней (CONTRACT v2, 4.1) с изоляцией по user_id
import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { localDay, nowUtc, toSql } from '../time.js';
import { skillOfKind, shiftDay, dayStr, safeJson } from '../activities.js';

export const mountPath = '/api/skills';
const router = Router();

const BY_SKILL_KEYS = ['hoeren', 'lesen', 'sprechen', 'schreiben', 'wortschatz'];
const ERROR_CATEGORIES = [
  'artikel', 'kasus', 'wortstellung', 'praeposition',
  'konjugation', 'rechtschreibung', 'wortschatz', 'sonstiges',
];
const TREND_MIN_N = 3;
const TREND_DELTA = 0.05;
const MAX_ERRORS_PER_VALUE = 200;

const num = (v) => Number(v) || 0;
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp01 = (n) => Math.min(1, Math.max(0, n));

function trendOf(a) {
  if (a.n <= 0 || a.nR < TREND_MIN_N || a.nO < TREND_MIN_N) return null;
  const diff = a.sumR / a.nR - a.sumO / a.nO;
  if (diff >= TREND_DELTA) return 'up';
  if (diff <= -TREND_DELTA) return 'down';
  return 'flat';
}

export function buildBySkill(rows, today) {
  const since7 = shiftDay(today, -6);
  const since30 = shiftDay(today, -29);
  const recentFrom = shiftDay(today, -9);
  const acc = {};
  for (const k of BY_SKILL_KEYS) acc[k] = { sec7: 0, sec30: 0, n: 0, sum: 0, nR: 0, sumR: 0, nO: 0, sumO: 0 };
  for (const r of rows) {
    const a = acc[r.skill];
    if (!a || !r.day || r.day < since30 || r.day > today) continue;
    const secs = num(r.secs);
    const n = num(r.n);
    const sum = num(r.sum01);
    a.sec30 += secs;
    if (r.day >= since7) a.sec7 += secs;
    a.n += n;
    a.sum += sum;
    if (r.day >= recentFrom) { a.nR += n; a.sumR += sum; } else { a.nO += n; a.sumO += sum; }
  }
  const out = {};
  for (const k of BY_SKILL_KEYS) {
    const a = acc[k];
    out[k] = {
      minutes_7d: round1(a.sec7 / 60),
      minutes_30d: round1(a.sec30 / 60),
      accuracy_30d: a.n > 0 ? round3(clamp01(a.sum / a.n)) : null,
      trend: trendOf(a),
    };
  }
  return out;
}

export function pickWeakest(bySkill) {
  const has = BY_SKILL_KEYS.some((k) => bySkill[k].minutes_30d > 0 || bySkill[k].accuracy_30d !== null);
  if (!has) return null;
  let best = null;
  for (const k of BY_SKILL_KEYS) {
    const acc = bySkill[k].accuracy_30d ?? -1;
    const min = bySkill[k].minutes_30d;
    if (!best || acc < best.acc || (acc === best.acc && min < best.min)) best = { k, acc, min };
  }
  return best.k;
}

export function buildActivityDays(actRows, statsRows, today) {
  const since30 = shiftDay(today, -29);
  const days = new Map();
  const slot = (day) => {
    if (!days.has(day)) days.set(day, { secs: 0, kinds: new Set() });
    return days.get(day);
  };
  for (const r of actRows) {
    if (!r.day || r.day < since30 || r.day > today) continue;
    const s = slot(r.day);
    s.secs += num(r.secs);
    if (r.kind) s.kinds.add(r.kind);
  }
  for (const r of statsRows) {
    if (!r.day || r.day < since30 || r.day > today) continue;
    if (num(r.reviews) <= 0 && num(r.secs) <= 0) continue;
    const s = slot(r.day);
    s.secs += num(r.secs);
    s.kinds.add('cards');
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, s]) => ({ day, minutes: round1(s.secs / 60), kinds: [...s.kinds].sort() }));
}

function errorsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  const out = [];
  if (Array.isArray(parsed.errors)) out.push(...parsed.errors);
  if (Array.isArray(parsed.items)) {
    for (const it of parsed.items) if (it && Array.isArray(it.errors)) out.push(...it.errors);
  }
  return out;
}

export function countErrorCategories(values) {
  const counts = {};
  for (const v of values ?? []) {
    const parsed = typeof v === 'string' ? safeJson(v, null) : v;
    for (const e of errorsOf(parsed).slice(0, MAX_ERRORS_PER_VALUE)) {
      if (!e || typeof e !== 'object' || typeof e.category !== 'string' || !e.category.trim()) continue;
      const c = e.category.trim().toLowerCase();
      const cat = ERROR_CATEGORIES.includes(c) ? c : 'sonstiges';
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
  }
  return counts;
}

router.get('/summary', requireAuth, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const now = nowUtc();
  const today = localDay(now);
  const since30 = shiftDay(today, -29);
  const cutoff = toSql(new Date(now.getTime() - 30 * 86400000));

  const [acts, revs, stats, numRows, sent, sets, writ] = await Promise.all([
    query(
      `SELECT local_day, kind, SUM(seconds) AS secs, COUNT(score) AS score_n, COALESCE(SUM(score), 0) AS score_sum
       FROM activities WHERE user_id = ? AND local_day >= ? GROUP BY local_day, kind`, [userId, since30]),
    query(
      `SELECT local_day, mode, COUNT(*) AS n, COALESCE(SUM(correct), 0) AS c
       FROM review_log WHERE user_id = ? AND local_day >= ? GROUP BY local_day, mode`, [userId, since30]),
    query('SELECT day, reviews, active_seconds FROM daily_stats WHERE user_id = ? AND day >= ?', [userId, since30]),
    query('SELECT COUNT(*) AS n, COALESCE(SUM(correct), 0) AS c FROM number_attempts WHERE user_id = ? AND local_day >= ?', [userId, since30]),
    query('SELECT errors FROM sentences WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 2000', [userId, cutoff]),
    query('SELECT result FROM translation_sets WHERE user_id = ? AND result IS NOT NULL AND local_day >= ? LIMIT 2000', [userId, since30]),
    query('SELECT result FROM writing_attempts WHERE user_id = ? AND result IS NOT NULL AND local_day >= ? LIMIT 2000', [userId, since30]),
  ]);

  const actRows = acts.map((r) => ({ day: dayStr(r.local_day), kind: r.kind, secs: num(r.secs) }));
  const statsRows = stats.map((r) => ({ day: dayStr(r.day), reviews: num(r.reviews), secs: num(r.active_seconds) }));

  const rows = [];
  for (const r of acts) {
    const skill = skillOfKind(r.kind);
    if (!skill) continue;
    rows.push({ day: dayStr(r.local_day), skill, secs: num(r.secs), n: num(r.score_n), sum01: num(r.score_sum) / 100 });
  }
  for (const r of revs) {
    const day = dayStr(r.local_day);
    rows.push({ day, skill: 'wortschatz', secs: 0, n: num(r.n), sum01: num(r.c) });
  }
  for (const r of statsRows) rows.push({ day: r.day, skill: 'wortschatz', secs: r.secs, n: 0, sum01: 0 });

  const by_skill = buildBySkill(rows, today);
  const nTotal = num(numRows[0]?.n);

  res.json({
    by_skill,
    numbers: { accuracy_30d: nTotal > 0 ? round3(clamp01(num(numRows[0]?.c) / nTotal)) : null },
    activity_days_30: buildActivityDays(actRows, statsRows, today),
    error_categories_30d: countErrorCategories([
      ...sent.map((r) => r.errors),
      ...sets.map((r) => r.result),
      ...writ.map((r) => r.result),
    ]),
    weakest: pickWeakest(by_skill),
  });
}));

export default router;
