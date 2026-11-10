/**
 * 链上只读读取库（M1）—— 所有函数均为只读（eth_call / getLogs），不构造任何交易。
 *
 * 已校准的存储读取（2026-11-09 链上校准，全部经交叉验证）：
 *   - PoolManager `_pools` 映射槽位 = 6（用 StateView.getSlot0 校准）
 *   - Pool.State: slot0(+0) / feeGrowthGlobal0(+1) / feeGrowthGlobal1(+2) / liquidity(+3) / ticks(+4) / tickBitmap(+5) / positions(+6)
 *   - positionKey = keccak256(abi.encodePacked(PM, int24 tickLower, int24 tickUpper, bytes32 tokenId))
 *   - Position.State: liquidity(+0) / feeGrowthInside0LastX128(+1) / feeGrowthInside1LastX128(+2)
 *   验证：extsload 流动性 == PositionManager.getPositionLiquidity（一致）；poolBase+1/+3 与 StateView 一致。
 */
const { createPublicClient, http, keccak256, encodeAbiParameters, encodePacked } = require('viem');
const { CHAIN, CONTRACTS, TOKENS, POOLS } = require('../config/whitelist');

const POOL = POOLS['KNTQ/HYPE (1%)'];
const POOL_KEY = POOL.poolKey;
const POOL_ID = POOL.poolId;
const PM_ADDR = CONTRACTS.positionManager.address;
const POOLM_ADDR = CONTRACTS.poolManager.address;
const SV_ADDR = CONTRACTS.stateView.address;
const DEPLOY_BLOCK = 256083;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

// —— 运行时不变量：白名单 PoolKey 必须与 poolId 一致（防止参数不一致）——
const computedPoolId = keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [POOL_KEY.currency0, POOL_KEY.currency1, POOL_KEY.fee, POOL_KEY.tickSpacing, POOL_KEY.hooks]));
if (computedPoolId.toLowerCase() !== POOL_ID.toLowerCase()) {
  throw new Error(`白名单 PoolKey 与 poolId 不一致（computed=${computedPoolId}）`);
}

