/**
 * M3.1 交易构造（build-only）—— 只构造 intent 与 calldata，**不签名、不广播、不请求钱包**。
 *
 * 安全边界：
 *   - 本模块没有任何钱包 / 签名 / 广播代码路径；
 *   - 构造完成后立即用 lib/tx-parse.js 做**参数级白名单校验**（spender / Permit2 / actions 语义），
 *     校验不通过则直接抛错（不返回 calldata）；
 *   - V4 编码复用 M2 模拟器的编码函数，保证「模拟」与「未来真实操作」使用同一布局。
 */
const { keccak256, encodeFunctionData, parseAbi, encodeAbiParameters } = require('viem');
const { CHAIN, CONTRACTS, POOLS, TOKENS } = require('../config/whitelist');
const { TX_GATE, GATE_VERSION } = require('../config/tx-gate');
const { validateCall, whitelistedPoolKey } = require('./tx-parse');
const simulator = require('./simulator');

const ERC20_ABI = parseAbi(['function approve(address spender, uint256 amount)']);
const PERMIT2_ABI = parseAbi(['function approve(address token, address spender, uint160 amount, uint48 expiration)']);

const INTENT_TYPES = ['mint', 'collect', 'remove', 'approve', 'permit2-approve'];

function poolId() {
  const pool = POOLS['KNTQ/HYPE (1%)'] || Object.values(POOLS)[0];
  return pool.poolId || pool.id || null;
}

function buildApproveCalldata({ spender, amount }) {
  return encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, BigInt(amount)] });
}

function buildPermit2ApproveCalldata({ token, spender, amount, expiration }) {
  return encodeFunctionData({
    abi: PERMIT2_ABI,
    functionName: 'approve',
    args: [token, spender, BigInt(amount), Number(expiration)],
  });
}

/**
 * 构造一个 intent（build-only）。
 * @param {object} p
 * @param {'mint'|'collect'|'remove'|'approve'|'permit2-approve'} p.type
 * @param {string} p.user        用户地址（owner / recipient / signer）
 * @param {number} [p.chainId]
 * @param {object} [p.mint]      { tickLower, tickUpper, liquidity, amount0Max, amount1Max }
 * @param {object} [p.remove]    { tokenId, liquidity, amount0Min, amount1Min }
 * @param {object} [p.collect]   { tokenId }
 * @param {object} [p.approve]   { tokenKey, spender, amountRaw }
 * @param {object} [p.permit2]   { tokenKey, amountRaw, expirationSec }
 * @param {number} [p.deadlineSec] deadline 相对当前时间的秒数（默认取门禁上限的一半）
 */
