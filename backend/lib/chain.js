/**
 * 链上只读读取库（M1 → M2）—— 所有函数均为只读（eth_call / getLogs / estimateGas），不构造任何交易。
 *
 * M2 增强（应对公共 RPC 限流与 0.1s 块速）：
 *  - 多端点（均通过准入检查）：状态读取可轮换；日志查询仅走支持 getLogs 的端点
 *  - 限流退避：命中 rate limit 自动切换端点并指数退避重试（上限 4 次）
 *  - 日志分块自适应：命中「logs count limit exceeded」自动折半区间重试
 *  - Multicall3 批量读取：头寸枚举/费用读取合并为 1-2 个请求
 *  - 历史状态读取 stateAt(block)：用于建仓台账的价格还原（已验证两端点均支持归档状态）
 *
 * 已校准的存储读取（2026-11-09 链上校准，全部经交叉验证）：
 *   - PoolManager `_pools` 映射槽位 = 6；positions 偏移 +6
 *   - positionKey = keccak256(abi.encodePacked(PM, int24 tickLower, int24 tickUpper, bytes32 tokenId))
 *   - Position.State: liquidity(+0) / feeGrowthInside0LastX128(+1) / feeGrowthInside1LastX128(+2)
 */
const { createPublicClient, http, keccak256, encodeAbiParameters, encodePacked } = require('viem');
const { CHAIN, CONTRACTS, TOKENS, POOLS } = require('../config/whitelist');
const v4math = require('./v4math');

const POOL = POOLS['KNTQ/HYPE (1%)'];
const POOL_KEY = POOL.poolKey;
const POOL_ID = POOL.poolId;
const PM_ADDR = CONTRACTS.positionManager.address;
const POOLM_ADDR = CONTRACTS.poolManager.address;
const SV_ADDR = CONTRACTS.stateView.address;
const MC3_ADDR = CONTRACTS.multicall3.address;
const DEPLOY_BLOCK = 256083;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000';

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
    { name: 'nextTokenId', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  ],
  erc20: [
    { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  ],
  permit2: [
    { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }] },
  ],
};

// —— RPC 端点管理（M2：两个端点均通过准入检查；能力路由 + 限流退避）——
const endpoints = CHAIN.rpcEndpoints.filter((e) => e.enabled).sort((a, b) => (a.priority || 9) - (b.priority || 9));
const clients = new Map();
function clientFor(url) {
  if (!clients.has(url)) clients.set(url, createPublicClient({ transport: http(url, { timeout: 25000, retryCount: 0 }) }));
  return clients.get(url);
}
const health = new Map(endpoints.map((e) => [e.url, { ok: true, latencyMs: null, lastError: null, rateLimitedAt: null, failures: 0, calls: 0 }]));
let activeUrl = endpoints[0] ? endpoints[0].url : null;

