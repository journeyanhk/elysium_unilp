/**
 * 链上参考向量回归（离线重放）
 *
 * 数据来源：backend/scripts/swap-vectors.js 从 KNTQ/HYPE 池真实 Swap 事件生成
 * （相邻两笔 Swap 之间无流动性变化 → 前一笔后状态即后一笔精确前状态）。
 * 断言：amountOut / sqrtPriceAfter / tickAfter / liquidityAfter 必须**逐位一致**。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const v4 = require('../lib/v4math');

const fixturePath = path.join(__dirname, 'fixtures', 'swap-vectors.json');
const fixture = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : null;

test('参考向量 fixture 存在且覆盖充分', { skip: !fixture && '缺少 fixture（先运行 node scripts/swap-vectors.js）' }, () => {
  assert.ok(fixture.vectors.length >= 1000, `向量数应 ≥1000（实际 ${fixture.vectors.length}）`);
  assert.ok(fixture.stats.coverage.crossTick >= 100, `跨 tick 样本应 ≥100（实际 ${fixture.stats.coverage.crossTick}）`);
  assert.ok(fixture.stats.coverage.zeroForOne > 0 && fixture.stats.coverage.oneForZero > 0, '两个方向都应有样本');
  assert.equal(fixture.stats.mismatchCount, 0, '生成时不应有不一致样本');
});

test('全部链上参考向量逐位复现', { skip: !fixture && '缺少 fixture' }, () => {
  let ok = 0;
  const fails = [];
  for (const v of fixture.vectors) {
    const base = {
      zeroForOne: v.zeroForOne,
      sqrtPriceX96: BigInt(v.sqrtPriceX96),
      tick: v.tick,
      liquidity: BigInt(v.liquidity),
      liquidityNetByTick: new Map(v.ticks.map(([t, n]) => [t, BigInt(n)])),
      feePips: v.feePips,
      sqrtPriceLimitX96: v.sqrtPriceLimitX96 ? BigInt(v.sqrtPriceLimitX96) : null,
    };
    const isOut = v.mode.startsWith('exactOut');
    const est = v4.swapEstimate(isOut
      ? { ...base, mode: 'exactOut', amountOut: BigInt(v.expected.amountOut) }
      : { ...base, mode: 'exactIn', amountIn: BigInt(v.amountIn) });
    const good = est.amountOut === BigInt(v.expected.amountOut)
      && est.sqrtPriceAfter === BigInt(v.expected.sqrtPriceAfter)
      && BigInt(est.tickAfter) === BigInt(v.expected.tickAfter)
      && est.liquidityAfter === BigInt(v.expected.liquidityAfter);
    if (good) ok++;
    else if (fails.length < 5) fails.push({ block: v.blockNumber, mode: v.mode });
  }
  assert.deepEqual(fails, [], `不一致样本：${JSON.stringify(fails)}`);
  assert.equal(ok, fixture.vectors.length, `应全部复现（${ok}/${fixture.vectors.length}）`);
});

test('跨 tick 子集单独校验', { skip: !fixture && '缺少 fixture' }, () => {
  const cross = fixture.vectors.filter((v) => v.meta.ticksCrossed > 0);
  assert.ok(cross.length > 0);
  for (const v of cross.slice(0, 300)) {
    const base = {
      zeroForOne: v.zeroForOne,
      sqrtPriceX96: BigInt(v.sqrtPriceX96),
      tick: v.tick,
      liquidity: BigInt(v.liquidity),
      liquidityNetByTick: new Map(v.ticks.map(([t, n]) => [t, BigInt(n)])),
      feePips: v.feePips,
      sqrtPriceLimitX96: v.sqrtPriceLimitX96 ? BigInt(v.sqrtPriceLimitX96) : null,
    };
    const est = v4.swapEstimate(v.mode.startsWith('exactOut')
      ? { ...base, mode: 'exactOut', amountOut: BigInt(v.expected.amountOut) }
      : { ...base, mode: 'exactIn', amountIn: BigInt(v.amountIn) });
    assert.equal(est.sqrtPriceAfter, BigInt(v.expected.sqrtPriceAfter), `blk ${v.blockNumber} sqrt 不一致`);
    assert.equal(BigInt(est.tickAfter), BigInt(v.expected.tickAfter), `blk ${v.blockNumber} tick 不一致`);
  }
});
