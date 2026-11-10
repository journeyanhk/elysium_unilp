/**
 * V4 数学库（M2 模拟器用）—— 纯本地计算，不发起任何 RPC。
 *
 * 精度说明：
 *  - sqrtPriceX96AtTick 用 decimal.js（80 位）+ ceil，与「大整数有理数真值」校验完全一致
 *    （tick 52534 真值 = 1095428069240745779990198058767，本实现逐位相同；tick -887272 = 4295128739 与官方常量一致）
 *  - 金额/流动性用 BigInt 定点运算（Q96），避免浮点误差
 *
 * Swap 语义（v0.4.1 重写，回应 review P0-3）：
 *  - 严格照 Uniswap V4 `SwapMath.computeSwapStep` + `SqrtPriceMath` 的**逐步（per-step）**语义实现：
 *    每个 step 内先算 `amountRemainingLessFee = floor(amountRemaining × (1e6 − fee) / 1e6)` 用于价格推进；
 *    若 step 走满到 tick 边界：fee = ceil(stepAmountIn × fee / (1e6 − fee))；
 *    若未走到边界（本步吃完剩余输入）：fee = 剩余输入 − 实际用量（余数全部计入手续费）。
 *    —— 即手续费是**每个 step 分别取整**，不是整笔只扣一次。
 *  - 跨 tick 走位：每跨过一个初始化 tick，按净流动性（liquidityNet）增减当前 L；
 *    向下跨 tick 时新 tick = tick−1，向上跨 tick 时新 tick = tick（与 V4 tickBitmap 的 lte/gt 语义一致）。
 *  - 到达价格极限（MIN/MAX_SQRT_RATIO）或流动性耗尽时返回 partial=true。
 *  - 本实现是**本地估算器，不是官方 Quoter**；已用链上真实 Swap 事件做参考向量回归
 *    （见 backend/scripts/swap-vectors.js 与 backend/tests/fixtures/swap-vectors.json）。
 */
const Decimal = require('decimal.js');
Decimal.set({ precision: 80 });

const Q96 = 2n ** 96n;
const Q96D = new Decimal(2).pow(96);
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

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
  while (t < MAX_TICK && sqrtPriceX96AtTick(Math.max(MIN_TICK, t + 1)) <= BigInt(sqrtPriceX96) && guard++ < 5) t++;
  while (t > MIN_TICK && sqrtPriceX96AtTick(Math.min(MAX_TICK, t)) > BigInt(sqrtPriceX96) && guard++ < 5) t--;
  return Math.min(MAX_TICK, Math.max(MIN_TICK, t));
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

/** 给定流动性 L 与价格区间，返回两种资产数量（BigInt，向上取整口径与链上 getAmountDelta 一致） */
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, L) {
  let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  const p = BigInt(sqrtP); const l = BigInt(L);
  if (l === 0n) return { amount0: 0n, amount1: 0n };
  if (p <= a) return { amount0: getAmount0Delta(a, b, l, true), amount1: 0n };
  if (p < b) return { amount0: getAmount0Delta(p, b, l, true), amount1: getAmount1Delta(a, p, l, false) };
  return { amount0: 0n, amount1: getAmount1Delta(a, b, l, false) };
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
    if (amt0 > 0n) l0 = liquidityForAmount0(a, b, amt0);
    if (amt1 > 0n) l1 = 0n; // 价格在区间下方：token1 不参与
  } else if (p >= b) {
    if (amt1 > 0n) l1 = liquidityForAmount1(a, b, amt1);
    if (amt0 > 0n) l0 = 0n;
  } else {
    if (amt0 > 0n) l0 = liquidityForAmount0(p, b, amt0);
    if (amt1 > 0n) l1 = liquidityForAmount1(a, p, amt1);
  }
  let L = null; let limiting = 'none';
  if (l0 != null && l1 != null) {
    if (l0 <= l1) { L = l0; limiting = 'amount0'; } else { L = l1; limiting = 'amount1'; }
  } else if (l0 != null) { L = l0; limiting = 'amount0'; } else if (l1 != null) { L = l1; limiting = 'amount1'; }
  if (L == null || L <= 0n) return { L: 0n, used0: 0n, used1: 0n, limiting: 'none' };
  const used = amountsForLiquidity(p, a, b, L);
  return { L, used0: used.amount0, used1: used.amount1, limiting };
}

// ——————————————————————————————————————————————————————————————
// SqrtPriceMath / LiquidityAmounts（逐字对照官方 v4-core 源码实现）
// 关键：官方 getAmount0Delta 是**两步取整**（先 mulDivRoundingUp 再 divRoundingUp；
//       向下时先 mulDiv 再整除），与「一次性 ceil(a*b/(c*d))」可能差 1 wei —— 必须照抄。
// ——————————————————————————————————————————————————————————————

