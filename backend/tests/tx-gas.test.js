/**
 * M3.3 review P0-2：Gas 计划（simulate 阶段锁定）与 Gas 绑定核对。
 *
 * 覆盖：
 *   [x] gasLimit = eth_estimateGas × 固定余量，且有下限
 *   [x] maxFeePerGas = 链上 Gas 价格，且 ≤ 门禁上限
 *   [x] maxPriorityFeePerGas = min(maxFeePerGas, 上限)
 *   [x] Gas 美元最坏成本（gasLimit × maxFeePerGas × HYPE 价格）≤ 1 USD
 *   [x] 缺少估算 / 缺少价格 / 超过任一上限 → 拒绝
 *   [x] 签名前核对：gasLimit / maxFeePerGas / maxPriorityFeePerGas 超过绑定 → 拒绝
 *   [x] 无法复核 Gas 美元上限（无 HYPE 价格）→ 拒绝
 */
const test = require('node:test');
const assert = require('node:assert');

const { GAS_PLAN_VERSION, computeGasPlan, checkGasAgainstBinding, normalizeTxType } = require('../lib/tx-gas');
const { TX_GATE } = require('../config/tx-gate');

const L = TX_GATE.limits;
const HYPE = 40; // 40 USD / HYPE
const PRICE = 500_000_000n; // 0.5 gwei

function plan(over = {}) {
  return computeGasPlan({ gasEstimate: 40000, gasPriceWei: PRICE, hypeUsd: HYPE, ...over });
}

// ---------- Gas 计划 ----------

test('Gas 计划：gasLimit = 估算 × (1 + 固定余量)，并遵守下限', () => {
  const r = plan();
  assert.equal(r.ok, true, r.reason);
  const expected = Math.max(Math.ceil(40000 * (1 + L.gasLimitMarginBps / 10000)), L.minGasLimit);
  assert.equal(r.plan.gasLimit, expected);
  assert.equal(r.plan.gasLimit, 50000, '40000 × 1.25 = 50000，恰为下限');
  assert.equal(r.plan.version, GAS_PLAN_VERSION);
  const small = plan({ gasEstimate: 10000 });
  assert.equal(small.plan.gasLimit, L.minGasLimit, '低于下限时取下限');
  const big = plan({ gasEstimate: 400000 });
  assert.equal(big.plan.gasLimit, 500000);
});

test('Gas 计划：费用参数取链上价格，优先费不超过上限且不超过 maxFeePerGas', () => {
  const r = plan();
  assert.equal(r.plan.maxFeePerGasWei, PRICE.toString());
  assert.equal(r.plan.maxPriorityFeePerGasWei, PRICE.toString(), '0.5 gwei < 1 gwei 上限 → 取 maxFeePerGas');
  const high = plan({ gasPriceWei: 3_000_000_000n }); // 3 gwei > 1 gwei 优先费上限
  assert.equal(high.plan.maxFeePerGasWei, '3000000000');
  assert.equal(high.plan.maxPriorityFeePerGasWei, String(1e9), '优先费被限制到上限');
});

test('Gas 计划：美元成本按最坏情况（gasLimit × maxFeePerGas）计算', () => {
  const r = plan();
  const expected = (Number(BigInt(r.plan.gasLimit) * PRICE) / 1e18) * HYPE;
  assert.ok(Math.abs(r.plan.gasUsd - expected) < 1e-9, `${r.plan.gasUsd} vs ${expected}`);
  assert.ok(r.plan.gasUsd <= L.maxGasUsd);
});

test('Gas 计划：缺少估算 / 缺少价格 / 缺少 HYPE 价格 → 拒绝', () => {
  assert.equal(plan({ gasEstimate: null }).code, 'GAS_ESTIMATE_MISSING');
  assert.equal(plan({ gasEstimate: 0 }).code, 'GAS_ESTIMATE_MISSING');
  assert.equal(plan({ gasPriceWei: null }).code, 'GAS_PRICE_MISSING');
  assert.equal(plan({ hypeUsd: null }).code, 'HYPE_PRICE_MISSING');
});

test('Gas 计划：Gas 单价超上限 / 美元成本超上限 → 拒绝', () => {
  assert.equal(plan({ gasPriceWei: BigInt(L.maxGasPriceGwei + 1) * 10n ** 9n }).code, 'GAS_PRICE_OVER');
  // 大估算 + 高价格 → 美元成本超 1 USD
  const r = plan({ gasEstimate: 6_000_000, gasPriceWei: 4_000_000_000n }); // 7.5M × 4 gwei × 40 USD ≈ 1.2 USD
  assert.equal(r.code, 'GAS_USD_OVER');
});

// ---------- 签名前 Gas 核对 ----------

const BINDING = { gasLimit: 50000, maxFeePerGas: PRICE.toString(), maxPriorityFeePerGas: PRICE.toString(), gasUsd: 0.001 };
const EIP1559 = { type: 'eip1559' };

test('签名前核对：严格等于绑定值 → 通过', () => {
  const r = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.gas.type, 'eip1559');
  assert.equal(r.gas.gasUsd <= L.maxGasUsd, true);
});

test('签名前核对：Gas 参数**降低**也必须拒绝（严格等于，不是「不超过」）', () => {
  assert.equal(checkGasAgainstBinding({ gasLimit: 49999n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'GAS_LIMIT_MISMATCH');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE - 1n, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'MAX_FEE_MISMATCH');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE - 1n, ...EIP1559 }, BINDING, L, HYPE).code, 'PRIORITY_FEE_MISMATCH');
});

