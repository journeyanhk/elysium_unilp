/**
 * 生产实现 vs 独立参考实现 的交叉校验（M2 / P0-3 第二次修订）
 *
 * 生产：backend/lib/v4math.js（十进制高精度 + BigInt 定点）
 * 参考：backend/reference/v4/*（官方 v4-core 源码的逐句移植，位分解 TickMath）
 *
 * 二者是**完全不同的代码路径**：本测试要求它们在
 *   - TickMath 双向换算（含边界）
 *   - 金额/流动性换算
 *   - 完整 Swap 逐步语义（含跨 tick、限价、exact-in/out、手续费取整）
 * 上逐位一致。任何一方出现转录错误都会在这里暴露。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const prod = require('../lib/v4math');
const RefTick = require('../reference/v4/tickmath');
const RefSwap = require('../reference/v4/pool-swap');
const RefSpm = require('../reference/v4/sqrtpricemath');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'swap-vectors.json'), 'utf8'));

test('参考 TickMath 与官方常量一致（位分解算法自洽）', () => {
  assert.equal(RefTick.getSqrtPriceAtTick(RefTick.MAX_TICK), RefTick.MAX_SQRT_PRICE);
  assert.equal(RefTick.getSqrtPriceAtTick(RefTick.MIN_TICK), RefTick.MIN_SQRT_PRICE);
  // 往返一致性
  for (const t of [-887272, -100000, -52534, -1, 0, 1, 52534, 100000, 887271]) {
    assert.equal(RefTick.getTickAtSqrtPrice(RefTick.getSqrtPriceAtTick(t)), t, `往返失败 @${t}`);
  }
});

test('生产 TickMath 与参考 TickMath 在活跃区间逐位一致', () => {
  for (let tick = -120000; tick <= 120000; tick += 337) {
    assert.equal(BigInt(prod.sqrtPriceX96AtTick(tick)), RefTick.getSqrtPriceAtTick(tick), `tick ${tick}`);
  }
  // 价格 → tick 的往返（活跃区间）
  for (const tick of [-99999, -52534, -200, 0, 200, 52534, 99999]) {
    const sqrt = RefTick.getSqrtPriceAtTick(tick);
    assert.equal(prod.tickAtSqrtPrice(sqrt), tick, `tickAtSqrtPrice @${tick}`);
  }
});

test('金额换算与参考实现逐位一致（含取整方向）', () => {
  const L = 162700892025519823405611n;
  for (let i = 0; i < 60; i++) {
    const a = RefTick.getSqrtPriceAtTick(52000 + i * 13);
    const b = RefTick.getSqrtPriceAtTick(52100 + i * 17);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    assert.equal(prod.getAmount0Delta(lo, hi, L, true), RefSpm.getAmount0Delta(lo, hi, L, true), `amount0 up @${i}`);
    assert.equal(prod.getAmount0Delta(lo, hi, L, false), RefSpm.getAmount0Delta(lo, hi, L, false), `amount0 down @${i}`);
    assert.equal(prod.getAmount1Delta(lo, hi, L, true), RefSpm.getAmount1Delta(lo, hi, L, true), `amount1 up @${i}`);
    assert.equal(prod.getAmount1Delta(lo, hi, L, false), RefSpm.getAmount1Delta(lo, hi, L, false), `amount1 down @${i}`);
  }
});

test('完整 Swap：生产实现与参考实现在全部链上向量上逐位一致', () => {
  let n = 0;
  for (const v of fixture.vectors) {
    const tickMap = new Map(v.ticks.map(([t, x]) => [t, BigInt(x)]));
    const limit = v.sqrtPriceLimitX96 ? BigInt(v.sqrtPriceLimitX96) : null;
    const ref = RefSwap.swap({
      zeroForOne: v.zeroForOne, mode: v.mode,
      amount: v.mode === 'exactOut' ? BigInt(v.expected.amountOut) : BigInt(v.amountIn),
      sqrtPriceX96: BigInt(v.sqrtPriceX96), tick: v.tick, liquidity: BigInt(v.liquidity),
      liquidityNetByTick: tickMap, feePips: v.feePips, sqrtPriceLimitX96: limit,
    });
    const p = prod.swapEstimate({
      zeroForOne: v.zeroForOne, mode: 'exactIn', amountIn: BigInt(v.amountIn),
      sqrtPriceX96: BigInt(v.sqrtPriceX96), tick: v.tick, liquidity: BigInt(v.liquidity),
      liquidityNetByTick: tickMap, feePips: v.feePips, sqrtPriceLimitX96: limit,
    });
    if (v.mode === 'exactIn') {
      assert.equal(p.amountIn, ref.amountIn, `blk ${v.blockNumber} amountIn`);
      assert.equal(p.amountOut, ref.amountOut, `blk ${v.blockNumber} amountOut`);
      assert.equal(p.feePaid, ref.feePaid, `blk ${v.blockNumber} feePaid`);
      assert.equal(p.sqrtPriceAfter, ref.sqrtPriceAfter, `blk ${v.blockNumber} sqrtPriceAfter`);
      assert.equal(BigInt(p.tickAfter), BigInt(ref.tickAfter), `blk ${v.blockNumber} tickAfter`);
      assert.equal(p.liquidityAfter, ref.liquidityAfter, `blk ${v.blockNumber} liquidityAfter`);
    } else {
      const pOut = prod.swapEstimate({
        zeroForOne: v.zeroForOne, mode: 'exactOut', amountOut: BigInt(v.expected.amountOut),
        sqrtPriceX96: BigInt(v.sqrtPriceX96), tick: v.tick, liquidity: BigInt(v.liquidity),
        liquidityNetByTick: tickMap, feePips: v.feePips, sqrtPriceLimitX96: limit,
      });
      assert.equal(pOut.amountIn, ref.amountIn, `blk ${v.blockNumber} exact-out amountIn`);
      assert.equal(pOut.feePaid, ref.feePaid, `blk ${v.blockNumber} exact-out feePaid`);
    }
    n++;
  }
  assert.equal(n, fixture.vectors.length);
  assert.ok(n > 0);
});

test('随机参数下生产实现与参考实现一致（构造性检查）', () => {
  // 用固定种子生成伪随机场景，覆盖不同费率/方向/限价
  let seed = 42n;
  const rnd = (mod) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); return Number(seed % BigInt(mod)); };
  const ticks = [-600, -400, -200, 0, 200, 400, 600];
  for (let i = 0; i < 120; i++) {
    const tick = 52000 + ticks[rnd(ticks.length)];
    const L = 10n ** 15n + BigInt(rnd(10 ** 6)) * 10n ** 15n;
    const zeroForOne = rnd(2) === 0;
    const amount = 10n ** 12n + BigInt(rnd(10 ** 6)) * 10n ** 12n;
    const feePips = [500, 3000, 10000][rnd(3)];
    const net = new Map([[52000 + ticks[rnd(ticks.length)], (rnd(2) ? 1n : -1n) * (10n ** 15n + BigInt(rnd(1000)) * 10n ** 15n)]]);
    const sqrtP = RefTick.getSqrtPriceAtTick(tick);
    const args = { zeroForOne, sqrtPriceX96: sqrtP, tick, liquidity: L, liquidityNetByTick: net, feePips };
    const ref = RefSwap.swap({ ...args, mode: 'exactIn', amount });
    const p = prod.swapEstimate({ ...args, mode: 'exactIn', amountIn: amount });
    assert.equal(p.amountOut, ref.amountOut, `case ${i} amountOut`);
    assert.equal(p.feePaid, ref.feePaid, `case ${i} feePaid`);
    assert.equal(p.sqrtPriceAfter, ref.sqrtPriceAfter, `case ${i} sqrtPriceAfter`);
    assert.equal(BigInt(p.tickAfter), BigInt(ref.tickAfter), `case ${i} tickAfter`);
    assert.equal(p.liquidityAfter, ref.liquidityAfter, `case ${i} liquidityAfter`);
  }
});
