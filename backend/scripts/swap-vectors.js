/**
 * 链上参考向量生成器（M2 / P0-3 第二次修订：消除「自证循环」）
 *
 * 回应 review 的三点要求：
 *   A. **不再由本地模型反选模式**。优先解析真实交易 calldata（Universal Router → V4_SWAP → swap action）：
 *      mode / amountSpecified / 限价语义全部来自 calldata（限价 = 官方 V4Router 固定哨兵值）。
 *   B. 无法解码 calldata 的交易（占多数：自定义路由器）使用**独立参考实现 + 链上可观测值假设检验**：
 *      对同一笔链上 Swap，分别用 exact-in / exact-out 两种假设跑 backend/reference/v4（与生产实现
 *      lib/v4math.js 完全分离的独立移植），要求**恰好一种**假设能同时复现链上全部可观测值
 *      （amountIn、amountOut、sqrtPriceAfter、tickAfter、liquidityAfter），两种都符合（歧义）或都不符合的
 *      样本一律排除并计数。
 *   C. **期望值来自链上**（上述 5 个量全部取自 Swap 事件）；feePaid 在「未跨 tick 且跨区块」的样本上由链上
 *      feeGrowthGlobal 增量反推（ceil(Δfg×L/2^128)），其余样本标注为独立参考实现推导。
 *      测试强制断言 fixture.validation.independentReference / feePaidChecked，且不依赖 mismatchCount 自证。
 *
 * 本脚本**不得**加载生产实现 lib/v4math.js（末尾有运行时断言；元数据记录 productionCodeUsedInGeneration=false）。
 * 只读：eth_getLogs / eth_call / eth_getTransactionByHash。不发送任何交易。
 *
 * 用法：node backend/scripts/swap-vectors.js [区块跨度, 默认 0 = 池创建至今]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execSync } = require('child_process');
const { keccak256, toHex, encodeFunctionData, decodeAbiParameters } = require('viem');

const TickMath = require('../reference/v4/tickmath');
const RefSwap = require('../reference/v4/pool-swap');
const Router = require('../reference/v4/router');

const RPC = process.env.ELYSIUM_RPC || 'https://rpc.elysium.kinetiq.xyz';
const POOLM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1';
const STATEVIEW = '0x27ed73ae0652fdcf71d6793412a7525f32be9dfe';
const POOL_ID = '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac';
const POOL_KEY = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0xe45a355d9e9cAd2aD85F2D03E3eE3102A036acF0',
  fee: 10000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000',
};
// 池子历史起点：以 PositionManager 部署块为下界（该池最早的 ModifyLiquidity 事件在块 458201，
// 早于此前误用的 3077585，导致 tick 表不完整 → 跨 tick 样本全部无法复现。此处取部署块作为安全下界。）
const HISTORY_START = 256083;
const SPAN = Number(process.argv[2] || 0);
const Q128 = 1n << 128n;
const TICK_MARGIN = 400;
const MAX_VECTORS = 3000;      // 上限（超出时按等距抽样，保证区块分布均匀）
const MAX_TX_FETCH = 2500;     // calldata 解析（方案 A）最多取多少笔交易

const SWAP_TOPIC = keccak256(toHex('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
const ML_TOPIC = keccak256(toHex('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json();
      if (j.error) {
        const msg = JSON.stringify(j.error);
        if (/rate limit|429|-32017|too many/i.test(msg)) { await new Promise((s) => setTimeout(s, 900 * (attempt + 1))); continue; }
        if (/limit exceeded|-32005/i.test(msg)) throw new Error('LOG_CAP');
        throw new Error(msg);
      }
      return j.result;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((s) => setTimeout(s, 900 * (attempt + 1)));
    }
  }
  throw new Error('RPC 重试耗尽');
}

/** JSON-RPC 批量（小批量 + 退避，规避公共端点限流） */
async function batchRpc(requests, chunk = 20) {
  const out = [];
  for (let i = 0; i < requests.length; i += chunk) {
    const part = requests.slice(i, i + chunk).map((r, k) => ({ jsonrpc: '2.0', id: k, method: r.method, params: r.params }));
    let res = null;
    for (let attempt = 0; attempt < 4 && !res; attempt++) {
      try {
        const r = await fetch(RPC, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(part), signal: AbortSignal.timeout(60000),
        });
        const j = await r.json();
        const arr = Array.isArray(j) ? j : [j];
        if (arr.length === 1 && arr[0].error && /rate|429|-32017/i.test(JSON.stringify(arr[0].error))) throw new Error('rate');
        res = arr.sort((a, b) => a.id - b.id).map((x) => (x.error ? { error: x.error } : x.result));
      } catch (e) {
        await new Promise((s) => setTimeout(s, 1200 * (attempt + 1)));
      }
    }
    if (!res) res = new Array(part.length).fill(null);
    out.push(...res);
    await new Promise((s) => setTimeout(s, 120));
  }
  return out;
}

