/**
 * PositionManager 只读行为对照（M2 · review P0-2 重写版）
 *
 * 对照对象：Elysium 部署 vs 官方参考部署（Ethereum / Base）
 * 对照维度：
 *  1) 目标地址代码存在性（eth_getCode 非空）+ 代码哈希
 *  2) 函数选择器集合：**以官方已部署合约的 ABI（Sourcify 验证源）为权威集合**，与目标字节码扫描结果双向比对
 *     （字节码 PUSH4 扫描仅作辅助证据，不作为完整 ABI 证明）
 *  3) 只读 Probe：**解码返回值**后按三类断言 —— same-value / same-shape / chain-specific，逐项 pass/fail
 *
 * 只读：仅 eth_getCode / eth_call / eth_blockNumber。不发送任何交易。
 * 用法：node backend/scripts/pm-behavior-compare.js
 */
const fs = require('fs');
const path = require('path');
const {
  encodeFunctionData, decodeAbiParameters, encodeAbiParameters, parseAbi, keccak256,
} = require('viem');
const pmCompare = require('../lib/pm-compare');

const TARGETS = [
  { name: 'Elysium', rpc: 'https://rpc.elysium.kinetiq.xyz', pm: '0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518', label: 'Elysium PositionManager', abiFrom: null },
  { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', pm: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', label: '官方 PositionManager（ETH）', abiFrom: 'sourcify' },
  { name: 'Base', rpc: 'https://base-rpc.publicnode.com', pm: '0x7C5f5A4bBd8fD63184577525326123B519429bDc', label: '官方 PositionManager（Base）', abiFrom: null },
];
// 各链已知 PoolManager（用于 poolManager() 的语义校验；Elysium 取自白名单）
const EXPECTED_POOL_MANAGER = {
  Elysium: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1',
  Ethereum: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  Base: '0x498581ff718922c3f8e6a244956af099b2652b2b',
};
const POOL_KEY_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
  ],
};

const PROBES = [
  { name: 'permit2()', category: 'same-value', sig: 'function permit2() view returns (address)', outputs: [{ type: 'address' }] },
  { name: 'ownerOf(不存在)', category: 'same-shape', sig: 'function ownerOf(uint256) view returns (address)', args: [999999999999n], expectRevert: true },
  { name: 'getPoolAndPositionInfo(不存在)', category: 'chain-specific', expect: 'zero-shape', sig: 'function getPoolAndPositionInfo(uint256) view returns ((address,address,uint24,int24,address), uint256)', args: [999999999999n], outputs: [POOL_KEY_TUPLE, { type: 'uint256' }] },
  { name: 'getPositionLiquidity(不存在)', category: 'chain-specific', expect: 'zero', sig: 'function getPositionLiquidity(uint256) view returns (uint128)', args: [999999999999n], outputs: [{ type: 'uint128' }] },
  { name: 'nextTokenId()', category: 'chain-specific', expect: 'positive', sig: 'function nextTokenId() view returns (uint256)', outputs: [{ type: 'uint256' }] },
  { name: 'poolManager()', category: 'chain-specific', expect: 'has-code', sig: 'function poolManager() view returns (address)', outputs: [{ type: 'address' }] },
  { name: 'modifyLiquidities(空 actions)', category: 'same-shape', expectRevert: true, sig: 'function modifyLiquidities(bytes,uint256)', args: ['0x', 2000000000n] },
  { name: 'modifyLiquidities(未知 action)', category: 'same-shape', expectRevert: true, sig: 'function modifyLiquidities(bytes,uint256)', args: ['0xffff', 2000000000n] },
  { name: 'modifyLiquidities(合法编码/头寸不存在)', category: 'same-shape', expectRevert: true, sig: 'function modifyLiquidities(bytes,uint256)', args: [encodeDecreaseNonexistent(), 2000000000n] },
  { name: 'multicall(bytes[])', category: 'same-shape', expectRevert: true, sig: 'function multicall(bytes[] data) returns (bytes[])', args: [['0x']] },
];

/** DECREASE_LIQUIDITY + TAKE_PAIR 的合法编码（写路径形状探测，仍为只读 eth_call） */
function encodeDecreaseNonexistent() {
  const p1 = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [999999999999n, 1n, 0n, 0n, '0x']);
  const p2 = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000001']);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x0111', [p1, p2]]);
}

const rpc = async (url, method, params) => {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  return r.json();
};

