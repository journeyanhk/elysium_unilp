/**
 * M3.3 手动签名与广播 —— 广播前置检查 / 签名交易核对 / 回执核对 / 失败熔断 / 静态无自动化检查。
 *
 * 说明：测试用**一次性测试私钥**构造签名交易，仅用于验证「核对逻辑」本身；
 * 产品代码不包含任何签名能力（下方静态检查会断言这一点）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { keccak256 } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const {
  preflightBroadcast, checkExistingBroadcast, classifyBroadcastFailure, evaluateReceipt,
  verifyRawTxAgainstBinding, verifyOnChainTxAgainstBinding, rawTxFingerprint, BROADCAST_MODES,
} = require('../lib/tx-broadcast');
const { computeBinding, bindingHashOf } = require('../lib/tx-binding');
const { CHAIN, CONTRACTS } = require('../config/whitelist');
const { TX_GATE } = require('../config/tx-gate');

const PM = CONTRACTS.positionManager.address;
const USER = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // 公开测试私钥
const TEST_ACCOUNT = privateKeyToAccount(TEST_KEY);
const OTHER_ACCOUNT = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba');
const CALLDATA = '0xdd46508f' + '11'.repeat(64);
const NOW = 1794300000000;

const BINDING = computeBinding({
  intentId: 77, chainId: CHAIN.id, to: PM, value: '0', calldataHash: keccak256(CALLDATA), selector: '0xdd46508f',
  key: 'positionManager', intentType: 'mint', amountUsd: 5, deadline: 1794300600, minOut: '10:20',
  quoteBlock: 3885000, simBlock: 3885001, simBlockHash: '0x' + 'ee'.repeat(32), simResultHash: '0x' + '11'.repeat(32),
  actions: ['MINT_POSITION', 'SETTLE_PAIR'], poolId: '0x' + 'ff'.repeat(32),
});
const BINDING_HASH = bindingHashOf(BINDING);

const OPEN_GATE = { enabled: true, version: 'M3-gate-4', unlockPath: 'user-informed-acceptance', killSwitchTripped: false, stateUnavailable: false };
const CONSUMED_AUTH = { status: 'consumed', bindingHash: BINDING_HASH, consumedAt: new Date(NOW - 10_000).toISOString() };

/** 预检辅助：固定 nowMs，避免「消费超时」先于其它检查触发 */
function pf(over = {}) {
  return preflightBroadcast({ gate: OPEN_GATE, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8', nowMs: NOW, ...over });
}

// ---------- 广播前置检查（纯函数） ----------

test('门禁关闭 → 拒绝广播（GATE_CLOSED）', () => {
  const r = preflightBroadcast({ gate: { ...OPEN_GATE, enabled: false }, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'GATE_CLOSED');
});

test('缺少解锁记录 → 拒绝广播（NO_UNLOCK_RECORD）', () => {
  const r = preflightBroadcast({ gate: { ...OPEN_GATE, unlockPath: null }, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' });
  assert.equal(r.code, 'NO_UNLOCK_RECORD');
});

test('熔断状态：已触发 / 未知 / 状态不可读 → 一律拒绝', () => {
  assert.equal(preflightBroadcast({ gate: { ...OPEN_GATE, killSwitchTripped: true, killSwitchReason: '测试' }, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' }).code, 'KILL_SWITCH');
  assert.equal(preflightBroadcast({ gate: { ...OPEN_GATE, killSwitchTripped: null }, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' }).code, 'GATE_STATE_UNAVAILABLE');
  assert.equal(preflightBroadcast({ gate: { ...OPEN_GATE, stateUnavailable: true }, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' }).code, 'GATE_STATE_UNAVAILABLE');
});

test('授权未消费 / 不存在 → 拒绝广播（禁止跳过一次性消费）', () => {
  const noAuth = preflightBroadcast({ gate: OPEN_GATE, authorization: null, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' });
  assert.equal(noAuth.code, 'NO_AUTHORIZATION');
  const notConsumed = preflightBroadcast({ gate: OPEN_GATE, authorization: { ...CONSUMED_AUTH, status: 'authorized' }, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8' });
  assert.equal(notConsumed.code, 'AUTHORIZATION_NOT_CONSUMED');
});

test('授权消费超时 → 拒绝广播（CONSUMPTION_STALE）', () => {
  const stale = preflightBroadcast({
    gate: OPEN_GATE, authorization: { ...CONSUMED_AUTH, consumedAt: new Date(NOW - (TX_GATE.limits.broadcastConsumeMaxAgeSec + 60) * 1000).toISOString() },
    bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8', nowMs: NOW,
  });
  assert.equal(stale.code, 'CONSUMPTION_STALE');
  const fresh = preflightBroadcast({ gate: OPEN_GATE, authorization: CONSUMED_AUTH, bindingHash: BINDING_HASH, mode: 'wallet-sign-raw', rawTx: '0x02f8', nowMs: NOW });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
});

test('绑定哈希不一致 / 缺失 → 拒绝广播', () => {
  assert.equal(pf({ authorization: { ...CONSUMED_AUTH, bindingHash: '0x' + 'aa'.repeat(32) } }).code, 'BINDING_MISMATCH');
  assert.equal(pf({ bindingHash: null }).code, 'BINDING_MISSING');
});

test('只允许两种手动方式；缺参数或非法方式 → 拒绝', () => {
  assert.deepEqual(BROADCAST_MODES, ['wallet-sign-raw', 'wallet-sent']);
  assert.equal(pf({ mode: 'auto' }).code, 'MODE_NOT_ALLOWED');
  assert.equal(pf({ mode: null }).code, 'MODE_NOT_ALLOWED');
  assert.equal(pf({ mode: 'wallet-sign-raw', rawTx: null }).code, 'RAW_TX_MISSING');
  assert.equal(pf({ mode: 'wallet-sent', rawTx: null, txHash: '0x12' }).code, 'TX_HASH_MISSING');
  assert.equal(pf({ mode: 'wallet-sent', rawTx: null, txHash: '0x' + 'ab'.repeat(32) }).ok, true);
});

test('同一 intent 只允许一笔广播', () => {
  assert.equal(checkExistingBroadcast([]).ok, true);
  for (const status of ['submitted', 'confirmed', 'reverted', 'verification_failed']) {
    const r = checkExistingBroadcast([{ id: 9, tx_hash: '0xabc', status }]);
    assert.equal(r.ok, false, status);
    assert.equal(r.code, 'ALREADY_BROADCAST');
  }
  assert.equal(checkExistingBroadcast([{ id: 9, tx_hash: null, status: 'rejected' }]).ok, true, '被拒绝的记录不阻止重来');
});

test('广播失败分类：节点明确拒绝不熔断；结果未知必须熔断（禁止自动重发）', () => {
  assert.equal(classifyBroadcastFailure({ code: 'BROADCAST_REJECTED' }).tripKillSwitch, false);
  assert.equal(classifyBroadcastFailure({ code: 'BROADCAST_UNKNOWN', ambiguous: true }).tripKillSwitch, true);
  assert.equal(classifyBroadcastFailure({ code: 'BROADCAST_ERROR' }).tripKillSwitch, true);
  assert.match(classifyBroadcastFailure({ code: 'BROADCAST_UNKNOWN', ambiguous: true }).reason, /禁止自动重发/);
});

// ---------- 签名交易核对 ----------

async function signTx({ to = PM, value = 0n, data = CALLDATA, chainId = CHAIN.id, gasPrice = 1_000_000_000n, account = TEST_ACCOUNT } = {}) {
  return account.signTransaction({
    to, value, data, chainId, nonce: 1, gas: 500000n, maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice, type: 'eip1559',
  });
}

test('钱包签名的原始交易与授权绑定一致 → 通过（含发送方恢复）', async () => {
  const rawTx = await signTx();
  const r = await verifyRawTxAgainstBinding({ rawTx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fields.to, PM.toLowerCase());
  assert.equal(r.fields.calldataHash, keccak256(CALLDATA));
  assert.equal(r.fields.selector, '0xdd46508f');
  assert.equal(String(r.fields.from), TEST_ACCOUNT.address.toLowerCase());
});

test('签名交易：链 / 合约 / 金额 / calldata / 发送方 任一不符 → 拒绝', async () => {
  const limits = TX_GATE.limits;
  const wrongChain = await signTx({ chainId: 1 });
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: wrongChain, binding: BINDING, user: TEST_ACCOUNT.address, limits })).code, 'CHAIN_MISMATCH');

  const wrongTo = await signTx({ to: CONTRACTS.poolManager.address });
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: wrongTo, binding: BINDING, user: TEST_ACCOUNT.address, limits })).code, 'TO_MISMATCH');

  const wrongValue = await signTx({ value: 10n ** 15n });
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: wrongValue, binding: BINDING, user: TEST_ACCOUNT.address, limits })).code, 'VALUE_MISMATCH');

  const wrongData = await signTx({ data: '0xdd46508f' + '22'.repeat(64) });
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: wrongData, binding: BINDING, user: TEST_ACCOUNT.address, limits })).code, 'CALLDATA_MISMATCH');

  const otherSender = await signTx({ account: OTHER_ACCOUNT });
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: otherSender, binding: BINDING, user: TEST_ACCOUNT.address, limits })).code, 'SENDER_MISMATCH');
});

