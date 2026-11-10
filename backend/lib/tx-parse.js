/**
 * M3.1 参数级白名单解析器（只读）—— review 要求：仅限制 selector 不够安全，必须解析 calldata 语义。
 *
 * 覆盖三类调用：
 *   1. ERC-20 approve(spender, amount)        → 限制 spender ∈ {positionManager, permit2}、金额、禁止无限授权
 *   2. Permit2 approve(token, spender, amount, expiration) → 限制 token/spender/金额/有效期
 *   3. PositionManager modifyLiquidities(bytes, uint256)   → 解码 actions 与参数，逐项校验
 *
 * 本模块**纯函数、只读**：不构造交易、不签名、不广播。
 */
const { decodeFunctionData, decodeAbiParameters, parseAbi } = require('viem');
const { CONTRACTS, POOLS } = require('../config/whitelist');

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];
const POOL_KEY_TUPLE = { type: 'tuple', components: POOL_KEY_COMPONENTS };

const ABI = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function modifyLiquidities(bytes unlockData, uint256 deadline)',
]);

/** V4 periphery Actions 编码（与官方 Actions.sol 一致；M2 编码器已在链上验证 0x020d / 0x0111） */
const ACTIONS = {
  0x00: 'INCREASE_LIQUIDITY',
  0x01: 'DECREASE_LIQUIDITY',
  0x02: 'MINT_POSITION',
  0x03: 'BURN_POSITION',
  0x04: 'INCREASE_LIQUIDITY_FROM_DELTAS',
  0x05: 'MINT_POSITION_FROM_DELTAS',
  0x06: 'SWAP_EXACT_IN_SINGLE',
  0x07: 'SWAP_EXACT_IN',
  0x08: 'SWAP_EXACT_OUT_SINGLE',
  0x09: 'SWAP_EXACT_OUT',
  0x0a: 'DONATE',
  0x0b: 'SETTLE',
  0x0c: 'SETTLE_ALL',
  0x0d: 'SETTLE_PAIR',
  0x0e: 'TAKE',
  0x0f: 'TAKE_ALL',
  0x10: 'TAKE_PORTION',
  0x11: 'TAKE_PAIR',
  0x12: 'CLOSE_CURRENCY',
  0x13: 'CLEAR_OR_TAKE',
  0x14: 'SWEEP',
};

/** 允许的 action 组合（与 intent 类型一一对应，顺序固定） */
const ALLOWED_ACTION_SEQUENCES = {
  mint: [[0x02, 0x0d]], // MINT_POSITION + SETTLE_PAIR
  collect: [[0x01, 0x11]], // DECREASE_LIQUIDITY(0) + TAKE_PAIR
  remove: [[0x01, 0x11]], // DECREASE_LIQUIDITY(>0) + TAKE_PAIR
};

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

function fail(msg) {
  const e = new Error(`参数级校验拒绝：${msg}`);
  e.code = 'PARAM_CHECK_FAILED';
  throw e;
}

function whitelistedPoolKey() {
  const pool = POOLS['KNTQ/HYPE (1%)'] || Object.values(POOLS)[0];
  if (!pool || !pool.poolKey) fail('白名单池缺少 poolKey');
  return pool.poolKey;
}

function normalizeAddr(a) {
  return String(a || '').toLowerCase();
}

function eqAddr(a, b) {
  return normalizeAddr(a) === normalizeAddr(b);
}

/** 解码 calldata 的 selector 与名称 */
function parseCalldata(calldata) {
  if (typeof calldata !== 'string' || !/^0x[0-9a-fA-F]+$/.test(calldata)) fail('calldata 格式非法');
  const selector = calldata.slice(0, 10).toLowerCase();
  const known = {
    '0x095ea7b3': 'approve',
    '0x87517c45': 'permit2-approve',
    '0xdd46508f': 'modifyLiquidities',
  };
  if (!known[selector]) fail(`未知函数选择器 ${selector}（不在参数级白名单）`);
  return { selector, name: known[selector], body: calldata };
}

