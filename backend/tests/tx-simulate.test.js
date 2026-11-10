/**
 * M3.1 只读预演测试 —— review P0-2 / P0-3：
 *   - 预演用户必须绑定 intent 用户（禁止用他人地址模拟）
 *   - 预检必须完整覆盖余额与两级授权（ERC-20 → Permit2 → PositionManager）与头寸归属，
 *     并给出**明确失败分类**，不能只依赖 eth_call 回滚字符串
 *
 * 通过注入假 RPC（deps.rpc）离线测试，不访问网络。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { precheck, checkSimulationUser, simulate, SEL } = require('../lib/tx-simulate');
const { CONTRACTS, POOLS } = require('../config/whitelist');

const USER = '0x2cC17141A8753706Cf5557C9eE9EF91f8E995f53';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const POOL_KEY = POOLS['KNTQ/HYPE (1%)'].poolKey;
const TOKEN1 = POOL_KEY.currency1;
const PM = CONTRACTS.positionManager.address;
const PERMIT2 = CONTRACTS.permit2.address;

const BN = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const ADDR_HEX = (a) => '0x' + String(a).toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** 假 RPC：按 calldata selector 返回预设值 */
function fakeRpc({ balance = 10n ** 18n, nativeBalance = 10n ** 18n, tokenBalance = 10n ** 18n, erc20Allow = 10n ** 18n, permit2Allow = 10n ** 18n, owner = USER, liquidity = 10n ** 18n, ownerOfReverts = false } = {}) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'eth_blockNumber': return '0x' + (3885286).toString(16);
      case 'eth_getBlockByNumber': return { number: '0x3b4a46', hash: '0x' + 'ab'.repeat(32), timestamp: '0x' + (1794300000).toString(16) };
      case 'eth_getBalance': return BN(nativeBalance);
      case 'eth_getCode': return '0x60806040';
      case 'eth_gasPrice': return BN(500000000n);
      case 'eth_estimateGas': return '0x' + (120000).toString(16);
      case 'eth_call': {
        const data = params[0].data;
        const sel = data.slice(0, 10);
        if (sel === SEL.balanceOf) return BN(tokenBalance);
        if (sel === SEL.allowance2) return BN(erc20Allow);
        if (sel === SEL.allowance3) return BN(permit2Allow);
        if (sel === SEL.ownerOf) { if (ownerOfReverts) throw new Error('RPC 错误：{"code":3,"message":"execution reverted"}'); return ADDR_HEX(owner); }
        if (sel === SEL.getPositionLiquidity) return BN(liquidity);
        if (sel === SEL.getPoolAndPositionInfo) return '0x' + 'cd'.repeat(64);
        // 其余（模拟 calldata 本身）
        return '0x';
      }
      default: throw new Error(`假 RPC 收到未预期方法：${method}`);
    }
  };
  return { rpc, calls };
}

// ---------- P0-2：预演用户绑定 ----------

test('checkSimulationUser：未指定用户 → 使用 intent 用户', () => {
  assert.equal(checkSimulationUser(USER, undefined), USER);
  assert.equal(checkSimulationUser(USER, null), USER);
});

test('checkSimulationUser：一致（含大小写差异）→ 通过', () => {
  assert.equal(checkSimulationUser(USER, USER.toLowerCase()), USER);
});

test('checkSimulationUser：不一致 → 拒绝（SIM_USER_MISMATCH）', () => {
  assert.throws(() => checkSimulationUser(USER, OTHER), (e) => e.code === 'SIM_USER_MISMATCH');
  assert.throws(() => checkSimulationUser(null, OTHER), /缺少用户地址/);
});

test('路由层：/simulate 不得允许覆盖用户，且审计同时记录 intentUser 与 simulationFrom', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  const idx = src.indexOf("'/simulate'");
  const handler = src.slice(idx, idx + 2600);
  assert.match(handler, /checkSimulationUser\(/, '/simulate 必须调用 checkSimulationUser');
  assert.match(handler, /status\(403\)/, '不一致时必须返回 403');
  assert.match(handler, /intentUser/, '审计必须记录 intentUser');
  assert.match(handler, /simulationFrom/, '审计必须记录 simulationFrom');
  assert.match(handler, /precheckBlockNumber/, '审计必须记录预检区块号');
  assert.ok(!/user: user \|\| it\.user_addr/.test(handler), '不得允许请求体覆盖用户');
});

// ---------- P0-3：完整预检 ----------

test('mint 预检：余额与两级授权都足够 → ok，无 issue', async () => {
  const { rpc } = fakeRpc();
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'mint', params: { amount0Max: (10n ** 17n).toString(), amount1Max: (10n ** 17n).toString() }, poolKey: POOL_KEY },
  });
  assert.equal(out.ok, true, JSON.stringify(out.issues));
  assert.equal(out.issues.length, 0);
  assert.equal(out.tokens.currency1.erc20AllowanceToPermit2, (10n ** 18n).toString());
  assert.equal(out.tokens.currency1.permit2AllowanceToPM, (10n ** 18n).toString());
  assert.ok(out.block && out.blockHash, '必须记录预检区块号与 block hash');
  assert.equal(out.tokens.currency0.isNative, true, 'currency0 为原生币');
});