const ABI = {
  stateView: [
    { name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] },
    { name: 'getLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint128' }] },
    { name: 'getFeeGrowthGlobals', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] },
    { name: 'getTickInfo', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'int24' }], outputs: [{ type: 'uint128' }, { type: 'int128' }, { type: 'uint256' }, { type: 'uint256' }] },
  ],
  poolManager: [
    { name: 'extsload', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bytes32' }] },
  ],
  positionManager: [
    { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
    { name: 'getPoolAndPositionInfo', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [
      { name: 'poolKey', type: 'tuple', components: [
        { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
      { name: 'info', type: 'uint256' }] },
    { name: 'getPositionLiquidity', type: 'function', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint128' }] },
  ],
  erc20: [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  ],
};

// —— RPC 端点管理（failover 框架；当前仅 1 个已核验端点）——
const endpoints = CHAIN.rpcEndpoints.filter((e) => e.enabled).sort((a, b) => (a.priority || 9) - (b.priority || 9));
const clients = new Map();
function clientFor(url) {
  if (!clients.has(url)) clients.set(url, createPublicClient({ transport: http(url, { timeout: 20000, retryCount: 0 }) }));
  return clients.get(url);
}
let activeUrl = endpoints[0] ? endpoints[0].url : null;
const rpcHealth = new Map();

async function withRpc(fn) {
  if (!endpoints.length) throw new Error('无可用 RPC 端点');
  const order = [activeUrl, ...endpoints.map((e) => e.url).filter((u) => u !== activeUrl)].filter(Boolean);
  let lastErr = null;
  for (const url of order) {
    const t0 = Date.now();
    try {
      const out = await fn(clientFor(url), url);
      rpcHealth.set(url, { ok: true, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString(), lastError: null });
      activeUrl = url;
      return out;
    } catch (e) {
      const prev = rpcHealth.get(url) || {};
      rpcHealth.set(url, {
        ok: false, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString(),
        lastError: String(e.shortMessage || e.message || e).slice(0, 200),
        consecutiveFails: (prev.consecutiveFails || 0) + 1,
      });
      lastErr = e;
    }
  }
  const err = new Error('所有 RPC 端点均失败：' + String(lastErr && (lastErr.shortMessage || lastErr.message) || 'unknown'));
  err.cause = lastErr;
  throw err;
}

function getRpcStatus() {
  return {
    active: activeUrl,
    failoverEnabled: endpoints.length > 1, // 当前仅 1 个端点 → 未启用故障切换（框架预留）
    endpoints: endpoints.map((e) => ({ url: e.url, source: e.source, priority: e.priority, enabled: true, ...(rpcHealth.get(e.url) || { ok: null }) })),
  };
}

// —— 基础读取 ——
async function latestBlock() {
  return withRpc((c) => c.getBlockNumber().then(Number));
}

function readPoolStateWith(c) {
  return (async () => {
    const [slot0, liquidity, globals] = await Promise.all([
      c.readContract({ address: SV_ADDR, abi: ABI.stateView, functionName: 'getSlot0', args: [POOL_ID] }),
      c.readContract({ address: SV_ADDR, abi: ABI.stateView, functionName: 'getLiquidity', args: [POOL_ID] }),
      c.readContract({ address: SV_ADDR, abi: ABI.stateView, functionName: 'getFeeGrowthGlobals', args: [POOL_ID] }),
    ]);
    return {
      sqrtPriceX96: slot0[0].toString(), tick: Number(slot0[1]), protocolFee: Number(slot0[2]), lpFee: Number(slot0[3]),
      liquidity: liquidity.toString(), feeGrowthGlobal0: globals[0].toString(), feeGrowthGlobal1: globals[1].toString(),
      at: new Date().toISOString(),
    };
  })();
}

async function getPoolState() {
  return withRpc((c) => readPoolStateWith(c));
}

async function fetchTransfers(fromBlock, toBlock) {
  // 注意：不用 viem 的 getLogs 封装（实测该 RPC 上 topics 过滤会被丢弃），直接走原始 eth_getLogs + 二次过滤
  return withRpc(async (c) => {
    const logs = await c.request({
      method: 'eth_getLogs',
      params: [{
        address: PM_ADDR,
        fromBlock: '0x' + BigInt(fromBlock).toString(16),
        toBlock: '0x' + BigInt(toBlock).toString(16),
        topics: [TRANSFER_TOPIC],
      }],
    });
    return (logs || []).filter((l) => l.topics && l.topics.length === 4 && String(l.topics[0]).toLowerCase() === TRANSFER_TOPIC);
  });
}

// —— 费用计算（已验证数学路径）——
const MOD = 1n << 256n;
const mod256 = (x) => ((x % MOD) + MOD) % MOD;
const POOLS_SLOT = 6n;
const POSITIONS_OFFSET = 6n;
const Q96 = 1n << 96n;

function poolBaseSlot() {
  return BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [POOL_ID, POOLS_SLOT])));
}
function positionKey(tokenId, tickLower, tickUpper) {
  const salt = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  return keccak256(encodePacked(['address', 'int24', 'int24', 'bytes32'], [PM_ADDR, Number(tickLower), Number(tickUpper), salt]));
}
async function readSlot(c, slot) {
  const key = '0x' + BigInt(slot).toString(16).padStart(64, '0');
  const word = await c.readContract({ address: POOLM_ADDR, abi: ABI.poolManager, functionName: 'extsload', args: [key] });
  return BigInt(word);
}

async function pendingFees(c, tokenId, tickLower, tickUpper, liquidity, poolState) {
  const posSlot = BigInt(keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }],
    [positionKey(tokenId, tickLower, tickUpper), poolBaseSlot() + POSITIONS_OFFSET])));
  const [last0, last1, tL, tU] = await Promise.all([
    readSlot(c, posSlot + 1n),
    readSlot(c, posSlot + 2n),
    c.readContract({ address: SV_ADDR, abi: ABI.stateView, functionName: 'getTickInfo', args: [POOL_ID, tickLower] }),
    c.readContract({ address: SV_ADDR, abi: ABI.stateView, functionName: 'getTickInfo', args: [POOL_ID, tickUpper] }),
  ]);
  const tickCur = poolState.tick;
  const g0 = BigInt(poolState.feeGrowthGlobal0);
  const g1 = BigInt(poolState.feeGrowthGlobal1);
  const inside = (g, outLower, outUpper) => {
    const below = tickCur >= Number(tickLower) ? outLower : mod256(g - outLower);
    const above = tickCur < Number(tickUpper) ? outUpper : mod256(g - outUpper);
    return mod256(g - below - above);
  };
  const in0 = inside(g0, tL[2], tU[2]);
  const in1 = inside(g1, tL[3], tU[3]);
  const d0 = mod256(in0 - last0);
  const d1 = mod256(in1 - last1);
  const HALF = 1n << 255n;
  // 异常保护：feeGrowthInside 不应回退（超过 2^255 视为异常，返回 0 并标记）
  const anomaly = d0 > HALF || d1 > HALF;
  const L = BigInt(liquidity);
  return {
    fee0: anomaly ? 0n : (L * d0) >> 128n,
    fee1: anomaly ? 0n : (L * d1) >> 128n,
    anomaly,
  };
}

