/**
 * M3.3 手动广播管线（唯一允许发出写请求的模块）。
 *
 * 设计原则（与 review 要求逐条对应）：
 *   1) **只有手动路径**：广播必须由用户点击触发，且必须已经完成「一次性授权消费」；
 *   2) **绝不重试**：广播 RPC 调用是一次性的，没有重试/替换/加速分支 ——
 *      广播超时属于「结果未知」，此时**触发熔断**并提示用户去区块浏览器人工确认，
 *      绝不允许自动重发（重发正是最容易造成双花的操作）；
 *   3) **发送前再次核对**：签名交易（rawTx）或链上交易（钱包自行广播）都必须与授权绑定逐字段一致；
 *   4) **失败即熔断**：广播异常 / 回执回滚 / 事后内容不一致 → 立即 tripKillSwitch；
 *   5) 本模块不签名、不持有私钥。
 */
const { keccak256 } = require('viem');
const { CHAIN } = require('../config/whitelist');
const { TX_GATE } = require('../config/tx-gate');
const { guardedRpc } = require('./tx-rpc-guard');
const { verifyRawTxAgainstBinding, verifyOnChainTxAgainstBinding, verifyReceipt, receiptSummary } = require('./tx-wallet-tx');

const BROADCAST_MODES = ['wallet-sign-raw', 'wallet-sent'];

/** 只有这一个写方法允许被本模块调用，且只调用一次 */
const WRITE_RPC_METHODS = new Set(['eth_sendRawTransaction']);

/**
 * 广播前置检查（**纯函数**，可离线测试全部拒绝分支）。
 * 必须在任何写 RPC 之前通过；任何一项不满足都直接拒绝。
 */
function preflightBroadcast({ gate = {}, authorization = null, bindingHash = null, mode = null, rawTx = null, txHash = null, nowMs = Date.now(), limits = TX_GATE.limits } = {}) {
  const deny = (code, reason) => ({ ok: false, code, reason });

  if (gate.enabled !== true) return deny('GATE_CLOSED', `交易总开关关闭（${gate.version || 'unknown'}）——不存在可用广播路径`);
  if (!gate.unlockPath) return deny('NO_UNLOCK_RECORD', '缺少解锁记录（官方确认或用户知情接受），拒绝广播');
  if (gate.killSwitchTripped === true) return deny('KILL_SWITCH', `熔断已触发（${gate.killSwitchReason || '未记录原因'}），需人工复核后才能广播`);
  if (gate.killSwitchTripped === null) return deny('GATE_STATE_UNAVAILABLE', '无法确认熔断状态（持久化状态不可读），拒绝广播');
  if (gate.stateUnavailable) return deny('GATE_STATE_UNAVAILABLE', '门禁持久化状态不可读，拒绝广播');

  if (!authorization) return deny('NO_AUTHORIZATION', '该 intent 没有可用的门禁授权记录（未经过 authorize）');
  if (authorization.status !== 'consumed') {
    return deny('AUTHORIZATION_NOT_CONSUMED', '授权尚未一次性消费（必须先调用 consume-authorization），拒绝广播');
  }
  if (!authorization.consumedAt) return deny('CONSUMPTION_TIME_MISSING', '授权消费时间缺失，拒绝广播');
  const consumedMs = new Date(authorization.consumedAt).getTime();
  if (!Number.isFinite(consumedMs)) return deny('CONSUMPTION_TIME_INVALID', '授权消费时间无法解析，拒绝广播');
  const ageSec = Math.floor((nowMs - consumedMs) / 1000);
  const maxAge = limits.broadcastConsumeMaxAgeSec != null ? Number(limits.broadcastConsumeMaxAgeSec) : 180;
  if (ageSec > maxAge) {
    return deny('CONSUMPTION_STALE', `授权消费已过去 ${ageSec}s（上限 ${maxAge}s），必须重新 build → simulate → authorize → consume`);
  }
  if (!bindingHash) return deny('BINDING_MISSING', '缺少授权绑定哈希，拒绝广播');
  if (String(authorization.bindingHash || '').toLowerCase() !== String(bindingHash).toLowerCase()) {
    return deny('BINDING_MISMATCH', '授权绑定哈希与当前交易不一致，拒绝广播');
  }

  if (!BROADCAST_MODES.includes(mode)) {
    return deny('MODE_NOT_ALLOWED', `不支持的广播方式「${mode || '(空)'}」（仅允许 ${BROADCAST_MODES.join(' / ')}）`);
  }
  // 首笔模式：只允许「钱包只签名 → 后端核对 → 后端广播」
  // （wallet-sent 是先广播后核对，内容有误无法撤回，首笔禁用）
  if (gate.firstTxMode === true && mode === 'wallet-sent') {
    return deny('MODE_DISABLED_IN_FIRST_TX', '首笔模式仅允许 wallet-sign-raw（钱包只签名 → 后端核对 → 后端单次广播）；wallet-sent 先广播后核对，首笔禁用');
  }
  if (mode === 'wallet-sign-raw' && (!rawTx || typeof rawTx !== 'string')) {
    return deny('RAW_TX_MISSING', 'wallet-sign-raw 方式必须提供用户钱包签好的原始交易（rawTx）');
  }
  if (mode === 'wallet-sent' && !/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
    return deny('TX_HASH_MISSING', 'wallet-sent 方式必须提供钱包已广播的交易哈希（txHash）');
  }
  return { ok: true, mode, ageSec };
}

/**
 * 单次广播：**不重试**。任何异常都返回 ok:false（调用方必须据此触发熔断）。
 * 明确不使用 guardedRpc（其自带重试），避免「自动重发」。
 */
