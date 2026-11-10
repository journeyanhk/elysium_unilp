/**
 * PositionManager 对照逻辑（纯函数，便于离线回归测试）。
 *
 * 三类探测（review 要求）：
 *  - same-value    ：各链解码后的返回值必须完全一致（如 permit2()）
 *  - same-shape    ：都 revert 且 revert 错误选择器一致（如 ownerOf 不存在、非法 actions）
 *  - chain-specific：各链返回各自链上的正确目标（地址有代码、默认值为零、数值合法），
 *                    但**不要求跨链数值相等**（如 poolManager()、nextTokenId()）
 *
 * 注意：只读 eth_call 只能证明「接口面 + 只读行为 + 错误语义」一致；
 * 内部实现（存储布局、事件顺序、gas、写路径状态变更）无法由只读手段证明。
 */
const { toFunctionSelector } = require('viem');

/** 从 ABI（JSON 数组）生成函数选择器集合 —— 权威集合 */
function selectorsFromAbi(abi) {
  const set = new Set();
  for (const item of abi || []) {
    if (item.type !== 'function') continue;
    const inputs = (item.inputs || []).map((i) => abiType(i)).join(',');
    set.add(toFunctionSelector(`function ${item.name}(${inputs})`));
  }
  return set;
}

function abiType(param) {
  if (param.type.startsWith('tuple')) {
    const inner = (param.components || []).map((c) => abiType(c)).join(',');
    return `(${inner})${param.type.slice('tuple'.length)}`;
  }
  return param.type;
}

/** 从运行时字节码中提取 PUSH4 选择器（启发式，仅作辅助证据） */
function extractSelectorsFromBytecode(code) {
  const hex = String(code || '').slice(2);
  const set = new Set();
  for (let i = 0; i + 16 < hex.length; i += 2) {
    if (hex.slice(i, i + 2) !== '63') continue;
    const sel = hex.slice(i + 2, i + 10);
    const window = hex.slice(i + 10, i + 24);
    if (window.includes('14') && window.includes('57')) set.add('0x' + sel);
  }
  return set;
}

/**
 * 选择器比对：
 *  - authoritative：官方 ABI（权威）——目标的启发式扫描必须**包含**其中每一个（missingOfficial 必须为空）
 *  - scanned 仅作辅助证据：启发式扫描会把内部调用用的选择器常量也扫进来（extraScanned 属正常，非错误）
 *  - 目标 vs 参考链：两边用同一启发式扫描，差集为空才说明「选择器集合一致」
 */
function compareSelectorSets(authoritative, scanned, referenceScanned = null, referenceMissing = []) {
  const a = authoritative instanceof Set ? authoritative : new Set(authoritative);
  const b = scanned instanceof Set ? scanned : new Set(scanned);
  const refMissing = new Set(referenceMissing || []);
  const missingOfficial = [...a].filter((s) => !b.has(s)); // 官方 ABI 有、目标未扫到
  // 参考链同样缺失的，属扫描器/ABI 口径问题，不算目标链差异
  const missingNotInReference = missingOfficial.filter((s) => !refMissing.has(s));
  const extraScanned = [...b].filter((s) => !a.has(s));
  const vsReference = referenceScanned
    ? {
      onlyTarget: [...b].filter((s) => !referenceScanned.has(s)),
      onlyReference: [...referenceScanned].filter((s) => !b.has(s)),
    }
    : null;
  const refOk = !vsReference || (vsReference.onlyTarget.length === 0 && vsReference.onlyReference.length === 0);
  return {
    authoritativeCount: a.size,
    scannedCount: b.size,
    commonOfficial: [...a].filter((s) => b.has(s)).length,
    missingOfficial,
    missingNotInReference,
    extraScanned,
    vsReference,
    ok: missingNotInReference.length === 0 && refOk,
  };
}

/**
 * 评估单个探测在所有链上的结果。
 * @param {object} spec { name, category, expect?, expectRevert? }
 * @param {Object<string,{outcome:string,decoded?:any,selector?:string,reason?:string}>} resultsByChain
 * @param {string[]} chains 链名顺序（第一个为参考链）
 * @param {object} ctx { expectedPoolManager?: {chain: address} }
 */
