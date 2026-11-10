/**
 * M2 风险分析 —— LP vs HODL 对照 / 近似无常损失 / Break-even（只读计算，不签名、不发交易）。
 *
 * 口径（按 review 要求收紧）：
 *  - HODL 基准 = 建仓台账中的「净投入数量」（累计存入 − 累计取出，按各次事件发生前的池价格折算）
 *  - `lpVsHodlExcludingCurrentFeesUsd` = LP 合计（本金现值 + 待领手续费）− HODL，即「扣除当前未领取手续费后
 *    的 LP 相对 HODL 差额」。**它不是严格意义的无常损失**：还包含区间效应、历史加减仓、已领取手续费
 *    （链上不记录，无法追溯）、价格路径等影响。页面上以「相对 HODL 差额（近似 IL）」展示。
 *  - `requiredVolumeApproxUsd` = 静态近似：假设头寸始终在区间内、流动性份额不变、所有成交都经过本区间。
 *
 * 纯计算函数（computeFeeVelocity / breakevenModel）单独导出，便于离线回归测试。
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

/** 纯函数：由采样行计算收益速度（$/天）。不足 2 条或跨度 < 10 分钟返回 null。 */
function computeFeeVelocity(rows, hypeUsd, kntqUsd) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { usdPerDay: null, samples: Array.isArray(rows) ? rows.length : 0, note: '采样不足（需 ≥2 条、跨度越长越准）' };
  }
  const first = rows[0]; const last = rows[rows.length - 1];
  const spanSec = (new Date(last.sampled_at).getTime() - new Date(first.sampled_at).getTime()) / 1000;
  if (!(spanSec > 0)) return { usdPerDay: null, samples: rows.length, note: '采样时间戳异常' };
  if (spanSec < 600) return { usdPerDay: null, samples: rows.length, note: '采样跨度不足 10 分钟' };
  const d0 = Math.max(0, fmtNum(last.fee0_pending) - fmtNum(first.fee0_pending));
  const d1 = Math.max(0, fmtNum(last.fee1_pending) - fmtNum(first.fee1_pending));
  const usd = d0 * (hypeUsd || 0) + d1 * (kntqUsd || 0);
  return { usdPerDay: usd * 86400 / spanSec, samples: rows.length, spanHours: Number((spanSec / 3600).toFixed(2)) };
}

/** 纯函数：Break-even 模型（静态近似）。bridgeCostUsd 为负数时归零。 */
function breakevenModel({ diffUsd, gasUsd, bridgeCostUsd, share, inRange, feeVelocityUsdPerDay }) {
  const bridge = Math.max(0, Number(bridgeCostUsd) || 0);
  const feesNeededToMatchHodlUsd = diffUsd != null ? Math.max(0, -diffUsd) : null;
  const requiredFeesUsd = feesNeededToMatchHodlUsd != null ? feesNeededToMatchHodlUsd + (gasUsd || 0) + bridge : null;
  const requiredVolumeApproxUsd = requiredFeesUsd != null && share > 0 && inRange
    ? requiredFeesUsd / (0.01 * share)
    : null;
  const daysToCover = requiredFeesUsd != null && feeVelocityUsdPerDay && feeVelocityUsdPerDay > 0
    ? requiredFeesUsd / feeVelocityUsdPerDay
    : null;
  return { bridgeCostUsd: bridge, feesNeededToMatchHodlUsd, requiredFeesUsd, requiredVolumeApproxUsd, daysToCover };
}

async function feeVelocityUsdPerDay(tokenId, hypeUsd, kntqUsd) {
  if (!Number.isInteger(CHAIN.id)) throw new Error('CHAIN.id 未配置（白名单链 ID 缺失，禁止静默降级为「采样不足」）');
  const { rows } = await dbQuery(
    `SELECT sampled_at, fee0_pending, fee1_pending FROM position_samples
     WHERE chain_id=$1 AND token_id=$2 AND sampled_at > now() - interval '25 hours'
     ORDER BY sampled_at ASC`, [CHAIN.id, String(tokenId)]);
  return computeFeeVelocity(rows, hypeUsd, kntqUsd);
}

/**
 * @param {string|number} tokenId
 * @param {{bridgeCostUsd?:number}} opts
 */
