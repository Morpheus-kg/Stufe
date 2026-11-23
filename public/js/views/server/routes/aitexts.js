// M8a: генерация и анализ текстов (/api/ai/generate-text, /api/ai/analyze-text) с изоляцией по user_id
import { Router } from 'express';
import { asyncHandler } from '../errors.js';
import { requireAuth } from '../auth.js';
import { generateText, analyzeText } from '../ai/textgen.js';
import { parseBody, generateTextRequestSchema, analyzeTextRequestSchema } from '../ai/schemas_v2.js';

export const mountPath = '/api/ai';
const router = Router();

router.post('/generate-text', requireAuth, asyncHandler(async (req, res) => {
  const params = parseBody(generateTextRequestSchema, req.body);
  res.status(201).json(await generateText(params, {}, req.user.id));
}));

router.post('/analyze-text', requireAuth, asyncHandler(async (req, res) => {
  const { text_id: textId, provider } = parseBody(analyzeTextRequestSchema, req.body);
  res.json(await analyzeText(textId, { provider }, req.user.id));
}));

export default router;
