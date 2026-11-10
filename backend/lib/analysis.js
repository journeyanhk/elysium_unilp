/**
 * M2 风险分析 —— 无常损失 / HODL 对照 / Break-even（只读计算，不签名、不发交易）。
 *
 * HODL 对照口径（按 review 要求，基于建仓时数量而非仅比较美元本金）：
 *   基准 = 建仓台账中的「净投入数量」（累计存入 − 累计取出，按各次事件发生前的池价格折算）
 *   把这些数量一直持有到现在（不做 LP）的价值 vs 当前 LP（剩余本金 + 待领手续费）的价值。
 * 注意：链上不记录「已领取的手续费」，因此若历史上有领费，本对照会把已领部分算作损失（页面已注明）。
 */
const { dbQuery } = require('@surf-ai/sdk/db');
const chain = require('./chain');
const ledger = require('./ledger');
const v4math = require('./v4math');
const { getPrices } = require('./prices');
const { GAS_STATIC } = require('./simulator');
const { CHAIN, POOLS } = require('../config/whitelist');

const POOL = POOLS['KNTQ/HYPE (1%)'];
const fmtNum = (v, d = 18) => Number(v) / Math.pow(10, d);

async function feeVelocityUsdPerDay(tokenId, hypeUsd, kntqUsd) {
  const { rows } = await dbQuery(
    `SELECT sampled_at, fee0_pending, fee1_pending FROM position_samples
     WHERE chain_id=$1 AND token_id=$2 AND sampled_at > now() - interval '25 hours'
     ORDER BY sampled_at ASC`, [CHAIN.ID, String(tokenId)]);
  if (rows.length < 2) return { usdPerDay: null, samples: rows.length, note: '采样不足（需 ≥2 条、跨度越长越准）' };
  const first = rows[0]; const last = rows[rows.length - 1];
  const spanSec = (new Date(last.sampled_at).getTime() - new Date(first.sampled_at).getTime()) / 1000;
  if (spanSec < 600) return { usdPerDay: null, samples: rows.length, note: '采样跨度不足 10 分钟' };
  const d0 = Math.max(0, fmtNum(last.fee0_pending) - fmtNum(first.fee0_pending));
  const d1 = Math.max(0, fmtNum(last.fee1_pending) - fmtNum(first.fee1_pending));
  const usd = d0 * (hypeUsd || 0) + d1 * (kntqUsd || 0);
  return { usdPerDay: usd * 86400 / spanSec, samples: rows.length, spanHours: Number((spanSec / 3600).toFixed(2)) };
}

/**
 * @param {string|number} tokenId
 * @param {{bridgeCostUsd?:number}} opts
 */