test('签名交易：钱包自填 Gas 价格超过门禁上限 → 拒绝（禁止自动放宽）', async () => {
  const expensive = await signTx({ gasPrice: BigInt(TX_GATE.limits.maxGasPriceGwei + 1) * 10n ** 9n });
  const r = await verifyRawTxAgainstBinding({ rawTx: expensive, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits });
  assert.equal(r.code, 'GAS_PRICE_OVER');
});

test('非法 rawTx → 拒绝（不抛异常）', async () => {
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: null, binding: BINDING, user: USER })).code, 'RAW_TX_INVALID');
  assert.equal((await verifyRawTxAgainstBinding({ rawTx: '0xzz', binding: BINDING, user: USER })).code, 'RAW_TX_INVALID');
  const r = await verifyRawTxAgainstBinding({ rawTx: '0x02f8deadbeef', binding: BINDING, user: USER });
  assert.ok(['RAW_TX_PARSE_FAILED', 'RAW_TX_RECOVER_FAILED'].includes(r.code), r.code);
});

test('链上交易（钱包自行广播）事后核对：内容一致 → 通过；不一致 → 拒绝', () => {
  const good = { from: USER, to: PM, value: 0n, input: CALLDATA, chainId: CHAIN.id, gasPrice: 500000000n };
  const r = verifyOnChainTxAgainstBinding({ tx: good, binding: BINDING, user: USER, limits: TX_GATE.limits });
  assert.equal(r.ok, true, r.reason);
  const bad = verifyOnChainTxAgainstBinding({ tx: { ...good, input: '0xdd46508f' + '33'.repeat(64) }, binding: BINDING, user: USER, limits: TX_GATE.limits });
  assert.equal(bad.code, 'CALLDATA_MISMATCH');
  assert.equal(verifyOnChainTxAgainstBinding({ tx: null, binding: BINDING, user: USER }).code, 'ONCHAIN_TX_MISSING');
});