// —— 头寸金额（显示级精度）——
function sqrtPriceAtTick(tick) {
  // 显示级：double 精度（~15-16 位有效数字），仅用于金额展示
  const s = Math.pow(1.0001, tick / 2);
  return BigInt(Math.max(1, Math.floor(s * Number(Q96))));
}
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, L) {
  let a = sqrtA, b = sqrtB;
  if (a > b) { const t = a; a = b; b = t; }
  if (sqrtP <= a) return { amount0: (L * (b - a) * Q96) / (b * a), amount1: 0n };
  if (sqrtP < b) return { amount0: (L * (b - sqrtP) * Q96) / (b * sqrtP), amount1: (L * (sqrtP - a)) / Q96 };
  return { amount0: 0n, amount1: (L * (b - a)) / Q96 };
}

function decodePositionInfo(infoWord) {
  const info = BigInt(infoWord);
  const se24 = (v) => (v >= 0x800000n ? v - 0x1000000n : v);
  return {
    tickLower: Number(se24((info >> 8n) & 0xffffffn)),
    tickUpper: Number(se24((info >> 32n) & 0xffffffn)),
    hasSubscriber: Number(info & 0xffn) === 1,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function enrichPositions(c, poolState, tokenIds) {
  const sqrtP = BigInt(poolState.sqrtPriceX96);
  return mapLimit(tokenIds, 4, async (tokenId) => {
    const [owner, gpi, liquidity] = await Promise.all([
      c.readContract({ address: PM_ADDR, abi: ABI.positionManager, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
      c.readContract({ address: PM_ADDR, abi: ABI.positionManager, functionName: 'getPoolAndPositionInfo', args: [BigInt(tokenId)] }),
      c.readContract({ address: PM_ADDR, abi: ABI.positionManager, functionName: 'getPositionLiquidity', args: [BigInt(tokenId)] }),
    ]);
    const pk = gpi.poolKey || gpi[0];
    const info = decodePositionInfo(gpi.info != null ? gpi.info : gpi[1]);
    const poolMatch = String(pk.currency0).toLowerCase() === POOL_KEY.currency0.toLowerCase()
      && String(pk.currency1).toLowerCase() === POOL_KEY.currency1.toLowerCase()
      && Number(pk.fee) === Number(POOL_KEY.fee)
      && Number(pk.tickSpacing) === Number(POOL_KEY.tickSpacing)
      && String(pk.hooks).toLowerCase() === POOL_KEY.hooks.toLowerCase();
    const base = {
      tokenId: String(tokenId),
      ownerOnchain: String(owner),
      liquidity: liquidity.toString(),
      closed: liquidity === 0n,
      ...info,
      poolMatch,
      poolKey: { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks },
    };
    if (!poolMatch) return base;
    const fees = await pendingFees(c, tokenId, info.tickLower, info.tickUpper, liquidity, poolState);
    const amts = amountsForLiquidity(sqrtP, sqrtPriceAtTick(info.tickLower), sqrtPriceAtTick(info.tickUpper), BigInt(liquidity));
    return {
      ...base,
      fee0: fees.fee0.toString(),
      fee1: fees.fee1.toString(),
      feeAnomaly: fees.anomaly,
      amount0: amts.amount0.toString(),
      amount1: amts.amount1.toString(),
      inRange: poolState.tick >= info.tickLower && poolState.tick < info.tickUpper,
    };
  });
}

async function loadWallet(address, tokenIds) {
  return withRpc(async (c) => {
    const poolState = await readPoolStateWith(c);
    const erc20Tokens = Object.entries(TOKENS).filter(([, t]) => t.address !== 'native');
    const [nativeBal, ...erc20Bals] = await Promise.all([
      c.getBalance({ address }),
      ...erc20Tokens.map(([, t]) => c.readContract({ address: t.address, abi: ABI.erc20, functionName: 'balanceOf', args: [address] })),
    ]);
    const balances = [
      { symbol: 'HYPE', raw: nativeBal.toString(), decimals: 18 },
      ...erc20Tokens.map(([sym, t], i) => ({ symbol: sym, raw: erc20Bals[i].toString(), decimals: t.decimals })),
    ];
    const positions = await enrichPositions(c, poolState, tokenIds);
    return { pool: poolState, balances, positions, block: Number(await c.getBlockNumber()) };
  });
}

async function loadPositions(tokenIds) {
  return withRpc(async (c) => {
    const poolState = await readPoolStateWith(c);
    const positions = await enrichPositions(c, poolState, tokenIds);
    return { pool: poolState, positions };
  });
}

module.exports = {
  POOL, POOL_KEY, POOL_ID, PM_ADDR, POOLM_ADDR, SV_ADDR, DEPLOY_BLOCK, TRANSFER_TOPIC, ZERO,
  withRpc, getRpcStatus, latestBlock, getPoolState, fetchTransfers, loadWallet, loadPositions,
};
