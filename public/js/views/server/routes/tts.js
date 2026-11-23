// /api/tts: серверная двухголосая нейросетевая озвучка немецкого (Edge Neural TTS + кэш)
import { Router } from 'express';
import { ApiError, asyncHandler } from '../errors.js';
import { synthesizeSpeech } from '../tts_service.js';

export const mountPath = '/api/tts';
const router = Router();
export default router;

router.get('/speak', asyncHandler(async (req, res) => {
  const text = String(req.query.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 600) {
    throw new ApiError(400, 'BAD_REQUEST', 'Укажите text (до 600 символов)');
  }
  const role = String(req.query.role || req.query.voice || 'female').trim();
  const rate = Number(req.query.rate) || 0.95;
  try {
    const { audio, mime, voice } = await synthesizeSpeech(text, { role, rate });
    res.set('Content-Type', mime);
    res.set('X-TTS-Voice', voice);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(audio);
  } catch {
    throw new ApiError(503, 'TTS_UNAVAILABLE', 'Серверная озвучка временно недоступна (используется голос браузера).');
  }
}));