/** 解码 modifyLiquidities 的 unlockData → { actions: [codes], params: [hex[]] } */
function decodeUnlockData(unlockData) {
  const [actionsHex, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], unlockData);
  const raw = actionsHex.slice(2);
  if (raw.length % 2 !== 0) fail('actions 字节长度非法');
  const codes = [];
  for (let i = 0; i < raw.length; i += 2) codes.push(parseInt(raw.slice(i, i + 2), 16));
  if (codes.length !== params.length) fail(`actions 数量(${codes.length}) 与参数数量(${params.length}) 不一致`);
  for (const c of codes) if (!(c in ACTIONS)) fail(`未知 action 0x${c.toString(16)}`);
  return { codes, params };
}

/** 解码单个 action 的参数（返回结构化对象，供校验与审计快照） */
function decodeActionParam(code, paramHex) {
  const name = ACTIONS[code];
  switch (name) {
    case 'MINT_POSITION': {
      const [poolKey, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData] = decodeAbiParameters(
        [POOL_KEY_TUPLE, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
        paramHex
      );
      return { name, poolKey, tickLower: Number(tickLower), tickUpper: Number(tickUpper), liquidity, amount0Max, amount1Max, owner, hookData };
    }
    case 'DECREASE_LIQUIDITY': {
      const [tokenId, liquidity, amount0Min, amount1Min, hookData] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
        paramHex
      );
      return { name, tokenId, liquidity, amount0Min, amount1Min, hookData };
    }
    case 'SETTLE_PAIR': {
      const [currency0, currency1] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], paramHex);
      return { name, currency0, currency1 };
    }
    case 'TAKE_PAIR': {
      const [currency0, currency1, recipient] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], paramHex);
      return { name, currency0, currency1, recipient };
    }
    case 'BURN_POSITION': {
      const [tokenId, amount0Min, amount1Min, hookData] = decodeAbiParameters(
        [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }], paramHex);
      return { name, tokenId, amount0Min, amount1Min, hookData };
    }
    case 'CLOSE_CURRENCY': {
      const [currency] = decodeAbiParameters([{ type: 'address' }], paramHex);
      return { name, currency };
    }
    case 'SWEEP': {
      const [token, recipient] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], paramHex);
      return { name, token, recipient };
    }
    default:
      // 其它 action（含被禁止的组合）也解析出来用于审计，但校验阶段会拒绝
      return { name, raw: paramHex };
  }
}

function checkPoolKey(poolKey) {
  const wl = whitelistedPoolKey();
  const pairs = [
    ['currency0', poolKey.currency0, wl.currency0],
    ['currency1', poolKey.currency1, wl.currency1],
    ['hooks', poolKey.hooks, wl.hooks],
  ];
  for (const [k, got, want] of pairs) {
    if (!eqAddr(got, want)) fail(`PoolKey.${k} 不匹配白名单池（${got} ≠ ${want}）`);
  }
  if (Number(poolKey.fee) !== Number(wl.fee)) fail(`PoolKey.fee 不匹配（${poolKey.fee} ≠ ${wl.fee}）`);
  if (Number(poolKey.tickSpacing) !== Number(wl.tickSpacing)) fail(`PoolKey.tickSpacing 不匹配（${poolKey.tickSpacing} ≠ ${wl.tickSpacing}）`);
}

/**
 * 校验一笔 calldata 是否与 intent 完全一致。
 * @returns {{ selector: string, name: string, actions?: string[], snapshot: object }}
 */
