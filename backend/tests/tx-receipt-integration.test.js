/**
 * M3.3 回执核对 —— 真实 RPC 字段映射集成测试（review 第三轮 P0）。
 *
 * 背景：`fetchTxByHash()` 曾遗漏 gas / maxPriorityFeePerGas / type 三个字段，
 * 而 Gas 参数已纳入授权绑定（严格相等），于是**一笔成功且内容正确的交易**会在回执阶段
 * 被判为内容不一致（GAS_LIMIT_MISSING / PRIORITY_FEE_MISSING）→ verification_failed → 误触发熔断。
 *
 * 本文件用**本地假节点**（真实 JSON-RPC 十六进制载荷）跑完整链路，而不是直接构造 GOOD_TX：
 *   eth_getTransactionByHash（真实 RPC 字段）
 *   → fetchTxByHash（字段映射）
 *   → verifyOnChainTxAgainstBinding（内容核对）
 *   → verifyReceipt / evaluateReceipt（回执结论 + 是否熔断）
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { keccak256, parseTransaction } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { fetchTxByHash, fetchReceipt, evaluateReceipt, verifyOnChainTxAgainstBinding } = require('../lib/tx-broadcast');
const { verifyReceipt } = require('../lib/tx-wallet-tx');
const { computeBinding, bindingHashOf } = require('../lib/tx-binding');
const { CHAIN, CONTRACTS } = require('../config/whitelist');
const { TX_GATE } = require('../config/tx-gate');

const PM = CONTRACTS.positionManager.address;
const TEST_ACCOUNT = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const CALLDATA = '0xdd46508f' + '11'.repeat(64);
const GAS_LIMIT = 525000n;
const MAX_FEE = 500_000_000n;
const PRIORITY_FEE = 500_000_000n;

const BINDING = computeBinding({
  intentId: 91, chainId: CHAIN.id, to: PM, value: '0', calldataHash: keccak256(CALLDATA), selector: '0xdd46508f',
  key: 'positionManager', intentType: 'mint', amountUsd: 5, deadline: 1794300600, minOut: '10:20',
  quoteBlock: 3885000, simBlock: 3885001, simBlockHash: '0x' + 'ee'.repeat(32), simResultHash: '0x' + '11'.repeat(32),
  actions: ['MINT_POSITION', 'SETTLE_PAIR'], poolId: '0x' + 'ff'.repeat(32),
  gasLimit: Number(GAS_LIMIT), maxFeePerGas: MAX_FEE.toString(), maxPriorityFeePerGas: PRIORITY_FEE.toString(), gasUsd: 0.0105,
});
const HYPE_USD = 40;

// ---------- 本地假节点（真实 JSON-RPC 形状：十六进制字符串） ----------

let nodeTx = null;
let nodeReceipt = null;
let rpcCalls = [];
let server = null;
let rpcUrl = null;

function startNode() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { method, id } = JSON.parse(body || '{}');
        rpcCalls.push(method);
        const result = method === 'eth_getTransactionByHash' ? nodeTx
          : method === 'eth_getTransactionReceipt' ? nodeReceipt
            : null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      rpcUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

/** 由真实签名交易派生节点返回的字段（保证「节点数据」与「真实交易」一致，而不是手写常量） */
function nodePayloadFromRawTx(rawTx) {
  const p = parseTransaction(rawTx);
  const hex = (v) => (v != null ? '0x' + BigInt(v).toString(16) : undefined);
  // viem 的 parseTransaction 返回类型标签（'eip1559' / 'legacy'），节点返回的是十六进制类型码
  const TYPE_HEX = { legacy: '0x0', eip2930: '0x1', eip1559: '0x2', eip4844: '0x3' };
  return {
    hash: '0x' + 'cd'.repeat(32),
    from: TEST_ACCOUNT.address, // 节点返回的发送方（= 签名恢复地址）
    to: p.to,
    value: hex(p.value ?? 0n),
    input: p.data,
    chainId: hex(p.chainId),
    type: TYPE_HEX[p.type] ?? undefined,
    gas: hex(p.gas),
    gasPrice: p.gasPrice != null ? hex(p.gasPrice) : undefined,
    maxFeePerGas: hex(p.maxFeePerGas),
    maxPriorityFeePerGas: hex(p.maxPriorityFeePerGas),
    blockNumber: '0x3b4c10',
  };
}

