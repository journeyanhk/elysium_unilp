/**
 * GET /api/rpc —— RPC 端点健康（多端点状态、限流记录、活跃端点）
 * 只读：仅展示 lib/chain.js 运行时的端点状态与最新区块。
 */
const express = require('express');
const router = express.Router();
const chain = require('../lib/chain');

router.get('/', async (req, res) => {
  try {
    const status = chain.getRpcStatus();
    let latestBlock = null; let gasPriceWei = null; let error = null;
    try {
      latestBlock = await chain.latestBlock();
      const gp = await chain.rpcRequest('eth_gasPrice', []);
      gasPriceWei = gp ? String(BigInt(gp)) : null;
    } catch (e) { error = String(e.message || e).slice(0, 200); }
    res.json({
      ...status,
      latestBlock, gasPriceWei,
      rateLimitNote: '公共端点有速率限制：命中限流会自动切换端点并退避重试（上限 4 次）',
      error,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
