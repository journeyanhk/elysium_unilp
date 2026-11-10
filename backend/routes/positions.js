/**
 * GET /api/positions?address=0x...
 * 只读持仓数据：索引同步 → 链上校验（ownerOf / positionInfo / 流动性）→ 待领费用（feeGrowth 数学）
 * → 多窗口年化（基于采样，样本不足不显示）→ 采样记录。
 * 不构造任何交易、不请求任何签名。
 */
const express = require('express');
const { dbQuery } = require('@surf-ai/sdk/db');
const router = express.Router();
const indexer = require('../lib/indexer');
const chain = require('../lib/chain');
const sampling = require('../lib/sampling');
const { getPrices } = require('../lib/prices');
const { CHAIN, POOLS } = require('../config/whitelist');

const CHAIN_ID = CHAIN.id;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const YEAR_SECONDS = 365 * 24 * 3600;
const WINDOWS = [['h1', 3600e3], ['h24', 86400e3], ['d7', 7 * 86400e3], ['d30', 30 * 86400e3]];
const toNum = (s, dec = 18) => Number(s) / Math.pow(10, dec);

router.get('/', async (req, res) => {
  const address = String(req.query.address || '').trim();
  if (!ADDR_RE.test(address)) return res.status(400).json({ error: '无效的钱包地址' });
  try {
    const budgetMs = Math.min(Number(req.query.budgetMs) || 6000, 15000);
    await indexer.syncOnce({ maxMs: budgetMs });
    const index = await indexer.getIndexStatus();
    const cand = await indexer.candidatesForWalletDetailed(address);
    const ids = cand.ids;
    const prices = await getPrices();
    const bundle = await chain.loadWallet(address, ids);
    // 链上 ownerOf 二次校验（与请求地址比对）
    bundle.positions = bundle.positions.map((p) => ({ ...p, ownerMatches: String(p.ownerOnchain).toLowerCase() === address.toLowerCase() }));
    const hypeUsd = prices.HYPE ? prices.HYPE.usd : null;
    const kntqUsd = prices.KNTQ ? prices.KNTQ.usd : null;
    const now = Date.now();

    // 采样时间序列（供多窗口年化）
    const samplesByToken = new Map();
    if (bundle.positions.length) {
      const { rows } = await dbQuery(
        `SELECT token_id, sampled_at, fee0_pending, fee1_pending FROM position_samples
         WHERE chain_id=$1 AND token_id = ANY($2) AND sampled_at > now() - interval '31 days'
         ORDER BY sampled_at ASC`,
        [CHAIN_ID, bundle.positions.map((p) => p.tokenId)]);
      for (const r of rows) {
        const arr = samplesByToken.get(r.token_id) || [];
        arr.push({ t: new Date(r.sampled_at).getTime(), f0: r.fee0_pending, f1: r.fee1_pending });
        samplesByToken.set(r.token_id, arr);
      }
    }

    const enriched = bundle.positions.map((p) => {
      const amount0 = p.amount0 != null ? toNum(p.amount0) : null;
      const amount1 = p.amount1 != null ? toNum(p.amount1) : null;
      const fee0 = p.fee0 != null ? toNum(p.fee0) : null;
      const fee1 = p.fee1 != null ? toNum(p.fee1) : null;
      const principalUsd = amount0 != null && hypeUsd != null ? amount0 * hypeUsd + (amount1 || 0) * (kntqUsd || 0) : null;
      const feesUsd = fee0 != null && hypeUsd != null ? fee0 * hypeUsd + (fee1 || 0) * (kntqUsd || 0) : null;
      const samples = samplesByToken.get(p.tokenId) || [];
      const windows = {};
      for (const [key, winMs] of WINDOWS) {
        if (fee0 == null || samples.length < 2) { windows[key] = null; continue; }
        const inWin = samples.filter((s) => s.t >= now - winMs);
        if (inWin.length < 2) { windows[key] = null; continue; }
        const spanSec = (now - inWin[0].t) / 1000;
        if (spanSec < (winMs / 1000) * 0.5) { windows[key] = null; continue; } // 样本跨度不足 → 不显示
        const d0 = fee0 - toNum(inWin[0].f0);
        const d1 = (fee1 || 0) - toNum(inWin[0].f1);
        const earnedUsd = Math.max(0, d0) * (hypeUsd || 0) + Math.max(0, d1) * (kntqUsd || 0);
        windows[key] = principalUsd && principalUsd > 0
          ? { apr: (earnedUsd / principalUsd) * (YEAR_SECONDS / spanSec) * 100, earnedUsd, spanSec: Math.round(spanSec), samples: inWin.length }
          : null;
      }
      let speedUsdPerDay = null;
      let speedBasis = null;
      for (const key of ['h24', 'h1', 'd7', 'd30']) {
        const w = windows[key];
        if (w) { speedUsdPerDay = (w.earnedUsd / w.spanSec) * 86400; speedBasis = key; break; }
      }
      return {
        ...p, amount0, amount1, fee0, fee1, principalUsd, feesUsd, windows, speedUsdPerDay, speedBasis,
        sampleCount: samples.length,
        lastSampleAt: samples.length ? new Date(samples[samples.length - 1].t).toISOString() : null,
      };
    });

    // 记录采样（节流 4 分钟；失败不影响读取）
    try {
      await sampling.recordPositionSamples(address, bundle.positions.filter((p) => p.poolMatch), bundle.pool);
    } catch (e) { /* 忽略 */ }

    const poolMeta = POOLS['KNTQ/HYPE (1%)'];
    const ageDays = (now - new Date(poolMeta.createdAt).getTime()) / 86400000;
    const warnings = [];
    if (ageDays < 7) warnings.push(`池龄不足 7 天（约 ${ageDays.toFixed(1)} 天）`);
    warnings.push('稳定性样本不足（年化需持续采样累积）');
    warnings.push('禁止默认推荐（部署身份待官方确认 + 早期数据）');

    const price1Per0 = Math.pow(Number(bundle.pool.sqrtPriceX96) / 2 ** 96, 2);

    res.json({
      address,
      chainId: CHAIN_ID,
      at: new Date().toISOString(),
      index: { ...index, needResync: !index.synced || bundle.positions.some((p) => !p.ownerMatches) },
      candidates: { total: cand.totalCandidates, returned: cand.returned, truncated: cand.truncated },
      rpc: chain.getRpcStatus(),
      prices,
      balances: bundle.balances,
      pool: { ...bundle.pool, price1Per0, impliedKntqUsd: hypeUsd != null && price1Per0 > 0 ? hypeUsd / price1Per0 : null },
      poolMeta: { createdAt: poolMeta.createdAt, createdBlock: poolMeta.createdBlock, ageDays: Number(ageDays.toFixed(2)), statusLabel: '已观察到链上活动' },
      warnings,
      positions: enriched.filter((p) => p.ownerMatches),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 400) });
  }
});

module.exports = router;
