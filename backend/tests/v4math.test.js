/**
 * v4math 回归测试（node --test）
 * 覆盖：TickMath 边界、tick 对齐、金额/流动性往返、SqrtPriceMath 两步取整、Swap 边界情形。
 */
const test = require('node:test');
const assert = require('node:assert');
const v4 = require('../lib/v4math');

const Q96 = 2n ** 96n;

test('TickMath：边界与往返', () => {
  assert.equal(v4.sqrtPriceX96AtTick(v4.MIN_TICK), 4295128739n, 'MIN_TICK 应等于官方 MIN_SQRT_RATIO');
  // 说明：链上 TickMath 为定点位运算实现，在 MAX_TICK 处与数学真值存在约 4e-20 的相对偏差；
  // 本实现取数学真值（与 Python 高精度一致），在活跃价格区间（±10 万 tick）与链上逐位一致（见 swap-vectors 回归）。
  const maxSqrt = v4.sqrtPriceX96AtTick(v4.MAX_TICK);
  assert.ok(maxSqrt <= v4.MAX_SQRT_RATIO, 'MAX_TICK 不应超过官方 MAX_SQRT_RATIO');
  const rel = Number(v4.MAX_SQRT_RATIO - maxSqrt) / Number(v4.MAX_SQRT_RATIO);
  assert.ok(rel < 1e-15, `与官方常量相对偏差应极小（实际 ${rel}）`);
  for (const tick of [-887272, -500000, -1000, -1, 0, 1, 1000, 52534, 500000, 887272]) {
    const sqrtP = v4.sqrtPriceX96AtTick(tick);
    assert.equal(v4.tickAtSqrtPrice(sqrtP), tick, `tick ${tick} 往返应一致`);
  }
  assert.throws(() => v4.sqrtPriceX96AtTick(v4.MIN_TICK - 1), /超出范围/);
  assert.throws(() => v4.sqrtPriceX96AtTick(v4.MAX_TICK + 1), /超出范围/);
});

test('tick 对齐与价格换算', () => {
  assert.equal(v4.alignTickDown(52534, 200), 52400);
  assert.equal(v4.alignTickUp(52534, 200), 52600);
  assert.equal(v4.alignTickDown(-1, 200), -200);
  const p = v4.priceAtTick(52534);
  const back = v4.tickAtPrice(p);
  assert.ok(Math.abs(back - 52534) <= 1, '价格→tick 往返误差应 ≤1 tick');
});

test('SqrtPriceMath：getAmount0Delta 为两步取整（与官方一致）', () => {
  const L = 162700892025519823405611n;
  const a = 1115529373527955976904234553622n;
  const b = 1115741414350882662184876258624n;
  const twoStepUp = (() => {
    const num1 = L * Q96; const num2 = b - a;
    const t = (num1 * num2 + b - 1n) / b;      // mulDivRoundingUp
    return (t + a - 1n) / a;                   // divRoundingUp
  })();
  assert.equal(v4.getAmount0Delta(a, b, L, true), twoStepUp, '向上取整必须是两步');
  // 逐个核对：实现必须与官方「两步取整」形式一致（这是曾经差 1 wei 的根因所在）
  for (let i = 0; i < 500; i++) {
    const aa = 10n ** 29n + BigInt(i) * 7919n;
    const bb = aa + 10n ** 24n + BigInt(i) * 104729n;
    const two = (() => { const n1 = L * Q96; const n2 = bb - aa; const t = (n1 * n2 + bb - 1n) / bb; return (t + aa - 1n) / aa; })();
    assert.equal(v4.getAmount0Delta(aa, bb, L, true), two, `两步取整不一致 @i=${i}`);
  }
  const twoStepDown = (() => {
    const num1 = L * Q96; const num2 = b - a;
    return ((num1 * num2) / b) / a;
  })();
  assert.equal(v4.getAmount0Delta(a, b, L, false), twoStepDown);
});

