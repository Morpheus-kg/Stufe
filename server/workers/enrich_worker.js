// Фоновый воркер дообогащения карточек (enriched = 0, active = 1): подхватывает то, что не успело обогатиться при создании
import { query } from '../db.js';
import { enrichCards, ENRICH_MAX_ATTEMPTS } from '../ai/enrich.js';

const INTERVAL_MS = Number(process.env.ENRICH_INTERVAL_MS) || 60_000;
const USERS_PER_TICK = 5;
let timer = null;
let running = false;

/** Один проход: выбирает пользователей с необогащёнными карточками и обогащает по очереди */
export async function tick() {
  if (running) return { skipped: true };
  running = true;
  try {
    const users = await query(
      'SELECT c.user_id AS user_id FROM cards c JOIN users u ON u.id = c.user_id '
      + 'WHERE c.enriched = 0 AND c.active = 1 AND u.disabled = 0 AND u.ai_mode <> \'off\' '
      + `AND c.enrich_attempts < ${ENRICH_MAX_ATTEMPTS} AND (c.enrich_next_at IS NULL OR c.enrich_next_at <= UTC_TIMESTAMP()) `
      + `GROUP BY c.user_id LIMIT ${USERS_PER_TICK} /* scope-ok: system worker, дальше enrichCards(…, user_id) */`,
    );
    let processed = 0;
    for (const row of users || []) {
      try {
        const r = await enrichCards(10, Number(row.user_id), { respectBackoff: true });
        processed += r.processed || 0;
      } catch {
        // сбой одного пользователя (лимит, ИИ недоступен) не останавливает остальных
      }
    }
    return { users: (users || []).length, processed };
  } catch {
    return { error: true };
  } finally {
    running = false;
  }
}

export function startEnrichWorker() {
  if (timer || process.env.ENRICH_WORKER === '0') return;
  timer = setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  timer.unref?.();
}

export function stopEnrichWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