async function getLogs(topics, from, to, out = []) {
  try {
    const logs = await rpc('eth_getLogs', [{ address: POOLM, topics, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    out.push(...logs);
  } catch (e) {
    if (String(e.message).includes('LOG_CAP') && to - from > 10) {
      const mid = from + Math.floor((to - from) / 2);
      await getLogs(topics, from, mid, out);
      await getLogs(topics, mid + 1, to, out);
    } else if (String(e.message).includes('LOG_CAP')) {
      throw new Error(`单块日志超上限 ${from}-${to}`);
    } else { throw e; }
  }
  return out;
}

function decodeSwap(lg) {
  const senderIndexed = lg.topics.length >= 3;
  const types = senderIndexed
    ? [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }]
    : [{ type: 'address' }, { type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }];
  const d = decodeAbiParameters(types, lg.data);
  const off = senderIndexed ? 0 : 1;
  return {
    block: Number(BigInt(lg.blockNumber)), logIndex: Number(BigInt(lg.logIndex)), txHash: lg.transactionHash,
    amount0: BigInt(d[off]), amount1: BigInt(d[off + 1]), sqrtPriceX96: BigInt(d[off + 2]),
    liquidity: BigInt(d[off + 3]), tick: Number(d[off + 4]), fee: Number(d[off + 5]),
  };
}

function decodeMl(lg) {
  const d = decodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], lg.data);
  return { block: Number(BigInt(lg.blockNumber)), logIndex: Number(BigInt(lg.logIndex)), tickLower: Number(d[0]), tickUpper: Number(d[1]), delta: BigInt(d[2]) };
}

/** 由 feeGrowthGlobal 增量反推手续费（仅当未跨 tick、流动性恒定、协议费 0 时精确） */
function feeFromGrowth(deltaFg, liquidity) {
  if (deltaFg <= 0n) return 0n;
  const num = deltaFg * liquidity;
  const q = num / Q128;
  return num % Q128 === 0n ? q : q + 1n;
}

/** 用独立参考实现跑一次假设（返回与链上可观测值的一致性） */
function runHypothesis(c, mode, amount, limit) {
  const ref = RefSwap.swap({
    zeroForOne: c.zeroForOne, mode, amount,
    sqrtPriceX96: c.prev.sqrtPriceX96, tick: c.prev.tick, liquidity: c.prev.liquidity,
    liquidityNetByTick: c.tickMap, feePips: c.cur.fee, sqrtPriceLimitX96: limit,
  });
  const chainOk = ref.sqrtPriceAfter === c.cur.sqrtPriceX96
    && BigInt(ref.tickAfter) === BigInt(c.cur.tick)
    && ref.liquidityAfter === c.cur.liquidity;
  return { ref, chainOk };
}