function classifyError(e) {
  const msg = String((e && (e.shortMessage || e.message)) || e).toLowerCase();
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('exceeded') && msg.includes('rate')) return 'rate';
  if (msg.includes('logs count limit') || msg.includes('query returned more than') || msg.includes('response size')) return 'logsLimit';
  return 'other';
}
function isRateLimitError(e) {
  const s = JSON.stringify(e && e.cause ? e.cause : e || {});
  return classifyError(e) === 'rate' || s.includes('-32017') || s.includes('429');
}
function isLogsLimitError(e) {
  const s = JSON.stringify(e && e.cause ? e.cause : e || {});
  return classifyError(e) === 'logsLimit' || s.includes('-32005');
}
function noteOk(url, ms) {
  const h = health.get(url); if (!h) return;
  h.ok = true; h.latencyMs = ms; h.failures = 0; h.calls++;
}
function noteErr(url, e) {
  const h = health.get(url); if (!h) return;
  h.ok = false; h.failures++; h.calls++;
  h.lastError = String((e && (e.shortMessage || e.message)) || e).slice(0, 160);
  if (isRateLimitError(e)) h.rateLimitedAt = new Date().toISOString();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 端点轮换 + 退避重试执行（capability: 'logs' 时只使用支持日志的端点） */
async function withRpc(fn, { capability = null, attempts = 4 } = {}) {
  if (!endpoints.length) throw new Error('无可用 RPC 端点');
  let order = [activeUrl, ...endpoints.map((e) => e.url).filter((u) => u !== activeUrl)];
  if (capability === 'logs') {
    const capable = endpoints.filter((e) => e.supportsLogs !== false).map((e) => e.url);
    if (!capable.length) throw new Error('无支持日志查询的端点');
    order = capable.sort((a, b) => {
      const ea = endpoints.find((e) => e.url === a); const eb = endpoints.find((e) => e.url === b);
      return (ea.priority || 9) - (eb.priority || 9);
    });
  }
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const url of order) {
      const t0 = Date.now();
      try {
        const out = await fn(clientFor(url), url);
        activeUrl = url;
        noteOk(url, Date.now() - t0);
        return out;
      } catch (e) {
        noteErr(url, e);
        lastErr = e;
        if (isRateLimitError(e)) continue; // 换下一个端点
        if (isLogsLimitError(e)) throw e;  // 交给调用方做区间折半
        throw e;                            // 其他错误（如 revert）直接抛出
      }
    }
    await sleep(800 * Math.pow(2, attempt)); // 全部端点都限流 → 退避后重试
  }
  throw lastErr || new Error('RPC 调用失败');
}

/** 原始 JSON-RPC 请求（走端点轮换与退避） */
async function rpcRequest(method, params, opts = {}) {
  return withRpc((c) => c.request({ method, params }), opts);
}

/**
 * 日志查询（原始 eth_getLogs + 二次过滤；自适应区间折半应对 10k 条上限）
 * @param {{address:string, topics:any[], fromBlock:number, toBlock:number, chunkSize?:number, filter?:Function}} o
 */
async function getLogsRaw({ address, topics, fromBlock, toBlock, chunkSize = 200000, filter = null }) {
  const out = [];
  let start = fromBlock;
  let chunk = chunkSize;
  while (start <= toBlock) {
    const end = Math.min(toBlock, start + chunk - 1);
    let logs;
    try {
      logs = await rpcRequest('eth_getLogs', [{
        address, fromBlock: '0x' + BigInt(start).toString(16), toBlock: '0x' + BigInt(end).toString(16), topics,
      }], { capability: 'logs' });
    } catch (e) {
      if (isLogsLimitError(e) && chunk > 1000) { chunk = Math.max(1000, Math.floor(chunk / 4)); continue; }
      throw e;
    }
    let arr = Array.isArray(logs) ? logs : [];
    // 防御：部分端点会丢弃 topics 过滤，这里按 topics 再过滤一次
    arr = arr.filter((l) => {
      if (!l || !l.topics || !l.topics.length) return false;
      for (let i = 0; i < topics.length; i++) {
        if (!topics[i]) continue;
        if (String(l.topics[i] || '').toLowerCase() !== String(topics[i]).toLowerCase()) return false;
      }
      return true;
    });
    if (filter) arr = arr.filter(filter);
    out.push(...arr);
    start = end + 1;
    if (arr.length === 0 && chunk < chunkSize) chunk = Math.min(chunkSize, chunk * 2); // 稀疏区间逐步恢复
  }
  return out;
}

// —— 基础读取 ——
async function latestBlock() {
  return withRpc(async (c) => Number(await c.getBlockNumber()));
}

async function blockMeta(blockNumber) {
  const b = await rpcRequest('eth_getBlockByNumber', ['0x' + BigInt(blockNumber).toString(16), false]);
  if (!b) return null;
  return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) * 1000, hash: b.hash };
}

async function stateAt(blockNumber) {
  // 历史状态读取（归档）：返回该区块结束时（含该区块）的池状态
  const data = encodeFunctionDataCompat('getSlot0', [POOL_ID]);
  const res = await rpcRequest('eth_call', [{ to: SV_ADDR, data }, '0x' + BigInt(blockNumber).toString(16)]);
  if (!res || res === '0x') return null;
  const { decodeAbiParameters } = require('viem');
  const dec = decodeAbiParameters([{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }], res);
  return { sqrtPriceX96: dec[0].toString(), tick: Number(dec[1]), protocolFee: Number(dec[2]), lpFee: Number(dec[3]) };
}
function encodeFunctionDataCompat(name, args) {
  const { encodeFunctionData } = require('viem');
  return encodeFunctionData({ abi: ABI.stateView, functionName: name, args });
}