const MAX_SWAP_FEE = 1000000n;
const mulDiv = (a, b, denom) => (BigInt(a) * BigInt(b)) / BigInt(denom);
function mulDivRoundingUp(a, b, denom) {
  const p = BigInt(a) * BigInt(b); const d = BigInt(denom);
  const q = p / d;
  return p % d === 0n ? q : q + 1n;
}
function divRoundingUp(a, b) {
  const q = BigInt(a) / BigInt(b);
  return BigInt(a) % BigInt(b) === 0n ? q : q + 1n;
}

/** token0 数量差（官方两步取整） */
function getAmount0Delta(sqrtA, sqrtB, L, roundUp) {
  let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  const num1 = BigInt(L) * Q96;
  const num2 = b - a;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(num1, num2, b), a)
    : mulDiv(num1, num2, b) / a;
}

/** token1 数量差（官方单步取整） */
function getAmount1Delta(sqrtA, sqrtB, L, roundUp) {
  let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  const num2 = b - a;
  return roundUp ? mulDivRoundingUp(BigInt(L), num2, Q96) : (BigInt(L) * num2) / Q96;
}

/** 由 token0 金额求流动性（官方两步 floor） */
function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  const intermediate = mulDiv(a, b, Q96);
  return mulDiv(BigInt(amount0), intermediate, b - a);
}

/** 由 token1 金额求流动性 */
function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  let a = BigInt(sqrtA); let b = BigInt(sqrtB);
  if (a > b) { const t = a; a = b; b = t; }
  return mulDiv(BigInt(amount1), Q96, b - a);
}

/** 给定输入求下一个 sqrtPrice（zeroForOne=true 时价格下降，用 amount0 公式） */
function getNextSqrtPriceFromInput(sqrtP, L, amountIn, zeroForOne) {
  const p = BigInt(sqrtP); const l = BigInt(L); const amt = BigInt(amountIn);
  if (zeroForOne) {
    // getNextSqrtPriceFromAmount0RoundingUp(..., add=true)：denominator = numerator1 + product
    const num1 = l * Q96;
    const denom = num1 + amt * p;
    return mulDivRoundingUp(num1, p, denom);
  }
  // getNextSqrtPriceFromAmount1RoundingDown(..., add=true)：sqrtP + floor(amount*Q96/L)
  return p + (amt * Q96) / l;
}

/** 由目标输出量求下一个 sqrtPrice（官方 getNextSqrtPriceFromOutput） */
function getNextSqrtPriceFromOutput(sqrtP, L, amountOut, zeroForOne) {
  const p = BigInt(sqrtP); const l = BigInt(L); const out = BigInt(amountOut);
  if (zeroForOne) {
    // token1 输出：sqrtP − ceil(out*Q96/L)
    const q = out <= (2n ** 160n - 1n) ? divRoundingUp(out * Q96, l) : mulDivRoundingUp(out, Q96, l);
    return p - q;
  }
  // token0 输出：numerator1 − product
  const num1 = l * Q96;
  const denom = num1 - out * p;
  return mulDivRoundingUp(num1, p, denom);
}

/** V4 SwapMath.computeSwapStep 的精确输出版本（exact-out，逐字对照官方源码） */
function computeSwapStepExactOut(sqrtCurrent, sqrtTarget, liquidity, amountRemainingOut, feePips) {
  const sqrtP = BigInt(sqrtCurrent); const sqrtT = BigInt(sqrtTarget);
  const L = BigInt(liquidity); const remainingOut = BigInt(amountRemainingOut);
  const fee = BigInt(feePips);
  const zeroForOne = sqrtP >= sqrtT;
  let amountOut = zeroForOne
    ? getAmount1Delta(sqrtT, sqrtP, L, false)
    : getAmount0Delta(sqrtP, sqrtT, L, false);
  let sqrtNext;
  if (remainingOut >= amountOut) {
    sqrtNext = sqrtT;
  } else {
    amountOut = remainingOut;
    sqrtNext = getNextSqrtPriceFromOutput(sqrtP, L, amountOut, zeroForOne);
  }
  const amountIn = zeroForOne
    ? getAmount0Delta(sqrtNext, sqrtP, L, true)
    : getAmount1Delta(sqrtP, sqrtNext, L, true);
  const feeAmount = mulDivRoundingUp(amountIn, fee, MAX_SWAP_FEE - fee);
  return { sqrtNext, amountIn, amountOut, feeAmount, reachedTarget: sqrtNext === sqrtT };
}

