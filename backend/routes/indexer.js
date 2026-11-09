/**
 * GET  /api/indexer          —— 索引状态（进度 / 最后同步区块与时间）
 * POST /api/indexer/sync     —— 执行一轮有预算的增量同步（前端在未完成时循环调用）
 */
const express = require('express');
const router = express.Router();
const indexer = require('../lib/indexer');

router.get('/', async (_req, res) => {
  try {
    res.json(await indexer.getIndexStatus());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const maxMs = Math.min(Number(req.body && req.body.budgetMs) || 8000, 15000);
    res.json(await indexer.syncOnce({ maxMs }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
