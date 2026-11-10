/**
 * 建仓台账（M2）—— ModifyLiquidity 事件索引 + 历史价格还原 + IL/HODL 对照 + Break-even。
 * 全部只读：日志查询 + 历史 eth_call；不构造任何交易、不请求签名。
 *
 * 关键事实（已链上验证）：
 *  - V4 的 ModifyLiquidity 事件 salt = bytes32(tokenId)，因此可按 tokenId 还原单个头寸的每次加减仓
 *  - 台账合计（Σ liquidityDelta）与 PositionManager.getPositionLiquidity 完全一致（已验证多个头寸）
 *  - Elysium RPC 支持归档状态读取（stateAt），可还原「事件发生前的池价格」→ 建仓时的资产数量
 */
const { keccak256, toHex } = require('viem');
const { dbQuery } = require('@surf-ai/sdk/db');
const chain = require('./chain');
const v4math = require('./v4math');
const { ensureIndexes } = require('./db');
const { CHAIN, TOKENS, POOLS } = require('../config/whitelist');

const CHAIN_ID = CHAIN.id;
const POOL_ID = POOLS['KNTQ/HYPE (1%)'].poolId;
const ML_TOPIC = keccak256(toHex('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'));
const PM_TOPIC = '0x' + chain.PM_ADDR.slice(2).padStart(64, '0');
const REORG_WINDOW = 3000; // 0.1s/块 → 约 5 分钟
const { decodeAbiParameters } = require('viem');

async function mlStateRow() {
  const { rows } = await dbQuery(
    `SELECT * FROM indexer_state WHERE chain_id=$1 AND position_manager=$2 LIMIT 1`,
    [CHAIN_ID, 'liquidity_events']);
  return rows[0] || null;
}

async function getMlStatus() {
  const st = await mlStateRow();
  const { rows } = await dbQuery('SELECT COUNT(*)::int AS n FROM liquidity_events WHERE chain_id=$1', [CHAIN_ID]);
  return {
    events: rows[0] ? rows[0].n : 0,
    lastSyncedBlock: st ? Number(st.last_synced_block) : null,
    lastSyncedAt: st ? st.last_synced_at : null,
  };
}

/** 同步 ModifyLiquidity 事件（幂等：重叠窗口删除后重插） */
async function syncLiquidityEvents({ maxMs = 25000 } = {}) {
  const t0 = Date.now();
  await ensureIndexes();
  const st = await mlStateRow();
  const latest = await chain.latestBlock();
  const lastSynced = st ? Number(st.last_synced_block) : null;
  if (lastSynced != null && lastSynced >= latest) return { ...(await getMlStatus()), inserted: 0, rounds: 0, elapsedMs: 0 };
  const start = lastSynced != null ? Math.max(chain.DEPLOY_BLOCK, lastSynced + 1 - REORG_WINDOW) : chain.DEPLOY_BLOCK;
  const logs = await chain.getLogsRaw({
    address: chain.POOLM_ADDR,
    topics: [ML_TOPIC, POOL_ID, PM_TOPIC],
    fromBlock: start,
    toBlock: latest,
    chunkSize: 2000000,
  });
  if (lastSynced != null) {
    await dbQuery('DELETE FROM liquidity_events WHERE chain_id=$1 AND pool_id=$2 AND block_number >= $3', [CHAIN_ID, POOL_ID, start]);
  }
  let inserted = 0;
  const B = 100;
  for (let i = 0; i < logs.length; i += B) {
    const batch = logs.slice(i, i + B);
    const values = []; const params = [];
    batch.forEach((lg, j) => {
      const dec = decodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], lg.data);
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      params.push(
        CHAIN_ID, POOL_ID, BigInt(dec[3]).toString(),
        Number(BigInt(lg.blockNumber)), lg.transactionHash, Number(BigInt(lg.logIndex)),
        Number(dec[0]), Number(dec[1]), dec[2].toString(),
      );
    });
    if (values.length) {
      await dbQuery(
        `INSERT INTO liquidity_events (chain_id, pool_id, token_id, block_number, tx_hash, log_index, tick_lower, tick_upper, liquidity_delta)
         VALUES ${values.join(',')} ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`, params);
      inserted += values.length;
    }
  }
  const upd = await dbQuery('UPDATE indexer_state SET last_synced_block=$1, last_synced_at=now() WHERE chain_id=$2 AND position_manager=$3', [latest, CHAIN_ID, 'liquidity_events']);
  if (upd.rowCount === 0) {
    await dbQuery(`INSERT INTO indexer_state (chain_id, position_manager, last_synced_block, last_synced_at) VALUES ($1,$2,$3,now())`, [CHAIN_ID, 'liquidity_events', latest]);
  }
  return { ...(await getMlStatus()), inserted, rounds: 1, elapsedMs: Date.now() - t0 };
}

// —— 历史价格 / 时间（带数据库缓存）——
async function priceBeforeBlock(blockNumber) {
  const b = Number(blockNumber) - 1;
  const { rows } = await dbQuery('SELECT sqrt_price_x96, tick FROM block_prices WHERE chain_id=$1 AND block_number=$2 LIMIT 1', [CHAIN_ID, b]);
  if (rows[0]) return { sqrtPriceX96: rows[0].sqrt_price_x96, tick: Number(rows[0].tick) };
  const st = await chain.stateAt(b);
  if (!st) return null;
  await dbQuery(
    `INSERT INTO block_prices (chain_id, block_number, sqrt_price_x96, tick) VALUES ($1,$2,$3,$4)
     ON CONFLICT (chain_id, block_number) DO NOTHING`, [CHAIN_ID, b, st.sqrtPriceX96, st.tick]);
  return { sqrtPriceX96: st.sqrtPriceX96, tick: st.tick };
}