/** V4 SwapMath.computeSwapStep 的精确输入版本（exact-in，逐字对照官方源码） */
function computeSwapStep(sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePips) {
  const sqrtP = BigInt(sqrtCurrent); const sqrtT = BigInt(sqrtTarget);
  const L = BigInt(liquidity); const remaining = BigInt(amountRemaining);
  const fee = BigInt(feePips);
  const zeroForOne = sqrtP >= sqrtT;
  const amountRemainingLessFee = mulDiv(remaining, MAX_SWAP_FEE - fee, MAX_SWAP_FEE);
  let amountIn = zeroForOne
    ? getAmount0Delta(sqrtT, sqrtP, L, true)
    : getAmount1Delta(sqrtP, sqrtT, L, true);
  let sqrtNext; let feeAmount;
  if (amountRemainingLessFee >= amountIn) {
    // 走满到 tick 边界
    sqrtNext = sqrtT;
    feeAmount = fee === MAX_SWAP_FEE ? amountIn : mulDivRoundingUp(amountIn, fee, MAX_SWAP_FEE - fee);
  } else {
    // 本步吃完剩余输入（官方：amountIn 直接取 lessFee；手续费 = 剩余 − amountIn）
    amountIn = amountRemainingLessFee;
    sqrtNext = getNextSqrtPriceFromInput(sqrtP, L, amountRemainingLessFee, zeroForOne);
    feeAmount = remaining - amountIn;
  }
  const amountOut = zeroForOne
    ? getAmount1Delta(sqrtNext, sqrtP, L, false)
    : getAmount0Delta(sqrtP, sqrtNext, L, false);
  return { sqrtNext, amountIn, amountOut, feeAmount, reachedTarget: sqrtNext === sqrtT };
}

/**
 * 本地兑换估算（V4 逐步语义 + 跨 tick 走位；支持 exact-in / exact-out）。
 * ⚠️ 本地估算器，不是官方 Quoter；结果以链上执行为准。
 * @param {object} o
 * @param {boolean} o.zeroForOne   true = token0 → token1（HYPE → KNTQ）
 * @param {bigint}  o.amountIn     输入数量（mode='exactIn'，含手续费）
 * @param {bigint}  [o.amountOut]  目标输出数量（mode='exactOut'）
 * @param {'exactIn'|'exactOut'} [o.mode='exactIn']
 * @param {bigint}  o.sqrtPriceX96 当前价格
 * @param {number}  o.tick         当前 tick
 * @param {bigint}  o.liquidity    当前区间流动性
 * @param {Map<number,bigint>} o.liquidityNetByTick 各初始化 tick 的净流动性
 * @param {number}  o.feePips      费率（百万分之，1% = 10000）
 * @param {bigint}  [o.sqrtPriceLimitX96] 价格限制（路由器设定）：价格触及后停止，剩余输入不消耗
 */
