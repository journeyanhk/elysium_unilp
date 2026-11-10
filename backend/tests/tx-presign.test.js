/**
 * M3.2 第四轮评审 P0-1：签名前核对必须使用**权威模拟数据**。
 *
 * 覆盖：
 *   [x] 没有成功模拟记录 → 拒绝
 *   [x] 模拟结果过期 → 拒绝
 *   [x] 缺少 simBlockHash / quoteBlock / simResultHash → 拒绝
 *   [x] calldata 解码的 actions / deadline 与 intent 记录不一致 → 拒绝
 *   [x] quoteBlock / simBlockHash / minOut 与授权绑定不同 → 拒绝
 *   [x] 权威记录完整且一致 → 通过
 */
const test = require('node:test');
const assert = require('node:assert');

const { simResultHashOf, buildPreSignCurrent } = require('../lib/tx-presign');
const { computeBinding, bindingHashOf, calldataHashOf, preSignCheck } = require('../lib/tx-binding');
const { CHAIN, CONTRACTS } = require('../config/whitelist');

const PM = CONTRACTS.positionManager.address;
const USER = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';
const CALldata = '0xdd46508f' + '11'.repeat(32);
const NOW = 1794300000000; // 固定时间，便于测试过期

const INTENT = {
  id: 77,
  chain_id: CHAIN.id,
  key: 'positionManager',
  intent_type: 'mint',
  target_contract: PM,
  selector: '0xdd46508f',
  calldata_hash: '0x' + 'ab'.repeat(32),
  actions: JSON.stringify(['MINT_POSITION', 'SETTLE_PAIR']),
  pool_id: '0x' + 'ff'.repeat(32),
  amount_usd: '5',
  deadline: 1794300600,
  params: JSON.stringify({ tickLower: 52000, tickUpper: 52800, liquidity: '1000', amount0Max: '10', amount1Max: '20', owner: USER, deadline: 1794300600 }),
  user_addr: USER,
};
const DECODED = { selector: '0xdd46508f', actions: ['MINT_POSITION', 'SETTLE_PAIR'], deadline: 1794300600, minOut: '10:20' };
const SIM_HASH = simResultHashOf({ ethCallOk: true, gasEstimate: '420000', gasUsd: 0.02, simBlockNumber: 3885001, simBlockHash: '0x' + 'ee'.repeat(32) });
function simFixture(over = {}) {
  return {
    simulationId: 5, intentId: 77, simBlock: 3885001, simBlockHash: '0x' + 'ee'.repeat(32),
    quoteBlock: 3885000, gasEstimate: '420000', gasPriceGwei: 0.5, gasUsd: 0.02,
    simResultHash: SIM_HASH, at: new Date(NOW).toISOString(), createdAtMs: NOW - 1000, ...over,
  };
}
const REQ = { calldata: CALldata, to: PM, value: '0', chainId: CHAIN.id };

function buildOk(over = {}) {
  const built = buildPreSignCurrent({
    intent: { ...INTENT, ...(over.intent || {}) },
    simulation: over.simulation === null ? null : simFixture(over.simulation || {}),
    request: { ...REQ, ...(over.request || {}) },
    decoded: over.decoded === undefined ? DECODED : over.decoded,
    simMaxAgeSec: over.simMaxAgeSec != null ? over.simMaxAgeSec : 300,
    nowMs: over.nowMs != null ? over.nowMs : NOW,
  });
  return built;
}

// ---------- 拒绝规则 ----------

test('没有成功模拟记录 → 拒绝（不得用 null 补位）', () => {
  const b = buildOk({ simulation: null });
  assert.equal(b.ok, false);
  assert.match(b.reason, /没有成功的模拟记录/);
});

test('模拟结果过期 → 拒绝', () => {
  const b = buildOk({ simulation: { createdAtMs: NOW - 400 * 1000 } });
  assert.equal(b.ok, false);
  assert.match(b.reason, /已过期/);
});

test('模拟记录缺少 simBlockHash / quoteBlock / simResultHash → 拒绝', () => {
  for (const over of [{ simBlockHash: null }, { quoteBlock: null }, { simResultHash: null }]) {
    const b = buildOk({ simulation: over });
    assert.equal(b.ok, false, JSON.stringify(over));
    assert.match(b.reason, /禁止签名/);
  }
});

test('缺少 calldata 解码结果 → 拒绝', () => {
  const b = buildOk({ decoded: null });
  assert.equal(b.ok, false);
  assert.match(b.reason, /缺少 calldata 解码结果/);
});

test('calldata 的 actions 与 intent 记录不一致 → 拒绝', () => {
  const b = buildOk({ decoded: { ...DECODED, actions: ['DECREASE_LIQUIDITY', 'TAKE_PAIR'] } });
  assert.equal(b.ok, false);
  assert.match(b.reason, /actions/);
});