test('mint 预检：原生币余额不足 → NATIVE_BALANCE_LOW', async () => {
  const { rpc } = fakeRpc({ nativeBalance: 5n });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'mint', params: { amount0Max: '1000', amount1Max: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'NATIVE_BALANCE_LOW'), JSON.stringify(out.issues));
});

test('mint 预检：代币余额不足 → TOKEN_BALANCE_LOW（明确分类，不靠回滚字符串）', async () => {
  const { rpc } = fakeRpc({ tokenBalance: 5n });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'mint', params: { amount0Max: '1000', amount1Max: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'TOKEN_BALANCE_LOW'), JSON.stringify(out.issues));
});

test('mint 预检：ERC-20 → Permit2 授权不足 → ERC20_ALLOWANCE_LOW', async () => {
  const { rpc } = fakeRpc({ erc20Allow: 5n });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'mint', params: { amount0Max: '1000', amount1Max: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'ERC20_ALLOWANCE_LOW'), JSON.stringify(out.issues));
});

test('mint 预检：Permit2 → PositionManager 授权不足 → PERMIT2_ALLOWANCE_LOW', async () => {
  const { rpc } = fakeRpc({ permit2Allow: 5n });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'mint', params: { amount0Max: '1000', amount1Max: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'PERMIT2_ALLOWANCE_LOW'), JSON.stringify(out.issues));
});

test('remove 预检：头寸不属于用户 → TOKEN_NOT_OWNER', async () => {
  const { rpc } = fakeRpc({ owner: OTHER });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'remove', params: { tokenId: '1529', liquidity: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'TOKEN_NOT_OWNER'), JSON.stringify(out.issues));
  assert.equal(out.position.owner.toLowerCase(), OTHER.toLowerCase());
});

test('remove 预检：头寸不存在（ownerOf 回滚）→ POSITION_NOT_FOUND', async () => {
  const { rpc } = fakeRpc({ ownerOfReverts: true });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'remove', params: { tokenId: '999999', liquidity: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'POSITION_NOT_FOUND'), JSON.stringify(out.issues));
});

test('remove 预检：头寸流动性不足 → LIQUIDITY_INSUFFICIENT', async () => {
  const { rpc } = fakeRpc({ liquidity: 5n });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'remove', params: { tokenId: '1529', liquidity: '1000' }, poolKey: POOL_KEY },
  });
  assert.ok(out.issues.some((i) => i.code === 'LIQUIDITY_INSUFFICIENT'), JSON.stringify(out.issues));
});

test('collect 预检：读取 ownerOf / 流动性 / PoolAndPositionInfo，且不做流动性充分性判断', async () => {
  const { rpc, calls } = fakeRpc({ liquidity: 5n });
  const out = await precheck({
    user: USER, targetContract: PM, rpc,
    intent: { type: 'collect', params: { tokenId: '1529', liquidity: '0' }, poolKey: POOL_KEY },
  });
  assert.equal(out.ok, true, JSON.stringify(out.issues));
  assert.ok(out.position.poolAndPositionInfo, '必须读取 getPoolAndPositionInfo');
  const sels = calls.filter((c) => c.method === 'eth_call').map((c) => c.params[0].data.slice(0, 10));
  assert.ok(sels.includes(SEL.ownerOf) && sels.includes(SEL.getPositionLiquidity) && sels.includes(SEL.getPoolAndPositionInfo));
});

// ---------- simulate：只读、可注入 ----------

test('simulate：只调用只读方法，且返回预检与区块信息', async () => {
  const { rpc, calls } = fakeRpc();
  const out = await simulate({
    user: USER, targetContract: PM, calldata: '0xdd46508f' + '00'.repeat(32), rpc,
    intent: { type: 'mint', params: { amount0Max: '1000', amount1Max: '1000' }, poolKey: POOL_KEY },
  });
  assert.equal(out.simBlockNumber, 3885286);
  assert.ok(out.precheck && typeof out.precheck.ok === 'boolean');
  for (const c of calls) {
    assert.ok(!/send|sign/i.test(c.method), `出现写/签名方法：${c.method}`);
  }
});

test('simulate：注入 rpc 时仍不得调用写/签名方法（含大小写变体）', async () => {
  let sawForbidden = false;
  const rpc = async (method) => {
    if (/sendRawTransaction|personal_sign|wallet_/i.test(method)) sawForbidden = true;
    if (method === 'eth_blockNumber') return '0x1';
    if (method === 'eth_getBlockByNumber') return { number: '0x1', hash: '0x' + 'aa'.repeat(32) };
    if (method === 'eth_call') return '0x';
    if (method === 'eth_estimateGas') return '0x5208';
    if (method === 'eth_gasPrice') return BN(500000000n);
    if (method === 'eth_getBalance') return BN(1n);
    if (method === 'eth_getCode') return '0x6080';
    return '0x';
  };
  await simulate({ user: USER, targetContract: PM, calldata: '0xdd46508f', rpc, intent: { type: 'collect', params: { tokenId: '1' }, poolKey: POOL_KEY } });
  assert.equal(sawForbidden, false);
});

test('预检结果写入数据库字段（静态检查：precheck 落库 + 审计 payload 含 issues）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  assert.match(src, /precheck/, 'tx_simulations 必须写入 precheck');
  assert.match(src, /precheckIssues/, '审计 payload 必须含预检失败分类');
});
