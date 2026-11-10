/**
 * M2 模拟器 —— 建仓 / 撤池模拟（只模拟，不签名，不发交易）。
 *
 * 说明：
 *  - 建仓：本地数学计算（lib/v4math.js，已用大整数真值校验）+ 本地兑换估算（跨 tick 走位）
 *  - Gas：调用 eth_estimateGas（只读模拟，不上链）；失败则退回静态估算并给出原因
 *  - 所有「最低结果 / 上限」均按用户设定的滑点计算，M3 真实操作时沿用同一口径
 *  - 白名单与 PoolKey 复用 config/whitelist.js（启动时已校验 PoolKey → poolId 一致性）
 */
const { parseUnits, formatUnits, encodeAbiParameters, encodeFunctionData, parseAbi } = require('viem');
const chain = require('./chain');
const ledger = require('./ledger');
const v4math = require('./v4math');
const { getPrices } = require('./prices');
const { POOLS, TOKENS } = require('../config/whitelist');

const POOL = POOLS['KNTQ/HYPE (1%)'];
const POOL_KEY = POOL.poolKey;
const SPACING = Number(POOL_KEY.tickSpacing);
const FEE_PIPS = Number(POOL_KEY.fee);
const KNTQ_ADDR = TOKENS.KNTQ.address;
const GAS_STATIC = { mint: 420000, remove: 165000, collect: 100000 };
const DEADLINE = 2000000000n; // 仅用于 gas 估算（不上链）

function gasNoteFromError(e) {
  const msg = String((e && (e.shortMessage || e.message)) || e);
  if (/insufficient funds/i.test(msg)) {
    const m = msg.match(/have (\d+).*want (\d+)/i);
    return m
      ? `链上估算未执行：该地址余额不足（持有 ${m[1]} wei，需要 ${m[2]} wei）——编码本身有效，属正常提示`
      : '链上估算未执行：该地址余额不足（编码本身有效，属正常提示）';
  }
  if (/execution reverted/i.test(msg)) return '链上估算被回滚（可能是授权/余额/参数问题，编码已通过节点校验）';
  return String(msg).slice(0, 140);
}

const fmt = (v, d = 18) => formatUnits(BigInt(v), d);
function parseAmount(x) {
  if (x == null || x === '') return 0n;
  const s = String(x).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return 0n;
  try { return parseUnits(s, 18); } catch { return 0n; }
}
function poolAge() {
  const ageDays = (Date.now() - new Date(POOL.createdAt).getTime()) / 86400000;
  return { ageDays, hardWarning: ageDays < 7 };
}

const POOL_KEY_ABI = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ],
};
const MODIFY_ABI = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline)']);

function encodeMintCalldata({ tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner }) {
  const p1 = encodeAbiParameters(
    [POOL_KEY_ABI, { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' }],
    [POOL_KEY, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, '0x']);
  const p2 = encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [POOL_KEY.currency0, POOL_KEY.currency1]);
  const unlock = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x020d', [p1, p2]]);
  return encodeFunctionData({ abi: MODIFY_ABI, functionName: 'modifyLiquidities', args: [unlock, DEADLINE] });
}
function encodeRemoveCalldata({ tokenId, liquidity, amount0Min, amount1Min, recipient }) {
  const p1 = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [BigInt(tokenId), liquidity, amount0Min, amount1Min, '0x']);
  const p2 = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [POOL_KEY.currency0, POOL_KEY.currency1, recipient]);
  const unlock = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x0111', [p1, p2]]);
  return encodeFunctionData({ abi: MODIFY_ABI, functionName: 'modifyLiquidities', args: [unlock, DEADLINE] });
}

/** 本地兑换估算（含 1% 费率 + 跨 tick 走位） */
async function quoteSwap({ zeroForOne, amountIn, poolState }) {
  if (amountIn <= 0n) return null;
  const net = await ledger.tickLiquidityNet();
  return v4math.swapEstimate({
    zeroForOne,
    amountIn,
    sqrtPriceX96: BigInt(poolState.sqrtPriceX96),
    tick: poolState.tick,
    liquidity: BigInt(poolState.liquidity),
    liquidityNetByTick: net,
    feePips: FEE_PIPS,
  });
}

