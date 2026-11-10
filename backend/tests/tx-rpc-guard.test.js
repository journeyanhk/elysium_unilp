/**
 * M3.1 只读 RPC 护栏测试 —— review 验收条件 1：
 * 预演管线只能使用只读方法，绝不能出现 eth_sendTransaction / eth_sendRawTransaction /
 * personal_sign / eth_signTypedData / wallet_* 等写或签名方法。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const guard = require('../lib/tx-rpc-guard');

test('只读方法放行', () => {
  for (const m of ['eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getLogs', 'eth_blockNumber', 'eth_getBlockByNumber']) {
    assert.equal(guard.assertReadOnlyRpc(m), true, `${m} 应放行`);
  }
});

test('写 / 签名方法必须拒绝（含大小写与未知方法）', () => {
  const forbidden = [
    'eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTransaction', 'eth_sign',
    'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4',
    'wallet_sendCalls', 'wallet_signTransaction', 'wallet_switchEthereumChain', 'eth_requestAccounts',
  ];
  for (const m of forbidden) {
    assert.throws(() => guard.assertReadOnlyRpc(m), /RPC 护栏拒绝/, `${m} 未被拒绝`);
  }
  // 未在白名单内的新方法（即使不是显式禁止）也必须拒绝
  assert.throws(() => guard.assertReadOnlyRpc('debug_traceCall'), /不在只读方法白名单内/);
  assert.throws(() => guard.assertReadOnlyRpc(''), /方法名为空/);
});

test('前缀判定：personal_ / wallet_ / eth_sign 一律禁止', () => {
  for (const m of ['personal_foo', 'wallet_anything', 'eth_signFoo']) {
    assert.equal(guard.isForbiddenMethod(m), true, `${m} 应被前缀规则拒绝`);
    assert.throws(() => guard.assertReadOnlyRpc(m), /RPC 护栏拒绝/);
  }
  assert.equal(guard.isForbiddenMethod('eth_call'), false);
});

test('被拒绝的调用会记录到统计（供审计）', () => {
  const before = guard.rpcGuardStats();
  try { guard.assertReadOnlyRpc('eth_sendRawTransaction'); } catch { /* 预期 */ }
  const after = guard.rpcGuardStats();
  assert.ok(after.blocked > before.blocked, 'blocked 计数应增加');
  assert.ok(after.blockedMethods.eth_sendRawTransaction >= 1, '应按方法名记录');
});

test('禁止方法不得出现在只读白名单集合中', () => {
  for (const m of guard.FORBIDDEN_METHODS) {
    assert.ok(!guard.READ_ONLY_METHODS.has(m), `${m} 不得出现在只读白名单`);
  }
});

test('guardedRpc 在发出网络请求之前就拒绝（用不存在的 URL 也不会被调用）', async () => {
  let called = false;
  const origFetch = global.fetch;
  global.fetch = async () => { called = true; throw new Error('不应被调用'); };
  try {
    await assert.rejects(() => guard.guardedRpc('http://127.0.0.1:1', 'eth_sendRawTransaction', []), /RPC 护栏拒绝/);
    assert.equal(called, false, '禁止方法不得触发任何网络请求');
  } finally {
    global.fetch = origFetch;
  }
});

test('预演模块与构造模块不含发送/签名调用（静态扫描）', () => {
  const files = ['lib/tx-simulate.js', 'lib/tx-build.js', 'lib/tx-parse.js', 'routes/tx.js'];
  const root = path.join(__dirname, '..');
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const bad of [/sendRawTransaction/, /sendTransaction/, /personal_sign/, /signTypedData/, /writeContract/, /signTransaction/, /privateKey/, /mnemonic/]) {
      assert.ok(!bad.test(src), `${f} 出现禁止内容：${bad}`);
    }
  }
});

test('tx-simulate 的 RPC 调用全部经过护栏', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'tx-simulate.js'), 'utf8');
  assert.ok(!/fetch\(/.test(src), 'tx-simulate 不得直接 fetch，必须走 guardedRpc');
  assert.match(src, /require\('\.\/tx-rpc-guard'\)/);
});