async function estimateGas({ to, data, from, value }) {
  const tx = { to, data };
  if (from) tx.from = from;
  if (value != null) {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = '0' + hex;
    tx.value = '0x' + hex;
  }
  const r = await rpcRequest('eth_estimateGas', [tx]);
  return r ? Number(BigInt(r)) : null;
}

// —— 池状态（带 5 秒缓存，降低 RPC 压力）——
let poolStateCache = { at: 0, data: null };
/** Multicall 结果兼容：allowFailure 形态（{status,result}）或原始值 */
function mcRes(r) {
  if (r && typeof r === 'object' && 'status' in r) return r.status === 'success' ? r.result : null;
  return r === undefined ? null : r;
}
async function readPoolStateWith(c) {
  const [slot0R, liqR, fgR] = await c.multicall({
    multicallAddress: MC3_ADDR,
    contracts: [
      { address: SV_ADDR, abi: ABI.stateView, functionName: 'getSlot0', args: [POOL_ID] },
      { address: SV_ADDR, abi: ABI.stateView, functionName: 'getLiquidity', args: [POOL_ID] },
      { address: SV_ADDR, abi: ABI.stateView, functionName: 'getFeeGrowthGlobals', args: [POOL_ID] },
    ],
  });
  const slot0 = mcRes(slot0R); const liq = mcRes(liqR); const fg = mcRes(fgR);
  if (!slot0 || liq == null || !fg) throw new Error('池状态读取失败（Multicall 返回失败）');
  return {
    poolId: POOL_ID,
    sqrtPriceX96: String(slot0[0]),
    tick: Number(slot0[1]),
    protocolFee: Number(slot0[2]),
    lpFee: Number(slot0[3]),
    liquidity: String(liq),
    feeGrowthGlobal0: String(fg[0]),
    feeGrowthGlobal1: String(fg[1]),
    at: new Date().toISOString(),
  };
}
async function getPoolState() {
  if (poolStateCache.data && Date.now() - poolStateCache.at < 5000) return poolStateCache.data;
  const data = await withRpc((c) => readPoolStateWith(c));
  poolStateCache = { at: Date.now(), data };
  return data;
}

async function fetchTransfers(fromBlock, toBlock) {
  return getLogsRaw({ address: PM_ADDR, topics: [TRANSFER_TOPIC], fromBlock, toBlock, chunkSize: 2000000 });
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
function positionStateSlot(tokenId, tickLower, tickUpper) {
  return BigInt(keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }],
    [positionKey(tokenId, tickLower, tickUpper), poolBaseSlot() + POSITIONS_OFFSET])));
}
async function readSlot(c, slot) {
  const key = '0x' + BigInt(slot).toString(16).padStart(64, '0');
  const word = await c.readContract({ address: POOLM_ADDR, abi: ABI.poolManager, functionName: 'extsload', args: [key] });
  return BigInt(word);
}

