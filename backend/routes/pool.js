/**
 * GET /api/pool —— 目标池状态（只读）：价格 / tick / 流动性 / 池龄 / 市场快照。
 * 状态措辞遵循 review 要求：不标「活跃池」，标「已观察到链上活动」+ 风险提示。
 */
const express = require('express');
const router = express.Router();
const chain = require('../lib/chain');
const { getPrices, getPoolMarket } = require('../lib/prices');
const { CHAIN, POOLS } = require('../config/whitelist');

router.get('/', async (_req, res) => {
  try {
    const [pool, market, prices] = await Promise.all([chain.getPoolState(), getPoolMarket(), getPrices()]);
    const poolMeta = POOLS['KNTQ/HYPE (1%)'];
    const ageDays = (Date.now() - new Date(poolMeta.createdAt).getTime()) / 86400000;
    const price1Per0 = Math.pow(Number(pool.sqrtPriceX96) / 2 ** 96, 2);
    const hypeUsd = prices.HYPE ? prices.HYPE.usd : null;
    res.json({
      pool: { ...pool, price1Per0, impliedKntqUsd: hypeUsd != null && price1Per0 > 0 ? hypeUsd / price1Per0 : null },
      market,
      prices,
      meta: {
        createdAt: poolMeta.createdAt,
        createdBlock: poolMeta.createdBlock,
        ageDays: Number(ageDays.toFixed(2)),
        statusLabel: '已观察到链上活动',
        warnings: [
          ageDays < 7 ? `池龄不足 7 天（约 ${ageDays.toFixed(1)} 天）` : null,
          '稳定性样本不足（首日成交量不作为稳定性依据）',
          '禁止默认推荐（部署身份待官方确认 + 早期数据）',
        ].filter(Boolean),
      },
      rpc: chain.getRpcStatus(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
});

module.exports = router;
