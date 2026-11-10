'use strict';
/**
 * 独立参考实现 · Uniswap v4-core SwapMath 的忠实移植
 * 来源：https://github.com/Uniswap/v4-core/blob/main/src/libraries/SwapMath.sol
 *      （含旧版签名 computeSwapStep(sqrtCurrent, sqrtTarget, liquidity, amountRemaining, feePips)）
 *
 * 语义要点：
 *  - exactIn（amountRemaining < 0）：lessFee = mulDiv(-remaining, 1e6-fee, 1e6)；
 *      能到目标 → sqrtNext = target，fee = ceil(amountIn × fee/(1e6−fee))；不能到 → amountIn = lessFee，fee = 剩余 − amountIn
 *  - exactOut（amountRemaining > 0）：amountOut 受目标价/剩余输出限制；fee = ceil(amountIn × fee/(1e6−fee))
 */
const SPM = require('./sqrtpricemath');

const MAX_SWAP_FEE = 1000000n;

function getSqrtPriceTarget(zeroForOne, sqrtPriceNextX96, sqrtPriceLimitX96) {
  return zeroForOne
    ? (sqrtPriceNextX96 < sqrtPriceLimitX96 ? sqrtPriceLimitX96 : sqrtPriceNextX96)
    : (sqrtPriceNextX96 > sqrtPriceLimitX96 ? sqrtPriceLimitX96 : sqrtPriceNextX96);
}

function computeSwapStep(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, amountRemaining, feePips) {
  const zeroForOne = sqrtPriceCurrentX96 >= sqrtPriceTargetX96;
  const exactIn = amountRemaining < 0n;
  let sqrtPriceNextX96; let amountIn; let amountOut; let feeAmount;

  if (exactIn) {
    const amountRemainingLessFee = SPM.mulDiv(-amountRemaining, MAX_SWAP_FEE - feePips, MAX_SWAP_FEE);
    amountIn = zeroForOne
      ? SPM.getAmount0Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, true)
      : SPM.getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, true);
    if (amountRemainingLessFee >= amountIn) {
      sqrtPriceNextX96 = sqrtPriceTargetX96;
      feeAmount = feePips === MAX_SWAP_FEE
        ? amountIn
        : SPM.mulDivRoundingUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
    } else {
      amountIn = amountRemainingLessFee;
      sqrtPriceNextX96 = SPM.getNextSqrtPriceFromInput(sqrtPriceCurrentX96, liquidity, amountRemainingLessFee, zeroForOne);
      feeAmount = (-amountRemaining) - amountIn;
    }
    amountOut = zeroForOne
      ? SPM.getAmount1Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, false)
      : SPM.getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, false);
  } else {
    amountOut = zeroForOne
      ? SPM.getAmount1Delta(sqrtPriceTargetX96, sqrtPriceCurrentX96, liquidity, false)
      : SPM.getAmount0Delta(sqrtPriceCurrentX96, sqrtPriceTargetX96, liquidity, false);
    if (amountRemaining >= amountOut) {
      sqrtPriceNextX96 = sqrtPriceTargetX96;
    } else {
      amountOut = amountRemaining;
      sqrtPriceNextX96 = SPM.getNextSqrtPriceFromOutput(sqrtPriceCurrentX96, liquidity, amountOut, zeroForOne);
    }
    amountIn = zeroForOne
      ? SPM.getAmount0Delta(sqrtPriceNextX96, sqrtPriceCurrentX96, liquidity, true)
      : SPM.getAmount1Delta(sqrtPriceCurrentX96, sqrtPriceNextX96, liquidity, true);
    feeAmount = SPM.mulDivRoundingUp(amountIn, feePips, MAX_SWAP_FEE - feePips);
  }
  return { sqrtPriceNextX96, amountIn, amountOut, feeAmount };
}

module.exports = { MAX_SWAP_FEE, getSqrtPriceTarget, computeSwapStep };
