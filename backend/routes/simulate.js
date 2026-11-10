/**
 * POST /api/simulate/mint   —— 建仓模拟（只模拟，不签名，不发交易）
 * POST /api/simulate/remove —— 撤池模拟（同上）
 * POST /api/simulate/quote  —— 本地兑换估算（退出滑点 / 多余资产兑换）
 * 全部只读：不构造交易、不请求任何签名；M2 阶段写操作仍被运行时拦截器封锁。
 */
const express = require('express');
const router = express.Router();
const ledger = require('../lib/ledger');
const chain = require('../lib/chain');
const { simulateMint, simulateRemove, quoteSwap } = require('../lib/simulator');
const { assertWriteEnabled } = require('../lib/tx-guard');

// 运行时写保护：模拟路由不得出现任何写路径（防御性检查，M3 前始终抛错）
function noWrites() {
  try { assertWriteEnabled('positionManager'); } catch (e) { return; }
  // 理论上不可达（M2 白名单 writeEnabled=false）；如被误改则拒绝服务
  throw new Error('写权限被意外开启，模拟器拒绝服务（请检查白名单）');
}

router.post('/mint', async (req, res) => {
  try {
    noWrites();
    await ledger.ensureSynced();
    const out = await simulateMint(req.body || {});
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 400) });
  }
});

router.post('/remove', async (req, res) => {
  try {
    noWrites();
    const out = await simulateRemove(req.body || {});
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 400) });
  }
});

router.post('/quote', async (req, res) => {
  try {
    noWrites();
    const { zeroForOne, amountIn } = req.body || {};
    const poolState = await chain.getPoolState();
    const amt = BigInt(String(amountIn || '0'));
    if (amt <= 0n) return res.status(400).json({ error: 'amountIn 必须为正整数（最小单位）' });
    await ledger.ensureSynced();
    const q = await quoteSwap({ zeroForOne: !!zeroForOne, amountIn: amt, poolState });
    if (!q) return res.status(400).json({ error: '无法估算' });
    res.json({
      zeroForOne: !!zeroForOne,
      amountIn: amt.toString(),
      amountOut: q.amountOut.toString(),
      feePaid: q.feePaid.toString(),
      priceImpactPct: Number(q.priceImpactPct.toFixed(4)),
      ticksCrossed: q.ticksCrossed,
      partial: q.partial,
      source: '本地 V4 数学估算（跨 tick 走位；非链上 Quoter）',
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 400) });
  }
});

module.exports = router;
