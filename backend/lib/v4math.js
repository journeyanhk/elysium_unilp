/**
 * V4 数学库（M2 模拟器用）—— 纯本地计算，不发起任何 RPC。
 *
 * 精度说明：
 *  - sqrtPriceX96AtTick 用 decimal.js（80 位）+ ceil，与「大整数有理数真值」校验完全一致
 *    （tick 52534 真值 = 1095428069240745779990198058767，本实现逐位相同；tick -887272 = 4295128739 与官方常量一致）
 *  - 金额/流动性用 BigInt 定点运算（Q96），避免浮点误差
 *  - 所有结果均为「估算」（用于预览，不代表链上执行结果）
 */
const Decimal = require('decimal.js');
Decimal.set({ precision: 80 });

const Q96 = 2n ** 96n;
const Q96D = new Decimal(2).pow(96);
const MIN_TICK = -887272;
const MAX_TICK = 887272;

/** tick → sqrtPriceX96（向上取整，与链上 TickMath 同语义） */
function sqrtPriceX96AtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick 超出范围: ${tick}`);
  const v = new Decimal(1.0001).pow(new Decimal(tick).div(2)).times(Q96D);
  return BigInt(v.ceil().toFixed(0));
}

/** sqrtPriceX96 → tick（向下取整，结果用 sqrtPriceX96AtTick 反向校准） */
function tickAtSqrtPrice(sqrtPriceX96) {
  const p = new Decimal(sqrtPriceX96.toString()).div(Q96D);
  let t = Math.floor(Number(Decimal.ln(p.times(p)).div(Decimal.ln(1.0001)).toFixed(0)));
  let guard = 0;
  while (sqrtPriceX96AtTick(Math.max(MIN_TICK, t + 1)) <= BigInt(sqrtPriceX96) && guard++ < 5) t++;
  while (sqrtPriceX96AtTick(Math.min(MAX_TICK, t)) > BigInt(sqrtPriceX96) && guard++ < 5) t--;
  return t;
}

/** 原始价格（token1 per token0，按小数位换算成人读价格） */
function priceFromSqrtX96(sqrtPriceX96, dec0 = 18, dec1 = 18) {
  const p = new Decimal(sqrtPriceX96.toString()).div(Q96D);
  return p.times(p).times(new Decimal(10).pow(dec0 - dec1));
}

/** 人读价格 → sqrtPriceX96 */
function sqrtX96FromPrice(price, dec0 = 18, dec1 = 18) {
  const p = new Decimal(price).div(new Decimal(10).pow(dec0 - dec1)).sqrt();
  return BigInt(p.times(Q96D).floor().toFixed(0));
}

/** tick → 人读价格 */
function priceAtTick(tick, dec0 = 18, dec1 = 18) {
  return priceFromSqrtX96(sqrtPriceX96AtTick(tick), dec0, dec1);
}

/** 人读价格 → tick（向下取整到 tick） */
function tickAtPrice(price, dec0 = 18, dec1 = 18) {
  return tickAtSqrtPrice(sqrtX96FromPrice(price, dec0, dec1));
}

/** 对齐到 tickSpacing（向下） */
function alignTickDown(tick, spacing) {
  return Math.floor(tick / spacing) * spacing;
}
function alignTickUp(tick, spacing) {
  return Math.ceil(tick / spacing) * spacing;
}

/** 给定流动性 L 与价格区间，返回两种资产数量（BigInt） */
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, L) {
  let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  const p = BigInt(sqrtP); const l = BigInt(L);
  if (l === 0n) return { amount0: 0n, amount1: 0n };
  if (p <= a) return { amount0: (l * (b - a) * Q96) / (b * a), amount1: 0n };
  if (p < b) return { amount0: (l * (b - p) * Q96) / (b * p), amount1: (l * (p - a)) / Q96 };
  return { amount0: 0n, amount1: (l * (b - a)) / Q96 };
}

/**
 * 由两种资产输入求最大可用流动性 L（V4 语义：取两侧约束的较小值）
 * @returns {{ L: bigint, used0: bigint, used1: bigint, limiting: 'amount0'|'amount1'|'none' }}
 */
function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  const p = BigInt(sqrtP); let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  const amt0 = BigInt(amount0); const amt1 = BigInt(amount1);
  let l0 = null; let l1 = null;
  if (p <= a) {
    if (amt0 > 0n) l0 = (amt0 * a * b) / ((b - a) * Q96);
    if (amt1 > 0n) l1 = 0n; // 价格在区间下方：token1 不参与
  } else if (p >= b) {
    if (amt1 > 0n) l1 = (amt1 * Q96) / (b - a);
    if (amt0 > 0n) l0 = 0n;
  } else {
    if (amt0 > 0n) l0 = (amt0 * p * b) / ((b - p) * Q96);
    if (amt1 > 0n) l1 = (amt1 * Q96) / (p - a);
  }
  let L = null; let limiting = 'none';
  if (l0 != null && l1 != null) {
    if (l0 <= l1) { L = l0; limiting = 'amount0'; } else { L = l1; limiting = 'amount1'; }
  } else if (l0 != null) { L = l0; limiting = 'amount0'; } else if (l1 != null) { L = l1; limiting = 'amount1'; }
  if (L == null || L <= 0n) return { L: 0n, used0: 0n, used1: 0n, limiting: 'none' };
  const used = amountsForLiquidity(p, a, b, L);
  return { L, used0: used.amount0, used1: used.amount1, limiting };
}

/**
 * 本地兑换估算（V4 语义，含 1% 费率与跨 tick 走位）—— 用于「多余资产兑换」「退出滑点」估算。
 * @param {object} o
 * @param {boolean} o.zeroForOne   方向：true = token0 换 token1（HYPE → KNTQ）
 * @param {bigint}  o.amountIn     输入数量（含手续费）
 * @param {bigint}  o.sqrtPriceX96 当前价格
 * @param {number}  o.tick         当前 tick
 * @param {bigint}  o.liquidity    当前区间流动性
 * @param {Map<number,bigint>} o.liquidityNetByTick  各初始化 tick 的净流动性（跨 tick 时应用）
 * @param {number}  o.feePips      费率（百万分之，1% = 10000）
 * @returns {{ amountOut: bigint, feePaid: bigint, sqrtPriceAfter: bigint, tickAfter: number, priceImpactPct: number, ticksCrossed: number, partial: boolean, liquidityAfter: bigint }}
 */
function swapEstimate({ zeroForOne, amountIn, sqrtPriceX96, tick, liquidity, liquidityNetByTick, feePips = 10000 }) {
  const feePaid = (BigInt(amountIn) * BigInt(feePips)) / 1000000n;
  let remaining = BigInt(amountIn) - feePaid;
  let sqrtP = BigInt(sqrtPriceX96);
  let t = Number(tick);
  let L = BigInt(liquidity);
  let out = 0n;
  let ticksCrossed = 0;
  const net = liquidityNetByTick instanceof Map ? liquidityNetByTick : new Map();
  const sorted = [...net.keys()].sort((a, b) => a - b);
  const nextDown = (from) => { let r = null; for (const x of sorted) { if (x < from) r = x; else break; } return r; };
  const nextUp = (from) => { for (const x of sorted) if (x > from) return x; return null; };
  const sqrtBefore = sqrtP;

  for (let step = 0; step < 60 && remaining > 0n; step++) {
    const targetTick = zeroForOne ? (nextDown(t) ?? MIN_TICK) : (nextUp(t) ?? MAX_TICK);
    const sqrtTarget = sqrtPriceX96AtTick(zeroForOne ? targetTick : Math.min(targetTick, MAX_TICK));
    // 到边界所需输入（同区间内 L 恒定）
    let maxIn;
    if (zeroForOne) {
      if (sqrtTarget >= sqrtP) { maxIn = remaining; } // 已在边界（防御）
      else maxIn = (L * (sqrtP - sqrtTarget) * Q96) / (sqrtP * sqrtTarget);
    } else {
      maxIn = sqrtTarget <= sqrtP ? remaining : (L * (sqrtTarget - sqrtP)) / Q96;
    }
    if (L === 0n) { break; } // 流动性耗尽（不可能：全区间被抽干）
    if (remaining >= maxIn && maxIn > 0n) {
      // 走满当前区间并跨越 tick
      if (zeroForOne) out += (L * (sqrtP - sqrtTarget)) / Q96;
      else out += (L * (sqrtTarget - sqrtP) * Q96) / (sqrtTarget * sqrtP);
      remaining -= maxIn;
      sqrtP = sqrtTarget;
      t = targetTick;
      ticksCrossed++;
      const n = net.get(targetTick) ?? 0n;
      L = zeroForOne ? L - n : L + n;
      if (L <= 0n) { L = 0n; break; }
    } else {
      // 区间内部分成交
      let sqrtNew;
      if (zeroForOne) sqrtNew = (L * Q96 * sqrtP) / (remaining * sqrtP + L * Q96);
      else sqrtNew = sqrtP + (remaining * Q96) / L;
      if (sqrtNew === sqrtP) break;
      if (zeroForOne) out += (L * (sqrtP - sqrtNew)) / Q96;
      else out += (L * (sqrtNew - sqrtP) * Q96) / (sqrtNew * sqrtP);
      sqrtP = sqrtNew;
      remaining = 0n;
    }
  }
  const pB = priceFromSqrtX96(sqrtBefore);
  const pA = priceFromSqrtX96(sqrtP);
  const priceImpactPct = pB.isZero() ? 0 : pA.minus(pB).div(pB).times(100).toNumber();
  return {
    amountOut: out, feePaid, sqrtPriceAfter: sqrtP, tickAfter: tickAtSqrtPrice(sqrtP),
    priceImpactPct, ticksCrossed, partial: remaining > 0n, liquidityAfter: L,
  };
}

module.exports = {
  Q96, MIN_TICK, MAX_TICK,
  sqrtPriceX96AtTick, tickAtSqrtPrice, priceFromSqrtX96, sqrtX96FromPrice, priceAtTick, tickAtPrice,
  alignTickDown, alignTickUp, amountsForLiquidity, liquidityForAmounts, swapEstimate,
};
