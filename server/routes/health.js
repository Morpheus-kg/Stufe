// /api/health: публичная проверка живости (без данных)
import { Router } from 'express';

export const mountPath = '/api/health';
const router = Router();
export default router;

router.get('/', (req, res) => {
  res.json({ ok: true });
});