test('交易指纹可复现（审计用，不保存原始签名数据）', async () => {
  const rawTx = await signTx();
  assert.equal(rawTxFingerprint(rawTx), keccak256(rawTx));
  assert.notEqual(rawTxFingerprint(rawTx), rawTx);
});

// ---------- 回执核对 ----------

const GOOD_TX = { from: USER, to: PM, value: 0n, input: CALLDATA, chainId: CHAIN.id, gasPrice: 500000000n };
function receiptFixture(over = {}) {
  return {
    transactionHash: '0x' + 'cd'.repeat(32), status: 'success', blockNumber: 3886000,
    gasUsed: 380000n, effectiveGasPrice: 500000000n, from: USER, to: PM, logs: [], ...over,
  };
}

test('回执：回滚 → 硬失败 + 必须熔断', () => {
  const r = evaluateReceipt({ receipt: receiptFixture({ status: 'reverted' }), tx: GOOD_TX, binding: BINDING, user: USER, limits: TX_GATE.limits });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'RECEIPT_REVERTED');
  assert.equal(r.tripKillSwitch, true);
});

test('回执：尚未打包 → pending（不熔断、不重发）', () => {
  const r = evaluateReceipt({ receipt: null, tx: null, binding: BINDING, user: USER, limits: TX_GATE.limits });
  assert.equal(r.pending, true);
  assert.equal(r.tripKillSwitch, false);
});

