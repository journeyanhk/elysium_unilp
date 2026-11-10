/**
 * PositionManager 行为级对照（M2）—— Elysium 部署 vs 官方参考部署（ETH / Base）
 *
 * 只读：仅 eth_getCode / eth_call；不发送任何交易。
 * 对照维度：
 *  1) 运行时字节码：体积、元数据（solc 版本）、函数选择器集合（双向差集）
 *  2) 只读行为：同一 calldata 在两边的返回值 / revert 数据（错误选择器）
 *  3) 不变量：permit2() 等只读返回是否与官方一致
 *
 * 输出：控制台摘要 + docs/M2-PM-BEHAVIOR.md（报告）
 * 用法：node backend/scripts/pm-behavior-compare.js
 */
const fs = require('fs');
const path = require('path');
const { encodeFunctionData, parseAbi } = require('viem');

const TARGETS = [
  { name: 'Elysium', rpc: 'https://rpc.elysium.kinetiq.xyz', pm: '0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518', label: 'Elysium PositionManager' },
  { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', pm: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', label: '官方 PositionManager（ETH）' },
  { name: 'Base', rpc: 'https://base-rpc.publicnode.com', pm: '0x7C5f5A4bBd8fD63184577525326123B519429bDc', label: '官方 PositionManager（Base）' },
];

const rpc = async (url, method, params) => {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(25000),
  });
  return r.json();
};

function bytecodeMeta(code) {
  if (!code || code === '0x') return { size: 0 };
  const hex = code.slice(2);
  const metaLen = parseInt(hex.slice(-4), 16) * 2;
  const tail = Buffer.from(hex.slice(-4 - metaLen), 'hex');
  const i = tail.indexOf(Buffer.from('solc'));
  const version = i >= 0 ? `${tail[i + 5]}.${tail[i + 6]}.${tail[i + 7]}` : 'n/a';
  return { size: hex.length / 2, metaLen: metaLen / 2, solc: version };
}

function extractSelectors(code) {
  const hex = code.slice(2);
  const sels = new Set();
  for (let i = 0; i + 16 < hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '63') continue;
    const sel = hex.slice(i + 2, i + 10);
    const window = hex.slice(i + 10, i + 24);
    if (window.includes('14') && window.includes('57')) sels.add('0x' + sel);
  }
  return sels;
}

const PROBES = [
  { name: 'ownerOf(不存在)', data: () => encodeFunctionData({ abi: parseAbi(['function ownerOf(uint256) view returns (address)']), functionName: 'ownerOf', args: [999999999999n] }) },
  { name: 'getPoolAndPositionInfo(不存在)', data: () => encodeFunctionData({ abi: parseAbi(['function getPoolAndPositionInfo(uint256) view returns (bytes)']), functionName: 'getPoolAndPositionInfo', args: [999999999999n] }) },
  { name: 'getPositionLiquidity(不存在)', data: () => encodeFunctionData({ abi: parseAbi(['function getPositionLiquidity(uint256) view returns (uint128)']), functionName: 'getPositionLiquidity', args: [999999999999n] }) },
  { name: 'nextTokenId()', data: () => encodeFunctionData({ abi: parseAbi(['function nextTokenId() view returns (uint256)']), functionName: 'nextTokenId' }) },
  { name: 'permit2()', data: () => encodeFunctionData({ abi: parseAbi(['function permit2() view returns (address)']), functionName: 'permit2' }) },
  { name: 'poolManager()', data: () => encodeFunctionData({ abi: parseAbi(['function poolManager() view returns (address)']), functionName: 'poolManager' }) },
  { name: 'modifyLiquidities(空 actions)', data: () => encodeFunctionData({ abi: parseAbi(['function modifyLiquidities(bytes,uint256)']), functionName: 'modifyLiquidities', args: ['0x', 2000000000n] }) },
  { name: 'modifyLiquidities(未知 action)', data: () => encodeFunctionData({ abi: parseAbi(['function modifyLiquidities(bytes,uint256)']), functionName: 'modifyLiquidities', args: ['0xffff', 2000000000n] }) },
  { name: 'multicall(bytes[])', data: () => encodeFunctionData({ abi: parseAbi(['function multicall(bytes[] data) returns (bytes[])']), functionName: 'multicall', args: [['0x']] }) },
];

async function callProbe(target, data) {
  const r = await rpc(target.rpc, 'eth_call', [{ to: target.pm, data, from: '0x0000000000000000000000000000000000000001' }, 'latest']);
  if (r.error) {
    const d = r.error.data || '0x';
    return { outcome: 'revert', selector: typeof d === 'string' && d.length >= 10 ? d.slice(0, 10) : d, message: String(r.error.message).slice(0, 80) };
  }
  return { outcome: 'ok', result: r.result, resultLen: (r.result || '').length };
}