async function sendRawTransactionOnce({ rawTx, rpcUrl, timeoutMs = 20000 } = {}) {
  if (!rpcUrl) return { ok: false, code: 'RPC_URL_MISSING', reason: '缺少 RPC 端点，拒绝广播' };
  const method = 'eth_sendRawTransaction';
  if (!WRITE_RPC_METHODS.has(method)) return { ok: false, code: 'METHOD_NOT_ALLOWED', reason: `${method} 不在允许的写方法清单内` };
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [rawTx] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    if (json.error) {
      const msg = JSON.stringify(json.error);
      // 明确的节点拒绝（如 nonce 太低 / 余额不足）→ 交易未进入内存池，可安全重来
      const rejected = /already known|nonce too low|insufficient funds|replacement transaction underpriced|gas required exceeds allowance/i.test(msg);
      return { ok: false, code: rejected ? 'BROADCAST_REJECTED' : 'BROADCAST_ERROR', reason: `节点拒绝广播：${msg.slice(0, 300)}`, nodeRejected: rejected, ambiguous: !rejected };
    }
    if (!json.result) return { ok: false, code: 'BROADCAST_NO_HASH', reason: '节点未返回交易哈希', ambiguous: true };
    return { ok: true, txHash: json.result, rpcUrl };
  } catch (e) {
    // 网络超时/中断：交易**可能已经进入内存池** → 结果未知，必须人工确认，绝不自动重发
    return { ok: false, code: 'BROADCAST_UNKNOWN', reason: `广播请求异常（结果未知，可能已进入内存池）：${String(e.message).slice(0, 200)}`, ambiguous: true };
  }
}

/** 读取链上交易（只读） */
async function fetchTxByHash({ txHash, rpcUrl }) {
  const raw = await guardedRpc(rpcUrl, 'eth_getTransactionByHash', [txHash], { retries: 1 });
  if (!raw) return null;
  return {
    hash: raw.hash,
    from: raw.from,
    to: raw.to,
    value: raw.value != null ? BigInt(raw.value) : 0n,
    input: raw.input,
    chainId: raw.chainId != null ? Number(raw.chainId) : null,
    gasPrice: raw.gasPrice != null ? BigInt(raw.gasPrice) : null,
    maxFeePerGas: raw.maxFeePerGas != null ? BigInt(raw.maxFeePerGas) : null,
    blockNumber: raw.blockNumber != null ? Number(raw.blockNumber) : null,
  };
}

/** 读取回执（只读，轮询次数有限；轮询 ≠ 重发） */
async function fetchReceipt({ txHash, rpcUrl, attempts = 10, pollMs = 3000 }) {
  for (let i = 0; i < attempts; i++) {
    const raw = await guardedRpc(rpcUrl, 'eth_getTransactionReceipt', [txHash], { retries: 1 });
    if (raw) {
      return {
        transactionHash: raw.transactionHash,
        status: raw.status === '0x1' ? 'success' : 'reverted',
        blockNumber: raw.blockNumber,
        gasUsed: raw.gasUsed != null ? BigInt(raw.gasUsed) : null,
        effectiveGasPrice: raw.effectiveGasPrice != null ? BigInt(raw.effectiveGasPrice) : (raw.gasPrice != null ? BigInt(raw.gasPrice) : null),
        from: raw.from,
        to: raw.to,
        logs: Array.isArray(raw.logs) ? raw.logs : [],
      };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/** 回执核对 + 失败分类（供路由与测试共用） */
function evaluateReceipt({ receipt, tx, binding, user, limits = TX_GATE.limits, hypeUsd = null } = {}) {
  const result = verifyReceipt({ receipt, tx, binding, user, limits, hypeUsd });
  if (result.ok || result.pending) return { ...result, tripKillSwitch: false };
  // 回滚 / 事后内容不一致 → 硬失败，必须熔断
  return { ...result, tripKillSwitch: true };
}

/** 广播失败分类：哪些情况必须熔断 */
function classifyBroadcastFailure(result = {}) {
  const code = result.code;
  if (code === 'BROADCAST_REJECTED') return { tripKillSwitch: false, reason: '节点明确拒绝，交易未进入内存池，可人工复核后重来' };
  return { tripKillSwitch: true, reason: result.ambiguous ? '广播结果未知（可能已进入内存池），必须人工确认后再决定，禁止自动重发' : '广播失败' };
}

/**
 * 同一 intent 只允许一笔广播：已有广播记录（含回滚/核对失败）时直接拒绝。
 * 需要再次操作时必须重新 build 新 intent（重新模拟、重新授权、重新消费）。
 */
function checkExistingBroadcast(rows = []) {
  const active = (rows || []).filter((r) => ['submitted', 'confirmed', 'reverted', 'verification_failed'].includes(String(r.status)));
  if (active.length) {
    return {
      ok: false,
      code: 'ALREADY_BROADCAST',
      reason: `该 intent 已有广播记录（#${active[0].id}，tx=${active[0].tx_hash || '未返回哈希'}），禁止重复广播；如需再次操作请重新 build 新的 intent`,
    };
  }
  return { ok: true };
}

/** 计算交易的指纹（用于审计记录，便于事后比对） */
function rawTxFingerprint(rawTx) {
  return rawTx ? keccak256(rawTx) : null;
}

module.exports = {
  BROADCAST_MODES,
  WRITE_RPC_METHODS,
  preflightBroadcast,
  checkExistingBroadcast,
  sendRawTransactionOnce,
  fetchTxByHash,
  fetchReceipt,
  evaluateReceipt,
  classifyBroadcastFailure,
  rawTxFingerprint,
  receiptSummary,
  verifyRawTxAgainstBinding,
  verifyOnChainTxAgainstBinding,
  CHAIN,
};
