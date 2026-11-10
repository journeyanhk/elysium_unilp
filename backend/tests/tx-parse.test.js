/**
 * M3.1 参数级白名单解析器测试 —— review 验收条件 3 / 4：
 *   - modifyLiquidities 的 actions 必须被解码并逐项校验（不能只看 selector）
 *   - ERC-20 approve 必须限制 spender 与金额；Permit2 approve 必须限制 token/spender/有效期/金额
 */
const test = require('node:test');
const assert = require('node:assert');

const { encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector } = require('viem');
const { validateCall, decodeUnlockData, parseCalldata, ACTIONS, whitelistedPoolKey } = require('../lib/tx-parse');
const { CONTRACTS } = require('../config/whitelist');
const simulator = require('../lib/simulator');

const ERC20 = parseAbi(['function approve(address spender, uint256 amount)']);
const PERMIT2 = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);
const MODIFY = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline)']);

const USER = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';
const now = Math.floor(Date.now() / 1000);
const POOL_KEY = whitelistedPoolKey();

function mintCalldata(overrides = {}) {
  return simulator.encodeMintCalldata({
    tickLower: 52000, tickUpper: 52800, liquidity: 10n ** 18n,
    amount0Max: 10n ** 18n, amount1Max: 10n ** 18n, owner: USER,
    deadline: BigInt(now + 600), ...overrides,
  });
}
function removeCalldata({ liquidity = 10n ** 18n, recipient = USER, tokenId = 1529, deadline = BigInt(now + 600), amount0Min = 0n, amount1Min = 0n } = {}) {
  return simulator.encodeRemoveCalldata({ tokenId, liquidity, amount0Min, amount1Min, recipient, deadline });
}
/** 手工构造任意 actions 组合（用于测试禁止的组合） */
function customCalldata(actionsHex, params, deadline = now + 600) {
  const unlock = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actionsHex, params]);
  return encodeFunctionData({ abi: MODIFY, functionName: 'modifyLiquidities', args: [unlock, BigInt(deadline)] });
}
const poolKeyParam = encodeAbiParameters(
  [{ type: 'tuple', components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }],
  [POOL_KEY]
);

function mintParam(overrides = {}) {
  const k = { ...POOL_KEY, ...(overrides.poolKey || {}) };
  return encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
      { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
    [k, overrides.tickLower ?? 52000, overrides.tickUpper ?? 52800, overrides.liquidity ?? 10n ** 18n,
      overrides.amount0Max ?? 10n ** 18n, overrides.amount1Max ?? 10n ** 18n, overrides.owner ?? USER, '0x']);
}
function settlePairParam(k = POOL_KEY) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [k.currency0, k.currency1]);
}
function takePairParam(k = POOL_KEY) {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [k.currency0, k.currency1, USER]);
}

test('selector 解析：未知选择器（含 multicall / permit 代发）必须拒绝', () => {
  for (const bad of ['0xac9650d8', '0x2b67b570', '0xdeadbeef']) {
    assert.throws(() => parseCalldata(bad + '00'.repeat(32)), /未知函数选择器/, `${bad} 未被拒绝`);
  }
  assert.equal(parseCalldata(mintCalldata()).name, 'modifyLiquidities');
  assert.equal(toFunctionSelector('modifyLiquidities(bytes,uint256)').toLowerCase(), '0xdd46508f');
});

// ---------- ERC-20 approve ----------

test('approve：spender 只能是 PositionManager 或 Permit2', () => {
  const ok = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CONTRACTS.positionManager.address, 100n] });
  const ok2 = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CONTRACTS.permit2.address, 100n] });
  assert.equal(validateCall({ key: 'KNTQ', calldata: ok, intent: { amountRaw: '100' } }).name, 'approve');
  assert.equal(validateCall({ key: 'KNTQ', calldata: ok2, intent: { amountRaw: '100' } }).name, 'approve');

  const attacker = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: ['0x000000000000000000000000000000000000dEaD', 100n] });
  assert.throws(() => validateCall({ key: 'KNTQ', calldata: attacker, intent: { amountRaw: '100' } }), /spender 不在允许集合/);
});

test('approve：禁止无限授权与超 intent 金额', () => {
  const infinite = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CONTRACTS.permit2.address, (1n << 256n) - 1n] });
  assert.throws(() => validateCall({ key: 'KNTQ', calldata: infinite, intent: { amountRaw: '100' } }), /禁止无限授权/);
  const tooMuch = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CONTRACTS.permit2.address, 1000n] });
  assert.throws(() => validateCall({ key: 'KNTQ', calldata: tooMuch, intent: { amountRaw: '100' } }), /超过本次 intent 金额/);
  const zero = encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [CONTRACTS.permit2.address, 0n] });
  assert.throws(() => validateCall({ key: 'KNTQ', calldata: zero, intent: { amountRaw: '100' } }), /金额必须大于 0/);
});

