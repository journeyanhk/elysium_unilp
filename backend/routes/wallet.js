/**
 * GET /api/wallet?address=0x... —— 余额读取（原生 HYPE + 白名单代币），带美元估值与来源。
 */
const express = require('express');
const router = express.Router();
const chain = require('../lib/chain');
const { getPrices } = require('../lib/prices');
const { CHAIN } = require('../config/whitelist');

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const toNum = (s, dec) => Number(s) / Math.pow(10, dec);

router.get('/', async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!ADDR_RE.test(address)) return res.status(400).json({ error: '无效的钱包地址' });
  try {
    const [bundle, prices] = await Promise.all([chain.loadWallet(address, []), getPrices()]);
    const balances = bundle.balances.map((b) => {
      const amount = toNum(b.raw, b.decimals);
      const p = prices[b.symbol];
      return { ...b, amount, usd: p && p.usd != null ? amount * p.usd : null };
    });
    res.json({ address, chainId: CHAIN.id, block: bundle.block, balances, prices, rpc: chain.getRpcStatus(), at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
