/**
 * analysis 纯函数回归：收益速度（含 CHAIN.id 未配置的显式报错）与 Break-even 模型。
 */
const test = require('node:test');
const assert = require('node:assert');
const { computeFeeVelocity, breakevenModel } = require('../lib/analysis');

const H = 3600 * 1000;
const row = (tMs, f0, f1) => ({ sampled_at: new Date(tMs).toISOString(), fee0_pending: f0, fee1_pending: f1 });

test('computeFeeVelocity：样本不足返回 null（不静默编造）', () => {
  assert.equal(computeFeeVelocity([], 80, 0.4).usdPerDay, null);
  assert.equal(computeFeeVelocity([row(Date.now(), '0', '0')], 80, 0.4).usdPerDay, null);
  const one = computeFeeVelocity([row(Date.now(), '1e18', '0')], 80, 0.4);
  assert.equal(one.samples, 1);
});

test('computeFeeVelocity：跨度不足 10 分钟返回 null', () => {
  const t0 = Date.now() - 5 * 60 * 1000;
  const r = computeFeeVelocity([row(t0, '0', '0'), row(Date.now(), '1e17', '0')], 80, 0.4);
  assert.equal(r.usdPerDay, null);
  assert.match(r.note, /跨度不足/);
});

test('computeFeeVelocity：正常样本返回 $/天', () => {
  const t0 = Date.now() - 24 * H;
  const rows = [row(t0, '0', '0'), row(Date.now(), (1n * 10n ** 18n).toString(), (2n * 10n ** 18n).toString())];
  const r = computeFeeVelocity(rows, 80, 0.4);
  // 24h 内累计 1 HYPE + 2 KNTQ → $/天 ≈ 80 + 0.8
  assert.ok(Math.abs(r.usdPerDay - 80.8) < 0.5, `实际 ${r.usdPerDay}`);
  assert.equal(r.samples, 2);
});

test('breakevenModel：LP 高于 HODL 时无需额外手续费', () => {
  const b = breakevenModel({ diffUsd: 5, gasUsd: 0.2, bridgeCostUsd: 0, share: 0.001, inRange: true, feeVelocityUsdPerDay: 1 });
  assert.equal(b.feesNeededToMatchHodlUsd, 0);
  assert.ok(b.requiredFeesUsd > 0, '仍应计入 gas 成本');
});

test('breakevenModel：LP 低于 HODL 时给出所需手续费与交易量', () => {
  const b = breakevenModel({ diffUsd: -3, gasUsd: 0.2, bridgeCostUsd: 1, share: 0.002, inRange: true, feeVelocityUsdPerDay: 0.5 });
  assert.equal(b.feesNeededToMatchHodlUsd, 3);
  assert.ok(Math.abs(b.requiredFeesUsd - 4.2) < 1e-9);
  assert.ok(Math.abs(b.requiredVolumeApproxUsd - 4.2 / (0.01 * 0.002)) < 1e-6);
  assert.ok(Math.abs(b.daysToCover - 4.2 / 0.5) < 1e-9);
});

test('breakevenModel：出区间时所需交易量为 null（公式不适用）', () => {
  const b = breakevenModel({ diffUsd: -3, gasUsd: 0, bridgeCostUsd: 0, share: 0.002, inRange: false, feeVelocityUsdPerDay: 1 });
  assert.equal(b.requiredVolumeApproxUsd, null);
});

test('breakevenModel：负桥接成本归零、无采样时不给天数', () => {
  const b = breakevenModel({ diffUsd: -1, gasUsd: 0, bridgeCostUsd: -99, share: 0.001, inRange: true, feeVelocityUsdPerDay: null });
  assert.equal(b.bridgeCostUsd, 0);
  assert.equal(b.daysToCover, null);
  assert.ok(b.requiredFeesUsd >= 1);
});

test('breakevenModel：缺少 LP 价值时全为 null（不编造数字）', () => {
  const b = breakevenModel({ diffUsd: null, gasUsd: 0.1, bridgeCostUsd: 0, share: 0.001, inRange: true, feeVelocityUsdPerDay: 1 });
  assert.equal(b.feesNeededToMatchHodlUsd, null);
  assert.equal(b.requiredFeesUsd, null);
  assert.equal(b.requiredVolumeApproxUsd, null);
});
