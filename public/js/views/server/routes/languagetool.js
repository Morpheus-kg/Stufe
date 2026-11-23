// POST /api/languagetool/check — быстрая проверка немецкой грамматики/орфографии через LanguageTool.
// Не затрагивает БД, авторизацию и существующие LLM-роуты; при сбое LT отдаёт тихий fallback (HTTP 200).
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { languageToolService } from '../services/languagetool_service.js';

export const mountPath = '/api/languagetool';
const router = Router();

const checkRequestSchema = z.object({
  text: z.string().min(1).max(5000),
  language: z.enum(['de-DE', 'de-AT', 'de-CH']).optional(),
});

router.post('/check', requireAuth, asyncHandler(async (req, res) => {
  const body = validate(checkRequestSchema, req.body || {}, 'Передайте текст до 5000 символов.');
  const result = await languageToolService.check(body.text, { language: body.language || 'de-DE' });
  res.json(result);
}));

export default router;