test('金额 ↔ 流动性往返', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52534);
  const sqrtA = v4.sqrtPriceX96AtTick(52400);
  const sqrtB = v4.sqrtPriceX96AtTick(52600);
  const L = 10n ** 21n;
  const amts = v4.amountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
  const back = v4.liquidityForAmounts(sqrtP, sqrtA, sqrtB, amts.amount0, amts.amount1);
  assert.ok(back.L <= L, '由数量反算的 L 不应大于原 L（取整向下）');
  assert.ok(Number(L - back.L) / Number(L) < 1e-9, '往返误差应极小');
  // 价格在区间下方：只需要 token0
  const below = v4.amountsForLiquidity(v4.sqrtPriceX96AtTick(50000), sqrtA, sqrtB, L);
  assert.equal(below.amount1, 0n);
  // 价格在区间上方：只需要 token1
  const above = v4.amountsForLiquidity(v4.sqrtPriceX96AtTick(60000), sqrtA, sqrtB, L);
  assert.equal(above.amount0, 0n);
});

test('computeSwapStep：费率 0 与 1% 的行为', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52534);
  const sqrtT = v4.sqrtPriceX96AtTick(52400);
  const L = 10n ** 21n;
  const amt = 10n ** 18n;
  const fee0 = v4.computeSwapStep(sqrtP, sqrtT, L, amt, 0n);
  assert.equal(fee0.feeAmount, 0n, '费率为 0 时不应有手续费');
  const fee1 = v4.computeSwapStep(sqrtP, sqrtT, L, amt, 10000n);
  assert.ok(fee1.feeAmount > 0n, '1% 费率应有手续费');
  assert.equal(fee1.reachedTarget, true, '大额输入应走满到边界');
  assert.equal(fee1.feeAmount, (fee1.amountIn * 10000n + 989999n) / 990000n, '到达边界时手续费 = ceil(amountIn × 费率/(1e6−费率))');
  // 小额输入：未到边界 → amountIn = lessFee，且 输入+手续费 恰好等于剩余输入
  const small = 10n ** 14n;
  const feeSmall = v4.computeSwapStep(sqrtP, sqrtT, L, small, 10000n);
  assert.equal(feeSmall.reachedTarget, false, '小额输入不应到边界');
  assert.equal(feeSmall.amountIn, (small * 990000n) / 1000000n, '未到边界时 amountIn 应等于 lessFee');
  assert.equal(feeSmall.amountIn + feeSmall.feeAmount, small, '未到边界时 输入+手续费 应恰好等于剩余输入');
});

test('swapEstimate：极小金额与零金额不崩溃', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52534);
  const e0 = v4.swapEstimate({ zeroForOne: true, amountIn: 0n, sqrtPriceX96: sqrtP, tick: 52534, liquidity: 10n ** 21n, liquidityNetByTick: new Map() });
  assert.equal(e0.amountOut, 0n);
  const e1 = v4.swapEstimate({ zeroForOne: true, amountIn: 1n, sqrtPriceX96: sqrtP, tick: 52534, liquidity: 10n ** 21n, liquidityNetByTick: new Map() });
  assert.ok(e1.amountOut >= 0n && e1.feePaid >= 0n, '1 wei 输入不应抛错');
});

test('swapEstimate：跨 tick 会改变流动性并计数', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52600);
  // 注意：起点 tick 本身若为初始化 tick，V4 会先「零消耗跨过」该 tick（ticksCrossed 会 +1），此处只放边界 52400
  const net = new Map([[52400, -500n * 10n ** 18n]]);
  const L = 10n ** 21n;
  // 输入量需覆盖「手续费 + 到达边界」，故取 toBoundary / 0.99 × 1.001（lessFee 恰好超过到边界所需）
  const toBoundary = v4.getAmount0Delta(v4.sqrtPriceX96AtTick(52400), sqrtP, L, true);
  const amountIn = (toBoundary * 1012n) / 1000n;
  const big = v4.swapEstimate({ zeroForOne: true, amountIn, sqrtPriceX96: sqrtP, tick: 52600, liquidity: L, liquidityNetByTick: net, feePips: 10000 });
  assert.equal(big.ticksCrossed, 1, '应跨过 52400');
  assert.notEqual(big.liquidityAfter, L, '跨 tick 后流动性应变化');
  assert.equal(big.tickAfter, 52399, '跨 tick 后 tick 应为边界−1');
  assert.equal(big.liquidityAfter, L + 500n * 10n ** 18n, '零对一跨 tick：L 应减去该 tick 的净流动性');
  const small = v4.swapEstimate({ zeroForOne: true, amountIn: toBoundary / 100n, sqrtPriceX96: sqrtP, tick: 52600, liquidity: L, liquidityNetByTick: net, feePips: 10000 });
  assert.equal(small.ticksCrossed, 0, '小额不应跨 tick');
  assert.equal(small.liquidityAfter, L);
});

