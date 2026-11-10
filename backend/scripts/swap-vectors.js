/**
 * 链上参考向量生成器（M2 / P0-3）
 *
 * 目的：用池子**真实发生的 Swap 事件**回归本地 swapEstimate（跨 tick、手续费逐步取整、双向、极小金额等）。
 * 方法：
 *   1. 取最近 N 个区块的 Swap 事件 + 全量 ModifyLiquidity 事件（构建「每个时点的初始化 tick 净流动性」）
 *   2. 只保留「相邻两笔 Swap 之间没有流动性变化」的样本 → 前一笔的后状态就是后一笔的精确前状态
 *   3. 用前一笔的后状态 + 本笔输入量，跑本地 swapEstimate，与链上真实结果逐项比对
 *      （amountOut / sqrtPriceAfter / tickAfter / liquidityAfter 必须完全一致）
 *   4. 生成 backend/tests/fixtures/swap-vectors.json 供离线回归测试
 *
 * 只读：eth_getLogs / eth_blockNumber。不发送任何交易。
 * 用法：node backend/scripts/swap-vectors.js [区块跨度, 默认 120000]
 */
const fs = require('fs');
const path = require('path');
const { keccak256, toHex, decodeAbiParameters } = require('viem');
const v4math = require('../lib/v4math');

const RPC = process.env.ELYSIUM_RPC || 'https://rpc.elysium.kinetiq.xyz';
const POOLM = '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1';
const POOL_ID = '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac';
const DEPLOY_BLOCK = 256083;
const SWAP_TOPIC = keccak256(toHex('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
const ML_TOPIC = keccak256(toHex('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)'));
const SPAN = Number(process.argv[2] || 120000);

async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(40000),
    });
    const j = await r.json();
    if (j.error) {
      const msg = JSON.stringify(j.error);
      if (/rate limit|429|-32017|too many/i.test(msg)) { await new Promise((s) => setTimeout(s, 800 * (attempt + 1))); continue; }
      if (/limit exceeded|-32005/i.test(msg)) throw new Error('LOG_CAP');
      throw new Error(msg);
    }
    return j.result;
  }
  throw new Error('RPC 重试耗尽');
}

/** 分块取日志（自适应折半规避 1 万条上限） */
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
    block: Number(BigInt(lg.blockNumber)),
    logIndex: Number(BigInt(lg.logIndex)),
    txHash: lg.transactionHash,
    amount0: BigInt(d[off]),
    amount1: BigInt(d[off + 1]),
    sqrtPriceX96: BigInt(d[off + 2]),
    liquidity: BigInt(d[off + 3]),
    tick: Number(d[off + 4]),
    fee: Number(d[off + 5]),
  };
}

function decodeMl(lg) {
  const d = decodeAbiParameters([{ type: 'int24' }, { type: 'int24' }, { type: 'int256' }, { type: 'bytes32' }], lg.data);
  return {
    block: Number(BigInt(lg.blockNumber)),
    logIndex: Number(BigInt(lg.logIndex)),
    tickLower: Number(d[0]), tickUpper: Number(d[1]), delta: BigInt(d[2]),
  };
}