async function analyzePosition(tokenId, opts = {}) {
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
  const hodlUsd = hypeUsd != null && kntqUsd != null ? net0 * hypeUsd + net1 * kntqUsd : null;

  const principal0 = valid ? fmtNum(p.amount0 || '0') : 0;
  const principal1 = valid ? fmtNum(p.amount1 || '0') : 0;
  const fee0 = valid ? fmtNum(p.fee0 || '0') : 0;
  const fee1 = valid ? fmtNum(p.fee1 || '0') : 0;
  const lpPrincipalUsd = hypeUsd != null && kntqUsd != null ? principal0 * hypeUsd + principal1 * kntqUsd : null;
  const feesUsd = hypeUsd != null && kntqUsd != null ? fee0 * hypeUsd + fee1 * kntqUsd : null;
  const lpTotalUsd = lpPrincipalUsd != null && feesUsd != null ? lpPrincipalUsd + feesUsd : null;

  const diffUsd = lpTotalUsd != null && hodlUsd != null ? lpTotalUsd - hodlUsd : null;
  const lpVsHodlExcludingFeesUsd = diffUsd != null && feesUsd != null ? diffUsd - feesUsd : null;
  const lpVsHodlExcludingFeesPct = lpVsHodlExcludingFeesUsd != null && hodlUsd ? (lpVsHodlExcludingFeesUsd / hodlUsd) * 100 : null;

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

  const Lpool = BigInt(pool.liquidity);
  const Lours = valid ? BigInt(p.liquidity) : 0n;
  const share = Lpool > 0n && Lours > 0n ? Number(Lours) / Number(Lpool) : 0;
  const inRange = valid ? p.inRange : false;
  const velocity = await feeVelocityUsdPerDay(tokenId, hypeUsd, kntqUsd);
  const be = breakevenModel({
    diffUsd, gasUsd, bridgeCostUsd: opts.bridgeCostUsd, share, inRange,
    feeVelocityUsdPerDay: velocity.usdPerDay,
  });

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
      deposited: { hype: fmtNum(led.totals.deposited0), kntq: fmtNum(led.totals.deposited1) },
      withdrawn: { hype: fmtNum(led.totals.withdrawn0), kntq: fmtNum(led.totals.withdrawn1) },
      netInvested: { hype: net0, kntq: net1 },
      detail: led.events,
    },
    comparison: {
      hodlUsd: hodlUsd != null ? Number(hodlUsd.toFixed(2)) : null,
      lpPrincipalUsd: lpPrincipalUsd != null ? Number(lpPrincipalUsd.toFixed(2)) : null,
      feesUsd: feesUsd != null ? Number(feesUsd.toFixed(4)) : null,
      lpTotalUsd: lpTotalUsd != null ? Number(lpTotalUsd.toFixed(2)) : null,
      diffUsd: diffUsd != null ? Number(diffUsd.toFixed(2)) : null,
      lpVsHodlExcludingCurrentFeesUsd: lpVsHodlExcludingFeesUsd != null ? Number(lpVsHodlExcludingFeesUsd.toFixed(2)) : null,
      lpVsHodlExcludingCurrentFeesPct: lpVsHodlExcludingFeesPct != null ? Number(lpVsHodlExcludingFeesPct.toFixed(2)) : null,
      // 兼容字段（页面已改用上面的完整字段名）：近似 IL，不含已领取手续费与完整价格路径
      approxIlUsd: lpVsHodlExcludingFeesUsd != null ? Number(lpVsHodlExcludingFeesUsd.toFixed(2)) : null,
      note: 'HODL 基准 = 建仓台账净投入数量（按各次事件前池价折算）持有至今；「相对 HODL 差额（扣除当前未领取手续费）」为近似 IL —— 链上不记录已领取手续费，且含区间效应与历史加减仓影响，不等于严格无常损失',
    },
    breakeven: {
      feesNeededToMatchHodlUsd: be.feesNeededToMatchHodlUsd != null ? Number(be.feesNeededToMatchHodlUsd.toFixed(2)) : null,
      gasUsd: gasUsd != null ? Number(gasUsd.toFixed(2)) : null,
      gasPriceWei: gasPriceWei != null ? gasPriceWei.toString() : null,
      gasNote: `按建仓+撤池+领费共 ${(GAS_STATIC.mint + GAS_STATIC.remove + GAS_STATIC.collect).toLocaleString()} gas 的静态估算`,
      bridgeCostUsd: be.bridgeCostUsd,
      requiredFeesUsd: be.requiredFeesUsd != null ? Number(be.requiredFeesUsd.toFixed(2)) : null,
      liquidityShare: share > 0 ? Number((share * 100).toFixed(6)) : null,
      requiredVolumeApproxUsd: be.requiredVolumeApproxUsd != null ? Number(be.requiredVolumeApproxUsd.toFixed(2)) : null,
      feeVelocityUsdPerDay: velocity.usdPerDay != null ? Number(velocity.usdPerDay.toFixed(4)) : null,
      feeVelocitySamples: velocity.samples,
      feeVelocityNote: velocity.note || null,
      daysToCover: be.daysToCover != null ? Number(be.daysToCover.toFixed(1)) : null,
      note: '「所需交易量」为静态近似：假设头寸始终在区间内、流动性份额不变、全部成交都经过本区间、费率恒为 1%；不是未来成交量预测',
    },
    scenarios,
    warnings, notes,
  };
}

module.exports = { analyzePosition, computeFeeVelocity, breakevenModel };