test('签名前核对：Gas 参数超过绑定值同样拒绝（错误码区分）', () => {
  assert.equal(checkGasAgainstBinding({ gasLimit: 50001n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'GAS_LIMIT_MISMATCH');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE + 1n, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'MAX_FEE_MISMATCH');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE + 1n, ...EIP1559 }, BINDING, L, HYPE).code, 'PRIORITY_FEE_MISMATCH');
});

test('签名前核对：优先费高于 maxFeePerGas → 拒绝（防御性检查，绑定异常时兜底）', () => {
  const weird = { gasLimit: 50000, maxFeePerGas: '100000000', maxPriorityFeePerGas: '200000000', gasUsd: 0.001 };
  const r = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: 100_000_000n, maxPriorityFeePerGasWei: 200_000_000n, ...EIP1559 }, weird, L, HYPE);
  assert.equal(r.code, 'PRIORITY_FEE_ABOVE_MAX_FEE');
});

test('签名前核对：绑定费用上限高于门禁单价上限 → 拒绝（绝对上限兜底）', () => {
  const high = { gasLimit: 50000, maxFeePerGas: String((L.maxGasPriceGwei + 1) * 1e9), maxPriorityFeePerGas: String((L.maxGasPriceGwei + 1) * 1e9), gasUsd: 0.001 };
  const r = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: BigInt((L.maxGasPriceGwei + 1) * 1e9), maxPriorityFeePerGasWei: BigInt((L.maxGasPriceGwei + 1) * 1e9), ...EIP1559 }, high, L, HYPE);
  assert.equal(r.code, 'GAS_PRICE_OVER');
});

test('交易类型：legacy（仅 gasPrice）不得与 EIP-1559 Gas 计划混用', () => {
  const legacy = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, type: 'legacy' }, BINDING, L, HYPE);
  assert.equal(legacy.code, 'TX_TYPE_MISMATCH');
  const legacyRaw = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, type: '0x0' }, BINDING, L, HYPE);
  assert.equal(legacyRaw.code, 'TX_TYPE_MISMATCH');
  const both = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, type: 'eip1559', gasPriceWei: PRICE }, BINDING, L, HYPE);
  assert.equal(both.code, 'TX_TYPE_MISMATCH', '同时携带 legacy gasPrice → 拒绝');
  const eip = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, type: '0x2' }, BINDING, L, HYPE);
  assert.equal(eip.ok, true, eip.reason);
  // 未标注类型：**不得推断**（M3.3 review 第四轮）→ fail-closed 拒绝
  const missing = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE }, BINDING, L, HYPE);
  assert.equal(missing.code, 'TX_TYPE_MISSING');
  const nullType = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, type: null }, BINDING, L, HYPE);
  assert.equal(nullType.code, 'TX_TYPE_MISSING', 'type=null 同样拒绝（即使其他 EIP-1559 字段完整）');
  const garbage = checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, type: '0x7f' }, BINDING, L, HYPE);
  assert.equal(garbage.code, 'TX_TYPE_MISSING', '无法识别的类型码 → 拒绝，不猜测');
  assert.equal(normalizeTxType(undefined), 'unknown');
  assert.equal(normalizeTxType(''), 'unknown');
  assert.equal(normalizeTxType('0x2'), 'eip1559');
  assert.equal(normalizeTxType('0x0'), 'legacy');
  assert.equal(normalizeTxType('0x1'), 'eip2930');
  assert.equal(normalizeTxType('0x3'), 'unknown');
});

test('签名前核对：缺少 Gas 字段 / 绑定缺 Gas / 无法复核美元上限 → 拒绝', () => {
  assert.equal(checkGasAgainstBinding({ maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'GAS_LIMIT_MISSING');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'GAS_PRICE_MISSING');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, HYPE).code, 'PRIORITY_FEE_MISSING');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, { ...BINDING, gasLimit: null }, L, HYPE).code, 'GAS_BINDING_MISSING');
  assert.equal(checkGasAgainstBinding({ gasLimit: 50000n, maxFeePerGasWei: PRICE, maxPriorityFeePerGasWei: PRICE, ...EIP1559 }, BINDING, L, null).code, 'HYPE_PRICE_MISSING');
});

test('签名前核对：美元成本超上限 → 拒绝（即使未超过绑定值）', () => {
  // 绑定给足额度，但 HYPE 价格暴涨 → 最坏成本超 1 USD
  const big = { gasLimit: 4_000_000, maxFeePerGas: '4000000000', maxPriorityFeePerGas: '1000000000', gasUsd: 0.5 };
  const r = checkGasAgainstBinding({ gasLimit: 4_000_000n, maxFeePerGasWei: 4_000_000_000n, maxPriorityFeePerGasWei: 1_000_000_000n, ...EIP1559 }, big, L, 5000);
  assert.equal(r.code, 'GAS_USD_OVER');
});

test('门禁上限覆盖：Gas 参数上限来自配置而非请求', () => {
  assert.equal(L.gasLimitMarginBps, 2500);
  assert.equal(L.minGasLimit, 50000);
  assert.equal(L.maxPriorityFeeGwei, 1);
  assert.equal(L.maxGasUsd, 1);
  assert.equal(L.maxGasPriceGwei, 5);
});
