/**
 * M3.2 最终评审 P0-2：交易内容级授权绑定测试。
 *
 * 目标：授权不得被复用到「另一笔交易」。任何字段（calldata / to / value / chainId /
 * intentId）变化都必须重新 build → simulate → authorize。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  computeBinding, bindingHashOf, assertBindingComplete, calldataHashOf, verifyBinding, preSignCheck,
} = require('../lib/tx-binding');
const { TX_GATE, GATE_VERSION, authorizeTx, evaluateTxRequest } = require('../config/tx-gate');
const { CHAIN, CONTRACTS } = require('../config/whitelist');

const PM = CONTRACTS.positionManager.address;
const CALldata_A = '0xdd46508f' + '11'.repeat(32);
const CALldata_B = '0xdd46508f' + '22'.repeat(32);

function unlockedConfig() {
  const cfg = JSON.parse(JSON.stringify(TX_GATE));
  cfg.enabled = true;
  cfg.unlockRecord = { path: 'user-informed-acceptance', recordedAt: new Date().toISOString(), recordedBy: 'test', note: '仅测试用' };
  for (const e of Object.values(cfg.allowedCalls)) e.writeEnabled = true;
  return cfg;
}
const baseReq = (calldataHash) => ({
  key: 'positionManager',
  selector: '0xdd46508f',
  intentType: 'mint',
  intentId: 101,
  chainId: CHAIN.id,
  to: PM,
  value: '0',
  calldataHash,
  amountUsd: 5,
  slippageBps: 50,
  hasMinOut: true,
  gasPriceGwei: 1,
  gasUsd: 0.2,
  quoteAgeSec: 5,
  priceImpactPct: 0.1,
});

// ---------- 绑定完整性 ----------

test('绑定字段完整性：缺任一关键字段都必须被识别', () => {
  const full = baseReq('0x' + 'ab'.repeat(32));
  assert.equal(assertBindingComplete(full).ok, true);
  for (const field of ['intentId', 'chainId', 'to', 'value', 'calldataHash']) {
    const bad = { ...full, [field]: undefined };
    const r = assertBindingComplete(bad);
    assert.equal(r.ok, false, `缺少 ${field} 应被识别`);
    assert.ok(r.missing.includes(field));
  }
  // 格式错误也算缺失
  assert.equal(assertBindingComplete({ ...full, calldataHash: '0x1234' }).ok, false);
  assert.equal(assertBindingComplete({ ...full, to: 'not-an-address' }).ok, false);
  assert.equal(assertBindingComplete({ ...full, value: '-1' }).ok, false);
});

// ---------- 绑定哈希 ----------

test('绑定哈希可复现：字段顺序不影响结果，任何字段变化都会改变哈希', () => {
  const b1 = computeBinding(baseReq('0x' + 'ab'.repeat(32)));
  const b2 = computeBinding(baseReq('0x' + 'ab'.repeat(32)));
  assert.equal(bindingHashOf(b1), bindingHashOf(b2));
  assert.match(bindingHashOf(b1), /^0x[0-9a-f]{64}$/);

  const changed = computeBinding({ ...baseReq('0x' + 'cd'.repeat(32)) });
  assert.notEqual(bindingHashOf(b1), bindingHashOf(changed));

  const changedTo = computeBinding({ ...baseReq('0x' + 'ab'.repeat(32)), to: '0x' + '11'.repeat(20) });
  assert.notEqual(bindingHashOf(b1), bindingHashOf(changedTo));
});

test('绑定内容包含完整交易要素（intentId / chainId / to / value / calldataHash 等）', () => {
  const b = computeBinding({ ...baseReq('0x' + 'ab'.repeat(32)), deadline: 1800000000, minOut: '123', quoteBlock: 3885000, simBlock: 3885001, simBlockHash: '0x' + 'ee'.repeat(32), actions: ['MINT_POSITION', 'SETTLE_PAIR'], poolId: '0x' + 'ff'.repeat(32) });
  for (const k of ['intentId', 'chainId', 'to', 'value', 'calldataHash', 'deadline', 'minOut', 'quoteBlock', 'simBlock', 'simBlockHash', 'actions', 'poolId']) {
    assert.ok(k in b, `绑定必须包含 ${k}`);
  }
});

// ---------- 授权不可复用（核心） ----------

test('授权 A 不能被用于交易 B（calldata 不同 → 绑定不一致）', () => {
  const authBinding = computeBinding(baseReq(calldataHashOf(CALldata_A)));
  const res = verifyBinding(authBinding, baseReq(calldataHashOf(CALldata_B)));
  assert.equal(res.ok, false);
  assert.ok(res.changed.includes('calldataHash'), JSON.stringify(res.changed));
  assert.match(res.reason, /必须重新 build/);
});

test('preSignCheck：calldata 与授权绑定一致 → 通过', () => {
  const binding = computeBinding(baseReq(calldataHashOf(CALldata_A)));
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, intent: { calldataHash: calldataHashOf(CALldata_A) }, calldata: CALldata_A, to: PM, value: '0', chainId: CHAIN.id });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.calldataHash, calldataHashOf(CALldata_A));
});

test('preSignCheck：签名前 calldata 被改动 → 拒绝（且给出明确原因）', () => {
  const binding = computeBinding(baseReq(calldataHashOf(CALldata_A)));
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, intent: { calldataHash: calldataHashOf(CALldata_A) }, calldata: CALldata_B, to: PM, value: '0', chainId: CHAIN.id });
  assert.equal(r.ok, false);
  assert.match(r.reason, /签名前核对失败/);
});

test('preSignCheck：to / value / chainId 变化 → 拒绝', () => {
  const binding = computeBinding(baseReq(calldataHashOf(CALldata_A)));
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  for (const over of [{ to: '0x' + '11'.repeat(20) }, { value: '1' }, { chainId: 1 }]) {
    const r = preSignCheck({ authorization, intent: { calldataHash: calldataHashOf(CALldata_A) }, calldata: CALldata_A, to: PM, value: '0', chainId: CHAIN.id, ...over });
    assert.equal(r.ok, false, `变化 ${JSON.stringify(over)} 应被拒绝`);
  }
});

test('preSignCheck：无授权绑定 / 无绑定哈希 → 一律拒绝', () => {
  assert.equal(preSignCheck({ authorization: {}, calldata: CALldata_A }).ok, false);
  const binding = computeBinding(baseReq(calldataHashOf(CALldata_A)));
  assert.equal(preSignCheck({ authorization: { binding }, calldata: CALldata_A }).ok, false);
});

test('preSignCheck：intent 记录与 calldata 不一致（intent 被替换）→ 拒绝', () => {
  const binding = computeBinding(baseReq(calldataHashOf(CALldata_A)));
  const authorization = { binding, bindingHash: bindingHashOf(binding) };
  const r = preSignCheck({ authorization, intent: { calldataHash: calldataHashOf(CALldata_B) }, calldata: CALldata_A, to: PM });
  assert.equal(r.ok, false);
  assert.match(r.reason, /intent/);
});

// ---------- 门禁层绑定校验 ----------

test('evaluateTxRequest：缺少绑定字段 → BINDING_MISSING（已解锁配置下也不放行）', () => {
  const d = evaluateTxRequest({ ...baseReq('0x' + 'ab'.repeat(32)), intentId: null }, {}, unlockedConfig());
  assert.equal(d.ok, false);
  assert.equal(d.code, 'BINDING_MISSING');
});

test('evaluateTxRequest：chainId / to 与白名单不一致 → 拒绝', () => {
  const d1 = evaluateTxRequest({ ...baseReq('0x' + 'ab'.repeat(32)), chainId: 1 }, {}, unlockedConfig());
  assert.equal(d1.code, 'CHAIN_MISMATCH');
  const d2 = evaluateTxRequest({ ...baseReq('0x' + 'ab'.repeat(32)), to: '0x' + '11'.repeat(20) }, {}, unlockedConfig());
  assert.equal(d2.code, 'TO_MISMATCH');
});

test('authorizeTx：授权记录必须携带绑定哈希（审计可追溯、签名前可比对）', async () => {
  const req = baseReq('0x' + 'ab'.repeat(32));
  const quotaStore = {
    reserveQuota: async () => ({ ok: true, reservation: { namespace: '', cents: 500 }, snapshot: { minuteCount: 1, dayCount: 1, dayAmountUsd: 5 } }),
    releaseQuota: async () => true,
    recordAttempt: async () => 1,
  };
  let recorded = null;
  const out = await authorizeTx(req, {
    stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
    config: unlockedConfig(), quotaStore,
    record: async (r, d) => { recorded = d; return 9; },
  });
  assert.equal(out.ok, true);
  assert.match(out.bindingHash, /^0x[0-9a-f]{64}$/);
  assert.equal(recorded.bindingHash, out.bindingHash);
  assert.equal(recorded.binding.intentId, '101');
  assert.equal(recorded.binding.to, PM.toLowerCase());
});

// ---------- 落库与接口静态检查 ----------

test('审计表与写入包含 intent_id / binding_hash / binding（静态检查）', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.js'), 'utf8');
  assert.match(schema, /intent_id: text\('intent_id'\)/);
  assert.match(schema, /binding_hash: text\('binding_hash'\)/);
  assert.match(schema, /binding: text\('binding'\)/);
  const state = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tx-gate-state.js'), 'utf8');
  assert.match(state, /binding_hash, binding\)/);
  assert.match(state, /loadLatestAuthorization/);
});

test('只读接口 /api/tx/pre-sign-check 存在且不签名、不广播（静态检查）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  assert.match(src, /'\/pre-sign-check'/);
  const idx = src.indexOf("'/pre-sign-check'");
  const handler = src.slice(idx, idx + 2200);
  assert.ok(!/sendTransaction|sendRawTransaction|signTransaction|eth_sign|personal_sign|wallet_/i.test(handler), '核对接口不得包含签名/发送调用');
  assert.match(handler, /preSignCheck/);
});

test('门禁版本为 M3-gate-4（含绑定校验）', () => {
  assert.equal(GATE_VERSION, 'M3-gate-4');
});
