'use strict';
/**
 * 独立参考实现 · Uniswap v4-core TickMath 的忠实移植（**位分解算法**）
 *
 * 来源：https://github.com/Uniswap/v4-core/blob/main/src/libraries/TickMath.sol
 *      函数 getSqrtPriceAtTick / getTickAtSqrtPrice（旧版命名 getSqrtRatioAtTick / getTickAtSqrtRatio，算法相同）
 *
 * 与生产实现 `backend/lib/v4math.js` 的区别：生产实现用十进制高精度数学（decimal.js）计算 1.0001^(tick/2)，
 * 本文件用官方源码的 20 个定点常数 + 位分解算法（含最终 >>32 的向上取整），二者是**完全不同的代码路径**。
 * 因此本文件可作为「独立参考」用于交叉验证，不参与任何生产路径。
 *
 * 注意：uint256 溢出在 Solidity 中依赖 unchecked 语义，本文件用 BigInt + 显式范围检查等价模拟。
 */
const MAX_UINT256 = (1n << 256n) - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
/** TickMath.MIN_SQRT_PRICE / MAX_SQRT_PRICE */
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const MAX_SQRT_PRICE_MINUS_MIN_SQRT_PRICE_MINUS_ONE = MAX_SQRT_PRICE - MIN_SQRT_PRICE - 1n;

/** 官方位分解常数（Q128.128，四舍五入到整数） */
const CONSTS = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

function getSqrtPriceAtTick(tick) {
  const t = BigInt(tick);
  if (t < BigInt(MIN_TICK) || t > BigInt(MAX_TICK)) throw new Error(`InvalidTick(${tick})`);
  const absTick = t < 0n ? -t : t;
  // price = absTick & 1 ? 2^128 / sqrt(1.0001) : 2^128
  let price = (absTick & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : (1n << 128n);
  for (const [bit, c] of CONSTS) {
    if ((absTick & bit) !== 0n) price = (price * c) >> 128n;
  }
  if (t > 0n) price = MAX_UINT256 / price;
  // Q128.128 → Q128.96，向上取整（保证 getTickAtSqrtPrice 往返一致）
  return (price + 0xffffffffn) >> 32n;
}

function mostSignificantBit(x) {
  if (x <= 0n) throw new Error('MSB of zero');
  let r = 0;
  let v = x;
  while (v > 1n) { v >>= 1n; r++; }
  return r;
}

/** int256 算术右移 128（向下取整） */
function sar128(x) {
  return x >= 0n ? x >> 128n : -(((-x) + (1n << 128n) - 1n) >> 128n);
}

function getTickAtSqrtPrice(sqrtPriceX96) {
  const p = BigInt(sqrtPriceX96);
  if (p < MIN_SQRT_PRICE || p >= MAX_SQRT_PRICE) throw new Error(`InvalidSqrtPrice(${sqrtPriceX96})`);
  if (p - MIN_SQRT_PRICE > MAX_SQRT_PRICE_MINUS_MIN_SQRT_PRICE_MINUS_ONE) throw new Error('InvalidSqrtPrice');

  let price = p << 32n;
  let r = price;
  const msb = mostSignificantBit(r);
  r = msb >= 128 ? price >> BigInt(msb - 127) : price << BigInt(127 - msb);

  let log2 = BigInt(msb - 128) << 64n;
  for (let shift = 63n; shift >= 50n; shift--) {
    r = (r * r) >> 127n;
    const f = r >> 128n;
    log2 |= f << shift;
    r >>= f;
  }

  const logSqrt10001 = log2 * 255738958999603826347141n;
  const tickLow = Number(sar128(logSqrt10001 - 3402992956809132418596140100660247210n));
  const tickHi = Number(sar128(logSqrt10001 + 291339464771989622907027621153398088495n));
  if (tickLow === tickHi) return tickLow;
  return getSqrtPriceAtTick(tickHi) <= p ? tickHi : tickLow;
}

module.exports = { MIN_TICK, MAX_TICK, MIN_SQRT_PRICE, MAX_SQRT_PRICE, getSqrtPriceAtTick, getTickAtSqrtPrice, sar128 };