(async () => {
  const out = { generatedAt: new Date().toISOString(), targets: [], selectors: {}, probes: [], invariants: [] };

  for (const t of TARGETS) {
    const code = (await rpc(t.rpc, 'eth_getCode', [t.pm, 'latest'])).result;
    const meta = bytecodeMeta(code);
    const sels = extractSelectors(code);
    out.targets.push({ ...t, ...meta, selectorCount: sels.size });
    out.selectors[t.name] = sels;
    t._sels = sels;
    console.log(`[code] ${t.name}: size=${meta.size} solc=${meta.solc} selectors=${sels.size}`);
  }

  const ely = out.selectors.Elysium;
  for (const other of ['Ethereum', 'Base']) {
    const o = out.selectors[other];
    if (!o) continue;
    const onlyEly = [...ely].filter((s) => !o.has(s));
    const onlyOther = [...o].filter((s) => !ely.has(s));
    out[`diff_Elysium_vs_${other}`] = { onlyElysium: onlyEly, onlyOther, common: [...ely].filter((s) => o.has(s)).length };
    console.log(`[diff] vs ${other}: 共有 ${[...ely].filter((s) => o.has(s)).length} | 仅 Elysium ${onlyEly.length} | 仅 ${other} ${onlyOther.length}`);
  }

  for (const p of PROBES) {
    const row = { name: p.name, results: {} };
    for (const t of TARGETS) {
      try { row.results[t.name] = await callProbe(t, p.data()); }
      catch (e) { row.results[t.name] = { outcome: 'error', message: String(e.message).slice(0, 80) }; }
    }
    out.probes.push(row);
    const fmt = (r) => r.outcome === 'ok' ? `ok(${r.result ? r.result.slice(0, 12) + '…' : 'empty'})` : `revert(${r.selector || '0x'})`;
    console.log(`[probe] ${p.name}: ${TARGETS.map((t) => `${t.name}=${fmt(row.results[t.name])}`).join(' | ')}`);
  }

  // 不变量：permit2() 返回一致
  const p2 = out.probes.find((x) => x.name === 'permit2()');
  if (p2) {
    const vals = Object.entries(p2.results).map(([k, v]) => [k, v.result]);
    const uniq = new Set(vals.map(([, v]) => (v || '').toLowerCase()));
    out.invariants.push({
      name: 'permit2() 返回值一致（三链）',
      pass: uniq.size === 1,
      values: Object.fromEntries(vals),
    });
    console.log('[invariant] permit2():', JSON.stringify(out.invariants[out.invariants.length - 1]));
  }

  // 写报告
  const md = [];
  md.push('# M2 — PositionManager 行为级对照报告');
  md.push('');
  md.push(`生成时间：${out.generatedAt}`);
  md.push('');
  md.push('> 本报告只做只读对照（eth_getCode / eth_call），不发送任何交易；结论用于决定 PositionManager 是否可以从「仅只读」推进到 M3 写操作评估。');
  md.push('');
  md.push('## 1. 字节码对照');
  md.push('');
  md.push('| 部署 | 地址 | 体积(B) | solc | 元数据(B) | 选择器数 |');
  md.push('|---|---|---|---|---|---|');
  for (const t of out.targets) md.push(`| ${t.label} | \`${t.pm}\` | ${t.size} | ${t.solc} | ${t.metaLen} | ${t.selectorCount} |`);
  md.push('');
  md.push('## 2. 函数选择器集合差集');
  md.push('');
  for (const other of ['Ethereum', 'Base']) {
    const d = out[`diff_Elysium_vs_${other}`];
    if (!d) continue;
    md.push(`**Elysium vs ${other}**：共有 ${d.common}，仅 Elysium ${d.onlyElysium.length}，仅 ${other} ${d.onlyOther.length}`);
    if (d.onlyElysium.length) md.push(`- 仅 Elysium 有：\`${d.onlyElysium.join('`, `')}\``);
    if (d.onlyOther.length) md.push(`- 仅 ${other} 有：\`${d.onlyOther.join('`, `')}\``);
    md.push('');
  }
  md.push('## 3. 只读行为对照（同一 calldata）');
  md.push('');
  md.push('| 调用 | Elysium | Ethereum | Base |');
  md.push('|---|---|---|---|');
  for (const p of out.probes) {
    const cell = (r) => r.outcome === 'ok'
      ? `ok \`${r.result ? r.result.slice(0, 18) : ''}…\``
      : `revert \`${r.selector || '0x'}\``;
    md.push(`| ${p.name} | ${cell(p.results.Elysium)} | ${cell(p.results.Ethereum)} | ${cell(p.results.Base)} |`);
  }
  md.push('');
  md.push('## 4. 不变量');
  md.push('');
  for (const inv of out.invariants) md.push(`- ${inv.pass ? '✅' : '❌'} ${inv.name}：\`${JSON.stringify(inv.values)}\``);
  md.push('');
  md.push('## 5. 结论与边界');
  md.push('');
  md.push('- 选择器集合与只读行为（含 revert 错误选择器）用于判断「接口面 + 错误语义」是否一致；');
  md.push('- **体积差异与内部实现（存储布局、事件发射顺序、gas 消耗）仍无法通过只读手段完全证明等价**；');
  md.push('- 因此 PositionManager 在 M3 前保持 `pending-official` + `writeEnabled=false`；');
  md.push('- M3 首次真实操作仍需：小额、手动签名、单步确认、可撤销、保留滑点上限与失败保护。');
  md.push('');
  md.push('## 附录：原始数据（JSON）');
  md.push('');
  md.push('```json');
  md.push(JSON.stringify({
    targets: out.targets.map((t) => ({ name: t.name, pm: t.pm, size: t.size, solc: t.solc, selectorCount: t.selectorCount })),
    diffs: { vsEthereum: out.diff_Elysium_vs_Ethereum, vsBase: out.diff_Elysium_vs_Base },
    probes: out.probes,
    invariants: out.invariants,
  }, null, 1));
  md.push('```');

  const outPath = path.join(__dirname, '..', '..', 'docs', 'M2-PM-BEHAVIOR.md');
  fs.writeFileSync(outPath, md.join('\n'));
  console.log('\n报告已写入:', outPath);
})().catch((e) => { console.error('FATAL', String(e.stack || e).slice(0, 500)); process.exit(1); });
