/**
 * GET /api/analysis/:tokenId?bridgeCostUsd=0
 * 只读分析：建仓台账 + 无常损失 / HODL 对照 + Break-even + 价格情景。
 */
const express = require('express');
const router = express.Router();
const ledger = require('../lib/ledger');
const { analyzePosition } = require('../lib/analysis');

router.get('/:tokenId', async (req, res) => {
  const tokenId = String(req.params.tokenId || '').trim();
  if (!/^\d{1,20}$/.test(tokenId)) return res.status(400).json({ error: '无效的 tokenId' });
  try {
    await ledger.ensureSynced();
    const out = await analyzePosition(tokenId, { bridgeCostUsd: req.query.bridgeCostUsd });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 400) });
  }
});

module.exports = router;
