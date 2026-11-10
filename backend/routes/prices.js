/**
 * GET /api/prices —— 美元价格（HYPE / KNTQ / USDC），带来源与时间戳。
 */
const express = require('express');
const router = express.Router();
const { getPrices } = require('../lib/prices');

router.get('/', async (_req, res) => {
  try {
    res.json(await getPrices());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