async function fetchOfficialAbi() {
  // 官方 PositionManager（ETH 部署，与目标链同一实现）：Sourcify 验证源
  const r = await fetch('https://sourcify.dev/server/v2/contract/1/0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e?fields=abi', { signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (!j.abi) throw new Error('Sourcify 未返回 ABI');
  return j.abi;
}

function isZeroAddress(a) { return String(a).toLowerCase() === '0x0000000000000000000000000000000000000000'; }

async function runProbe(target, probe) {
  const abi = parseAbi([probe.sig]);
  const fn = probe.sig.match(/function (\w+)/)[1];
  const data = encodeFunctionData({ abi, functionName: fn, args: probe.args || [] });
  const r = await rpc(target.rpc, 'eth_call', [{ to: target.pm, data, from: '0x0000000000000000000000000000000000000001' }, 'latest']);
  if (r.error) {
    const d = r.error.data;
    return {
      outcome: 'revert',
      selector: typeof d === 'string' && d.length >= 10 ? d.slice(0, 10) : (d ? JSON.stringify(d).slice(0, 40) : '0x'),
      reason: String(r.error.message).slice(0, 100),
    };
  }
  // —— 解码返回值（不展示截断的 ABI 原始串）——
  let decoded = null;
  try {
    if (probe.outputs) {
      const vals = decodeAbiParameters(probe.outputs, r.result);
      if (probe.name === 'permit2()') decoded = vals[0];
      else if (probe.name === 'getPositionLiquidity(不存在)') decoded = vals[0].toString();
      else if (probe.name === 'nextTokenId()') decoded = vals[0].toString();
      else if (probe.name === 'poolManager()') {
        const addr = vals[0];
        const code = (await rpc(target.rpc, 'eth_getCode', [addr, 'latest'])).result;
        decoded = { address: addr, hasCode: !!code && code !== '0x' };
      } else if (probe.name === 'getPoolAndPositionInfo(不存在)') {
        const [key, info] = vals;
        // viem 对具名 tuple 可能返回对象或数组，两种都兼容
        const at = (i, n) => (key && key[n] !== undefined && key[n] !== null) ? key[n] : (key ? key[i] : undefined);
        const c0 = at(0, 'currency0'); const c1 = at(1, 'currency1');
        const fee = Number(at(2, 'fee')); const spacing = Number(at(3, 'tickSpacing')); const hooks = at(4, 'hooks');
        decoded = {
          poolKey: { currency0: c0, currency1: c1, fee, tickSpacing: spacing, hooks },
          info: info.toString(),
          isZeroShape: isZeroAddress(c0) && isZeroAddress(c1) && fee === 0 && spacing === 0 && isZeroAddress(hooks) && info === 0n,
        };
      } else decoded = vals.length === 1 ? vals[0] : vals;
    } else {
      decoded = r.result;
    }
    return { outcome: 'ok', decoded, rawLen: (r.result || '').length };
  } catch (e) {
    return { outcome: 'decode-error', reason: String(e.message).slice(0, 120), raw: String(r.result).slice(0, 80) };
  }
}

(async () => {
  const out = { generatedAt: new Date().toISOString(), targets: [], selectorDiffs: {}, probes: [], invariants: [], summary: null };

  // 1) 代码存在性 + 代码哈希 + 官方 ABI
  const officialAbi = await fetchOfficialAbi();
  const authoritative = pmCompare.selectorsFromAbi(officialAbi);
  console.log(`[abi] 官方 PositionManager ABI 函数选择器：${authoritative.size} 个（来源：Sourcify 验证源，ETH 官方部署）`);

  const scannedByChain = {};
  for (const t of TARGETS) {
    const code = (await rpc(t.rpc, 'eth_getCode', [t.pm, 'latest'])).result;
    const hasCode = !!code && code !== '0x';
    const scanned = pmCompare.extractSelectorsFromBytecode(code);
    scannedByChain[t.name] = scanned;
    out.targets.push({ name: t.name, label: t.label, pm: t.pm, hasCode, size: hasCode ? (code.length - 2) / 2 : 0, codeHash: hasCode ? keccak256(code) : null, scannedSelectors: scanned.size });
    console.log(`[code] ${t.name}: hasCode=${hasCode} size=${hasCode ? (code.length - 2) / 2 : 0} scannedSelectors=${scanned.size}`);
  }
  const refScanned = scannedByChain.Ethereum;
  const refMissing = [...authoritative].filter((sel) => !refScanned.has(sel));
  console.log(`[diff] 参考链（Ethereum）自身未扫到官方 ABI 选择器 ${refMissing.length} 个（扫描器/ABI 口径，属基线）`);
  for (const t of TARGETS) {
    out.selectorDiffs[t.name] = pmCompare.compareSelectorSets(authoritative, scannedByChain[t.name], refScanned, refMissing);
    const d = out.selectorDiffs[t.name];
    console.log(`[diff] ${t.name}：官方 ABI ${d.authoritativeCount} 个中扫到 ${d.commonOfficial}（缺失 ${d.missingOfficial.length}，其中参考链也缺 ${d.missingOfficial.length - d.missingNotInReference.length}）| vs 参考链 仅本方 ${d.vsReference.onlyTarget.length} / 仅参考 ${d.vsReference.onlyReference.length} | ${d.ok ? 'PASS' : 'FAIL'}`);
  }

  // 2) 只读 Probe（解码 + 三分类断言）
  const chains = TARGETS.map((t) => t.name);
  for (const probe of PROBES) {
    const resultsByChain = {};
    for (const t of TARGETS) {
      try { resultsByChain[t.name] = await runProbe(t, probe); }
      catch (e) { resultsByChain[t.name] = { outcome: 'error', reason: String(e.message).slice(0, 100) }; }
    }
    const ev = pmCompare.evaluateProbe(probe, resultsByChain, chains, { expectedPoolManager: EXPECTED_POOL_MANAGER });
    out.probes.push(ev);
    const fmt = (r) => r.outcome === 'ok' ? `ok(${typeof r.decoded === 'object' ? JSON.stringify(r.decoded).slice(0, 40) : r.decoded})` : `${r.outcome}(${r.selector || r.reason || ''})`;
    console.log(`[probe] ${probe.pass === false ? '' : ''}${ev.name} [${ev.category}] ${ev.pass ? 'PASS' : 'FAIL'} :: ${chains.map((c) => `${c}=${fmt(ev.rows.find((r) => r.chain === c))}`).join(' | ')}${ev.pass ? '' : ' → ' + ev.reasons.join('; ')}`);
  }

  // 3) 不变量：permit2() 三链一致（same-value 汇总）
  const p2 = out.probes.find((p) => p.name === 'permit2()');
  out.invariants.push({
    name: 'permit2() 三链返回值一致',
    pass: !!p2 && p2.pass,
    values: p2 ? Object.fromEntries(p2.rows.map((r) => [r.chain, r.decoded])) : null,
  });

  out.summary = pmCompare.summarize({
    targets: out.targets, selectorDiffs: out.selectorDiffs, probes: out.probes, invariants: out.invariants,
  });
  console.log('\n[summary]', JSON.stringify(out.summary, null, 1));

  // —— 写报告 ——
  const md = [];
  md.push('# M2 — PositionManager 只读行为对照报告（P0-2 重写版）');
  md.push('');
  md.push(`生成时间：${out.generatedAt}`);
  md.push('');
  md.push('> 只读对照（eth_getCode / eth_call），不发送任何交易。权威选择器集合来自 **官方已部署合约的 ABI（Sourcify 验证源）**；字节码 PUSH4 扫描仅作辅助。');
  md.push('> 结论口径：只读手段只能证明「接口面 + 只读行为 + 错误语义」一致，**不能证明内部实现（存储布局/事件顺序/gas/写路径）等价**。');
  md.push('');
  md.push('## 1. 目标与代码存在性');
  md.push('');
  md.push('| 部署 | 地址 | 有代码 | 体积(B) | 代码哈希 | 扫描到的选择器数 |');
  md.push('|---|---|---|---|---|---|');
  for (const t of out.targets) md.push(`| ${t.label} | \`${t.pm}\` | ${t.hasCode ? '✅' : '❌'} | ${t.size} | \`${t.codeHash ? t.codeHash.slice(0, 18) + '…' : '—'}\` | ${t.scannedSelectors} |`);
  md.push('');
  md.push('## 2. 函数选择器集合（官方 ABI vs 目标字节码）');
  md.push('');
  md.push(`官方 ABI 函数选择器总数：**${authoritative.size}**`);
  md.push('');
  md.push('| 目标 | 官方 ABI 选择器 | 目标扫到其中 | 官方缺失 | 扫描独有(辅助) | vs 参考链差异 | 结论 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const t of TARGETS) {
    const d = out.selectorDiffs[t.name];
    md.push(`| ${t.name} | ${d.authoritativeCount} | ${d.commonOfficial} | ${d.missingOfficial.length}（参考链也缺 ${d.missingOfficial.length - d.missingNotInReference.length}） | ${d.extraScanned.length} | 仅本方 ${d.vsReference.onlyTarget.length} / 仅参考 ${d.vsReference.onlyReference.length} | ${d.ok ? '✅ 一致' : '❌ 不一致'} |`);
  }
  md.push('');
  md.push('> 说明：字节码 PUSH4 扫描是**启发式**（会把内部调用用的选择器常量一并扫出），因此「扫描独有」不是错误；真正的判据是（a）官方 ABI 的每个函数选择器都能在目标字节码中找到，（b）目标与参考链在同一启发式下的扫描差集为空。');
  md.push('');
  for (const t of TARGETS) {
    const d = out.selectorDiffs[t.name];
    if (d.missingOfficial.length) md.push(`- ❌ ${t.name} 缺失官方函数选择器：\`${d.missingOfficial.join('`, `')}\``);
    if (d.vsReference.onlyTarget.length) md.push(`- ${t.name} 相比参考链多出：\`${d.vsReference.onlyTarget.join('`, `')}\``);
    if (d.vsReference.onlyReference.length) md.push(`- ${t.name} 相比参考链缺少：\`${d.vsReference.onlyReference.join('`, `')}\``);
  }
  md.push('');
  md.push('## 3. 只读 Probe（解码后断言，逐项 pass/fail）');
  md.push('');
  md.push('| 探测 | 分类 | 断言 | 结论 | 各链结果（解码值 / revert 选择器） |');
  md.push('|---|---|---|---|---|');
  for (const p of out.probes) {
    const cells = p.rows.map((r) => `${r.chain}: ${r.outcome === 'ok'
      ? (typeof r.decoded === 'object' ? JSON.stringify(r.decoded) : String(r.decoded))
      : `${r.outcome} ${r.selector || ''}`}`).join('<br>');
    md.push(`| ${p.name} | ${p.category} | ${p.expect} | ${p.pass ? '✅ PASS' : '❌ FAIL'} | ${cells} |`);
  }
  md.push('');
  for (const p of out.probes) if (!p.pass) md.push(`- ❌ ${p.name}：${p.reasons.join('；')}`);
  md.push('');
  md.push('## 4. 不变量');
  md.push('');
  for (const i of out.invariants) md.push(`- ${i.pass ? '✅' : '❌'} ${i.name}：\`${JSON.stringify(i.values)}\``);
  md.push('');
  md.push('## 5. 结论（分开陈述，避免过度声明）');
  md.push('');
  md.push(`- 选择器集合一致（官方 ABI 权威集合）：**${out.summary.selectorSetConsistent ? '通过' : '未通过'}**`);
  md.push(`- 错误选择器语义一致（same-shape）：**${out.summary.errorSemanticsConsistent ? '通过' : '未通过'}**`);
  md.push(`- same-value 不变量（permit2 等）：**${out.summary.sameValueInvariantsConsistent ? '通过' : '未通过'}**`);
  md.push(`- chain-specific 只读函数（类型 + 目标关系）：**${out.summary.chainSpecificTargetsValid ? '通过' : '未通过'}**`);
  md.push('- 内部实现等价性：**无法由只读调用证明**（存储布局、事件顺序、gas、写路径状态变更均不在只读证明范围内）');
  md.push('- 因此 PositionManager 在 M3 前保持 `pending-official` + `writeEnabled=false`；写路径（mint/collect/burn）行为仍待 M3 用真实小额交易验证。');
  md.push('');
  md.push('## 附录：原始数据（JSON）');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify({
    targets: out.targets,
    selectorDiffs: Object.fromEntries(Object.entries(out.selectorDiffs).map(([k, v]) => [k, { commonOfficial: v.commonOfficial, missingOfficial: v.missingOfficial, extraScanned: v.extraScanned, vsReference: v.vsReference, ok: v.ok }])),
    probes: out.probes.map((p) => ({ name: p.name, category: p.category, expect: p.expect, pass: p.pass, reasons: p.reasons, rows: p.rows.map((r) => ({ chain: r.chain, outcome: r.outcome, selector: r.selector, decoded: r.decoded, reason: r.reason })) })),
    invariants: out.invariants,
    summary: out.summary,
  }, null, 1));
  md.push('```');

  const outPath = path.join(__dirname, '..', '..', 'docs', 'M2-PM-BEHAVIOR.md');
  fs.writeFileSync(outPath, md.join('\n'));
  console.log('\n报告已写入:', outPath);
})().catch((e) => { console.error('FATAL', String(e.stack || e).slice(0, 600)); process.exit(1); });