test('calldata 的 deadline 与 intent 记录不一致 → 拒绝', () => {
  const b = buildOk({ decoded: { ...DECODED, deadline: DECODED.deadline + 60 } });
  assert.equal(b.ok, false);
  assert.match(b.reason, /deadline/);
});

test('calldata 未解出金额边界（minOut）→ 拒绝', () => {
  const b = buildOk({ decoded: { ...DECODED, minOut: null } });
  assert.equal(b.ok, false);
  assert.match(b.reason, /金额边界/);
});

// ---------- 通过路径 ----------

test('权威记录完整且一致 → 通过，且 quoteBlock / simBlock / simBlockHash / simResultHash 均来自记录', () => {
  const b = buildOk();
  assert.equal(b.ok, true, b.reason);
  assert.equal(b.current.quoteBlock, 3885000);
  assert.equal(b.current.simBlock, 3885001);
  assert.equal(b.current.simBlockHash, '0x' + 'ee'.repeat(32));
  assert.equal(b.current.simResultHash, SIM_HASH);
  assert.equal(b.current.minOut, '10:20');
  assert.equal(b.current.amountUsd, 5);
  assert.equal(b.current.intentId, 77);
});

test('授权绑定由权威记录生成 → 签名前核对通过', () => {
  const b = buildOk();
  const binding = computeBinding({ ...b.current, calldataHash: calldataHashOf(CALldata) });
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, current: b.current, calldata: CALldata, decoded: DECODED });
  assert.equal(r.ok, true, r.reason);
});

// ---------- 与授权不同即拒绝 ----------

test('quoteBlock 与授权不同 → 拒绝', () => {
  const b = buildOk();
  const binding = computeBinding({ ...b.current, calldataHash: calldataHashOf(CALldata) });
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, current: { ...b.current, quoteBlock: 3884999 }, calldata: CALldata, decoded: DECODED });
  assert.equal(r.ok, false);
  assert.ok(r.changed.includes('quoteBlock'), JSON.stringify(r.changed));
});

test('simBlockHash 与授权不同 → 拒绝', () => {
  const b = buildOk();
  const binding = computeBinding({ ...b.current, calldataHash: calldataHashOf(CALldata) });
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, current: { ...b.current, simBlockHash: '0x' + 'aa'.repeat(32) }, calldata: CALldata, decoded: DECODED });
  assert.equal(r.ok, false);
  assert.ok(r.changed.includes('simBlockHash'), JSON.stringify(r.changed));
});

test('minOut 与 calldata 不同 → 拒绝（解码结果优先，不能靠传入值绕过）', () => {
  const b = buildOk();
  const binding = computeBinding({ ...b.current, calldataHash: calldataHashOf(CALldata) });
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  // 传入不同的 minOut，但解码结果仍为 10:20 → 解码结果覆盖，故必须一致才通过
  const r1 = preSignCheck({ authorization, current: { ...b.current, minOut: '99:99' }, calldata: CALldata, decoded: DECODED });
  assert.equal(r1.ok, true, '解码结果优先：传入值被真实 calldata 覆盖');
  // 真实 calldata 解出不同边界 → 拒绝
  const r2 = preSignCheck({ authorization, current: b.current, calldata: CALldata, decoded: { ...DECODED, minOut: '99:99' } });
  assert.equal(r2.ok, false);
  assert.ok(r2.changed.includes('minOut'), JSON.stringify(r2.changed));
});

test('simResultHash 与授权不同 → 拒绝', () => {
  const b = buildOk();
  const binding = computeBinding({ ...b.current, calldataHash: calldataHashOf(CALldata) });
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, current: { ...b.current, simResultHash: '0x' + '11'.repeat(32) }, calldata: CALldata, decoded: DECODED });
  assert.equal(r.ok, false);
  assert.ok(r.changed.includes('simResultHash'), JSON.stringify(r.changed));
});

// ---------- 摘要算法 ----------

test('模拟结果摘要稳定：同一结果同哈希，任何字段变化都改变哈希', () => {
  const base = { ethCallOk: true, gasEstimate: '420000', gasUsd: 0.02, simBlockNumber: 3885001, simBlockHash: '0x' + 'ee'.repeat(32) };
  assert.equal(simResultHashOf(base), simResultHashOf({ ...base }));
  assert.notEqual(simResultHashOf(base), simResultHashOf({ ...base, gasEstimate: '420001' }));
  assert.notEqual(simResultHashOf(base), simResultHashOf({ ...base, simBlockHash: '0x' + 'aa'.repeat(32) }));
  assert.match(simResultHashOf(base), /^0x[0-9a-f]{64}$/);
});