const TX_HASH = '0x' + 'cd'.repeat(32);

/** 归一化回执（= fetchReceipt 的输出形状），供内容核对类用例使用 */
function normalizedReceipt(over = {}) {
  return {
    transactionHash: TX_HASH, status: 'success', blockNumber: 3886096,
    gasUsed: 40000n, effectiveGasPrice: MAX_FEE, from: TEST_ACCOUNT.address, to: PM, logs: [],
    ...over,
  };
}

test.before(async () => {
  await startNode();
  const rawTx = await TEST_ACCOUNT.signTransaction({
    to: PM, value: 0n, data: CALLDATA, chainId: CHAIN.id, nonce: 1,
    gas: GAS_LIMIT, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE, type: 'eip1559',
  });
  nodeTx = nodePayloadFromRawTx(rawTx);
  nodeReceipt = {
    transactionHash: TX_HASH, status: '0x1', blockNumber: '0x3b4c10',
    gasUsed: '0x9c40', effectiveGasPrice: '0x1dcd6500',
    from: TEST_ACCOUNT.address, to: PM, logs: [],
  };
});

test.after(() => { if (server) server.close(); });

// ---------- 字段映射 ----------

test('fetchTxByHash：gas / maxPriorityFeePerGas / type 完整映射（P0 回归）', async () => {
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  assert.equal(typeof tx.gas, 'bigint', 'gas 必须转为 bigint');
  assert.equal(tx.gas, GAS_LIMIT);
  assert.equal(typeof tx.maxPriorityFeePerGas, 'bigint', 'maxPriorityFeePerGas 必须转为 bigint');
  assert.equal(tx.maxPriorityFeePerGas, PRIORITY_FEE);
  assert.equal(typeof tx.maxFeePerGas, 'bigint');
  assert.equal(tx.maxFeePerGas, MAX_FEE);
  assert.equal(tx.type, '0x2', 'type 必须保留');
  assert.equal(tx.chainId, CHAIN.id);
  assert.equal(tx.input, CALLDATA);
  assert.equal(tx.from, TEST_ACCOUNT.address);
  assert.equal(tx.value, 0n);
  assert.ok(rpcCalls.includes('eth_getTransactionByHash'));
});

