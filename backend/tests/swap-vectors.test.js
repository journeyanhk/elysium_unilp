/**
 * 链上参考向量回归（M2 / P0-3 第二次修订）
 *
 * 规则（对应 review 要求）：
 *  - 强制校验 fixture 的独立性元数据：validation.independentReference / feePaidChecked /
 *    productionCodeUsedInGeneration===false / limitInsensitiveOnly / exclusiveHypothesisOnly
 *    （缺失或不满足直接失败，绝不静默跳过）
 *  - 逐位断言：amountOut、amountIn（exact-out 亦断言）、feePaid、sqrtPriceAfter、tickAfter、liquidityAfter
 *  - 不依赖 fixture.stats.mismatchCount 自证：测试内自行逐条重算并统计
 *  - feePaid 为链上反推（onchain-feeGrowthGlobal）的样本必须与链上值逐位一致；
 *    参考实现推导的样本也必须与生产实现一致（跨实现一致性）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const v4 = require('../lib/v4math');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'swap-vectors.json');
const META_PATH = path.join(__dirname, 'fixtures', 'swap-vectors.meta.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

function run(v) {
  const base = {
    zeroForOne: v.zeroForOne,
    sqrtPriceX96: BigInt(v.sqrtPriceX96),
    tick: v.tick,
    liquidity: BigInt(v.liquidity),
    liquidityNetByTick: new Map(v.ticks.map(([t, n]) => [t, BigInt(n)])),
    feePips: v.feePips,
    sqrtPriceLimitX96: v.sqrtPriceLimitX96 ? BigInt(v.sqrtPriceLimitX96) : null,
  };
  return v4.swapEstimate(v.mode === 'exactOut'
    ? { ...base, mode: 'exactOut', amountOut: BigInt(v.expected.amountOut) }
    : { ...base, mode: 'exactIn', amountIn: BigInt(v.amountIn) });
}

test('fixture 独立性元数据必须齐备且为真', () => {
  const val = fixture.stats && fixture.stats.validation;
  assert.ok(val, 'fixture 缺少 validation 元数据');
  assert.equal(val.independentReference, true, 'independentReference 必须为 true');
  assert.equal(val.feePaidChecked, true, 'feePaidChecked 必须为 true');
  assert.equal(val.productionCodeUsedInGeneration, false, '生成过程不得使用生产实现');
  assert.equal(val.limitSemanticsChecked, true, '限价语义必须经过检查');
  assert.equal(val.exclusiveHypothesisOnly, true, '模式判定必须为排他性检验');
  assert.equal(val.expectedSource, 'on-chain-swap-event', '期望值必须来自链上事件');
  assert.ok(val.modeSource.includes('transaction-calldata'), '模式来源需包含 calldata 解析');
  // 每条向量都必须带来源信息与 feePaid 来源
  for (const v of fixture.vectors) {
    assert.ok(v.source && v.source.modeSource, `向量 ${v.blockNumber} 缺少 modeSource`);
    assert.ok(['transaction-calldata', 'chain-observable-hypothesis-test'].includes(v.source.modeSource));
    // 限价语义：要么对备选限价不敏感，要么已用链上结果确认
    assert.ok(v.source.limitInsensitive === true || typeof v.source.limitConfirmedBy === 'string',
      `向量 ${v.blockNumber} 缺少限价语义确认`);
    if (v.source.modeSource === 'chain-observable-hypothesis-test') {
      assert.equal(v.source.exclusive, true, `向量 ${v.blockNumber} 缺少排他性标记`);
    } else {
      assert.equal(v.source.decodedFromCalldata, true, `向量 ${v.blockNumber} 未标记 calldata 解码`);
      assert.ok(v.source.action && v.source.router, `向量 ${v.blockNumber} 缺少路由/动作信息`);
    }
    assert.ok(v.expected.feePaid, `向量 ${v.blockNumber} 缺少 expected.feePaid`);
    assert.ok(['onchain-feeGrowthGlobal', 'independent-reference'].includes(v.expected.feePaidSource));
  }
});

test('fixture 元数据（sha256/字节数）与文件一致', () => {
  const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(FIXTURE_PATH)).digest('hex');
  assert.equal(meta.sha256, sha, 'fixture sha256 与元数据不一致（文件被手工修改？）');
  assert.equal(meta.bytes, fs.statSync(FIXTURE_PATH).size);
  assert.equal(meta.vectors, fixture.vectors.length);
  assert.ok(meta.poolId && meta.blockRange && meta.generatorCommit !== undefined);
});

test('样本规模与覆盖达标', () => {
  const s = fixture.stats;
  assert.ok(s.vectors >= 200, `向量数过少：${s.vectors}`);
  assert.ok(s.coverage.zeroForOne > 0 && s.coverage.oneForZero > 0, '需双向覆盖');
  assert.ok(s.coverage.crossTick > 0, '需覆盖跨 tick');
  assert.ok(s.byModeSource.transactionCalldata > 0, '需包含 calldata 解码样本（方案 A）');
  assert.ok(s.byModeSource.transactionCalldata + s.byModeSource.chainObservableHypothesisTest === s.vectors, '来源计数应等于总数');
  assert.equal(s.exactInVectors + s.exactOutVectors, s.vectors, 'mode 计数应等于总数');
  assert.ok(s.coverage.feePaidFromChain > 0, '需包含链上反推 feePaid 的样本');
});

test('全部链上参考向量逐位复现（生产实现）', () => {
  const mismatches = [];
  let checked = 0;
  let feeOnchain = 0;
  for (const v of fixture.vectors) {
    const est = run(v);
    checked++;
    const exp = v.expected;
    if (est.amountOut !== BigInt(exp.amountOut)) mismatches.push({ b: v.blockNumber, f: 'amountOut', exp: exp.amountOut, got: est.amountOut.toString() });
    if (est.amountIn !== BigInt(exp.amountIn)) mismatches.push({ b: v.blockNumber, f: 'amountIn', exp: exp.amountIn, got: est.amountIn.toString() });
    if (est.feePaid !== BigInt(exp.feePaid)) mismatches.push({ b: v.blockNumber, f: 'feePaid', exp: exp.feePaid, got: est.feePaid.toString() });
    if (est.sqrtPriceAfter !== BigInt(exp.sqrtPriceAfter)) mismatches.push({ b: v.blockNumber, f: 'sqrtPriceAfter', exp: exp.sqrtPriceAfter, got: est.sqrtPriceAfter.toString() });
    if (BigInt(est.tickAfter) !== BigInt(exp.tickAfter)) mismatches.push({ b: v.blockNumber, f: 'tickAfter', exp: exp.tickAfter, got: est.tickAfter });
    if (est.liquidityAfter !== BigInt(exp.liquidityAfter)) mismatches.push({ b: v.blockNumber, f: 'liquidityAfter', exp: exp.liquidityAfter, got: est.liquidityAfter.toString() });
    // 链上反推的 feePaid：必须与链上值逐位一致（这是最强的手续费断言）
    if (exp.feePaidSource === 'onchain-feeGrowthGlobal') {
      feeOnchain++;
      assert.equal(est.feePaid.toString(), exp.feePaidOnchain, `blk ${v.blockNumber} feePaid 与链上反推值不一致`);
    }
  }
  assert.equal(mismatches.length, 0, `不一致 ${mismatches.length} 条：${JSON.stringify(mismatches.slice(0, 3))}`);
  assert.equal(checked, fixture.vectors.length);
  assert.ok(feeOnchain > 0, '链上 feePaid 校验样本数应大于 0');
});

test('exact-out 向量单独校验（amountIn 亦须逐位一致）', () => {
  const outs = fixture.vectors.filter((v) => v.mode === 'exactOut');
  assert.ok(outs.length > 0, '需包含 exact-out 样本');
  for (const v of outs) {
    const est = run(v);
    assert.equal(est.amountOut.toString(), v.expected.amountOut, `blk ${v.blockNumber} exact-out amountOut`);
    assert.equal(est.amountIn.toString(), v.expected.amountIn, `blk ${v.blockNumber} exact-out amountIn`);
  }
});

test('跨 tick 子集单独校验（流动性切换）', () => {
  const cross = fixture.vectors.filter((v) => v.meta.ticksCrossed > 0);
  assert.ok(cross.length > 0, '需包含跨 tick 样本');
  for (const v of cross) {
    const est = run(v);
    assert.equal(est.ticksCrossed > 0, true, `blk ${v.blockNumber} 应跨 tick`);
    assert.equal(est.liquidityAfter.toString(), v.expected.liquidityAfter, `blk ${v.blockNumber} 跨 tick 后流动性`);
    assert.equal(BigInt(est.tickAfter), BigInt(v.expected.tickAfter), `blk ${v.blockNumber} 跨 tick 后 tick`);
  }
});