test('swapEstimate：价格限制（limit）停止', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52600);
  const L = 10n ** 21n;
  // 情形 A：限价在 tick 边界之内（更近）→ 停在限价、不跨 tick、L 不变
  const limitMid = v4.sqrtPriceX96AtTick(52500);
  const net = new Map([[52400, -500n * 10n ** 18n]]);
  const a = v4.swapEstimate({ zeroForOne: true, amountIn: 10n ** 20n, sqrtPriceX96: sqrtP, tick: 52600, liquidity: L, liquidityNetByTick: net, feePips: 10000, sqrtPriceLimitX96: limitMid });
  assert.equal(a.sqrtPriceAfter, limitMid, '应恰好停在限价');
  assert.equal(a.ticksCrossed, 0, '未到边界不应跨 tick');
  assert.equal(a.liquidityAfter, L);
  assert.equal(a.limitReached, true);
  assert.equal(a.partial, true, '限价终止时剩余输入未消耗');
  assert.ok(a.amountIn < 10n ** 20n, '实际消耗应小于指定输入');
  // 情形 B：限价恰为 tick 边界 → V4 语义：先跨过该 tick（更新 L/tick），随后因价格==限价退出
  const limitAtTick = v4.sqrtPriceX96AtTick(52400);
  const b = v4.swapEstimate({ zeroForOne: true, amountIn: 10n ** 20n, sqrtPriceX96: sqrtP, tick: 52600, liquidity: L, liquidityNetByTick: net, feePips: 10000, sqrtPriceLimitX96: limitAtTick });
  assert.equal(b.sqrtPriceAfter, limitAtTick);
  assert.equal(b.ticksCrossed, 1);
  assert.equal(b.tickAfter, 52399);
  assert.equal(b.limitReached, true);
  // 情形 C：限价等于起始价 → 无成交
  const c = v4.swapEstimate({ zeroForOne: true, amountIn: 10n ** 20n, sqrtPriceX96: sqrtP, tick: 52600, liquidity: L, liquidityNetByTick: net, feePips: 10000, sqrtPriceLimitX96: sqrtP });
  assert.equal(c.amountOut, 0n);
  assert.equal(c.amountIn, 0n);
  assert.equal(c.sqrtPriceAfter, sqrtP);
});

test('swapEstimate：exact-out 与 exact-in 互为近似（同向同区间）', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52534);
  const L = 10n ** 21n;
  const ein = v4.swapEstimate({ zeroForOne: true, amountIn: 10n ** 18n, sqrtPriceX96: sqrtP, tick: 52534, liquidity: L, liquidityNetByTick: new Map(), feePips: 10000 });
  const eout = v4.swapEstimate({ zeroForOne: true, amountOut: ein.amountOut, mode: 'exactOut', sqrtPriceX96: sqrtP, tick: 52534, liquidity: L, liquidityNetByTick: new Map(), feePips: 10000 });
  assert.equal(eout.amountOut, ein.amountOut, 'exact-out 应精确给出目标输出');
  const diff = ein.amountIn > eout.amountIn ? ein.amountIn - eout.amountIn : eout.amountIn - ein.amountIn;
  assert.ok(diff <= 2n, `两种口径的输入差应在 2 wei 内（实际 ${diff}）`);
});

test('swapEstimate：执行价影响包含费率（价格为 0 变化时不应为 null）', () => {
  const sqrtP = v4.sqrtPriceX96AtTick(52534);
  const L = 10n ** 21n;
  const e = v4.swapEstimate({ zeroForOne: true, amountIn: 10n ** 18n, sqrtPriceX96: sqrtP, tick: 52534, liquidity: L, liquidityNetByTick: new Map(), feePips: 10000 });
  assert.ok(e.priceImpactPct !== null && e.priceImpactPct < 0, '买入方向的执行价影响应为负（含 1% 费率）');
  assert.ok(e.priceImpactPct > -3, '小额成交的费率+滑点不应超过 3%');
});