test('fetchTxByHash 的结果能通过链上交易内容核对（不再因缺 Gas 字段被误判）', async () => {
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  const r = verifyOnChainTxAgainstBinding({ tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fields.gasLimit, GAS_LIMIT.toString());
  assert.equal(r.fields.txType, 'eip1559');
});

// ---------- 完整链路：RPC → fetchTxByHash → verifyReceipt → evaluateReceipt ----------

test('成功交易完整链路：RPC → fetchTxByHash → verifyReceipt → confirmed 且不熔断', async () => {
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  const receipt = await fetchReceipt({ txHash: TX_HASH, rpcUrl, attempts: 1, pollMs: 1 });
  assert.equal(receipt.status, 'success');
  assert.equal(receipt.gasUsed, 40000n);
  const r = verifyReceipt({ receipt, tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(r.ok, true, r.reason);
  const e = evaluateReceipt({ receipt, tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.ok, true, e.reason);
  assert.equal(e.tripKillSwitch, false, '成功交易绝不能触发熔断');
  assert.equal(e.receipt.gasUsed, 40000n);
  assert.ok(e.gasUsd > 0);
});

test('交易内容被篡改（calldata 不同）→ POST_BROADCAST_MISMATCH 且熔断', async () => {
  const tx = { ...(await fetchTxByHash({ txHash: TX_HASH, rpcUrl })), input: '0xdd46508f' + '22'.repeat(64) };
  const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.ok, false);
  assert.equal(e.code, 'POST_BROADCAST_MISMATCH');
  assert.equal(e.contentCode, 'CALLDATA_MISMATCH');
  assert.equal(e.tripKillSwitch, true);
});

test('Gas 参数被篡改（gasLimit 不同）→ POST_BROADCAST_MISMATCH 且熔断', async () => {
  const tx = { ...(await fetchTxByHash({ txHash: TX_HASH, rpcUrl })), gas: GAS_LIMIT - 1n };
  const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.contentCode, 'GAS_LIMIT_MISMATCH');
  assert.equal(e.tripKillSwitch, true);
});

test('节点未返回 Gas 字段（无法核对）→ fail-closed 拒绝并列出缺失字段', async () => {
  const tx = { ...(await fetchTxByHash({ txHash: TX_HASH, rpcUrl })), gas: null, maxPriorityFeePerGas: null };
  const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.ok, false, '无法核对时必须拒绝，不能默认放行');
  assert.equal(e.code, 'POST_BROADCAST_MISMATCH');
  assert.deepEqual(e.missingTxFields, ['gas', 'maxPriorityFeePerGas']);
  assert.equal(e.tripKillSwitch, true, '无法核对 → 人工复核');
});

test('legacy 交易（节点返回 type 0x0 + gasPrice）→ TX_TYPE_MISMATCH 且熔断', async () => {
  const legacyRaw = await TEST_ACCOUNT.signTransaction({
    to: PM, value: 0n, data: CALLDATA, chainId: CHAIN.id, nonce: 1, gas: GAS_LIMIT, gasPrice: MAX_FEE, type: 'legacy',
  });
  nodeTx = { ...nodePayloadFromRawTx(legacyRaw), blockNumber: '0x3b4c10' };
  try {
    const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
    assert.equal(tx.type, '0x0');
    const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
    assert.equal(e.contentCode, 'TX_TYPE_MISMATCH');
    assert.equal(e.tripKillSwitch, true);
  } finally {
    const rawTx = await TEST_ACCOUNT.signTransaction({
      to: PM, value: 0n, data: CALLDATA, chainId: CHAIN.id, nonce: 1,
      gas: GAS_LIMIT, maxFeePerGas: MAX_FEE, maxPriorityFeePerGas: PRIORITY_FEE, type: 'eip1559',
    });
    nodeTx = nodePayloadFromRawTx(rawTx);
  }
});

test('节点未返回交易类型（type 缺失）→ TX_TYPE_MISSING 且熔断，不推断为 EIP-1559', async () => {
  const tx = { ...(await fetchTxByHash({ txHash: TX_HASH, rpcUrl })), type: null };
  const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.ok, false);
  assert.equal(e.contentCode, 'TX_TYPE_MISSING');
  assert.equal(e.tripKillSwitch, true);
  assert.ok(e.missingTxFields.includes('type'), '缺失字段清单应包含 type');
});

test('节点返回 type=0x2 → 通过（显式类型不被拒绝）', async () => {
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  assert.equal(tx.type, '0x2');
  const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.ok, true, e.reason);
});

test('回滚交易 → RECEIPT_REVERTED 且熔断', async () => {
  const receipt = normalizedReceipt({ status: 'reverted' });
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  const e = evaluateReceipt({ receipt, tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.code, 'RECEIPT_REVERTED');
  assert.equal(e.tripKillSwitch, true);
});

test('尚无回执（交易仍在内存池）→ RECEIPT_PENDING 且不熔断、不重发', async () => {
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  const e = evaluateReceipt({ receipt: null, tx, binding: BINDING, user: TEST_ACCOUNT.address, limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.pending, true);
  assert.equal(e.code, 'RECEIPT_PENDING');
  assert.equal(e.tripKillSwitch, false);
});

test('发送方不符（节点返回的 from ≠ intent 用户）→ SENDER_MISMATCH 且熔断', async () => {
  const tx = await fetchTxByHash({ txHash: TX_HASH, rpcUrl });
  const e = evaluateReceipt({ receipt: normalizedReceipt(), tx, binding: BINDING, user: '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53', limits: TX_GATE.limits, hypeUsd: HYPE_USD });
  assert.equal(e.contentCode, 'SENDER_MISMATCH');
  assert.equal(e.tripKillSwitch, true);
});

test('绑定哈希不随字段映射变化（回归护栏）', () => {
  assert.equal(bindingHashOf(BINDING), bindingHashOf(computeBinding({ ...BINDING })));
});