(async () => {
  const t0 = Date.now();
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const start = Math.max(DEPLOY_BLOCK, latest - SPAN);
  console.log(`区块范围: ${start} → ${latest}（跨度 ${latest - start}，约 ${((latest - start) * 0.1 / 60).toFixed(0)} 分钟）`);

  console.log('拉取历史 ModifyLiquidity（构建起始 tick 状态）…');
  const mlBefore = (await getLogs([ML_TOPIC, POOL_ID], DEPLOY_BLOCK, start - 1)).map(decodeMl);
  const netMap = new Map();
  const applyMl = (m) => {
    netMap.set(m.tickLower, (netMap.get(m.tickLower) || 0n) + m.delta);
    netMap.set(m.tickUpper, (netMap.get(m.tickUpper) || 0n) - m.delta);
  };
  mlBefore.forEach(applyMl);
  console.log(`  历史 ML 事件 ${mlBefore.length} 条，初始初始化 tick 数 ${netMap.size}`);

  console.log('拉取区间内 Swap + ModifyLiquidity…');
  const swaps = (await getLogs([SWAP_TOPIC, POOL_ID], start, latest)).map(decodeSwap);
  const mlInRange = (await getLogs([ML_TOPIC, POOL_ID], start, latest)).map(decodeMl);
  console.log(`  区间内 Swap ${swaps.length} 笔 / ML ${mlInRange.length} 条`);

  // 按 (block, logIndex) 归并
  const events = [
    ...mlInRange.map((m) => ({ ...m, kind: 'ml' })),
    ...swaps.map((s) => ({ ...s, kind: 'swap' })),
  ].sort((a, b) => (a.block - b.block) || (a.logIndex - b.logIndex));

  const vectors = [];
  let prevSwap = null; let dirty = false; let skippedDirty = 0; let skippedFee = 0; let dirMismatch = 0;
  let exact = 0; let exactOutCount = 0; let limitCount = 0; const mismatches = [];

  for (const ev of events) {
    if (ev.kind === 'ml') { applyMl(ev); dirty = true; continue; }
    const cur = ev;
    if (cur.fee !== 10000) { skippedFee++; prevSwap = cur; dirty = false; continue; }
    if (prevSwap && !dirty) {
      // V4 Swap 事件金额是「交易者视角」：负数 = 付出（输入），正数 = 收到（输出）
      const zeroForOne = cur.amount0 < 0n;
      const amountIn = zeroForOne ? -cur.amount0 : -cur.amount1; // 输入侧（含手续费）
      const expectedOut = zeroForOne ? cur.amount1 : cur.amount0;
      const dirConsistent = zeroForOne ? cur.sqrtPriceX96 <= prevSwap.sqrtPriceX96 : cur.sqrtPriceX96 >= prevSwap.sqrtPriceX96;
      if (!dirConsistent) dirMismatch++;
      if (dirConsistent && amountIn > 0n && expectedOut > 0n) {
        // 只保留与本笔相关的初始化 tick（±2 个 tickSpacing），保证离线可复现
        const lo = Math.min(prevSwap.tick, cur.tick) - 400;
        const hi = Math.max(prevSwap.tick, cur.tick) + 400;
        const ticks = [...netMap.entries()].filter(([t]) => t >= lo && t <= hi).map(([t, n]) => [t, n.toString()]);
        const tickMap = new Map(ticks.map(([t, n]) => [t, BigInt(n)]));
        const base = { zeroForOne, sqrtPriceX96: prevSwap.sqrtPriceX96, tick: prevSwap.tick, liquidity: prevSwap.liquidity, liquidityNetByTick: tickMap, feePips: cur.fee };
        const matches = (est, checkIn) => est.amountOut === expectedOut
          && est.sqrtPriceAfter === cur.sqrtPriceX96
          && BigInt(est.tickAfter) === BigInt(cur.tick)
          && est.liquidityAfter === cur.liquidity
          && (!checkIn || est.amountIn === amountIn);
        // 依次尝试：exact-in → exact-out → 带限价（路由器设定 sqrtPriceLimitX96 时价格停在限价）
        const estIn = v4math.swapEstimate({ ...base, mode: 'exactIn', amountIn });
        let est = estIn; let mode = 'exactIn'; let limit = null;
        if (!matches(estIn, false)) {
          const estOut = v4math.swapEstimate({ ...base, mode: 'exactOut', amountOut: expectedOut });
          if (matches(estOut, true)) { est = estOut; mode = 'exactOut'; }
          else {
            const lim = cur.sqrtPriceX96;
            const estLimIn = v4math.swapEstimate({ ...base, mode: 'exactIn', amountIn, sqrtPriceLimitX96: lim });
            const estLimOut = v4math.swapEstimate({ ...base, mode: 'exactOut', amountOut: expectedOut, sqrtPriceLimitX96: lim });
            if (matches(estLimIn, true)) { est = estLimIn; mode = 'exactIn+limit'; limit = lim.toString(); }
            else if (matches(estLimOut, true)) { est = estLimOut; mode = 'exactOut+limit'; limit = lim.toString(); }
          }
        }
        const ok = matches(est, mode !== 'exactIn');
        if (ok) {
          exact++;
          if (mode === 'exactOut') exactOutCount++;
          if (mode.includes('limit')) limitCount++;
        } else if (mismatches.length < 12) {
          mismatches.push({
            block: cur.block, zeroForOne,
            amountIn: amountIn.toString(),
            amountOut: { expected: expectedOut.toString(), got: est.amountOut.toString() },
            sqrt: { expected: cur.sqrtPriceX96.toString(), got: est.sqrtPriceAfter.toString() },
            tick: { expected: cur.tick, got: est.tickAfter },
            liquidity: { expected: cur.liquidity.toString(), got: est.liquidityAfter.toString() },
            ticksCrossed: est.ticksCrossed, partial: est.partial,
          });
        }
        vectors.push({
          blockNumber: cur.block, txHash: cur.txHash, zeroForOne, feePips: cur.fee, mode, sqrtPriceLimitX96: limit,
          amountIn: amountIn.toString(),
          amountOut: expectedOut.toString(),
          sqrtPriceX96: prevSwap.sqrtPriceX96.toString(),
          tick: prevSwap.tick,
          liquidity: prevSwap.liquidity.toString(),
          ticks,
          expected: {
            amountOut: expectedOut.toString(),
            sqrtPriceAfter: cur.sqrtPriceX96.toString(),
            tickAfter: cur.tick,
            liquidityAfter: cur.liquidity.toString(),
          },
          meta: { ticksCrossed: est.ticksCrossed, partial: est.partial },
        });
      }
    }
    if (dirty) skippedDirty++;
    prevSwap = cur; dirty = false;
  }

  const stats = {
    generatedAt: new Date().toISOString(),
    rpc: RPC, poolId: POOL_ID,
    blockRange: { from: start, to: latest, span: latest - start },
    swapsSeen: swaps.length,
    mlSeen: mlInRange.length + mlBefore.length,
    vectors: vectors.length,
    exactMatches: exact,
    exactInVectors: vectors.length - exactOutCount - limitCount,
    exactOutVectors: exactOutCount,
    limitTerminatedVectors: limitCount,
    mismatchCount: vectors.length - exact,
    skipped: { liquidityChangedInBetween: skippedDirty, nonTargetFee: skippedFee, directionInconsistent: dirMismatch },
    coverage: {
      zeroForOne: vectors.filter((v) => v.zeroForOne).length,
      oneForZero: vectors.filter((v) => !v.zeroForOne).length,
      crossTick: vectors.filter((v) => v.meta.ticksCrossed > 0).length,
      partial: vectors.filter((v) => v.meta.partial).length,
      tinyAmount: vectors.filter((v) => BigInt(v.amountIn) < 10n ** 15n).length,
    },
  };

  console.log(`\n向量总数 ${vectors.length}：完全一致 ${exact}，不一致 ${vectors.length - exact}（其中 exact-in ${vectors.length - exactOutCount} / exact-out ${exactOutCount}）`);
  console.log(`覆盖：zeroForOne ${stats.coverage.zeroForOne} / oneForZero ${stats.coverage.oneForZero} / 跨 tick ${stats.coverage.crossTick} / partial ${stats.coverage.partial} / 极小金额 ${stats.coverage.tinyAmount}`);
  if (mismatches.length) console.log('前几例不一致：\n' + JSON.stringify(mismatches, null, 1));

  const dir = path.join(__dirname, '..', 'tests', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'swap-vectors.json'), JSON.stringify({ stats, vectors }, null, 1));
  console.log(`\n已写入 backend/tests/fixtures/swap-vectors.json（${((fs.statSync(path.join(dir, 'swap-vectors.json')).size) / 1024).toFixed(1)} KB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
})().catch((e) => { console.error('FATAL', String(e.stack || e).slice(0, 800)); process.exit(1); });