/** 纯函数版待领费用（供 multicall 批量读取后本地计算） */
function computePendingFees({ liquidity, last0, last1, tickLower, tickUpper, tickInfoLower, tickInfoUpper, poolState }) {
  const tickCur = poolState.tick;
  const g0 = BigInt(poolState.feeGrowthGlobal0);
  const g1 = BigInt(poolState.feeGrowthGlobal1);
  const inside = (g, outLower, outUpper) => {
    const below = tickCur >= Number(tickLower) ? BigInt(outLower) : mod256(g - BigInt(outLower));
    const above = tickCur < Number(tickUpper) ? BigInt(outUpper) : mod256(g - BigInt(outUpper));
    return mod256(g - below - above);
  };
  const in0 = inside(g0, tickInfoLower[2], tickInfoUpper[2]);
  const in1 = inside(g1, tickInfoLower[3], tickInfoUpper[3]);
  const d0 = mod256(in0 - BigInt(last0));
  const d1 = mod256(in1 - BigInt(last1));
  const HALF = 1n << 255n;
  const anomaly = d0 > HALF || d1 > HALF;
  const L = BigInt(liquidity);
  return { fee0: anomaly ? 0n : (L * d0) >> 128n, fee1: anomaly ? 0n : (L * d1) >> 128n, anomaly };
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

/** 头寸链上读取（Multicall3 批量：3 个基础读取 + 4 个费用读取，共 2 个请求） */
async function enrichPositions(c, poolState, tokenIds) {
  if (!tokenIds.length) return [];
  const base = await c.multicall({
    multicallAddress: MC3_ADDR,
    allowFailure: true,
    contracts: tokenIds.flatMap((id) => ([
      { address: PM_ADDR, abi: ABI.positionManager, functionName: 'ownerOf', args: [BigInt(id)] },
      { address: PM_ADDR, abi: ABI.positionManager, functionName: 'getPoolAndPositionInfo', args: [BigInt(id)] },
      { address: PM_ADDR, abi: ABI.positionManager, functionName: 'getPositionLiquidity', args: [BigInt(id)] },
    ])),
  });
  const out = [];
  const matched = [];
  tokenIds.forEach((tokenId, i) => {
    const rOwner = mcRes(base[i * 3]);
    const gpi = mcRes(base[i * 3 + 1]);
    const rLiq = mcRes(base[i * 3 + 2]);
    if (rOwner == null || gpi == null || rLiq == null) {
      out.push({ tokenId: String(tokenId), invalid: true, reason: '链上读取失败（可能已销毁）' });
      return;
    }
    const owner = rOwner;
    const pk = gpi.poolKey || gpi[0];
    const info = decodePositionInfo(gpi.info != null ? gpi.info : gpi[1]);
    const liq = rLiq;
    const liquidity = liq;
    const poolMatch = String(pk.currency0).toLowerCase() === POOL_KEY.currency0.toLowerCase()
      && String(pk.currency1).toLowerCase() === POOL_KEY.currency1.toLowerCase()
      && Number(pk.fee) === Number(POOL_KEY.fee)
      && Number(pk.tickSpacing) === Number(POOL_KEY.tickSpacing)
      && String(pk.hooks).toLowerCase() === POOL_KEY.hooks.toLowerCase();
    const rec = {
      tokenId: String(tokenId),
      ownerOnchain: String(owner),
      liquidity: liquidity.toString(),
      closed: liquidity === 0n,
      ...info,
      poolMatch,
      poolKey: { currency0: pk.currency0, currency1: pk.currency1, fee: Number(pk.fee), tickSpacing: Number(pk.tickSpacing), hooks: pk.hooks },
    };
    out.push(rec);
    if (poolMatch) matched.push({ rec, tokenId, info, liquidity });
  });

  if (matched.length) {
    const feeCalls = await c.multicall({
      multicallAddress: MC3_ADDR,
      allowFailure: true,
      contracts: matched.flatMap(({ tokenId, info }) => ([
        { address: POOLM_ADDR, abi: ABI.poolManager, functionName: 'extsload', args: ['0x' + (positionStateSlot(tokenId, info.tickLower, info.tickUpper) + 1n).toString(16).padStart(64, '0')] },
        { address: POOLM_ADDR, abi: ABI.poolManager, functionName: 'extsload', args: ['0x' + (positionStateSlot(tokenId, info.tickLower, info.tickUpper) + 2n).toString(16).padStart(64, '0')] },
        { address: SV_ADDR, abi: ABI.stateView, functionName: 'getTickInfo', args: [POOL_ID, info.tickLower] },
        { address: SV_ADDR, abi: ABI.stateView, functionName: 'getTickInfo', args: [POOL_ID, info.tickUpper] },
      ])),
    });
    matched.forEach(({ rec, tokenId, info, liquidity }, i) => {
      const s0 = mcRes(feeCalls[i * 4]); const s1 = mcRes(feeCalls[i * 4 + 1]);
      const tl = mcRes(feeCalls[i * 4 + 2]); const tu = mcRes(feeCalls[i * 4 + 3]);
      if (s0 == null || s1 == null || tl == null || tu == null) { rec.feeAnomaly = true; return; }
      const fees = computePendingFees({
        liquidity, last0: BigInt(s0), last1: BigInt(s1),
        tickLower: info.tickLower, tickUpper: info.tickUpper,
        tickInfoLower: tl, tickInfoUpper: tu, poolState,
      });
      const amts = v4math.amountsForLiquidity(
        BigInt(poolState.sqrtPriceX96),
        v4math.sqrtPriceX96AtTick(info.tickLower),
        v4math.sqrtPriceX96AtTick(info.tickUpper),
        BigInt(liquidity));
      rec.fee0 = fees.fee0.toString();
      rec.fee1 = fees.fee1.toString();
      rec.feeAnomaly = fees.anomaly;
      rec.amount0 = amts.amount0.toString();
      rec.amount1 = amts.amount1.toString();
      rec.inRange = poolState.tick >= info.tickLower && poolState.tick < info.tickUpper;
      void tokenId;
    });
  }
  return out;
}

async function loadWallet(address, tokenIds) {
  return withRpc(async (c) => {
    const poolState = await readPoolStateWith(c);
    const erc20Tokens = Object.entries(TOKENS).filter(([, t]) => t.address !== 'native');
    const calls = [
      { address: undefined, abi: null, functionName: null, args: null }, // 占位（原生余额单独取）
      ...erc20Tokens.map(([, t]) => ({ address: t.address, abi: ABI.erc20, functionName: 'balanceOf', args: [address] })),
    ];
    const nativeBal = await c.getBalance({ address });
    const erc20Res = await c.multicall({ multicallAddress: MC3_ADDR, allowFailure: true, contracts: calls.slice(1) });
    const balances = [
      { symbol: 'HYPE', raw: nativeBal.toString(), decimals: 18 },
      ...erc20Tokens.map(([sym, t], i) => {
        const v = mcRes(erc20Res[i]);
        return { symbol: sym, raw: v == null ? '0' : v.toString(), decimals: t.decimals };
      }),
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

/** 读取下一个将要铸造的 tokenId（用于「预计获得的 Position NFT」） */
async function nextTokenId() {
  return withRpc(async (c) => String(await c.readContract({ address: PM_ADDR, abi: ABI.positionManager, functionName: 'nextTokenId' })));
}

/** Permit2 授权状态（只读） */
async function permit2Allowance(owner, token) {
  return withRpc(async (c) => {
    const r = await c.readContract({ address: CONTRACTS.permit2.address, abi: ABI.permit2, functionName: 'allowance', args: [owner, token, PM_ADDR] });
    return { amount: String(r[0]), expiration: Number(r[1]), nonce: Number(r[2]) };
  });
}

function getRpcStatus() {
  const list = endpoints.map((e) => {
    const h = health.get(e.url) || {};
    return {
      url: e.url, source: e.source || null, priority: e.priority || 9,
      supportsLogs: e.supportsLogs !== false, active: e.url === activeUrl,
      ok: h.ok !== false, latencyMs: h.latencyMs ?? null, calls: h.calls || 0,
      lastError: h.lastError || null, rateLimitedAt: h.rateLimitedAt || null,
    };
  });
  return { active: activeUrl, failoverEnabled: list.length > 1, endpoints: list };
}

module.exports = {
  POOL, POOL_KEY, POOL_ID, PM_ADDR, POOLM_ADDR, SV_ADDR, MC3_ADDR, DEPLOY_BLOCK, TRANSFER_TOPIC, ZERO,
  ABI, withRpc, rpcRequest, getLogsRaw, blockMeta, stateAt, estimateGas, getRpcStatus,
  latestBlock, getPoolState, fetchTransfers, loadWallet, loadPositions, nextTokenId, permit2Allowance,
  computePendingFees, positionStateSlot, positionKey, decodePositionInfo,
};