async function blockTimeOf(blockNumber) {
  const { rows } = await dbQuery('SELECT block_time FROM block_times WHERE chain_id=$1 AND block_number=$2 LIMIT 1', [CHAIN_ID, blockNumber]);
  if (rows[0] && rows[0].block_time) return new Date(rows[0].block_time).getTime();
  const meta = await chain.blockMeta(blockNumber);
  if (!meta) return null;
  await dbQuery(
    `INSERT INTO block_times (chain_id, block_number, block_time) VALUES ($1,$2,$3)
     ON CONFLICT (chain_id, block_number) DO NOTHING`, [CHAIN_ID, blockNumber, new Date(meta.timestamp).toISOString()]);
  return meta.timestamp;
}

/** 各初始化 tick 的净流动性（用于本地兑换估算跨 tick 走位；60 秒缓存） */
let netCache = { at: 0, map: null };
async function tickLiquidityNet() {
  if (netCache.map && Date.now() - netCache.at < 60000) return netCache.map;
  const { rows } = await dbQuery('SELECT tick_lower, tick_upper, liquidity_delta FROM liquidity_events WHERE chain_id=$1 AND pool_id=$2', [CHAIN_ID, POOL_ID]);
  const map = new Map();
  for (const r of rows) {
    const d = BigInt(r.liquidity_delta);
    map.set(Number(r.tick_lower), (map.get(Number(r.tick_lower)) || 0n) + d);
    map.set(Number(r.tick_upper), (map.get(Number(r.tick_upper)) || 0n) - d);
  }
  netCache = { at: Date.now(), map };
  return map;
}

/** 单个头寸的建仓台账（每次加减仓的时间、价格、数量） */
async function getLedger(tokenId) {
  const { rows } = await dbQuery(
    `SELECT block_number, tx_hash, log_index, tick_lower, tick_upper, liquidity_delta
     FROM liquidity_events WHERE chain_id=$1 AND pool_id=$2 AND token_id=$3
     ORDER BY block_number ASC, log_index ASC`, [CHAIN_ID, POOL_ID, String(tokenId)]);
  const events = [];
  let dep0 = 0n; let dep1 = 0n; let wd0 = 0n; let wd1 = 0n;
  for (const r of rows) {
    const price = await priceBeforeBlock(Number(r.block_number));
    const time = await blockTimeOf(Number(r.block_number));
    const delta = BigInt(r.liquidity_delta);
    let amount0 = 0n; let amount1 = 0n;
    if (price && delta !== 0n) {
      const amts = v4math.amountsForLiquidity(
        BigInt(price.sqrtPriceX96),
        v4math.sqrtPriceX96AtTick(Number(r.tick_lower)),
        v4math.sqrtPriceX96AtTick(Number(r.tick_upper)),
        delta < 0n ? -delta : delta);
      amount0 = amts.amount0; amount1 = amts.amount1;
    }
    const add = delta > 0n;
    if (add) { dep0 += amount0; dep1 += amount1; } else { wd0 += amount0; wd1 += amount1; }
    events.push({
      block: Number(r.block_number),
      txHash: r.tx_hash,
      time: time ? new Date(time).toISOString() : null,
      tickLower: Number(r.tick_lower), tickUpper: Number(r.tick_upper),
      liquidityDelta: delta.toString(),
      add,
      priceAtEvent: price ? { sqrtPriceX96: price.sqrtPriceX96, tick: price.tick, kntqPerHype: v4math.priceFromSqrtX96(price.sqrtPriceX96).toString() } : null,
      amount0: amount0.toString(), amount1: amount1.toString(),
    });
  }
  return {
    tokenId: String(tokenId),
    events,
    totals: {
      deposited0: dep0.toString(), deposited1: dep1.toString(),
      withdrawn0: wd0.toString(), withdrawn1: wd1.toString(),
      net0: (dep0 - wd0).toString(), net1: (dep1 - wd1).toString(),
    },
  };
}

/** 按需同步（默认 10 分钟内只同步一次；供模拟/分析路由调用） */
let lastEnsure = 0;
async function ensureSynced({ maxAgeMs = 10 * 60 * 1000 } = {}) {
  const st = await mlStateRow();
  const age = st && st.last_synced_at ? Date.now() - new Date(st.last_synced_at).getTime() : Infinity;
  if (age < maxAgeMs) return await getMlStatus();
  if (Date.now() - lastEnsure < 60 * 1000) return await getMlStatus();
  lastEnsure = Date.now();
  try {
    return await syncLiquidityEvents({ maxMs: 15000 });
  } catch (e) {
    return { ...(await getMlStatus()), error: String(e.message || e).slice(0, 200) };
  }
}

module.exports = { ML_TOPIC, getMlStatus, syncLiquidityEvents, ensureSynced, priceBeforeBlock, blockTimeOf, tickLiquidityNet, getLedger };