test('回执：成功且链上内容与授权一致 → 通过', () => {
  const r = evaluateReceipt({ receipt: receiptFixture(), tx: GOOD_TX, binding: BINDING, user: USER, limits: TX_GATE.limits, hypeUsd: 40 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.receipt.gasUsed, '380000');
  assert.ok(r.gasUsd > 0 && r.gasUsd < TX_GATE.limits.maxGasUsd, `gasUsd=${r.gasUsd}`);
  assert.equal(r.tripKillSwitch, false);
});

test('回执：成功但链上内容与授权不一致 → 硬失败 + 必须熔断', () => {
  const r = evaluateReceipt({ receipt: receiptFixture(), tx: { ...GOOD_TX, to: CONTRACTS.poolManager.address }, binding: BINDING, user: USER, limits: TX_GATE.limits });
  assert.equal(r.code, 'POST_BROADCAST_MISMATCH');
  assert.equal(r.tripKillSwitch, true);
});

test('回执：实际 Gas 超过上限 → 记录偏差并要求人工复核（不熔断）', () => {
  const r = evaluateReceipt({ receipt: receiptFixture({ gasUsed: 10n ** 9n, effectiveGasPrice: 10n ** 9n }), tx: GOOD_TX, binding: BINDING, user: USER, limits: TX_GATE.limits, hypeUsd: 40 });
  assert.equal(r.ok, true);
  assert.equal(r.requiresReview, true);
  assert.equal(r.deviations[0].code, 'GAS_USD_OVER');
  assert.equal(r.tripKillSwitch, false);
});

// ---------- 静态检查：没有自动化、没有签名能力 ----------

test('静态检查：产品代码不包含任何签名能力（不托管私钥）', () => {
  const files = [
    ...fs.readdirSync(path.join(__dirname, '..', 'lib')).map((f) => path.join(__dirname, '..', 'lib', f)),
    ...fs.readdirSync(path.join(__dirname, '..', 'routes')).map((f) => path.join(__dirname, '..', 'routes', f)),
  ].filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const bad of ['privateKeyToAccount', 'mnemonicToAccount', 'hdKeyToAccount', 'signTransaction(', 'signTypedData(']) {
      if (src.includes(bad)) offenders.push(`${path.basename(f)}:${bad}`);
    }
  }
  assert.deepEqual(offenders, [], `产品代码不得包含签名能力：${offenders.join(', ')}`);
});

test('静态检查：广播只有单次调用，没有重试 / 替换 / 加速分支', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tx-broadcast.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function sendRawTransactionOnce'), src.indexOf('/** 读取链上交易（只读） */'));
  assert.ok(!/for\s*\(/.test(fn), '广播函数内不得有循环（重试）');
  assert.ok(!/retries|retry/i.test(fn), '广播函数内不得有重试逻辑');
  assert.ok(!/eth_sendTransaction|eth_sign|personal_sign|wallet_/i.test(src), '广播模块不得包含签名/钱包方法');
  assert.ok(!/\b(speedUp|replaceTransaction|resendTransaction|bumpFee|accelerate)\s*\(/.test(src), '广播模块不得包含加速/替换/重发函数');
  assert.ok(!/nonce\s*:/.test(src), '广播模块不得自行指定 nonce（自动替换/加速依赖手工 nonce）');
  const methodCalls = src.match(/eth_sendRawTransaction/g) || [];
  assert.equal(methodCalls.length, 2, 'eth_sendRawTransaction 只应出现在写方法白名单与单次广播调用中');
});

test('静态检查：广播路由顺序正确（门禁预检 → 内容核对 → 单次广播 → 记录）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  const route = src.slice(src.indexOf("router.post('/broadcast'"));
  const iPre = route.indexOf('preflightBroadcast(');
  const iSend = route.indexOf('sendRawTransactionOnce(');
  const iCheck = route.indexOf('verifyRawTxAgainstBinding(');
  assert.ok(iPre > -1 && iSend > -1 && iCheck > -1, '广播路由必须包含预检、内容核对与单次广播');
  assert.ok(iPre < iCheck && iCheck < iSend, '顺序必须是：预检 → 内容核对 → 广播');
  assert.ok(!/config:\s*(cfg|unlockedConfig|JSON\.parse)/.test(src), '路由不得注入自定义门禁配置');
});