async function analyzePosition(tokenId, opts = {}) {
  const bridgeCostUsd = Math.max(0, Number(opts.bridgeCostUsd) || 0);
  const notes = []; const warnings = [];
  const led = await ledger.getLedger(String(tokenId));
  const { pool, positions } = await chain.loadPositions([String(tokenId)]);
  const p = positions[0] || null;
  const valid = !!(p && !p.invalid && p.poolMatch);
  if (p && p.invalid) warnings.push('链上读取失败：该头寸可能已销毁（流动性为 0 且 NFT 已 burn）');
  if (p && !p.invalid && !p.poolMatch) warnings.push('该头寸不属于目标池，分析仅含台账部分');

  const prices = await getPrices();
  const hypeUsd = prices.HYPE ? prices.HYPE.usd : null;
  const currentPrice = v4math.priceFromSqrtX96(pool.sqrtPriceX96); // KNTQ per HYPE
  const kntqUsd = hypeUsd != null ? hypeUsd / Math.max(1e-12, currentPrice.toNumber()) : (prices.KNTQ ? prices.KNTQ.usd : null);
  if (hypeUsd == null || kntqUsd == null) warnings.push('缺少美元价格，部分指标无法计算（仅展示数量口径）');

  const net0 = fmtNum(led.totals.net0);
  const net1 = fmtNum(led.totals.net1);
  const deposited0 = fmtNum(led.totals.deposited0);
  const deposited1 = fmtNum(led.totals.deposited1);
  const withdrawn0 = fmtNum(led.totals.withdrawn0);
  const withdrawn1 = fmtNum(led.totals.withdrawn1);
  const hodlUsd = hypeUsd != null && kntqUsd != null ? net0 * hypeUsd + net1 * kntqUsd : null;

  const principal0 = valid ? fmtNum(p.amount0 || '0') : 0;
  const principal1 = valid ? fmtNum(p.amount1 || '0') : 0;
  const fee0 = valid ? fmtNum(p.fee0 || '0') : 0;
  const fee1 = valid ? fmtNum(p.fee1 || '0') : 0;
  const lpPrincipalUsd = hypeUsd != null && kntqUsd != null ? principal0 * hypeUsd + principal1 * kntqUsd : null;
  const feesUsd = hypeUsd != null && kntqUsd != null ? fee0 * hypeUsd + fee1 * kntqUsd : null;
  const lpTotalUsd = lpPrincipalUsd != null && feesUsd != null ? lpPrincipalUsd + feesUsd : null;

  const diffUsd = lpTotalUsd != null && hodlUsd != null ? lpTotalUsd - hodlUsd : null; // LP 相对 HODL（含手续费）
  const ilUsd = diffUsd != null && feesUsd != null ? diffUsd - feesUsd : null;         // 纯价格/区间部分
  const ilPct = ilUsd != null && hodlUsd ? (ilUsd / hodlUsd) * 100 : null;

  // —— Break-even ——
  let gasPriceWei = null; let gasUsd = null;
  try {
    const gp = await chain.rpcRequest('eth_gasPrice', []);
    gasPriceWei = gp ? BigInt(gp) : null;
    if (gasPriceWei != null && hypeUsd != null) {
      const totalGas = BigInt(GAS_STATIC.mint + GAS_STATIC.remove + GAS_STATIC.collect);
      gasUsd = fmtNum(totalGas * gasPriceWei) * hypeUsd;
    }
  } catch (e) { notes.push('gas 价格读取失败，Break-even 未计入 gas'); }
  const feesNeededForHodl = diffUsd != null ? Math.max(0, -diffUsd) : null;
  const requiredFeesUsd = feesNeededForHodl != null ? feesNeededForHodl + (gasUsd || 0) + bridgeCostUsd : null;

  const Lpool = BigInt(pool.liquidity);
  const Lours = valid ? BigInt(p.liquidity) : 0n;
  const share = Lpool > 0n && Lours > 0n ? Number(Lours) / Number(Lpool) : 0;
  const inRange = valid ? p.inRange : false;
  const requiredVolumeUsd = requiredFeesUsd != null && share > 0 && inRange
    ? requiredFeesUsd / (0.01 * share)
    : null;
  const velocity = await feeVelocityUsdPerDay(tokenId, hypeUsd, kntqUsd);
  const daysToCover = requiredFeesUsd != null && velocity.usdPerDay && velocity.usdPerDay > 0
    ? requiredFeesUsd / velocity.usdPerDay
    : null;

  // —— 价格情景（假设 HYPE 美元价不变，KNTQ 价随池内价格联动）——
  const scenarios = [];
  if (valid && hypeUsd != null && kntqUsd != null) {
    const sqrtA = v4math.sqrtPriceX96AtTick(p.tickLower);
    const sqrtB = v4math.sqrtPriceX96AtTick(p.tickUpper);
    for (const pct of [-50, -25, -10, 0, 10, 25, 50]) {
      const price = currentPrice.times(1 + pct / 100);
      const sqrtP = v4math.sqrtX96FromPrice(price);
      const amts = v4math.amountsForLiquidity(sqrtP, sqrtA, sqrtB, BigInt(p.liquidity));
      const kntqUsd2 = hypeUsd / Math.max(1e-12, price.toNumber());
      const lpUsd = fmtNum(amts.amount0) * hypeUsd + fmtNum(amts.amount1) * kntqUsd2 + (feesUsd || 0);
      const hodlUsd2 = net0 * hypeUsd + net1 * kntqUsd2;
      const tick = v4math.tickAtSqrtPrice(sqrtP);
      scenarios.push({
        pct,
        priceKntqPerHype: price.toNumber(),
        priceKntqUsd: kntqUsd2,
        lpUsd: Number(lpUsd.toFixed(2)),
        hodlUsd: Number(hodlUsd2.toFixed(2)),
        diffUsd: Number((lpUsd - hodlUsd2).toFixed(2)),
        inRange: tick >= p.tickLower && tick < p.tickUpper,
        amounts: { amount0: fmtNum(amts.amount0), amount1: fmtNum(amts.amount1) },
      });
    }
  }

  return {
    tokenId: String(tokenId),
    at: new Date().toISOString(),
    mode: 'analysis-only（只读）',
    position: valid ? {
      owner: p.ownerOnchain, liquidity: p.liquidity, closed: p.closed,
      tickLower: p.tickLower, tickUpper: p.tickUpper, inRange,
      amount0: principal0, amount1: principal1, fee0, fee1,
    } : null,
    prices: { HYPE: hypeUsd, KNTQ: kntqUsd, source: prices.HYPE ? prices.HYPE.source : null, at: prices.HYPE ? prices.HYPE.at : null },
    ledger: {
      events: led.events.length,
      deposited: { hype: deposited0, kntq: deposited1 },
      withdrawn: { hype: withdrawn0, kntq: withdrawn1 },
      netInvested: { hype: net0, kntq: net1 },
      detail: led.events,
    },
    comparison: {
      hodlUsd: hodlUsd != null ? Number(hodlUsd.toFixed(2)) : null,
      lpPrincipalUsd: lpPrincipalUsd != null ? Number(lpPrincipalUsd.toFixed(2)) : null,
      feesUsd: feesUsd != null ? Number(feesUsd.toFixed(4)) : null,
      lpTotalUsd: lpTotalUsd != null ? Number(lpTotalUsd.toFixed(2)) : null,
      diffUsd: diffUsd != null ? Number(diffUsd.toFixed(2)) : null,
      ilUsd: ilUsd != null ? Number(ilUsd.toFixed(2)) : null,
      ilPct: ilPct != null ? Number(ilPct.toFixed(2)) : null,
      note: 'HODL 基准 = 建仓台账净投入数量（按各次事件前池价折算）持有至今；链上不记录已领取手续费，历史领费会低估 LP 表现',
    },
    breakeven: {
      feesNeededToMatchHodlUsd: feesNeededForHodl != null ? Number(feesNeededForHodl.toFixed(2)) : null,
      gasUsd: gasUsd != null ? Number(gasUsd.toFixed(2)) : null,
      gasPriceWei: gasPriceWei != null ? gasPriceWei.toString() : null,
      gasNote: `按建仓+撤池+领费共 ${(GAS_STATIC.mint + GAS_STATIC.remove + GAS_STATIC.collect).toLocaleString()} gas 的静态估算`,
      bridgeCostUsd,
      requiredFeesUsd: requiredFeesUsd != null ? Number(requiredFeesUsd.toFixed(2)) : null,
      liquidityShare: share > 0 ? Number((share * 100).toFixed(6)) : null,
      requiredVolumeUsd: requiredVolumeUsd != null ? Number(requiredVolumeUsd.toFixed(2)) : null,
      feeVelocityUsdPerDay: velocity.usdPerDay != null ? Number(velocity.usdPerDay.toFixed(4)) : null,
      feeVelocitySamples: velocity.samples,
      feeVelocityNote: velocity.note || null,
      daysToCover: daysToCover != null ? Number(daysToCover.toFixed(1)) : null,
      note: '「所需交易量」= 需要的手续费 ÷ (1% 费率 × 本头寸在池内流动性占比)，仅在区间内时有效',
    },
    scenarios,
    warnings, notes,
  };
}

module.exports = { analyzePosition };
