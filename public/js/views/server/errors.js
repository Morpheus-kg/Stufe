// Ошибки API и обёртки для express
export class ApiError extends Error {
  /**
   * @param {number} status HTTP-статус
   * @param {string} code BAD_REQUEST | UNAUTHORIZED | NOT_FOUND | RATE_LIMITED | AI_UNAVAILABLE | AI_CAP | CONFLICT | INTERNAL
   * @param {string} message текст для пользователя (по-русски)
   * @param {object} [extra] доп. поля тела ошибки (например existing_id)
   */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Оборачивает async-обработчик: любая ошибка уходит в error handler */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).catch(next);
};

/** Единый формат ответа с ошибкой */
export function sendError(res, status, code, message, extra = {}) {
  res.status(status).json({ error: { code, message, ...extra } });
}

/**
 * Проверка данных по zod-схеме. Значения из запроса в сообщение не попадают.
 * @returns {any} разобранные данные
 */
export function validate(schema, data, message = 'Некорректные данные запроса') {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const path = (r.error.issues[0]?.path ?? []).join('.');
  throw new ApiError(400, 'BAD_REQUEST', path ? `${message}: ${path}` : message);
}