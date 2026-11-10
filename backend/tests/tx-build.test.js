/**
 * M3.1 build-only 构造测试 —— review 验收条件 2 / 7 / 8：
 *   - build-only 不触发钱包签名（后端不产生任何签名请求；返回值不含签名字段）
 *   - calldata 与 M2 模拟器完全一致（同一布局）
 *   - 审计字段齐备（chainId / selector / calldata hash / actions / PoolKey / deadline）
 *   - 广播入口不存在可用路径
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { keccak256 } = require('viem');

const { buildIntent } = require('../lib/tx-build');
const simulator = require('../lib/simulator');
const { CONTRACTS } = require('../config/whitelist');

const USER = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';

test('mint：构造出 MINT_POSITION + SETTLE_PAIR，且与 M2 模拟器编码逐字节一致', () => {
  const r = buildIntent({
    type: 'mint', user: USER,
    mint: { tickLower: 52000, tickUpper: 52800, liquidity: 10n ** 18n, amount0Max: 10n ** 18n, amount1Max: 10n ** 18n },
    deadlineSec: 600,
  });
  assert.equal(r.selector, '0xdd46508f');
  assert.equal(r.targetContract.toLowerCase(), CONTRACTS.positionManager.address.toLowerCase());
  assert.deepEqual(r.actions, ['MINT_POSITION', 'SETTLE_PAIR']);
  assert.equal(r.signed, false, 'build-only 不得产生签名');
  assert.equal(r.broadcast, false, 'build-only 不得广播');
  assert.equal(r.calldataHash, keccak256(r.calldata));
  assert.ok(r.poolKey && r.poolId, '必须携带 PoolKey 与 poolId 快照');

  const m2 = simulator.encodeMintCalldata({
    tickLower: 52000, tickUpper: 52800, liquidity: 10n ** 18n,
    amount0Max: 10n ** 18n, amount1Max: 10n ** 18n, owner: USER, deadline: BigInt(r.deadline),
  });
  assert.equal(r.calldata, m2, 'M3 构造必须与 M2 模拟器使用完全相同的编码');
});

test('collect：DECREASE_LIQUIDITY(0) + TAKE_PAIR，与 M2 编码一致', () => {
  const r = buildIntent({ type: 'collect', user: USER, collect: { tokenId: 1529 }, deadlineSec: 600 });
  assert.deepEqual(r.actions, ['DECREASE_LIQUIDITY', 'TAKE_PAIR']);
  assert.equal(r.params.liquidity, '0');
  const m2 = simulator.encodeRemoveCalldata({
    tokenId: 1529, liquidity: 0n, amount0Min: 0n, amount1Min: 0n, recipient: USER, deadline: BigInt(r.deadline),
  });
  assert.equal(r.calldata, m2);
});

test('remove：liquidity > 0 + minOut 携带，与 M2 编码一致', () => {
  const r = buildIntent({
    type: 'remove', user: USER,
    remove: { tokenId: 1529, liquidity: 10n ** 18n, amount0Min: 5n, amount1Min: 7n }, deadlineSec: 600,
  });
  assert.deepEqual(r.actions, ['DECREASE_LIQUIDITY', 'TAKE_PAIR']);
  assert.equal(r.params.amount0Min, '5');
  const m2 = simulator.encodeRemoveCalldata({
    tokenId: 1529, liquidity: 10n ** 18n, amount0Min: 5n, amount1Min: 7n, recipient: USER, deadline: BigInt(r.deadline),
  });
  assert.equal(r.calldata, m2);
});

test('approve / permit2-approve：参数级校验在构造阶段即生效', () => {
  const ok = buildIntent({ type: 'approve', user: USER, approve: { tokenKey: 'KNTQ', spender: CONTRACTS.permit2.address, amountRaw: 100n } });
  assert.equal(ok.selector, '0x095ea7b3');
  assert.throws(
    () => buildIntent({ type: 'approve', user: USER, approve: { tokenKey: 'KNTQ', spender: '0x000000000000000000000000000000000000dEaD', amountRaw: 100n } }),
    /spender 不在允许集合/
  );

  const p2 = buildIntent({ type: 'permit2-approve', user: USER, permit2: { tokenKey: 'KNTQ', amountRaw: 100n, expirationSec: Math.floor(Date.now() / 1000) + 86400 } });
  assert.equal(p2.selector, '0x87517c45');
  assert.equal(p2.targetContract.toLowerCase(), CONTRACTS.permit2.address.toLowerCase());
});

test('build-only 返回值不含任何签名 / 交易载荷字段', () => {
  const r = buildIntent({ type: 'mint', user: USER, mint: { tickLower: 52000, tickUpper: 52800, liquidity: 10n ** 18n, amount0Max: 1n, amount1Max: 1n } });
  const keys = Object.keys(r).map((k) => k.toLowerCase());
  for (const bad of ['signature', 'signedtx', 'rawtransaction', 'privatekey', 'mnemonic', 'sendrawtransaction']) {
    assert.ok(!keys.includes(bad), `返回值出现敏感字段：${bad}`);
  }
  assert.equal(r.signed, false);
  assert.equal(r.broadcast, false);
});

test('非法输入必须拒绝（未知类型 / 非法地址 / 未对齐 tick / 超 intent 上限）', () => {
  assert.throws(() => buildIntent({ type: 'swap', user: USER }), /不支持的 intent 类型/);
  assert.throws(() => buildIntent({ type: 'mint', user: 'not-an-address' }), /合法的用户地址/);
  assert.throws(() => buildIntent({ type: 'mint', user: USER, mint: { tickLower: 52050, tickUpper: 52800, liquidity: 1n, amount0Max: 1n, amount1Max: 1n } }), /未按 tickSpacing/);
  assert.throws(() => buildIntent({ type: 'mint', user: USER, mint: { tickLower: 52000, tickUpper: 52800, liquidity: 0n, amount0Max: 1n, amount1Max: 1n } }), /liquidity 必须大于 0/);
  assert.throws(() => buildIntent({ type: 'approve', user: USER, approve: { tokenKey: 'KNTQ', spender: CONTRACTS.permit2.address, amountRaw: (1n << 256n) - 1n } }), /禁止无限授权/);
});

test('tx-build / tx-simulate 模块不含钱包或广播依赖（静态检查）', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['lib/tx-build.js', 'lib/tx-simulate.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const bad of [/window\.ethereum/, /ethereum\.request/, /@walletconnect/, /viem\/accounts/, /createWalletClient/, /sendTransaction/]) {
      assert.ok(!bad.test(src), `${f} 出现钱包/广播依赖：${bad}`);
    }
  }
});

test('routes/tx.js 的 build 接口声明「不签名、不广播」', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  assert.match(src, /build-only：未签名、未广播/);
  assert.match(src, /只读预演：eth_call \/ eth_estimateGas，未广播任何交易/);
});