function validateCall({ key, calldata, intent, now = Math.floor(Date.now() / 1000) }) {
  const parsed = parseCalldata(calldata);
  const expectedContract = {
    KNTQ: CONTRACTS.permit2.address, // 由调用方另行校验目标地址，这里仅作映射提示
  };

  if (parsed.name === 'approve') {
    const { args } = decodeFunctionData({ abi: ABI, data: calldata });
    const [spender, amount] = args;
    const allowedSpenders = [CONTRACTS.positionManager.address, CONTRACTS.permit2.address];
    if (!allowedSpenders.some((a) => eqAddr(a, spender))) fail(`approve spender 不在允许集合（${spender}）`);
    if (amount === MAX_UINT256) fail('禁止无限授权（amount = 2^256-1），必须按本次 intent 金额授权');
    if (amount <= 0n) fail('approve 金额必须大于 0');
    if (intent && intent.amountRaw != null && amount > BigInt(intent.amountRaw)) {
      fail(`approve 金额 ${amount} 超过本次 intent 金额 ${intent.amountRaw}`);
    }
    return {
      selector: parsed.selector,
      name: 'approve',
      snapshot: { spender, amount: amount.toString() },
    };
  }

  if (parsed.name === 'permit2-approve') {
    const { args } = decodeFunctionData({ abi: ABI, data: calldata });
    const [token, spender, amount, expiration] = args;
    if (intent && intent.token && !eqAddr(token, intent.token)) fail(`Permit2 token ${token} 不是本次目标代币 ${intent.token}`);
    if (!eqAddr(spender, CONTRACTS.positionManager.address)) fail(`Permit2 spender 必须是 PositionManager（${spender}）`);
    if (amount <= 0n || amount > MAX_UINT160) fail('Permit2 授权金额非法');
    if (intent && intent.amountRaw != null && amount > BigInt(intent.amountRaw)) {
      fail(`Permit2 授权金额 ${amount} 超过本次 intent 金额 ${intent.amountRaw}`);
    }
    const maxExpiration = now + 30 * 86400; // 授权有效期上限 30 天
    if (Number(expiration) > maxExpiration) fail(`Permit2 授权有效期过长（${expiration} > ${maxExpiration}）`);
    if (Number(expiration) <= now) fail('Permit2 授权已过期');
    return {
      selector: parsed.selector,
      name: 'permit2-approve',
      snapshot: { token, spender, amount: amount.toString(), expiration: Number(expiration) },
    };
  }

  // —— modifyLiquidities：action 级校验 ——
  const { args } = decodeFunctionData({ abi: ABI, data: calldata });
  const [unlockData, deadline] = args;
  const { codes, params } = decodeUnlockData(unlockData);
  const decoded = codes.map((c, i) => {
    try {
      return decodeActionParam(c, params[i]);
    } catch (e) {
      return fail(`action ${ACTIONS[c]} 参数解码失败（${String(e.message).slice(0, 120)}）`);
    }
  });

  const type = intent && intent.type;
  if (!type || !ALLOWED_ACTION_SEQUENCES[type]) fail(`intent 类型非法或缺失（${type}）`);
  const allowed = ALLOWED_ACTION_SEQUENCES[type];
  const seqKey = codes.join(',');
  if (!allowed.some((s) => s.join(',') === seqKey)) {
    fail(`action 组合 [${codes.map((c) => ACTIONS[c]).join(' + ')}] 不属于 ${type} 的允许组合`);
  }

  // deadline 上限（默认 30 分钟）
  const maxDeadline = now + 1800;
  if (Number(deadline) > maxDeadline) fail(`deadline 过长（${deadline} > ${maxDeadline}）`);
  if (Number(deadline) < now) fail('deadline 已过期');

  const snapshot = { actions: codes.map((c) => ACTIONS[c]), params: decoded, deadline: Number(deadline) };

  if (type === 'mint') {
    const mint = decoded.find((d) => d.name === 'MINT_POSITION');
    const settle = decoded.find((d) => d.name === 'SETTLE_PAIR');
    if (!mint || !settle) fail('缺少 MINT_POSITION 或 SETTLE_PAIR');
    checkPoolKey(mint.poolKey);
    const wl = whitelistedPoolKey();
    const ts = Number(wl.tickSpacing);
    if (mint.tickLower % ts !== 0 || mint.tickUpper % ts !== 0) fail(`tick 未按 tickSpacing(${ts}) 对齐`);
    if (mint.tickLower >= mint.tickUpper) fail('tickLower 必须小于 tickUpper');
    if (mint.liquidity <= 0n) fail('liquidity 必须大于 0');
    if (intent.tickLower != null && mint.tickLower !== Number(intent.tickLower)) fail('tickLower 与 intent 不一致');
    if (intent.tickUpper != null && mint.tickUpper !== Number(intent.tickUpper)) fail('tickUpper 与 intent 不一致');
    if (intent.liquidity != null && mint.liquidity !== BigInt(intent.liquidity)) fail('liquidity 与 intent 不一致');
    if (intent.amount0Max != null && mint.amount0Max > BigInt(intent.amount0Max)) fail('amount0Max 超过 intent 上限');
    if (intent.amount1Max != null && mint.amount1Max > BigInt(intent.amount1Max)) fail('amount1Max 超过 intent 上限');
    if (intent.owner && !eqAddr(mint.owner, intent.owner)) fail('owner 必须是用户本人地址');
    if (!eqAddr(settle.currency0, mint.poolKey.currency0) || !eqAddr(settle.currency1, mint.poolKey.currency1)) {
      fail('SETTLE_PAIR 货币与 PoolKey 不一致');
    }
  } else {
    // collect / remove 共用 DECREASE_LIQUIDITY + TAKE_PAIR
    const dec = decoded.find((d) => d.name === 'DECREASE_LIQUIDITY');
    const take = decoded.find((d) => d.name === 'TAKE_PAIR');
    if (!dec || !take) fail('缺少 DECREASE_LIQUIDITY 或 TAKE_PAIR');
    if (intent.tokenId != null && dec.tokenId !== BigInt(intent.tokenId)) fail('tokenId 与 intent 不一致');
    if (type === 'collect') {
      if (dec.liquidity !== 0n) fail('领费必须使用 DECREASE_LIQUIDITY(0)（不得顺带减少流动性）');
    } else {
      if (dec.liquidity <= 0n) fail('撤池的 liquidity 必须大于 0');
      if (intent.liquidity != null && dec.liquidity !== BigInt(intent.liquidity)) fail('撤池 liquidity 与 intent 不一致');
      if (intent.amount0Min != null && dec.amount0Min < BigInt(intent.amount0Min)) fail('amount0Min 低于 intent 下限');
      if (intent.amount1Min != null && dec.amount1Min < BigInt(intent.amount1Min)) fail('amount1Min 低于 intent 下限');
    }
    if (intent.recipient && !eqAddr(take.recipient, intent.recipient)) fail('TAKE_PAIR recipient 必须是用户本人地址');
    const wl = whitelistedPoolKey();
    if (!eqAddr(take.currency0, wl.currency0) || !eqAddr(take.currency1, wl.currency1)) fail('TAKE_PAIR 货币与白名单池不一致');
  }

  return { selector: parsed.selector, name: 'modifyLiquidities', actions: snapshot.actions, snapshot };
}