// ---------- Permit2 approve ----------

test('Permit2 approve：token / spender / 有效期 / 金额都必须受限', () => {
  const token = '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0';
  const good = encodeFunctionData({ abi: PERMIT2, functionName: 'approve', args: [token, CONTRACTS.positionManager.address, 100n, now + 86400] });
  assert.equal(validateCall({ key: 'permit2', calldata: good, intent: { token, amountRaw: '100' }, now }).name, 'permit2-approve');

  const wrongToken = encodeFunctionData({ abi: PERMIT2, functionName: 'approve', args: ['0x000000000000000000000000000000000000dEaD', CONTRACTS.positionManager.address, 100n, now + 86400] });
  assert.throws(() => validateCall({ key: 'permit2', calldata: wrongToken, intent: { token, amountRaw: '100' }, now }), /不是本次目标代币/);

  const wrongSpender = encodeFunctionData({ abi: PERMIT2, functionName: 'approve', args: [token, '0x000000000000000000000000000000000000dEaD', 100n, now + 86400] });
  assert.throws(() => validateCall({ key: 'permit2', calldata: wrongSpender, intent: { token, amountRaw: '100' }, now }), /spender 必须是 PositionManager/);

  const longExpiry = encodeFunctionData({ abi: PERMIT2, functionName: 'approve', args: [token, CONTRACTS.positionManager.address, 100n, now + 90 * 86400] });
  assert.throws(() => validateCall({ key: 'permit2', calldata: longExpiry, intent: { token, amountRaw: '100' }, now }), /授权有效期过长/);

  const expired = encodeFunctionData({ abi: PERMIT2, functionName: 'approve', args: [token, CONTRACTS.positionManager.address, 100n, now - 10] });
  assert.throws(() => validateCall({ key: 'permit2', calldata: expired, intent: { token, amountRaw: '100' }, now }), /授权已过期/);

  const tooMuch = encodeFunctionData({ abi: PERMIT2, functionName: 'approve', args: [token, CONTRACTS.positionManager.address, 1000n, now + 86400] });
  assert.throws(() => validateCall({ key: 'permit2', calldata: tooMuch, intent: { token, amountRaw: '100' }, now }), /超过本次 intent 金额/);
});

// ---------- modifyLiquidities action 级校验 ----------

test('mint：MINT_POSITION + SETTLE_PAIR 通过，且校验 tick / 流动性 / 上限 / owner', () => {
  const cd = mintCalldata();
  const r = validateCall({ key: 'positionManager', calldata: cd, intent: { type: 'mint', owner: USER, tickLower: 52000, tickUpper: 52800, liquidity: String(10n ** 18n), amount0Max: String(10n ** 18n), amount1Max: String(10n ** 18n) }, now });
  assert.deepEqual(r.actions, ['MINT_POSITION', 'SETTLE_PAIR']);

  // tick 未按 tickSpacing(200) 对齐
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata({ tickLower: 52050 }), intent: { type: 'mint', owner: USER }, now }), /未按 tickSpacing/);
  // 流动性为 0
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata({ liquidity: 0n }), intent: { type: 'mint', owner: USER }, now }), /liquidity 必须大于 0/);
  // 超出 intent 上限
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata(), intent: { type: 'mint', owner: USER, amount0Max: '1' }, now }), /amount0Max 超过 intent 上限/);
  // owner 不是用户
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata({ owner: '0x000000000000000000000000000000000000dEaD' }), intent: { type: 'mint', owner: USER }, now }), /owner 必须是用户本人/);
});

test('mint：PoolKey 必须等于白名单池（改一个币即拒绝）', () => {
  const fakeKey = { ...POOL_KEY, currency1: '0x000000000000000000000000000000000000dEaD' };
  const p1 = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
      { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
    [fakeKey, 52000, 52800, 10n ** 18n, 10n ** 18n, 10n ** 18n, USER, '0x']);
  const p2 = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [fakeKey.currency0, fakeKey.currency1]);
  const cd = customCalldata('0x020d', [p1, p2]);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: cd, intent: { type: 'mint', owner: USER }, now }), /PoolKey.currency1 不匹配白名单池/);
});

