'use strict';
/**
 * 独立参考实现 · Uniswap v4-core `Pool.swap` 循环的忠实移植
 * 来源：https://github.com/Uniswap/v4-core/blob/main/src/libraries/Pool.sol
 *
 * 与生产实现 lib/v4math.js 的 swapEstimate 是两套独立代码（本文件按官方 Solidity 结构逐句移植）。
 * 语义要点（官方）：
 *  - 循环条件：`while (!(amountSpecifiedRemaining == 0 || sqrtPrice == sqrtPriceLimit))`
 *  - 目标价 = getSqrtPriceTarget(zeroForOne, 下一个初始化 tick 的价格, 限价)
 *  - 到达 tick 边界 → tick = 边界 ∓ 1 并按 zeroForOne 取反 liquidityNet 更新流动性；价格动了但未到边界 → getTickAtSqrtPrice；价格未动 → tick 不变
 *  - 事件/调用方金额口径：(amount0, amount1)，负数 = 付出（输入），正数 = 收到（输出）
 *
 * tick 数据：用「初始化 tick → 净流动性」映射（等价于链上 tickBitmap + ticks，前提是数据完整；
 * 参考向量生成器已保证所涉区间内的初始化 tick 全部包含在内）。
 */
const TickMath = require('./tickmath');
const SwapMath = require('./swapmath');

const MAX_SWAP_FEE = 1000000n;

/**
 * @param {object} p
 * @param {boolean} p.zeroForOne
 * @param {'exactIn'|'exactOut'} p.mode
 * @param {bigint} p.amount           指定侧数量（exactIn = 输入，exactOut = 输出），正数
 * @param {bigint} p.sqrtPriceX96      起始价
 * @param {number} p.tick              起始 tick
 * @param {bigint} p.liquidity         起始有效流动性
 * @param {Map<number,bigint>} p.liquidityNetByTick
 * @param {number} p.feePips           费率（pips）
 * @param {bigint} [p.sqrtPriceLimitX96]
 * @param {number} [p.protocolFeePips] 协议费（pips，默认 0）
 */
function swap(p) {
  const zeroForOne = p.zeroForOne;
  const exactIn = p.mode === 'exactIn';
  const feePips = BigInt(p.feePips);
  const protocolFeePips = BigInt(p.protocolFeePips || 0);
  const limit = p.sqrtPriceLimitX96 != null ? BigInt(p.sqrtPriceLimitX96) : (zeroForOne ? TickMath.MIN_SQRT_PRICE + 1n : TickMath.MAX_SQRT_PRICE - 1n);

  const amountSpecified = exactIn ? -BigInt(p.amount) : BigInt(p.amount);
  let amountSpecifiedRemaining = amountSpecified;
  let amountCalculated = 0n;

  let sqrtPrice = BigInt(p.sqrtPriceX96);
  let tick = Number(p.tick);
  let liquidity = BigInt(p.liquidity);
  const net = p.liquidityNetByTick;
  let feePaid = 0n;
  let steps = 0;
  let ticksCrossed = 0;

  // 官方：swapFee = protocolFee == 0 ? lpFee : calculateSwapFee(lpFee, protocolFee)
  const swapFee = protocolFeePips === 0n ? feePips : feePips + protocolFeePips - (feePips * protocolFeePips) / MAX_SWAP_FEE;

  // 边界校验（与 Pool.swap 一致）
  if (zeroForOne) {
    if (limit >= sqrtPrice) throw new Error('PriceLimitAlreadyExceeded');
    if (limit <= TickMath.MIN_SQRT_PRICE) throw new Error('PriceLimitOutOfBounds');
  } else {
    if (limit <= sqrtPrice) throw new Error('PriceLimitAlreadyExceeded');
    if (limit >= TickMath.MAX_SQRT_PRICE) throw new Error('PriceLimitOutOfBounds');
  }

  if (amountSpecified === 0n) {
    return { amountIn: 0n, amountOut: 0n, feePaid: 0n, sqrtPriceAfter: sqrtPrice, tickAfter: tick, liquidityAfter: liquidity, steps: 0, ticksCrossed: 0, partial: false, limitReached: false };
  }

  while (!(amountSpecifiedRemaining === 0n || sqrtPrice === limit)) {
    const sqrtPriceStart = sqrtPrice;
    // 下一个初始化 tick：零对一取 ≤ 当前 tick 的最大者；一对零取 > 当前 tick 的最小者
    let tickNext;
    let initialized = false;
    if (zeroForOne) {
      for (const t of net.keys()) { if (t <= tick && (tickNext === undefined || t > tickNext)) { tickNext = t; initialized = true; } }
    } else {
      for (const t of net.keys()) { if (t > tick && (tickNext === undefined || t < tickNext)) { tickNext = t; initialized = true; } }
    }
    if (tickNext === undefined) tickNext = zeroForOne ? TickMath.MIN_TICK : TickMath.MAX_TICK;
    if (tickNext <= TickMath.MIN_TICK) tickNext = TickMath.MIN_TICK;
    if (tickNext >= TickMath.MAX_TICK) tickNext = TickMath.MAX_TICK;
    const sqrtPriceNext = TickMath.getSqrtPriceAtTick(tickNext);

    const step = SwapMath.computeSwapStep(
      sqrtPrice,
      SwapMath.getSqrtPriceTarget(zeroForOne, sqrtPriceNext, limit),
      liquidity,
      amountSpecifiedRemaining,
      swapFee,
    );
    sqrtPrice = step.sqrtPriceNextX96;
    let stepFee = step.feeAmount;

    if (!exactIn) {
      amountSpecifiedRemaining -= step.amountOut;
      amountCalculated -= step.amountIn + stepFee;
    } else {
      amountSpecifiedRemaining += step.amountIn + stepFee;
      amountCalculated += step.amountOut;
    }

    if (protocolFeePips > 0n) {
      const delta = swapFee === protocolFeePips
        ? stepFee
        : ((step.amountIn + stepFee) * protocolFeePips) / MAX_SWAP_FEE;
      stepFee -= delta; // 协议费部分不进入 LP 手续费
    }
    feePaid += stepFee;
    steps++;

    if (sqrtPrice === sqrtPriceNext) {
      ticksCrossed++;
      if (initialized) {
        const n = net.get(tickNext) ?? 0n;
        liquidity += zeroForOne ? -n : n;
      }
      tick = zeroForOne ? tickNext - 1 : tickNext;
    } else if (sqrtPrice !== sqrtPriceStart) {
      tick = TickMath.getTickAtSqrtPrice(sqrtPrice);
    }
  }

  let amount0; let amount1;
  if (zeroForOne !== exactIn) {
    amount0 = amountCalculated;
    amount1 = amountSpecified - amountSpecifiedRemaining;
  } else {
    amount0 = amountSpecified - amountSpecifiedRemaining;
    amount1 = amountCalculated;
  }
  const amountIn = zeroForOne ? -amount0 : -amount1;
  const amountOut = zeroForOne ? amount1 : amount0;
  const remainingSpecified = exactIn ? -amountSpecifiedRemaining : amountSpecifiedRemaining;

  return {
    amountIn,
    amountOut,
    feePaid,
    sqrtPriceAfter: sqrtPrice,
    tickAfter: tick,
    liquidityAfter: liquidity,
    steps,
    ticksCrossed,
    partial: remainingSpecified !== 0n,
    limitReached: sqrtPrice === limit,
    remainingSpecified,
  };
}

module.exports = { swap };
