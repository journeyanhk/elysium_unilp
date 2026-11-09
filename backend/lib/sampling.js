/**
 * 采样（M1）：池状态与头寸待领费用时间序列 → 供多窗口年化使用。
 * 由 cron（每 5 分钟）与 /api/positions 请求触发；节流：同一头寸 4 分钟内只采一次。
 */
const { dbQuery } = require('@surf-ai/sdk/db');
const chain = require('./chain');
const { ensureIndexes } = require('./db');
const { CHAIN } = require('../config/whitelist');

const CHAIN_ID = CHAIN.id;
const POOL_ID = chain.POOL_ID;
const SAMPLE_INTERVAL_MS = 4 * 60 * 1000;

async function samplePool() {
  const ps = await chain.getPoolState();
  await dbQuery(
    `INSERT INTO pool_samples (chain_id, pool_id, tick, sqrt_price_x96, liquidity, fee_growth_global0, fee_growth_global1)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [CHAIN_ID, POOL_ID, ps.tick, ps.sqrtPriceX96, ps.liquidity, ps.feeGrowthGlobal0, ps.feeGrowthGlobal1]);
  return ps;
}

async function recordPositionSamples(address, positions, poolState) {
  if (!positions.length) return 0;
  await ensureIndexes();
  const ids = positions.map((p) => p.tokenId);
  const { rows } = await dbQuery(
    `SELECT token_id, MAX(sampled_at) AS last_at FROM position_samples WHERE chain_id=$1 AND token_id = ANY($2) GROUP BY token_id`,
    [CHAIN_ID, ids]);
  const lastMap = new Map(rows.map((r) => [r.token_id, r.last_at ? new Date(r.last_at).getTime() : 0]));
  const now = Date.now();
  let inserted = 0;
  for (const p of positions) {
    if (p.fee0 == null) continue;
    const last = lastMap.get(p.tokenId) || 0;
    if (now - last < SAMPLE_INTERVAL_MS) continue;
    await dbQuery(
      `INSERT INTO position_samples (chain_id, token_id, pool_id, liquidity, fee0_pending, fee1_pending, tick, sqrt_price_x96)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [CHAIN_ID, p.tokenId, POOL_ID, p.liquidity, p.fee0, p.fee1, poolState.tick, poolState.sqrtPriceX96]);
    inserted++;
  }
  // 更新被跟踪头寸（cron 采样范围）—— 原子 upsert（依赖唯一索引）
  for (const p of positions) {
    await dbQuery(
      `INSERT INTO tracked_positions (chain_id, token_id, owner_addr, last_seen_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (chain_id, token_id) DO UPDATE SET owner_addr = EXCLUDED.owner_addr, last_seen_at = now()`,
      [CHAIN_ID, p.tokenId, address || p.ownerOnchain || '']);
  }
  return inserted;
}

async function sampleTrackedPositions(limit = 25) {
  const { rows } = await dbQuery(
    `SELECT token_id FROM tracked_positions WHERE chain_id=$1 AND last_seen_at > now() - interval '7 days' ORDER BY last_seen_at DESC LIMIT $2`,
    [CHAIN_ID, limit]);
  if (!rows.length) return { sampled: 0, positions: 0 };
  const ids = rows.map((r) => r.token_id);
  const { pool, positions } = await chain.loadPositions(ids);
  const n = await recordPositionSamples('', positions.filter((p) => p.poolMatch), pool);
  return { sampled: n, positions: ids.length };
}

module.exports = { samplePool, recordPositionSamples, sampleTrackedPositions };