function evaluateProbe(spec, resultsByChain, chains, ctx = {}) {
  const rows = chains.map((c) => ({ chain: c, ...(resultsByChain[c] || { outcome: 'missing' }) }));
  const reasons = [];
  let pass = false;

  if (spec.expectRevert) {
    const allRevert = rows.every((r) => r.outcome === 'revert');
    if (!allRevert) reasons.push('存在未 revert 的链（预期都应 revert）');
    const ref = rows[0].selector;
    const sameSelector = rows.every((r) => r.selector === ref);
    if (!sameSelector) reasons.push(`revert 选择器不一致：${rows.map((r) => `${r.chain}=${r.selector || '—'}`).join(' ')}`);
    pass = allRevert && sameSelector;
  } else if (spec.category === 'same-value') {
    const allOk = rows.every((r) => r.outcome === 'ok');
    if (!allOk) reasons.push('存在调用失败的链');
    const norm = rows.map((r) => String(r.decoded).toLowerCase());
    const same = norm.every((v) => v === norm[0]);
    if (!same) reasons.push(`返回值不一致：${rows.map((r) => `${r.chain}=${r.decoded}`).join(' ')}`);
    pass = allOk && same;
  } else {
    // chain-specific：各链返回各自链上的正确目标
    const allOk = rows.every((r) => r.outcome === 'ok');
    if (!allOk) reasons.push('存在调用失败的链');
    if (spec.expect === 'zero') {
      const zeros = rows.every((r) => String(r.decoded) === '0');
      if (!zeros) reasons.push(`不存在的 token 应返回 0：${rows.map((r) => `${r.chain}=${r.decoded}`).join(' ')}`);
      pass = allOk && zeros;
    } else if (spec.expect === 'zero-shape') {
      const zeros = rows.every((r) => r.decoded && r.decoded.isZeroShape === true);
      if (!zeros) reasons.push('不存在的 token 应返回全零 PoolKey/PositionInfo');
      pass = allOk && zeros;
    } else if (spec.expect === 'positive') {
      const pos = rows.every((r) => typeof r.decoded === 'string' && r.decoded !== '0');
      if (!pos) reasons.push('nextTokenId 应为正数');
      pass = allOk && pos;
    } else if (spec.expect === 'has-code') {
      const ok = rows.every((r) => r.decoded && r.decoded.hasCode === true);
      if (!ok) reasons.push('返回地址在对应链上无代码');
      const uniq = new Set(rows.map((r) => String(r.decoded && r.decoded.address).toLowerCase()));
      if (uniq.size !== rows.length) reasons.push('chain-specific 地址在不同链上相同（异常）');
      if (ctx.expectedPoolManager && ctx.expectedPoolManager[rows[0].chain]) {
        const want = String(ctx.expectedPoolManager[rows[0].chain]).toLowerCase();
        const got = String(rows[0].decoded && rows[0].decoded.address).toLowerCase();
        if (got !== want) reasons.push(`${rows[0].chain} poolManager() 与白名单 PoolManager 不一致（got ${got}）`);
      }
      pass = allOk && ok && uniq.size === rows.length
        && !(ctx.expectedPoolManager && ctx.expectedPoolManager[rows[0].chain]
          && String(rows[0].decoded.address).toLowerCase() !== String(ctx.expectedPoolManager[rows[0].chain]).toLowerCase());
    } else {
      pass = allOk;
      if (!pass) reasons.push('未通过链特有语义检查');
    }
  }

  return { name: spec.name, category: spec.category, expect: spec.expect || (spec.expectRevert ? 'revert' : 'equal'), pass, reasons, rows };
}

/** 汇总所有探测 + 选择器比对 → 报告数据 */
function summarize({ targets, selectorDiffs, probes, invariants }) {
  const selectorOk = Object.values(selectorDiffs).every((d) => d.ok);
  const probesOk = probes.every((p) => p.pass);
  const invariantsOk = invariants.every((i) => i.pass);
  return {
    selectorSetConsistent: selectorOk,
    errorSemanticsConsistent: probes.filter((p) => p.category === 'same-shape').every((p) => p.pass),
    sameValueInvariantsConsistent: invariantsOk && probes.filter((p) => p.category === 'same-value').every((p) => p.pass),
    chainSpecificTargetsValid: probes.filter((p) => p.category === 'chain-specific').every((p) => p.pass),
    allProbesPass: probesOk,
    internalEquivalenceProven: false,
    note: '只读对照只能证明接口面、只读行为与错误语义一致；内部实现等价性与写路径状态变更无法由只读手段证明',
    targetsWithCode: targets.every((t) => t.hasCode),
  };
}

module.exports = {
  selectorsFromAbi, extractSelectorsFromBytecode, compareSelectorSets,
  evaluateProbe, summarize, abiType,
};