test('collect：DECREASE_LIQUIDITY(0) + TAKE_PAIR 通过；流动性不为 0 则拒绝', () => {
  const ok = removeCalldata({ liquidity: 0n, tokenId: 1529 });
  const r = validateCall({ key: 'positionManager', calldata: ok, intent: { type: 'collect', recipient: USER, tokenId: 1529 }, now });
  assert.deepEqual(r.actions, ['DECREASE_LIQUIDITY', 'TAKE_PAIR']);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: removeCalldata({ liquidity: 5n }), intent: { type: 'collect', recipient: USER }, now }), /领费必须使用 DECREASE_LIQUIDITY\(0\)/);
});

test('remove：liquidity > 0 且 minOut 不得低于 intent 下限；recipient 必须是用户', () => {
  const cd = removeCalldata({ liquidity: 10n ** 18n, amount0Min: 5n, amount1Min: 7n });
  const r = validateCall({ key: 'positionManager', calldata: cd, intent: { type: 'remove', recipient: USER, liquidity: String(10n ** 18n), amount0Min: '5', amount1Min: '7' }, now });
  assert.deepEqual(r.actions, ['DECREASE_LIQUIDITY', 'TAKE_PAIR']);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: cd, intent: { type: 'remove', recipient: USER, amount0Min: '6' }, now }), /amount0Min 低于 intent 下限/);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: removeCalldata({ recipient: '0x000000000000000000000000000000000000dEaD' }), intent: { type: 'remove', recipient: USER }, now }), /recipient 必须是用户本人/);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: removeCalldata({ liquidity: 0n }), intent: { type: 'remove', recipient: USER }, now }), /liquidity 必须大于 0/);
});

test('禁止的 action 组合必须拒绝（未知 action / 组合错误 / 顺序错误 / 夹带 sweep）', () => {
  const decParam = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [1529n, 0n, 0n, 0n, '0x']);
  const sweepParam = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [POOL_KEY.currency0, USER]);
  const closeParam = encodeAbiParameters([{ type: 'address' }], [POOL_KEY.currency0]);

  // 未知 action
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x99', ['0x']), intent: { type: 'mint', owner: USER }, now }), /未知 action/);
  // mint 用了 collect 的组合（参数按 collect 类型提供，确保是「组合不允许」而不是解码失败）
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x0111', [decParam, takePairParam()]), intent: { type: 'mint', owner: USER }, now }), /不属于 mint 的允许组合/);
  // 顺序错误（SETTLE_PAIR 在前）
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x0d02', [settlePairParam(), mintParam()]), intent: { type: 'mint', owner: USER }, now }), /不属于 mint 的允许组合/);
  // 夹带 SWEEP / CLOSE_CURRENCY
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x020d14', [mintParam(), settlePairParam(), sweepParam]), intent: { type: 'mint', owner: USER }, now }), /不属于 mint 的允许组合/);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x011112', [decParam, takePairParam(), closeParam]), intent: { type: 'collect', recipient: USER }, now }), /不属于 collect 的允许组合/);
  // actions 与参数数量不一致
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x020d', [mintParam()]), intent: { type: 'mint', owner: USER }, now }), /数量\(2\) 与参数数量\(1\) 不一致/);
  // 参数类型与 action 不匹配（把 SETTLE_PAIR 参数当作 MINT_POSITION）→ 明确拒绝而非底层报错
  assert.throws(() => validateCall({ key: 'positionManager', calldata: customCalldata('0x020d', [settlePairParam(), settlePairParam()]), intent: { type: 'mint', owner: USER }, now }), /参数解码失败/);
});

test('deadline 上限必须强制（过长 / 已过期）', () => {
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata({ deadline: BigInt(now + 99999) }), intent: { type: 'mint', owner: USER }, now }), /deadline 过长/);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata({ deadline: BigInt(now - 10) }), intent: { type: 'mint', owner: USER }, now }), /deadline 已过期/);
});

test('intent 类型缺失 / 非法必须拒绝', () => {
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata(), intent: { owner: USER }, now }), /intent 类型非法或缺失/);
  assert.throws(() => validateCall({ key: 'positionManager', calldata: mintCalldata(), intent: { type: 'swap', owner: USER }, now }), /intent 类型非法或缺失/);
});

test('action 常量与 M2 编码一致（0x020d / 0x0111）', () => {
  assert.equal(ACTIONS[0x02], 'MINT_POSITION');
  assert.equal(ACTIONS[0x0d], 'SETTLE_PAIR');
  assert.equal(ACTIONS[0x01], 'DECREASE_LIQUIDITY');
  assert.equal(ACTIONS[0x11], 'TAKE_PAIR');
  const { codes } = decodeUnlockData(encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x020d', ['0x', '0x']]));
  assert.deepEqual(codes, [0x02, 0x0d]);
});
