// /api/settings: чтение и частичное обновление настроек с привязкой к user_id
import { Router } from 'express';
import { asyncHandler, validate } from '../errors.js';
import { requireAuth } from '../auth.js';
import { getSettings, saveSettings, settingsPatchSchema } from '../settings.js';

export const mountPath = '/api/settings';
const router = Router();
export default router;

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  res.json(await getSettings(null, req.user.id));
}));

router.put('/', requireAuth, asyncHandler(async (req, res) => {
  const patch = validate(settingsPatchSchema, req.body, 'Некорректные настройки');
  await saveSettings(patch, null, req.user.id);
  res.json(await getSettings(null, req.user.id));
}));
