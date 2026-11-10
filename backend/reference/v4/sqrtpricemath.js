'use strict';
/**
 * 独立参考实现 · Uniswap v4-core SqrtPriceMath 的忠实移植
 * 来源：https://github.com/Uniswap/v4-core/blob/main/src/libraries/SqrtPriceMath.sol
 *
 * 移植要点（与生产实现 lib/v4math.js 独立编写）：
 *  - FullMath.mulDiv / mulDivRoundingUp 在 BigInt 下天然精确（无 512 位溢出问题），语义一致
 *  - getNextSqrtPriceFromAmount0RoundingUp 有「无溢出分支 / 溢出回退分支」两条路径，取整方式不同 → 必须显式模拟 uint256 溢出判断
 *  - getNextSqrtPriceFromAmount1RoundingDown 有「amount ≤ uint160.max」分支，同样影响取整
 *  - getAmount0Delta 为**两步取整**：divRoundingUp(mulDivRoundingUp(n1, n2, sqrtB), sqrtA)
 */
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const Q96 = 1n << 96n;
const RESOLUTION = 96n;

function mulDiv(a, b, d) { return (a * b) / d; }
function mulDivRoundingUp(a, b, d) { const p = a * b; const q = p / d; return p % d === 0n ? q : q + 1n; }
function divRoundingUp(a, b) { const q = a / b; return a % b === 0n ? q : q + 1n; }

function getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amount, add) {
  if (amount === 0n) return sqrtPX96;
  const numerator1 = liquidity << RESOLUTION;
  const product = amount * sqrtPX96;
  if (add) {
    // unchecked 乘法：只有未溢出且除法自洽时才走快路径
    if (product <= MAX_UINT256 && product / amount === sqrtPX96) {
      const denominator = numerator1 + product;
      if (denominator >= numerator1 && denominator <= MAX_UINT256) {
        return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
      }
    }
    return divRoundingUp(numerator1, (numerator1 / sqrtPX96) + amount);
  }
  if (!(product <= MAX_UINT256 && product / amount === sqrtPX96 && numerator1 > product)) throw new Error('PriceOverflow');
  const denominator = numerator1 - product;
  return mulDivRoundingUp(numerator1, sqrtPX96, denominator);
}

function getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amount, add) {
  if (add) {
    const quotient = amount <= MAX_UINT160 ? (amount << RESOLUTION) / liquidity : mulDiv(amount, Q96, liquidity);
    const next = sqrtPX96 + quotient;
    if (next > MAX_UINT160) throw new Error('PriceOverflow');
    return next;
  }
  const quotient = amount <= MAX_UINT160 ? divRoundingUp(amount << RESOLUTION, liquidity) : mulDivRoundingUp(amount, Q96, liquidity);
  if (!(sqrtPX96 > quotient)) throw new Error('NotEnoughLiquidity');
  return sqrtPX96 - quotient;
}

function getNextSqrtPriceFromInput(sqrtPX96, liquidity, amountIn, zeroForOne) {
  if (sqrtPX96 === 0n || liquidity === 0n) throw new Error('InvalidPriceOrLiquidity');
  return zeroForOne
    ? getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountIn, true)
    : getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountIn, true);
}

function getNextSqrtPriceFromOutput(sqrtPX96, liquidity, amountOut, zeroForOne) {
  if (sqrtPX96 === 0n || liquidity === 0n) throw new Error('InvalidPriceOrLiquidity');
  return zeroForOne
    ? getNextSqrtPriceFromAmount1RoundingDown(sqrtPX96, liquidity, amountOut, false)
    : getNextSqrtPriceFromAmount0RoundingUp(sqrtPX96, liquidity, amountOut, false);
}

function getAmount0Delta(sqrtPriceAX96, sqrtPriceBX96, liquidity, roundUp) {
  let a = sqrtPriceAX96; let b = sqrtPriceBX96;
  if (a > b) { const t = a; a = b; b = t; }
  if (a === 0n) throw new Error('InvalidPrice');
  const numerator1 = liquidity << RESOLUTION;
  const numerator2 = b - a;
  return roundUp
    ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a)
    : mulDiv(numerator1, numerator2, b) / a;
}

function getAmount1Delta(sqrtPriceAX96, sqrtPriceBX96, liquidity, roundUp) {
  const numerator = sqrtPriceAX96 > sqrtPriceBX96 ? sqrtPriceAX96 - sqrtPriceBX96 : sqrtPriceBX96 - sqrtPriceAX96;
  const amount1 = mulDiv(liquidity, numerator, Q96);
  return amount1 + (((liquidity * numerator) % Q96 > 0n && roundUp) ? 1n : 0n);
}

module.exports = {
  Q96, MAX_UINT160, MAX_UINT256,
  mulDiv, mulDivRoundingUp, divRoundingUp,
  getNextSqrtPriceFromInput, getNextSqrtPriceFromOutput,
  getNextSqrtPriceFromAmount0RoundingUp, getNextSqrtPriceFromAmount1RoundingDown,
  getAmount0Delta, getAmount1Delta,
};