function buildIntent(p = {}) {
  const { type, user } = p;
  if (!INTENT_TYPES.includes(type)) throw new Error(`不支持的 intent 类型：${type}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(user || ''))) throw new Error('缺少合法的用户地址');
  // P0-1（M3.1 review）：chainId 必须绑定白名单链，禁止请求体携带任意链 ID
  if (p.chainId != null && Number(p.chainId) !== CHAIN.id) {
    throw new Error(`chainId 不匹配：要求 ${CHAIN.id}，收到 ${p.chainId}`);
  }
  const chainId = CHAIN.id;
  const now = Math.floor(Date.now() / 1000);
  const deadlineSec = p.deadlineSec != null ? Number(p.deadlineSec) : Math.floor(TX_GATE.limits.maxDeadlineSec / 2);
  const deadline = now + deadlineSec;

  let target;
  let calldata;
  let intentParams;
  let tokenKey = null;

  if (type === 'mint') {
    const m = p.mint || {};
    target = CONTRACTS.positionManager.address;
    calldata = simulator.encodeMintCalldata({
      tickLower: m.tickLower,
      tickUpper: m.tickUpper,
      liquidity: BigInt(m.liquidity),
      amount0Max: BigInt(m.amount0Max),
      amount1Max: BigInt(m.amount1Max),
      owner: user,
      deadline: BigInt(deadline),
    });
    intentParams = {
      tickLower: m.tickLower, tickUpper: m.tickUpper, liquidity: String(m.liquidity),
      amount0Max: String(m.amount0Max), amount1Max: String(m.amount1Max), owner: user, deadline,
    };
  } else if (type === 'collect') {
    const c = p.collect || {};
    target = CONTRACTS.positionManager.address;
    calldata = simulator.encodeRemoveCalldata({
      tokenId: c.tokenId, liquidity: 0n, amount0Min: 0n, amount1Min: 0n, recipient: user, deadline: BigInt(deadline),
    });
    intentParams = { tokenId: String(c.tokenId), liquidity: '0', amount0Min: '0', amount1Min: '0', recipient: user, deadline };
  } else if (type === 'remove') {
    const r = p.remove || {};
    target = CONTRACTS.positionManager.address;
    calldata = simulator.encodeRemoveCalldata({
      tokenId: r.tokenId, liquidity: BigInt(r.liquidity),
      amount0Min: BigInt(r.amount0Min || 0), amount1Min: BigInt(r.amount1Min || 0),
      recipient: user, deadline: BigInt(deadline),
    });
    intentParams = {
      tokenId: String(r.tokenId), liquidity: String(r.liquidity),
      amount0Min: String(r.amount0Min || 0), amount1Min: String(r.amount1Min || 0), recipient: user, deadline,
    };
  } else if (type === 'approve') {
    const a = p.approve || {};
    tokenKey = a.tokenKey;
    const token = (TOKENS[tokenKey] || {}).address;
    if (!token) throw new Error(`未知代币键：${tokenKey}`);
    target = token;
    calldata = buildApproveCalldata({ spender: a.spender, amount: a.amountRaw });
    intentParams = { tokenKey, token, spender: a.spender, amountRaw: String(a.amountRaw), deadline };
  } else {
    const a = p.permit2 || {};
    tokenKey = a.tokenKey;
    const token = (TOKENS[tokenKey] || {}).address;
    if (!token) throw new Error(`未知代币键：${tokenKey}`);
    target = CONTRACTS.permit2.address;
    const expiration = a.expirationSec != null ? Number(a.expirationSec) : now + 7 * 86400;
    calldata = buildPermit2ApproveCalldata({ token, spender: CONTRACTS.positionManager.address, amount: a.amountRaw, expiration });
    intentParams = { tokenKey, token, spender: CONTRACTS.positionManager.address, amountRaw: String(a.amountRaw), expiration, deadline };
  }

  const selector = calldata.slice(0, 10).toLowerCase();

  // —— 参数级白名单校验（不通过则不返回 calldata）——
  const intentForValidation = {
    type,
    user,
    owner: user,
    recipient: user,
    token: intentParams.token,
    amountRaw: intentParams.amountRaw,
    tickLower: intentParams.tickLower,
    tickUpper: intentParams.tickUpper,
    liquidity: intentParams.liquidity,
    amount0Max: intentParams.amount0Max,
    amount1Max: intentParams.amount1Max,
    amount0Min: intentParams.amount0Min,
    amount1Min: intentParams.amount1Min,
    tokenId: intentParams.tokenId,
  };
  const validation = validateCall({ key: type === 'permit2-approve' ? 'permit2' : (tokenKey || 'positionManager'), calldata, intent: intentForValidation, now });

  const wlPoolKey = whitelistedPoolKey();
  const record = {
    chainId,
    type,
    user,
    targetContract: target,
    selector,
    calldata,
    calldataHash: keccak256(calldata),
    actions: validation.actions || [validation.name],
    poolId: type === 'mint' || type === 'collect' || type === 'remove' ? poolId() : null,
    poolKey: type === 'mint' || type === 'collect' || type === 'remove' ? wlPoolKey : null,
    tokenId: intentParams.tokenId || null,
    params: intentParams,
    quoteSnapshot: null, // 由调用方（route）填入报价来源/时间/状态区块
    deadline,
    gateVersion: GATE_VERSION,
    parsedSnapshot: validation.snapshot,
    signed: false, // 恒为 false：build-only 不产生签名
    broadcast: false, // 恒为 false：本模块不广播
  };
  return record;
}

module.exports = { buildIntent, INTENT_TYPES, buildApproveCalldata, buildPermit2ApproveCalldata };