/**
 * 建仓模拟
 * @param {{amount0?:string, amount1?:string, tickLower:number, tickUpper:number, slippageBps?:number, owner?:string, swapExcess?:boolean}} input
 */
async function simulateMint(input) {
  const warnings = []; const errors = []; const notes = [];
  const slippageBps = Math.max(1, Math.min(Number(input.slippageBps) || 100, 5000));
  const poolState = await chain.getPoolState();
  const sqrtP = BigInt(poolState.sqrtPriceX96);
  const currentTick = poolState.tick;
  const age = poolAge();
  if (age.hardWarning) warnings.push(`池龄不足 7 天（约 ${age.ageDays.toFixed(1)} 天）—— 硬性风险提示：早期数据不可作为稳定性依据`);

  // —— 区间校验与 tickSpacing 对齐（支持直接给 tick，或给价格 KNTQ/HYPE）——
  let tL = Number(input.tickLower);
  let tU = Number(input.tickUpper);
  if ((!Number.isFinite(tL) || !Number.isFinite(tU)) && input.priceLower && input.priceUpper) {
    const pl = Number(input.priceLower); const pu = Number(input.priceUpper);
    if (Number.isFinite(pl) && Number.isFinite(pu) && pl > 0 && pu > pl) {
      tL = v4math.tickAtPrice(pl);
      tU = v4math.tickAtPrice(pu);
      notes.push(`已由价格换算 tick：${pl} → ${tL}，${pu} → ${tU}`);
    }
  }
  let tL2 = Math.trunc(Number(tL));
  let tU2 = Math.trunc(Number(tU));
  if (!Number.isFinite(tL2) || !Number.isFinite(tU2)) return { ok: false, errors: ['请填写有效的区间（tick 或价格）'], warnings, notes };
  const alignedL = v4math.alignTickDown(tL2, SPACING);
  const alignedU = v4math.alignTickUp(tU2, SPACING);
  if (alignedL !== tL2 || alignedU !== tU2) {
    notes.push(`区间已对齐到 tickSpacing=${SPACING}：${tL2} → ${alignedL}，${tU2} → ${alignedU}`);
  }
  tL = alignedL; tU = alignedU;
  if (tL >= tU) errors.push('区间下界必须小于上界（对齐后仍无效）');
  if (tL < v4math.MIN_TICK || tU > v4math.MAX_TICK) errors.push('区间超出可表示范围（±887272）');
  if (errors.length) return { ok: false, errors, warnings, notes };

  const amount0 = parseAmount(input.amount0);
  const amount1 = parseAmount(input.amount1);
  if (amount0 === 0n && amount1 === 0n) errors.push('请至少填写一种资产的金额');
  const sqrtA = v4math.sqrtPriceX96AtTick(tL);
  const sqrtB = v4math.sqrtPriceX96AtTick(tU);
  const inRange = currentTick >= tL && currentTick < tU;
  const belowRange = currentTick < tL; // 价格在区间下方 → 只需要 token0（HYPE）
  const aboveRange = currentTick >= tU; // 价格在区间上方 → 只需要 token1（KNTQ）

  let base = { L: 0n, used0: 0n, used1: 0n, limiting: 'none' };
  if (!errors.length) base = v4math.liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1);
  if (!errors.length && base.L === 0n) errors.push('金额过小，无法形成有效流动性（L=0），请增加金额');
  if (!errors.length && belowRange && amount0 === 0n) errors.push('当前价格在区间下方：该区间只需要 HYPE（token0）');
  if (!errors.length && aboveRange && amount1 === 0n) errors.push('当前价格在区间上方：该区间只需要 KNTQ（token1）');
  if (errors.length) {
    return {
      ok: false, errors, warnings, notes,
      context: { currentTick, inRange, belowRange, aboveRange, tickSpacing: SPACING },
    };
  }

  // —— 多余资产 → 本地兑换估算（两步法：先兑换再建仓）——
  const DUST = 10n ** 12n; // 1e-6 代币以下视为尘埃，不触发兑换估算
  let leftover0 = amount0 - base.used0;
  let leftover1 = amount1 - base.used1;
  if (leftover0 < DUST) leftover0 = 0n;
  if (leftover1 < DUST) leftover1 = 0n;
  let swap = null;
  let final0 = base.used0;
  let final1 = base.used1;
  let sqrtAfter = sqrtP;
  const swapExcess = input.swapExcess !== false;
  if ((leftover0 > 0n || leftover1 > 0n) && swapExcess) {
    const zeroForOne = leftover0 > 0n; // 多余 token0 → 换成 token1
    const amountIn = zeroForOne ? leftover0 : leftover1;
    const q = await quoteSwap({ zeroForOne, amountIn, poolState });
    if (q) {
      swap = {
        direction: zeroForOne ? 'HYPE→KNTQ' : 'KNTQ→HYPE',
        amountIn: amountIn.toString(),
        amountInHuman: fmt(amountIn),
        amountOut: q.amountOut.toString(),
        amountOutHuman: fmt(q.amountOut),
        feePaid: q.feePaid.toString(),
        priceImpactPct: Number(q.priceImpactPct.toFixed(4)),
        ticksCrossed: q.ticksCrossed,
        partial: q.partial,
      };
      if (q.partial) warnings.push('兑换估算未能完全成交（池内流动性不足），请减小金额或调整区间');
      if (Math.abs(q.priceImpactPct) > 3) warnings.push(`兑换价格影响较大（${q.priceImpactPct.toFixed(2)}%）`);
      if (zeroForOne) { final0 = base.used0 + amountIn; final1 = base.used1 + q.amountOut; }
      else { final1 = base.used1 + amountIn; final0 = base.used0 + q.amountOut; }
      sqrtAfter = q.sqrtPriceAfter;
    } else {
      notes.push('多余资产未做兑换估算（金额为 0）');
    }
  } else if (leftover0 > 0n || leftover1 > 0n) {
    notes.push(`存在多余资产未使用：${fmt(leftover0)} HYPE / ${fmt(leftover1)} KNTQ（已关闭自动兑换估算）`);
  }

  // —— 用（兑换后的）金额与价格重新计算最终流动性 ——
  const finalCalc = v4math.liquidityForAmounts(sqrtAfter, sqrtA, sqrtB, final0, final1);
  const L = finalCalc.L;
  const used0 = finalCalc.used0;
  const used1 = finalCalc.used1;
  if (L === 0n) errors.push('兑换后仍无法形成有效流动性，请调整金额');

  const slip = BigInt(Math.round(slippageBps));
  const amount0Max = (used0 * (10000n + slip)) / 10000n;
  const amount1Max = (used1 * (10000n + slip)) / 10000n;
  const minLiquidity = (L * (10000n - slip)) / 10000n;

  const rangeLower = v4math.priceFromSqrtX96(sqrtA);
  const rangeUpper = v4math.priceFromSqrtX96(sqrtB);
  const currentPrice = v4math.priceFromSqrtX96(sqrtP);

  // —— 预计获得的 Position NFT ——
  let expectedTokenId = null;
  try { expectedTokenId = await chain.nextTokenId(); } catch (e) { notes.push('无法读取 nextTokenId（不影响模拟）'); }

  // —— Gas 估算（eth_estimateGas，只读模拟；失败退回静态值）——
  let gas = { value: GAS_STATIC.mint, source: 'static', note: '静态估算（未能链上估算）' };
  const owner = input.owner && /^0x[0-9a-fA-F]{40}$/.test(input.owner) ? input.owner : null;
  if (owner && L > 0n) {
    try {
      const data = encodeMintCalldata({ tickLower: tL, tickUpper: tU, liquidity: L, amount0Max, amount1Max, owner });
      const est = await chain.estimateGas({ to: chain.PM_ADDR, data, from: owner, value: amount0Max });
      if (est) gas = { value: est, source: 'estimateGas', note: '链上模拟估算（未上链）' };
    } catch (e) {
      gas = { value: GAS_STATIC.mint, source: 'static', note: gasNoteFromError(e) };
    }
  } else if (!owner) {
    gas.note = '未提供钱包地址，使用静态估算';
  }

  // —— 授权与余额预检（只读）——
  let allowance = null; let balances = null;
  if (owner) {
    try {
      const al = await chain.permit2Allowance(owner, KNTQ_ADDR);
      const nowSec = Math.floor(Date.now() / 1000);
      allowance = {
        amount: al.amount, expiration: al.expiration,
        sufficient: BigInt(al.amount) >= used1 && al.expiration > nowSec,
        note: BigInt(al.amount) >= used1 && al.expiration > nowSec ? 'KNTQ 已授权给 Permit2（足够本次建仓）' : '需要先授权 KNTQ 给 Permit2（M3 阶段才会请求签名）',
      };
    } catch (e) { allowance = { error: String(e.message || e).slice(0, 120) }; }
    try {
      const w = await chain.loadWallet(owner, []);
      const hype = w.balances.find((b) => b.symbol === 'HYPE');
      const kntq = w.balances.find((b) => b.symbol === 'KNTQ');
      const hypeBal = hype ? BigInt(hype.raw) : 0n;
      const kntqBal = kntq ? BigInt(kntq.raw) : 0n;
      balances = {
        hype: hypeBal.toString(), kntq: kntqBal.toString(),
        hypeSufficient: hypeBal >= amount0Max, kntqSufficient: kntqBal >= amount1Max,
        note: hypeBal >= amount0Max && kntqBal >= amount1Max ? '余额充足' : '余额不足（含滑点上限）',
      };
    } catch (e) { balances = { error: String(e.message || e).slice(0, 120) }; }
  }

  if (!inRange) notes.push(belowRange ? '当前价格在区间下方：建仓为单边 HYPE（价格涨入区间后开始赚费）' : '当前价格在区间上方：建仓为单边 KNTQ（价格跌入区间后开始赚费）');
  const widthPct = rangeLower.isZero() ? 0 : rangeUpper.minus(rangeLower).div(rangeLower).times(100).toNumber();
  if (widthPct < 0.5) warnings.push(`区间过窄（约 ${widthPct.toFixed(2)}%）：出区间概率高，手续费可能无法覆盖无常损失`);

  let prices = null;
  try { prices = await getPrices(); } catch (e) { /* 忽略 */ }
  const hypeUsd = prices && prices.HYPE ? prices.HYPE.usd : null;
  const depositUsd = hypeUsd != null
    ? Number(fmt(used0)) * hypeUsd + Number(fmt(used1)) * (hypeUsd / Math.max(1e-12, currentPrice.toNumber()))
    : null;

  return {
    ok: errors.length === 0,
    errors, warnings, notes,
    mode: 'simulation-only（未上链、未请求签名）',
    pool: {
      poolId: chain.POOL_ID, fee: FEE_PIPS, tickSpacing: SPACING,
      currentTick, currentPrice: currentPrice.toString(), inRange, belowRange, aboveRange,
      liquidity: poolState.liquidity, protocolFee: poolState.protocolFee,
    },
    range: {
      tickLower: tL, tickUpper: tU,
      priceLower: rangeLower.toString(), priceUpper: rangeUpper.toString(),
      widthPct: Number(widthPct.toFixed(3)),
      priceLowerUsd: hypeUsd != null ? (hypeUsd / rangeLower.toNumber()).toFixed(6) : null,
      priceUpperUsd: hypeUsd != null ? (hypeUsd / rangeUpper.toNumber()).toFixed(6) : null,
    },
    result: {
      liquidity: L.toString(),
      liquidityWithoutSwap: base.L.toString(),
      used0: used0.toString(), used1: used1.toString(),
      used0Human: fmt(used0), used1Human: fmt(used1),
      depositUsd: depositUsd != null ? Number(depositUsd.toFixed(2)) : null,
      expectedTokenId,
      amount0Max: amount0Max.toString(), amount1Max: amount1Max.toString(),
      minLiquidity: minLiquidity.toString(),
      slippageBps,
    },
    swap,
    gas: { ...gas, gasCostHype: fmt(BigInt(gas.value)), note: `${gas.note}（gas 用量估算，实际以钱包显示为准）` },
    allowance, balances,
    dataSources: { poolState: 'StateView(链上)', math: '本地 V4 数学（已用大整数真值校验）', swap: swap ? '本地兑换估算（跨 tick 走位）' : null },
  };
}

