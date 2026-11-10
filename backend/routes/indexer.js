/**
 * GET  /api/indexer        —— 索引状态（Transfer 索引 + ModifyLiquidity 台账索引）
 * POST /api/indexer/sync   —— 触发同步（进程内互斥；重复请求返回 syncInProgress）
 */
const express = require('express');
const router = express.Router();
const indexer = require('../lib/indexer');
const ledger = require('../lib/ledger');

router.get('/', async (req, res) => {
  try {
    const [status, ml] = await Promise.all([indexer.getIndexStatus(), ledger.getMlStatus()]);
    res.json({ transfer: status, liquidityEvents: ml });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const budgetMs = Math.min(Number((req.body && req.body.budgetMs) || req.query.budgetMs) || 8000, 20000);
    const t = await indexer.syncOnce({ maxMs: budgetMs });
    let ml = await ledger.getMlStatus();
    // 台账索引：按需同步（最多再花 10 秒）
    if (!ml.lastSyncedBlock || !ml.lastSyncedAt || (Date.now() - new Date(ml.lastSyncedAt).getTime()) > 10 * 60 * 1000) {
      try { ml = await ledger.syncLiquidityEvents({ maxMs: 10000 }); } catch (e) { ml = { ...ml, error: String(e.message || e).slice(0, 200) }; }
    }
    res.json({ transfer: t, liquidityEvents: ml });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
