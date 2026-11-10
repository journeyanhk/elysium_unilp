/**
 * 交易内容级授权绑定（M3.2 最终评审 P0-2）。
 *
 * 问题：如果门禁授权只绑定「合约 + selector + 金额」，就可能出现
 *   「交易 A 获得授权 → 实际发送交易 B（B 复用 A 的额度与审计）」。
 *
 * 方案：授权时把**完整交易内容**（intentId / chainId / to / value / calldataHash /
 * actions / PoolKey / deadline / minOut / 报价区块 / 预演区块 hash）算成一个
 * 绑定对象与 bindingHash；签名前再次用**真实 calldata** 重算并逐项比对，
 * 任何字段变化都必须重新 build → simulate → authorize。
 *
 * 本模块为纯函数（无网络、无签名、无广播），可在只读阶段完整测试。
 */
const { keccak256, toHex } = require('viem');

/** 绑定字段固定顺序（保证 bindingHash 可复现） */
function computeBinding(req = {}) {
  return {
    intentId: req.intentId != null ? String(req.intentId) : null,
    chainId: req.chainId != null ? Number(req.chainId) : null,
    to: req.to ? String(req.to).toLowerCase() : null,
    value: req.value != null ? String(req.value) : null,
    calldataHash: req.calldataHash ? String(req.calldataHash).toLowerCase() : null,
    selector: req.selector ? String(req.selector).toLowerCase() : null,
    key: req.key || null,
    intentType: req.intentType || null,
    amountUsd: req.amountUsd != null ? Number(req.amountUsd) : null,
    deadline: req.deadline != null ? Number(req.deadline) : null,
    minOut: req.minOut != null ? String(req.minOut) : null,
    quoteBlock: req.quoteBlock != null ? Number(req.quoteBlock) : null,
    simBlock: req.simBlock != null ? Number(req.simBlock) : null,
    simBlockHash: req.simBlockHash ? String(req.simBlockHash).toLowerCase() : null,
    simResultHash: req.simResultHash ? String(req.simResultHash).toLowerCase() : null,
    actions: Array.isArray(req.actions) ? req.actions.map((a) => String(a)) : null,
    poolId: req.poolId ? String(req.poolId).toLowerCase() : null,
  };
}

/** 绑定哈希（keccak256(canonical JSON)），用于审计与比对 */
function bindingHashOf(binding) {
  return keccak256(toHex(JSON.stringify(binding)));
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** 绑定字段完整性检查：缺任何关键字段都不允许授权 */
function assertBindingComplete(req = {}) {
  const missing = [];
  if (req.intentId == null || String(req.intentId).trim() === '') missing.push('intentId');
  if (req.chainId == null || !Number.isInteger(Number(req.chainId))) missing.push('chainId');
  if (!req.to || !/^0x[0-9a-fA-F]{40}$/.test(String(req.to))) missing.push('to');
  if (req.value == null || !/^\d+$/.test(String(req.value))) missing.push('value');
  if (!req.calldataHash || !HEX32.test(String(req.calldataHash))) missing.push('calldataHash');
  return { ok: missing.length === 0, missing };
}

/** 用真实 calldata 重算哈希 */
function calldataHashOf(calldata) {
  if (!calldata || typeof calldata !== 'string' || !/^0x[0-9a-fA-F]*$/.test(calldata)) {
    throw new Error('calldata 非法（必须是 0x 开头的十六进制字符串）');
  }
  return keccak256(calldata);
}

/**
 * 比对「已授权绑定」与「当前准备发送的交易」是否完全一致。
 * @returns {{ok:boolean, reason?:string, changed:string[]}}
 */
function verifyBinding(authorizedBinding = {}, currentReq = {}) {
  const current = computeBinding(currentReq);
  const changed = [];
  for (const k of Object.keys(current)) {
    const a = authorizedBinding[k];
    const b = current[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  if (changed.length) {
    return {
      ok: false,
      reason: `交易内容与授权绑定不一致（字段变化：${changed.join(', ')}）——必须重新 build → simulate → authorize`,
      changed,
    };
  }
  return { ok: true, changed: [] };
}

/**
 * 签名前核对（M3.3 使用；M3.2 最终评审 P0 修订）。
 *
 * 关键点：**当前交易**的绑定必须由「intent 记录 + 当前请求 + 真实 calldata 解码」重新构造，
 * 绝不能把授权绑定里的字段原样放回去（那等于没核对）。
 *
 * 核对内容：
 *   1. 授权绑定自身完整性：bindingHashOf(binding) === authorization.bindingHash（防篡改）
 *   2. 真实 calldata 重算 calldataHash，并从中解析 selector / actions / deadline / 金额边界
 *   3. 用 intent 记录（intentId / chainId / to / intentType / amountUsd / quoteBlock / poolId 等）
 *      重建当前绑定，逐字段与授权绑定比对
 *
 * 任何不一致 → ok:false，必须重新 build → simulate → authorize。
 */
function preSignCheck({ authorization = {}, current = {}, calldata = null, decoded = null } = {}) {
  const authBinding = authorization.binding || null;
  if (!authBinding) return { ok: false, reason: '缺少授权绑定（未经过 authorizeTx），禁止签名' };
  if (!authorization.bindingHash) return { ok: false, reason: '缺少授权绑定哈希，禁止签名' };

  // 1) 绑定哈希自校验（内容被篡改但哈希未同步 → 拒绝）
  let selfHash;
  try {
    selfHash = bindingHashOf(authBinding);
  } catch (e) {
    return { ok: false, reason: `授权绑定无法计算哈希：${e.message}` };
  }
  if (selfHash.toLowerCase() !== String(authorization.bindingHash).toLowerCase()) {
    return {
      ok: false,
      reason: '授权绑定内容与其哈希不一致（疑似被篡改），禁止签名',
      expected: authorization.bindingHash,
      actual: selfHash,
    };
  }

  // 2) 用真实 calldata 重算哈希与 selector
  let calldataHash = null;
  let selector = null;
  if (calldata != null) {
    try {
      calldataHash = calldataHashOf(calldata);
    } catch (e) {
      return { ok: false, reason: `calldata 校验失败：${e.message}` };
    }
    if (!/^0x[0-9a-fA-F]{8}/.test(calldata)) return { ok: false, reason: 'calldata 过短，缺少 selector' };
    selector = calldata.slice(0, 10).toLowerCase();
  } else if (current.calldataHash) {
    calldataHash = String(current.calldataHash).toLowerCase();
  } else {
    return { ok: false, reason: '缺少 calldata，无法核对' };
  }

  // 3) 构造「当前交易」绑定：intent 记录 + 当前请求 + 解码结果（解码结果优先）
  const merged = { ...current };
  if (decoded) {
    if (decoded.actions) merged.actions = decoded.actions;
    if (decoded.deadline != null) merged.deadline = decoded.deadline;
    if (decoded.minOut !== undefined) merged.minOut = decoded.minOut;
    if (decoded.selector) merged.selector = decoded.selector;
  }
  const currentBinding = computeBinding({ ...merged, calldataHash, selector: selector || merged.selector });

  // 4) 逐字段比对（含 intentId / chainId / to / value / amountUsd / deadline / minOut / actions / quoteBlock / simBlockHash / poolId ...）
  const res = verifyBinding(authBinding, currentBinding);
  if (!res.ok) return { ok: false, reason: res.reason, changed: res.changed };
  return { ok: true, calldataHash, bindingHash: selfHash };
}

module.exports = { computeBinding, bindingHashOf, assertBindingComplete, calldataHashOf, verifyBinding, preSignCheck };