/**
 * 撤池模拟
 * @param {{tokenId:string|number, pct?:number, owner?:string, toSingle?:boolean, slippageBps?:number}} input
 */
async function simulateRemove(input) {
  const warnings = []; const errors = []; const notes = [];
  const slippageBps = Math.max(1, Math.min(Number(input.slippageBps) || 100, 5000));
  const pct = Math.max(1, Math.min(Number(input.pct) || 100, 100));
  const age = poolAge();
  if (age.hardWarning) warnings.push(`池龄不足 7 天（约 ${age.ageDays.toFixed(1)} 天）—— 硬性风险提示`);

  const { pool, positions } = await chain.loadPositions([String(input.tokenId)]);
  const p = positions[0];
  if (!p || p.invalid) return { ok: false, errors: ['头寸不存在或已销毁（链上读取失败）'], warnings, notes };
  if (!p.poolMatch) return { ok: false, errors: ['该头寸不属于目标池（KNTQ/HYPE 1%）—— 白名单外，不提供模拟'], warnings, notes };
  const owner = input.owner && /^0x[0-9a-fA-F]{40}$/.test(input.owner) ? input.owner : null;
  if (owner && String(p.ownerOnchain).toLowerCase() !== owner.toLowerCase()) {
    return { ok: false, errors: [`该头寸当前持有人是 ${p.ownerOnchain}，不是 ${owner}`], warnings, notes };
  }
  const L = BigInt(p.liquidity);
  if (L === 0n) {
    notes.push('该头寸流动性已为 0（已撤空）：本模拟只包含待领手续费');
  }
  const Lrm = (L * BigInt(Math.round(pct))) / 100n;
  const sqrtP = BigInt(pool.sqrtPriceX96);
  const sqrtA = v4math.sqrtPriceX96AtTick(p.tickLower);
  const sqrtB = v4math.sqrtPriceX96AtTick(p.tickUpper);
  const out = v4math.amountsForLiquidity(sqrtP, sqrtA, sqrtB, Lrm);
  const remaining = v4math.amountsForLiquidity(sqrtP, sqrtA, sqrtB, L - Lrm);
  const fee0 = BigInt(p.fee0 || '0');
  const fee1 = BigInt(p.fee1 || '0');
  if (p.feeAnomaly) warnings.push('待领费用读取出现异常（feeGrowth 回退），已按 0 处理，请谨慎对待');

  // —— 退出滑点：若要换成单一资产 ——
  let exitSwap = null;
  if (input.toSingle && out.amount1 > 0n) {
    const q = await quoteSwap({ zeroForOne: false, amountIn: out.amount1, poolState: pool }); // KNTQ → HYPE
    if (q) {
      exitSwap = {
        direction: 'KNTQ→HYPE',
        amountIn: out.amount1.toString(), amountInHuman: fmt(out.amount1),
        amountOut: q.amountOut.toString(), amountOutHuman: fmt(q.amountOut),
        feePaid: q.feePaid.toString(),
        priceImpactPct: Number(q.priceImpactPct.toFixed(4)),
        slippagePct: Number(Math.abs(q.priceImpactPct).toFixed(4)),
        partial: q.partial,
      };
      if (q.partial) warnings.push('兑换估算未能完全成交（池内流动性不足），请分批退出');
      if (Math.abs(q.priceImpactPct) > 3) warnings.push(`退出兑换价格影响较大（${q.priceImpactPct.toFixed(2)}%）`);
    }
  }

  // —— Gas 估算（与真实撤池/领费同一编码：DECREASE_LIQUIDITY + TAKE_PAIR）——
  let gas = { value: GAS_STATIC.remove, source: 'static', note: '静态估算' };
  if (owner) {
    try {
      const data = encodeRemoveCalldata({ tokenId: input.tokenId, liquidity: Lrm, amount0Min: 0n, amount1Min: 0n, recipient: owner });
      const est = await chain.estimateGas({ to: chain.PM_ADDR, data, from: owner });
      if (est) gas = { value: est, source: 'estimateGas', note: '链上模拟估算（未上链）' };
    } catch (e) {
      gas = { value: GAS_STATIC.remove, source: 'static', note: gasNoteFromError(e) };
    }
  } else {
    gas.note = '未提供钱包地址，使用静态估算';
  }

  // —— 交易后余额 ——
  let balancesAfter = null;
  if (owner) {
    try {
      const w = await chain.loadWallet(owner, []);
      const hype = w.balances.find((b) => b.symbol === 'HYPE');
      const kntq = w.balances.find((b) => b.symbol === 'KNTQ');
      const before0 = hype ? BigInt(hype.raw) : 0n;
      const before1 = kntq ? BigInt(kntq.raw) : 0n;
      const after0 = before0 + out.amount0 + fee0;
      const after1 = before1 + out.amount1 + fee1;
      balancesAfter = {
        before: { hype: before0.toString(), kntq: before1.toString() },
        after: { hype: after0.toString(), kntq: after1.toString() },
        delta: { hype: (out.amount0 + fee0).toString(), kntq: (out.amount1 + fee1).toString() },
      };
    } catch (e) { balancesAfter = { error: String(e.message || e).slice(0, 120) }; }
  }

  let prices = null;
  try { prices = await getPrices(); } catch (e) { /* 忽略 */ }
  const hypeUsd = prices && prices.HYPE ? prices.HYPE.usd : null;
  const currentPrice = v4math.priceFromSqrtX96(sqrtP);
  const kntqUsd = hypeUsd != null ? hypeUsd / Math.max(1e-12, currentPrice.toNumber()) : null;
  const outUsd = hypeUsd != null ? Number(fmt(out.amount0)) * hypeUsd + Number(fmt(out.amount1)) * (kntqUsd || 0) : null;
  const feeUsd = hypeUsd != null ? Number(fmt(fee0)) * hypeUsd + Number(fmt(fee1)) * (kntqUsd || 0) : null;

  return {
    ok: true,
    errors, warnings, notes,
    mode: 'simulation-only（未上链、未请求签名）',
    tokenId: String(input.tokenId),
    owner: p.ownerOnchain,
    position: {
      tickLower: p.tickLower, tickUpper: p.tickUpper,
      inRange: p.inRange, liquidity: p.liquidity,
      closed: p.closed,
      fee0: fee0.toString(), fee1: fee1.toString(),
      fee0Human: fmt(fee0), fee1Human: fmt(fee1),
    },
    remove: {
      pct,
      liquidityRemoved: Lrm.toString(),
      liquidityRemaining: (L - Lrm).toString(),
      amount0: out.amount0.toString(), amount1: out.amount1.toString(),
      amount0Human: fmt(out.amount0), amount1Human: fmt(out.amount1),
      amount0Min: ((out.amount0 * (10000n - BigInt(Math.round(slippageBps)))) / 10000n).toString(),
      amount1Min: ((out.amount1 * (10000n - BigInt(Math.round(slippageBps)))) / 10000n).toString(),
      slippageBps,
      valueUsd: outUsd != null ? Number(outUsd.toFixed(2)) : null,
      remainingPrincipal0: remaining.amount0.toString(),
      remainingPrincipal1: remaining.amount1.toString(),
      willClose: L - Lrm === 0n,
      nftNote: L - Lrm === 0n ? '流动性将归零（NFT 仍保留，需另发 BURN_POSITION 才会销毁）' : 'NFT 保留，仍持有剩余流动性',
    },
    fees: {
      fee0: fee0.toString(), fee1: fee1.toString(),
      fee0Human: fmt(fee0), fee1Human: fmt(fee1),
      valueUsd: feeUsd != null ? Number(feeUsd.toFixed(4)) : null,
      note: '待领手续费需与减仓同一笔交易一起收取（TAKE_PAIR），金额以模拟为准',
    },
    exitSwap,
    gas: { ...gas, gasCostHype: fmt(BigInt(gas.value)) },
    balancesAfter,
    dataSources: { position: 'PositionManager(链上)', fees: 'feeGrowth 数学读取', swap: exitSwap ? '本地兑换估算' : null },
  };
}

module.exports = { simulateMint, simulateRemove, quoteSwap, GAS_STATIC };