/**
 * 从**真实 calldata** 解出可用于签名前核对的字段（复用同一套参数级校验，不放松任何限制）。
 * intent（类型 + 参数）来自 intent 记录（权威来源），用于校验 action 组合与金额方向。
 * 任何解码失败都会抛错 → 调用方必须拒绝签名（fail-closed）。
 */
function decodeForCheck({ calldata, key, intent = null }) {
  const r = validateCall({ key, calldata, intent });
  const snap = r.snapshot || {};
  const params = Array.isArray(snap.params) ? snap.params : [];
  return {
    selector: r.selector,
    name: r.name,
    actions: r.actions || snap.actions || null,
    deadline: snap.deadline != null ? Number(snap.deadline) : null,
    minOut: amountBoundsOf(params),
    params,
  };
}

/**
 * 金额边界的规范化表示（授权与签名前核对使用同一个函数，保证可比性）：
 *   - mint：MINT_POSITION 的 amount0Max / amount1Max
 *   - remove：DECREASE_LIQUIDITY 的 amount0Min / amount1Min
 *   - collect：liquidity 必须为 0（金额边界恒为 0:0）
 */
function amountBoundsOf(params = []) {
  const p = params.find((x) => x && (x.amount0Min != null || x.amount0Max != null)) || {};
  const a0 = p.amount0Min != null ? p.amount0Min : p.amount0Max;
  const a1 = p.amount1Min != null ? p.amount1Min : p.amount1Max;
  if (a0 == null && a1 == null) return null;
  return `${a0 != null ? a0 : 0}:${a1 != null ? a1 : 0}`;
}

module.exports = {
  ACTIONS,
  decodeForCheck,
  amountBoundsOf,
  ALLOWED_ACTION_SEQUENCES,
  parseCalldata,
  decodeUnlockData,
  decodeActionParam,
  validateCall,
  whitelistedPoolKey,
  MAX_UINT256,
};