(async () => {
  const t0 = Date.now();
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const start = SPAN > 0 ? Math.max(latest - SPAN, HISTORY_START) : HISTORY_START;
  console.log(`区块范围: ${start} → ${latest}（跨度 ${latest - start}）`);

  console.log('拉取历史 ModifyLiquidity…');
  const mlBefore = (await getLogs([ML_TOPIC, POOL_ID], HISTORY_START, start - 1)).map(decodeMl);
  const netMap = new Map();
  const applyMl = (m) => {
    netMap.set(m.tickLower, (netMap.get(m.tickLower) || 0n) + m.delta);
    netMap.set(m.tickUpper, (netMap.get(m.tickUpper) || 0n) - m.delta);
  };
  mlBefore.forEach(applyMl);
  console.log(`  历史 ML ${mlBefore.length} 条，初始 tick 数 ${netMap.size}`);

  const swaps = (await getLogs([SWAP_TOPIC, POOL_ID], start, latest)).map(decodeSwap);
  const mlInRange = (await getLogs([ML_TOPIC, POOL_ID], start, latest)).map(decodeMl);
  console.log(`  区间内 Swap ${swaps.length} 笔 / ML ${mlInRange.length} 条`);

  const events = [
    ...mlInRange.map((m) => ({ ...m, kind: 'ml' })),
    ...swaps.map((s) => ({ ...s, kind: 'swap' })),
  ].sort((a, b) => (a.block - b.block) || (a.logIndex - b.logIndex));

  // —— 阶段 1：构造候选 ——
  const skip = { liquidityChangedInBetween: 0, nonTargetFee: 0, directionInconsistent: 0, sameBlockSwaps: 0 };
  const candidates = [];
  const swapsPerTx = new Map();
  for (const s of swaps) swapsPerTx.set(s.txHash, (swapsPerTx.get(s.txHash) || 0) + 1);
  const firstSwapOfBlock = new Map(); const lastSwapOfBlock = new Map();
  for (const s of swaps) {
    if (!firstSwapOfBlock.has(s.block)) firstSwapOfBlock.set(s.block, s.logIndex);
    lastSwapOfBlock.set(s.block, s.logIndex);
  }
  let prevSwap = null; let dirty = false;
  for (const ev of events) {
    if (ev.kind === 'ml') { applyMl(ev); dirty = true; continue; }
    const cur = ev;
    if (cur.fee !== 10000) { skip.nonTargetFee++; prevSwap = cur; dirty = false; continue; }
    if (prevSwap && !dirty) {
      const zeroForOne = cur.amount0 < 0n;
      const amountIn = zeroForOne ? -cur.amount0 : -cur.amount1;
      const amountOut = zeroForOne ? cur.amount1 : cur.amount0;
      const dirConsistent = zeroForOne ? cur.sqrtPriceX96 <= prevSwap.sqrtPriceX96 : cur.sqrtPriceX96 >= prevSwap.sqrtPriceX96;
      if (!dirConsistent) skip.directionInconsistent++;
      else if (amountIn > 0n && amountOut > 0n) {
        if (cur.block === prevSwap.block) skip.sameBlockSwaps++;
        const lo = Math.min(prevSwap.tick, cur.tick) - TICK_MARGIN;
        const hi = Math.max(prevSwap.tick, cur.tick) + TICK_MARGIN;
        const ticks = [...netMap.entries()].filter(([t]) => t >= lo && t <= hi).map(([t, n]) => [t, n.toString()]);
        candidates.push({
          prev: prevSwap, cur, zeroForOne, amountIn, amountOut,
          tickMap: new Map(ticks.map(([t, n]) => [t, BigInt(n)])), ticks, ticksRange: [lo, hi],
        });
      }
    }
    if (dirty) skip.liquidityChangedInBetween++;
    prevSwap = cur; dirty = false;
  }
  console.log(`候选（相邻 Swap 且中间无 ML）: ${candidates.length}`);

  // —— 阶段 2（方案 A）：抽样解析真实 calldata ——
  const txStride = Math.max(1, Math.ceil(candidates.length / MAX_TX_FETCH));
  const toFetch = candidates.filter((_, i) => i % txStride === 0);
  console.log(`方案 A：解析 calldata（抽样 ${toFetch.length} 笔交易，步长 ${txStride}）…`);
  const txHashes = [...new Set(toFetch.map((c) => c.cur.txHash))];
  const txRes = await batchRpc(txHashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
  const txByHash = new Map();
  txHashes.forEach((h, i) => txByHash.set(h, txRes[i]));
  const txFetchFailed = [...txByHash.values()].filter((t) => !t || t.error).length;

  const reasonCounts = {};
  const reasonExamples = [];
  const decodedByKey = new Map(); // block:logIndex → 解码结果
  for (const c of toFetch) {
    const tx = txByHash.get(c.cur.txHash);
    if (!tx || tx.error) continue;
    const dec = Router.decodeRouterSwap(tx.input, POOL_KEY);
    if (!dec.ok) {
      const rawReason = String(dec.reason);
      const rk = rawReason.includes('multi-hop') ? 'multi-hop-path' : rawReason.split('(')[0].split(':')[0];
      reasonCounts[rk] = (reasonCounts[rk] || 0) + 1;
      if (rk === 'swap-params-decode-failed' && reasonExamples.length < 3) reasonExamples.push({ txHash: c.cur.txHash, to: tx.to, reason: dec.reason });
      continue;
    }
    if (dec.zeroForOne !== c.zeroForOne) { reasonCounts.directionMismatch = (reasonCounts.directionMismatch || 0) + 1; continue; }
    const expect = dec.mode === 'exactIn' ? c.amountIn : c.amountOut;
    if (dec.amount !== expect) { reasonCounts.amountMismatch = (reasonCounts.amountMismatch || 0) + 1; continue; }
    decodedByKey.set(`${c.cur.block}:${c.cur.logIndex}`, { dec, txFrom: tx.from, slippageLimit: dec.slippageLimit });
  }
  const decodedCount = decodedByKey.size;
  console.log(`  解码成功 ${decodedCount} 笔（失败分类：${JSON.stringify(reasonCounts)}；取交易失败 ${txFetchFailed}）`);

  // —— 阶段 3：逐候选生成向量（方案 A 优先；否则方案 B 假设检验）——
  const vectors = [];
  const excl = {
    calldataUnknownRouter: 0, calldataDecodeFailed: 0, calldataDirectionMismatch: 0, calldataAmountMismatch: 0,
    hypothesisBothMatch: 0, hypothesisNeitherMatch: 0, hypothesisLimitSensitive: 0, calldataLimitUnconfirmed: 0, multiSwapInTx: 0,
    productionIndependent: 0,
  };
  let feeChainChecks = { checked: 0, exact: 0, failed: 0 };
  const feeChainFailedExamples = [];
  const hypothesisFailExamples = [];
  let ambiguousExamples = 0;

  const kept = [];
  for (const c of candidates) {
    if ((swapsPerTx.get(c.cur.txHash) || 0) > 1) { excl.multiSwapInTx++; continue; }
    const key = `${c.cur.block}:${c.cur.logIndex}`;
    const decoded = decodedByKey.get(key);
    const sentinel = Router.routerSentinelLimit(c.zeroForOne);
    let mode; let amount; let limit; let source;

    if (decoded) {
      mode = decoded.dec.mode;
      amount = decoded.dec.amount;
      limit = sentinel;
      source = { modeSource: 'transaction-calldata', decodedFromCalldata: true, router: decoded.dec.router, action: decoded.dec.actionName, layout: decoded.dec.layout, amountSpecified: amount.toString(), sentinelLimit: sentinel.toString() };
    } else {
      // 方案 B：两种模式假设，要求恰好一种能复现链上全部可观测值
      let inHyp; let outHyp;
      try {
        inHyp = runHypothesis(c, 'exactIn', c.amountIn, sentinel);
        outHyp = runHypothesis(c, 'exactOut', c.amountOut, sentinel);
      } catch (e) { excl.productionIndependent++; continue; }
      const inOk = inHyp.chainOk && inHyp.ref.amountOut === c.amountOut;
      const outOk = outHyp.chainOk && outHyp.ref.amountIn === c.amountIn;
      if (inOk && outOk) { excl.hypothesisBothMatch++; ambiguousExamples++; continue; }
      if (!inOk && !outOk) {
        excl.hypothesisNeitherMatch++;
        if (hypothesisFailExamples.length < 3) hypothesisFailExamples.push({ block: c.cur.block, amountIn: c.amountIn.toString(), amountOut: c.amountOut.toString() });
        continue;
      }
      if (inOk) { mode = 'exactIn'; amount = c.amountIn; } else { mode = 'exactOut'; amount = c.amountOut; }
      limit = sentinel;
      source = {
        modeSource: 'chain-observable-hypothesis-test',
        exclusive: true,
        decodedFromCalldata: false,
        hypothesis: { exactInMatches: inOk, exactOutMatches: outOk },
        amountSpecified: amount.toString(),
      };
    }

    // 限价不敏感检查：以「结束价」作为限价重算，结果必须完全相同（否则该样本存在限价歧义）
    const altLimit = decoded
      ? Router.slippageDerivedLimit({ mode, zeroForOne: c.zeroForOne, slippageLimit: decoded.slippageLimit, sqrtPriceX96: c.prev.sqrtPriceX96, liquidity: c.prev.liquidity })
      : c.cur.sqrtPriceX96;
    let ref; let refAlt; // eslint-disable-line prefer-const
    try {
      ref = RefSwap.swap({ zeroForOne: c.zeroForOne, mode, amount, sqrtPriceX96: c.prev.sqrtPriceX96, tick: c.prev.tick, liquidity: c.prev.liquidity, liquidityNetByTick: c.tickMap, feePips: c.cur.fee, sqrtPriceLimitX96: limit });
      refAlt = RefSwap.swap({ zeroForOne: c.zeroForOne, mode, amount, sqrtPriceX96: c.prev.sqrtPriceX96, tick: c.prev.tick, liquidity: c.prev.liquidity, liquidityNetByTick: c.tickMap, feePips: c.cur.fee, sqrtPriceLimitX96: altLimit });
    } catch (e) { excl.productionIndependent++; continue; }
    const eq = (a, b) => a.amountIn === b.amountIn && a.amountOut === b.amountOut && a.feePaid === b.feePaid
      && a.sqrtPriceAfter === b.sqrtPriceAfter && BigInt(a.tickAfter) === BigInt(b.tickAfter) && a.liquidityAfter === b.liquidityAfter;
    const limitInsensitive = eq(ref, refAlt);

    // 与链上事件比对（期望值全部来自链上事件）
    const matchesChain = (r) => r.amountIn === c.amountIn && r.amountOut === c.amountOut
      && r.sqrtPriceAfter === c.cur.sqrtPriceX96 && BigInt(r.tickAfter) === BigInt(c.cur.tick) && r.liquidityAfter === c.cur.liquidity;

    if (decoded) {
      // 方案 A：模式来自 calldata；限价语义用链上结果确认（哨兵 / 滑点推导），两者都不符合则排除
      const sentOk = matchesChain(ref);
      const altOk = matchesChain(refAlt);
      if (!sentOk && !altOk) { excl.calldataLimitUnconfirmed++; continue; }
      source.limitConfirmedBy = sentOk && altOk ? 'insensitive' : (sentOk ? 'chain-match-sentinel' : 'chain-match-slippage-derived');
      source.limitInsensitive = Boolean(sentOk && altOk);
      if (!sentOk && altOk) { const t = ref; ref = refAlt; refAlt = t; }
    } else {
      if (!limitInsensitive) { excl.hypothesisLimitSensitive++; continue; }
      if (!matchesChain(ref)) { excl.productionIndependent++; continue; }
    }

    kept.push({ c, mode, amount, limit, altLimit, source, ref });
  }
  console.log(`通过假设/解码校验的样本: ${kept.length}`);

  // —— 阶段 4：等距抽样 + 链上 feePaid 二次校验（仅未跨 tick 且跨区块的样本）——
  // 链上反推条件：跨区块、区间内流动性不变、且 cur 是其区块最后一笔 Swap
  // （feeGrowthGlobal 只在区块末读取，若同块还有后续 Swap，其手续费会一并计入 Δfg）
  const feeOk = (k) => k.c.cur.block > k.c.prev.block && k.ref.liquidityAfter === k.c.prev.liquidity
    && lastSwapOfBlock.get(k.c.cur.block) === k.c.cur.logIndex;
  const selected = [];
  const selectedKeys = new Set();
  const addSel = (k) => { const key = `${k.c.cur.block}:${k.c.cur.logIndex}`; if (!selectedKeys.has(key)) { selectedKeys.add(key); selected.push(k); } };
  // (a) calldata 解码样本全部保留（最强证据）
  kept.filter((k) => k.source.modeSource === 'transaction-calldata').forEach(addSel);
  // (b) 可做链上 feePaid 校验的样本优先（最多 400 条）
  const FEE_CHECK_MAX = 300;
  const feeEligible = kept.filter(feeOk);
  const feeStride = Math.max(1, Math.ceil(feeEligible.length / FEE_CHECK_MAX));
  feeEligible.filter((_, i) => i % feeStride === 0).forEach(addSel);
  // (c) 其余等距抽样补足
  const stride = Math.max(1, Math.ceil(kept.length / MAX_VECTORS));
  kept.filter((_, i) => i % stride === 0).forEach((k) => { if (selected.length < MAX_VECTORS) addSel(k); });
  selected.sort((a, b) => (a.c.cur.block - b.c.cur.block) || (a.c.cur.logIndex - b.c.cur.logIndex));
  console.log(`入选向量 ${selected.length}（含 calldata 样本 ${selected.filter((k) => k.source.modeSource === 'transaction-calldata').length}、fee 可链上校验 ${selected.filter(feeOk).length}）`);

  const feeCheckSet = new Set(selected.filter(feeOk));
  const feeBlocks = new Set();
  for (const k of feeCheckSet) { feeBlocks.add(k.c.prev.block); feeBlocks.add(k.c.cur.block); }
  console.log(`读取 feeGrowthGlobal（${feeBlocks.size} 个区块）…`);
  const blockList = [...feeBlocks].sort((a, b) => a - b);
  const fgData = encodeFunctionData({ abi: [{ name: 'getFeeGrowthGlobals', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint256' }, { type: 'uint256' }] }], functionName: 'getFeeGrowthGlobals', args: [POOL_ID] });
  const slot0Data = encodeFunctionData({ abi: [{ name: 'getSlot0', type: 'function', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint160' }, { type: 'int24' }, { type: 'uint24' }, { type: 'uint24' }] }], functionName: 'getSlot0', args: [POOL_ID] });
  const callRes = await batchRpc(blockList.flatMap((b) => ([
    { method: 'eth_call', params: [{ to: STATEVIEW, data: fgData }, '0x' + b.toString(16)] },
    { method: 'eth_call', params: [{ to: STATEVIEW, data: slot0Data }, '0x' + b.toString(16)] },
  ])));
  const fgByBlock = new Map(); const protocolFeeByBlock = new Map();
  blockList.forEach((b, i) => {
    const fgRaw = callRes[i * 2]; const s0Raw = callRes[i * 2 + 1];
    if (typeof fgRaw === 'string' && fgRaw.length >= 130) fgByBlock.set(b, [BigInt('0x' + fgRaw.slice(2, 66)), BigInt('0x' + fgRaw.slice(66, 130))]);
    if (typeof s0Raw === 'string' && s0Raw.length >= 194) protocolFeeByBlock.set(b, Number(BigInt('0x' + s0Raw.slice(130, 194)) & 0xffffffn));
  });

  for (const k of selected) {
    const { c, ref, mode, amount, limit, altLimit, source } = k;
    let feePaidOnchain = null;
    let feePaidOnchainExact = false;
    const sameLiquidity = ref.liquidityAfter === c.prev.liquidity;
    if (sameLiquidity && c.cur.block > c.prev.block && feeCheckSet.has(k)
      && lastSwapOfBlock.get(c.cur.block) === c.cur.logIndex) {
      const fgPrev = fgByBlock.get(c.prev.block); const fgCur = fgByBlock.get(c.cur.block);
      const pf = protocolFeeByBlock.get(c.prev.block);
      if (fgPrev && fgCur && (pf == null || pf === 0)) {
        const dFg = c.zeroForOne ? fgCur[0] - fgPrev[0] : fgCur[1] - fgPrev[1];
        if (dFg >= 0n && dFg < (1n << 255n)) {
          feePaidOnchain = feeFromGrowth(dFg, c.prev.liquidity);
          feeChainChecks.checked++;
          if (feePaidOnchain === ref.feePaid) { feeChainChecks.exact++; feePaidOnchainExact = true; }
          else {
            feeChainChecks.failed++;
            if (feeChainFailedExamples.length < 5) feeChainFailedExamples.push({ block: c.cur.block, chain: feePaidOnchain.toString(), ref: ref.feePaid.toString() });
          }
        }
      }
    }
    vectors.push({
      blockNumber: c.cur.block, txHash: c.cur.txHash, zeroForOne: c.zeroForOne, feePips: c.cur.fee, mode,
      sqrtPriceLimitX96: limit.toString(),
      amountIn: c.amountIn.toString(), amountOut: c.amountOut.toString(),
      sqrtPriceX96: c.prev.sqrtPriceX96.toString(), tick: c.prev.tick, liquidity: c.prev.liquidity.toString(),
      ticks: c.ticks,
      source: { ...source, txHash: c.cur.txHash, blockNumber: c.cur.block, zeroForOne: c.zeroForOne,
        limitInsensitive: source.limitInsensitive !== undefined ? source.limitInsensitive : true,
        altLimitChecked: altLimit.toString() },
      expected: {
        amountIn: c.amountIn.toString(),
        amountOut: c.amountOut.toString(),
        feePaid: (feePaidOnchainExact ? feePaidOnchain : ref.feePaid).toString(),
        feePaidSource: feePaidOnchainExact ? 'onchain-feeGrowthGlobal' : 'independent-reference',
        feePaidOnchain: feePaidOnchain != null ? feePaidOnchain.toString() : null,
        feePaidOnchainExact,
        sqrtPriceAfter: c.cur.sqrtPriceX96.toString(),
        tickAfter: c.cur.tick,
        liquidityAfter: c.cur.liquidity.toString(),
      },
      meta: { ticksCrossed: ref.ticksCrossed, steps: ref.steps, partial: ref.partial, limitReached: ref.limitReached },
    });
  }

  // 生成输入文件（生成器自身 + 独立参考实现）的 SHA-256 清单
function codeHashesOfGenerationInputs() {
  const root = path.join(__dirname, '..');
  const files = [
    'scripts/swap-vectors.js',
    ...fs.readdirSync(path.join(root, 'reference', 'v4')).filter((f) => f.endsWith('.js')).sort().map((f) => `reference/v4/${f}`),
  ];
  const out = {};
  for (const f of files) out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
  return out;
}

// —— 统计（直接按字段计数）——
  const count = (f) => vectors.filter(f).length;
  const stats = {
    generatedAt: new Date().toISOString(),
    generator: 'backend/scripts/swap-vectors.js',
    generatorCommit: (() => { try { return execSync('git rev-parse HEAD', { cwd: path.join(__dirname, '..', '..') }).toString().trim(); } catch { return null; } })(),
    // 代码溯源：生成 fixture 时所用「生成器 + 独立参考实现」的逐文件 SHA-256。
    // 测试会用当前工作树重新计算并比对 —— 一旦参考实现或生成器改动而 fixture 未重新生成，测试即失败。
    codeHashes: codeHashesOfGenerationInputs(),
    generatorCommitDirty: (() => {
      try {
        // 仓库根目录 + 从根目录出发的路径（此前用相对 backend/ 的路径，git 不匹配 → 永远返回 false）
        const root = path.join(__dirname, '..', '..');
        const out = execSync('git status --porcelain -- backend/scripts/swap-vectors.js backend/reference', { cwd: root }).toString().trim();
        return out.length > 0;
      } catch { return null; }
    })(),
    rpc: RPC, poolId: POOL_ID, poolManager: POOLM,
    blockRange: { from: start, to: latest, span: latest - start },
    swapsSeen: swaps.length, mlSeen: mlInRange.length + mlBefore.length,
    candidates: candidates.length,
    vectors: vectors.length,
    exactInVectors: count((v) => v.mode === 'exactIn'),
    exactOutVectors: count((v) => v.mode === 'exactOut'),
    limitTerminatedVectors: count((v) => v.meta.limitReached),
    // 说明：不再使用 mismatchCount 命名（易被误读为「数学不一致」）。
    // excludedCount 表示被排除 / 无法独立验证的样本数，数学不一致单独由 tests 断言。
    excludedCount: excl.productionIndependent,
    byModeSource: {
      transactionCalldata: count((v) => v.source.modeSource === 'transaction-calldata'),
      chainObservableHypothesisTest: count((v) => v.source.modeSource === 'chain-observable-hypothesis-test'),
    },
    // 独立验证来源统计（统一命名，供 review 直接核对）
    validationCounts: {
      calldataDecoded: count((v) => v.source.modeSource === 'transaction-calldata'),
      exclusiveHypothesis: count((v) => v.source.modeSource === 'chain-observable-hypothesis-test'),
      feePaidFromChain: count((v) => v.expected.feePaidSource === 'onchain-feeGrowthGlobal'),
      feePaidFromReference: count((v) => v.expected.feePaidSource === 'independent-reference'),
      crossTick: count((v) => v.meta.ticksCrossed > 0),
      multiStep: count((v) => v.meta.steps > 1),
    },
    excluded: {
      ...excl, ...skip, calldataFailures: reasonCounts, txFetchFailed,
      calldataSampled: toFetch.length, calldataDecoded: decodedCount,
    },
    feePaidOnchainCheck: { ...feeChainChecks, failedExamples: feeChainFailedExamples },
    coverage: {
      zeroForOne: count((v) => v.zeroForOne),
      oneForZero: count((v) => !v.zeroForOne),
      crossTick: count((v) => v.meta.ticksCrossed > 0),
      multiStep: count((v) => v.meta.steps > 1),
      tinyAmount: count((v) => BigInt(v.amountIn) < 10n ** 15n),
      feePaidFromChain: count((v) => v.expected.feePaidSource === 'onchain-feeGrowthGlobal'),
      feePaidFromReference: count((v) => v.expected.feePaidSource === 'independent-reference'),
      exactOutWithAmountInChecked: count((v) => v.mode === 'exactOut'),
    },
    validation: {
      modeSource: 'transaction-calldata (方案A) | exclusive chain-observable hypothesis test (方案B)',
      routerDecoder: 'backend/reference/v4/router.js',
      hypothesisReference: 'backend/reference/v4/pool-swap.js (independent v4-core port)',
      expectedSource: 'on-chain-swap-event',
      feePaidSource: 'onchain-feeGrowthGlobal (exact when no tick crossing) | independent-reference',
      independentReference: true,
      productionCodeUsedInGeneration: false,
      feePaidChecked: true,
      exclusiveHypothesisOnly: true,
      ambiguousSamplesExcluded: true,
      limitInsensitiveOnly: vectors.every((v) => v.source.limitInsensitive === true),
    limitSemanticsChecked: true,
    },
  };
  if (stats.exactInVectors + stats.exactOutVectors !== stats.vectors) throw new Error('mode 计数自检失败');
  if (stats.byModeSource.transactionCalldata + stats.byModeSource.chainObservableHypothesisTest !== stats.vectors) throw new Error('来源计数自检失败');

  const prodLoaded = Object.keys(require.cache).some((k) => k.includes(`lib${path.sep}v4math.js`));
  if (prodLoaded) throw new Error('生成器不得加载生产实现 lib/v4math.js');

  console.log(`\n向量总数 ${vectors.length}：exact-in ${stats.exactInVectors} / exact-out ${stats.exactOutVectors}`);
  console.log(`来源：calldata 解码 ${stats.byModeSource.transactionCalldata} / 链上假设检验 ${stats.byModeSource.chainObservableHypothesisTest}`);
  console.log(`覆盖：zeroForOne ${stats.coverage.zeroForOne} / oneForZero ${stats.coverage.oneForZero} / 跨 tick ${stats.coverage.crossTick} / 多步 ${stats.coverage.multiStep} / 极小金额 ${stats.coverage.tinyAmount}`);
  console.log(`feePaid：链上反推 ${stats.coverage.feePaidFromChain} / 参考实现 ${stats.coverage.feePaidFromReference}（链上校验 ${feeChainChecks.checked} 条：一致 ${feeChainChecks.exact}，不一致 ${feeChainChecks.failed}）`);
  console.log(`排除：${JSON.stringify(stats.excluded)}`);
  if (feeChainFailedExamples.length) console.log('feePaid 链上校验不一致样例：', JSON.stringify(feeChainFailedExamples));
  if (hypothesisFailExamples.length) console.log('假设检验均不匹配样例：', JSON.stringify(hypothesisFailExamples));
  if (reasonExamples.length) console.log('calldata 解码失败样例：', JSON.stringify(reasonExamples));

  const dir = path.join(__dirname, '..', 'tests', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const json = JSON.stringify({ stats, vectors }, null, 1);
  const file = path.join(dir, 'swap-vectors.json');
  fs.writeFileSync(file, json);
  const gz = zlib.gzipSync(Buffer.from(json), { level: 9 });
  fs.writeFileSync(file + '.gz', gz);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(path.join(dir, 'swap-vectors.meta.json'), JSON.stringify({
    fixture: 'swap-vectors.json',
    bytes: fs.statSync(file).size,
    sha256,
    gzipBytes: gz.length,
    gzipSha256: crypto.createHash('sha256').update(gz).digest('hex'),
    generatedAt: stats.generatedAt,
    generatorCommit: stats.generatorCommit,
    generatorCommitDirty: stats.generatorCommitDirty,
    codeHashes: stats.codeHashes,
    validationCounts: stats.validationCounts,
    blockRange: stats.blockRange,
    poolId: POOL_ID,
    poolManager: POOLM,
    vectors: vectors.length,
    byModeSource: stats.byModeSource,
    validation: stats.validation,
    provenanceNotes: [
      'generatorCommit 是生成 fixture 时所用代码的快照（git rev-parse HEAD）；提交 fixture 后 HEAD 会前进，因此不要求它等于最新提交。',
      'codeHashes 是生成时「生成器 + 独立参考实现」逐文件 SHA-256；测试会用当前工作树重算并比对，一旦代码改动而 fixture 未重新生成即失败。',
      'fixture 不是运行测试时动态生成的：测试离线重放已提交的 fixture，不访问 RPC。',
    ],
    regenerate: 'cd backend && node scripts/swap-vectors.js   # 改动生成器或 reference/ 后必须重新生成；CI 默认离线使用本 fixture',
  }, null, 2));
  console.log(`\n已写入 swap-vectors.json（${(fs.statSync(file).size / 1024).toFixed(1)} KB）+ .gz（${(gz.length / 1024).toFixed(1)} KB）`);
  console.log(`sha256 = ${sha256}`);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch((e) => { console.error('FATAL', String(e.stack || e).slice(0, 1200)); process.exit(1); });