function swapEstimate({ zeroForOne, amountIn, amountOut, mode = 'exactIn', sqrtPriceX96, tick, liquidity, liquidityNetByTick, feePips = 10000, sqrtPriceLimitX96 = null }) {
  const net = liquidityNetByTick instanceof Map ? liquidityNetByTick : new Map();
  const sorted = [...net.keys()].sort((a, b) => a - b);
  const nextInitAtOrBelow = (from) => { let r = null; for (const x of sorted) { if (x <= from) r = x; else break; } return r; };
  const nextInitAbove = (from) => { for (const x of sorted) if (x > from) return x; return null; };

  let sqrtP = BigInt(sqrtPriceX96);
  let t = Number(tick);
  let L = BigInt(liquidity);
  let remaining = mode === 'exactOut' ? BigInt(amountOut || 0n) : BigInt(amountIn || 0n);
  const specifiedIn = mode === 'exactIn' ? BigInt(amountIn || 0n) : null;
  const limit = sqrtPriceLimitX96 != null ? BigInt(sqrtPriceLimitX96) : null;
  let out = 0n; let inTotal = 0n; let feeTotal = 0n; let ticksCrossed = 0; let steps = 0;
  const sqrtBefore = sqrtP;
  const fee = BigInt(feePips);
  let partial = false;
  let limitReached = false;
  // 限价恰为起始价：V4 的循环条件 `sqrtPrice != sqrtPriceLimit` 直接不进入循环（无成交）
  if (limit != null && limit === sqrtP) {
    return {
      mode, amountIn: 0n, amountInSpecified: specifiedIn, amountOut: 0n, feePaid: 0n,
      sqrtPriceAfter: sqrtP, tickAfter: t, priceImpactPct: null, priceChangePct: 0,
      ticksCrossed: 0, partial: false, limitReached: true, liquidityAfter: L, steps: 0,
    };
  }
  // V4 Pool.swap 的 tick 更新规则（逐行对照）：
  //  - 价格到达 tick 边界（非限价）→ tick = 边界−1(零对一) / 边界(一对零)
  //  - 价格移动但未到边界 → tick = getTickAtSqrtRatio(价格)
  //  - 价格未移动（仅消耗手续费尘埃）→ tick 保持不变
  let currentTick = t;

  while (remaining > 0n && steps++ < 500) {
    const targetTick = zeroForOne ? (nextInitAtOrBelow(t) ?? MIN_TICK) : (nextInitAbove(t) ?? MAX_TICK);
    let sqrtTarget = zeroForOne
      ? (targetTick <= MIN_TICK ? MIN_SQRT_RATIO : sqrtPriceX96AtTick(targetTick))
      : (targetTick >= MAX_TICK ? MAX_SQRT_RATIO : sqrtPriceX96AtTick(targetTick));
    let atLimit = false;
    let stopAfterCross = false;
    if (limit != null) {
      // 限价比 tick 边界更近时，以限价为本步目标（与 V4 的 price limit 语义一致）
      if (zeroForOne && limit > sqrtTarget && limit < sqrtP) { sqrtTarget = limit; atLimit = true; }
      else if (!zeroForOne && limit < sqrtTarget && limit > sqrtP) { sqrtTarget = limit; atLimit = true; }
      // 限价恰好落在 tick 边界上：V4 会先跨过该 tick（更新流动性/tick），随后因价格==限价退出循环
      else if (limit === sqrtTarget) stopAfterCross = true;
    }
    if (L <= 0n) { partial = true; break; }
    const step = mode === 'exactOut'
      ? computeSwapStepExactOut(sqrtP, sqrtTarget, L, remaining, fee)
      : computeSwapStep(sqrtP, sqrtTarget, L, remaining, fee);
    out += step.amountOut;
    inTotal += step.amountIn;
    feeTotal += step.feeAmount;
    remaining -= mode === 'exactOut' ? step.amountOut : (step.amountIn + step.feeAmount);
    if (remaining < 0n) remaining = 0n;
    const sqrtPrev = sqrtP;
    sqrtP = step.sqrtNext;
    if (step.reachedTarget) {
      if (atLimit) {
        if (sqrtP !== sqrtPrev) currentTick = tickAtSqrtPrice(sqrtP);
        limitReached = true; partial = remaining > 0n; break;
      }
      ticksCrossed++;
      t = zeroForOne ? targetTick - 1 : targetTick;
      currentTick = t;
      const n = net.get(targetTick) ?? 0n;
      L = zeroForOne ? L - n : L + n;
      if (L <= 0n) { L = 0n; partial = remaining > 0n; break; }
      if (stopAfterCross) { limitReached = true; partial = remaining > 0n; break; }
      if (targetTick <= MIN_TICK || targetTick >= MAX_TICK) { limitReached = remaining > 0n; partial = remaining > 0n; break; }
    } else if (sqrtP === sqrtPrev) {
      partial = true; break;
    } else {
      currentTick = tickAtSqrtPrice(sqrtP);
    }
    if (remaining === 0n) break;
  }
  if (remaining > 0n) partial = true;

  const priceBefore = priceFromSqrtX96(sqrtBefore);
  const priceAfter = priceFromSqrtX96(sqrtP);
  const priceChangePct = priceBefore.isZero() ? 0 : priceAfter.minus(priceBefore).div(priceBefore).times(100).toNumber();
  const consumedIn = inTotal + feeTotal;
  const amountInFinal = consumedIn;
  const amountOutFinal = out;
  // 执行价 vs 池价（含费率与滑点，与 DEX 界面「价格影响」同口径）
  let priceImpactPct = null;
  if (amountInFinal > 0n && amountOutFinal > 0n && !priceBefore.isZero()) {
    const decIn = new Decimal(amountInFinal.toString()).div(1e18);
    const decOut = new Decimal(amountOutFinal.toString()).div(1e18);
    const spot = zeroForOne ? priceBefore : new Decimal(1).div(priceBefore);
    priceImpactPct = decOut.div(decIn).div(spot).minus(1).times(100).toNumber();
  }

  return {
    mode,
    amountIn: amountInFinal, amountInSpecified: specifiedIn, amountOut: amountOutFinal, feePaid: feeTotal,
    sqrtPriceAfter: sqrtP,
    tickAfter: currentTick,
    priceImpactPct, priceChangePct, ticksCrossed, partial, limitReached,
    liquidityAfter: L, steps,
  };
}

module.exports = {
  Q96, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, MAX_SWAP_FEE,
  sqrtPriceX96AtTick, tickAtSqrtPrice, priceFromSqrtX96, sqrtX96FromPrice, priceAtTick, tickAtPrice,
  alignTickDown, alignTickUp, amountsForLiquidity, liquidityForAmounts, swapEstimate,
  getAmount0Delta, getAmount1Delta, getNextSqrtPriceFromInput, getNextSqrtPriceFromOutput,
  computeSwapStep, computeSwapStepExactOut,
  liquidityForAmount0, liquidityForAmount1, mulDiv, mulDivRoundingUp, divRoundingUp,
};
