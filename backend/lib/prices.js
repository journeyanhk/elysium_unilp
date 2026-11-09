/**
 * 价格与池市场数据（M1）：Surf 为主，DexScreener 兜底；全部带来源与时间戳。
 */
const { dataApi } = require('@surf-ai/sdk/server');
const { POOLS } = require('../config/whitelist');

const KNTQ_ADDRESS = '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0';
const POOL_ID = POOLS['KNTQ/HYPE (1%)'].poolId;

let priceCache = { at: 0, data: null };
let marketCache = { at: 0, data: null };

async function surfLast(symbol) {
  const res = await dataApi.market.price({ symbol, time_range: '1d' });
  const last = res && res.summary && typeof res.summary.last === 'number' ? res.summary.last : null;
  if (last == null || !(last > 0)) return null;
  const dt = res.summary && res.summary.latest_dt ? new Date(res.summary.latest_dt * 1000).toISOString() : new Date().toISOString();
  return { usd: last, at: dt };
}

async function dexPoolSnapshot() {
  if (marketCache.data && Date.now() - marketCache.at < 5 * 60 * 1000) return marketCache.data;
  const r = await fetch(`https://api.dexscreener.com/token-pairs/v1/elysium/${KNTQ_ADDRESS}`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
  const arr = await r.json();
  const pair = Array.isArray(arr) ? arr.find((p) => p.pairAddress && p.pairAddress.toLowerCase() === POOL_ID.toLowerCase()) : null;
  if (!pair) return null;
  const data = {
    priceUsd: pair.priceUsd != null ? Number(pair.priceUsd) : null,
    liqUsd: pair.liquidity && pair.liquidity.usd != null ? Number(pair.liquidity.usd) : null,
    vol24Usd: pair.volume && pair.volume.h24 != null ? Number(pair.volume.h24) : null,
    dexId: pair.dexId || null,
    labels: pair.labels || [],
    snapshotAt: new Date().toISOString(),
    source: 'dexscreener',
  };
  marketCache = { at: Date.now(), data };
  return data;
}

async function getPrices() {
  if (priceCache.data && Date.now() - priceCache.at < 60000) return priceCache.data;
  const out = { HYPE: null, KNTQ: null, USDC: { usd: 1, source: 'pegged', at: new Date().toISOString() } };
  try { const h = await surfLast('HYPE'); if (h) out.HYPE = { ...h, source: 'surf' }; } catch (e) { /* 忽略，走兜底 */ }
  try { const k = await surfLast('KNTQ'); if (k) out.KNTQ = { ...k, source: 'surf' }; } catch (e) { /* 忽略 */ }
  if (!out.KNTQ) {
    try {
      const d = await dexPoolSnapshot();
      if (d && d.priceUsd) out.KNTQ = { usd: d.priceUsd, at: d.snapshotAt, source: 'dexscreener-pool' };
    } catch (e) { /* 保持 null */ }
  }
  priceCache = { at: Date.now(), data: out };
  return out;
}

async function getPoolMarket() {
  try { return await dexPoolSnapshot(); } catch (e) { return null; }
}

module.exports = { getPrices, getPoolMarket };
