/**
 * M3.3 手动签名与广播 —— 「已签名交易 / 链上交易」与授权绑定的比对，以及回执核对。
 *
 * 安全边界（本模块永久不变）：
 *   - **不签名**、不持有私钥、不生成助记词、不代替用户签名；
 *   - 只做「校验」与「核对」：把用户钱包产出的交易（原始已签名交易或已上链交易）
 *     与授权绑定逐字段比对，任何不一致都必须拒绝并触发熔断；
 *   - 不自动重试、不自动替换、不自动加速（本模块不包含任何重发分支）。
 *
 * 比对字段：chainId / to / value / calldataHash / selector / 发送方（必须等于 intent 用户）
 *          + 钱包自填的 Gas 价格不得高于门禁上限（防止钱包端自行抬高费用）。
 */
const { parseTransaction, recoverTransactionAddress, keccak256, isHex } = require('viem');
const { CHAIN } = require('../config/whitelist');

const lower = (a) => String(a || '').toLowerCase();
const gweiOf = (wei) => (wei == null ? null : Number(wei) / 1e9);

function _fail(code, reason, extra = {}) {
  return { ok: false, code, reason, ...extra };
}

/**
 * 核心比对：把交易字段与授权绑定逐项核对。
 * @param {{source:string, from?:string, to?:string, value?:bigint|string, data?:string, chainId?:number,
 *          gasPriceWei?:bigint|null, maxFeePerGasWei?:bigint|null}} tx
 * @param {object} binding  授权绑定（lib/tx-binding.js computeBinding 结果）
 * @param {string} user     intent 用户地址（交易的 from 必须等于它）
 * @param {object} limits   门禁上限（用于 Gas 价格复核）
 */
function compareTxToBinding(tx = {}, binding = null, user = null, limits = {}) {
  if (!binding) return _fail('BINDING_MISSING', '缺少授权绑定，无法核对交易内容');
  if (!tx.data || !isHex(tx.data)) return _fail('CALLDATA_MISSING', '交易缺少 calldata，无法核对');

  const chainId = Number(tx.chainId);
  if (!Number.isInteger(chainId)) return _fail('CHAIN_MISSING', '交易未携带 chainId（拒绝：无法确认链）');
  if (chainId !== Number(CHAIN.id)) {
    return _fail('CHAIN_MISMATCH', `交易 chainId ${chainId} 与白名单链 ${CHAIN.id} 不一致`);
  }
  if (Number(binding.chainId) !== chainId) {
    return _fail('CHAIN_MISMATCH', `交易 chainId ${chainId} 与授权绑定 ${binding.chainId} 不一致`);
  }

  if (lower(tx.to) !== lower(binding.to)) {
    return _fail('TO_MISMATCH', `交易收款合约 ${tx.to} 与授权绑定 ${binding.to} 不一致`);
  }

  const value = BigInt(tx.value ?? 0);
  const boundValue = BigInt(binding.value ?? '0');
  if (value !== boundValue) {
    return _fail('VALUE_MISMATCH', `交易附带金额 ${value} wei 与授权绑定 ${boundValue} wei 不一致（拒绝：防止附带转账）`);
  }

  const calldataHash = keccak256(tx.data);
  if (lower(calldataHash) !== lower(binding.calldataHash)) {
    return _fail('CALLDATA_MISMATCH', '交易 calldata 哈希与授权绑定不一致（参数被改动）');
  }
  const selector = String(tx.data).slice(0, 10).toLowerCase();
  if (selector !== lower(binding.selector)) {
    return _fail('SELECTOR_MISMATCH', `交易选择器 ${selector} 与授权绑定 ${binding.selector} 不一致`);
  }

  if (user && lower(tx.from) !== lower(user)) {
    return _fail('SENDER_MISMATCH', `交易发送方 ${tx.from} 与 intent 用户 ${user} 不一致（禁止代发）`);
  }

  // 钱包自填费用复核：钱包可能自行抬高 Gas 价格，必须重新核对上限
  const feeWei = tx.maxFeePerGasWei != null ? tx.maxFeePerGasWei : tx.gasPriceWei;
  const feeGwei = gweiOf(feeWei);
  if (limits.maxGasPriceGwei != null && feeGwei != null && feeGwei > limits.maxGasPriceGwei) {
    return _fail('GAS_PRICE_OVER', `交易 Gas 价格 ${feeGwei.toFixed(4)} gwei 超过门禁上限 ${limits.maxGasPriceGwei} gwei（禁止自动放宽）`);
  }

  return {
    ok: true,
    fields: {
      source: tx.source || null,
      chainId, to: lower(tx.to), value: value.toString(), calldataHash: lower(calldataHash), selector,
      from: tx.from ? lower(tx.from) : null,
      gasPriceGwei: feeGwei != null ? Number(feeGwei.toFixed(6)) : null,
    },
  };
}

/** 校验「用户钱包签好但尚未广播」的原始交易（rawTx） */
async function verifyRawTxAgainstBinding({ rawTx, binding, user, limits } = {}) {
  if (!rawTx || !isHex(rawTx)) return _fail('RAW_TX_INVALID', '缺少合法的已签名原始交易（rawTx 必须是 0x 十六进制）');
  let parsed;
  try {
    parsed = parseTransaction(rawTx);
  } catch (e) {
    return _fail('RAW_TX_PARSE_FAILED', `无法解析已签名交易：${String(e.message).slice(0, 200)}`);
  }
  let from = null;
  try {
    from = await recoverTransactionAddress({ serializedTransaction: rawTx });
  } catch (e) {
    return _fail('RAW_TX_RECOVER_FAILED', `无法从签名恢复发送方地址：${String(e.message).slice(0, 200)}`);
  }
  return compareTxToBinding(
    {
      source: 'wallet-sign-raw',
      from,
      to: parsed.to,
      value: parsed.value,
      data: parsed.data,
      chainId: parsed.chainId,
      gasPriceWei: parsed.gasPrice ?? null,
      maxFeePerGasWei: parsed.maxFeePerGas ?? null,
    },
    binding,
    user,
    limits
  );
}

/** 校验「已经上链的交易」（钱包自行广播的场景，事后核对） */
function verifyOnChainTxAgainstBinding({ tx, binding, user, limits } = {}) {
  if (!tx) return _fail('ONCHAIN_TX_MISSING', '链上查不到该交易（可能尚未打包，或交易哈希错误）');
  return compareTxToBinding(
    {
      source: 'wallet-sent',
      from: tx.from,
      to: tx.to,
      value: tx.value ?? 0n,
      data: tx.input,
      chainId: tx.chainId != null ? Number(tx.chainId) : null,
      gasPriceWei: tx.gasPrice ?? null,
      maxFeePerGasWei: tx.maxFeePerGas ?? null,
    },
    binding,
    user,
    limits
  );
}

/** 回执摘要（只保留核对需要的字段） */
function receiptSummary(receipt) {
  if (!receipt) return null;
  return {
    txHash: receipt.transactionHash,
    status: receipt.status, // 'success' | 'reverted'
    blockNumber: receipt.blockNumber != null ? Number(receipt.blockNumber) : null,
    gasUsed: receipt.gasUsed != null ? receipt.gasUsed.toString() : null,
    effectiveGasPrice: receipt.effectiveGasPrice != null ? receipt.effectiveGasPrice.toString() : null,
    from: receipt.from || null,
    to: receipt.to || null,
    logCount: Array.isArray(receipt.logs) ? receipt.logs.length : 0,
  };
}

/**
 * 回执核对（步骤 12 的机器部分）：
 *   1) status 必须是 success（回滚 = 硬失败 → 调用方必须触发熔断）；
 *   2) 链上交易内容必须与授权绑定一致（钱包自行广播的场景只能事后核对，这里兜底）；
 *   3) 实际 Gas 成本超过门禁上限 → 标记偏差（不熔断，但必须人工复核）。
 */
function verifyReceipt({ receipt, tx, binding, user, limits = {}, hypeUsd = null } = {}) {
  if (!receipt) return { ok: false, pending: true, code: 'RECEIPT_PENDING', reason: '尚无回执（交易可能仍在内存池）' };
  const summary = receiptSummary(receipt);
  if (summary.status !== 'success') {
    return { ok: false, code: 'RECEIPT_REVERTED', reason: `交易回滚（status=${summary.status}）——必须触发熔断并人工复核`, receipt: summary };
  }
  const content = verifyOnChainTxAgainstBinding({ tx, binding, user, limits });
  if (!content.ok) {
    return { ok: false, code: 'POST_BROADCAST_MISMATCH', reason: `链上交易内容与授权绑定不一致：${content.reason}`, receipt: summary, content };
  }
  let gasUsd = null;
  if (summary.gasUsed && summary.effectiveGasPrice) {
    const wei = BigInt(summary.gasUsed) * BigInt(summary.effectiveGasPrice);
    if (hypeUsd != null) gasUsd = (Number(wei) / 1e18) * Number(hypeUsd);
  }
  const deviations = [];
  if (gasUsd != null && limits.maxGasUsd != null && gasUsd > limits.maxGasUsd) {
    deviations.push({ code: 'GAS_USD_OVER', detail: `实际 Gas ${gasUsd.toFixed(4)} USD 超过上限 ${limits.maxGasUsd} USD` });
  }
  return { ok: true, receipt: summary, gasUsd, deviations, requiresReview: deviations.length > 0 };
}

module.exports = {
  compareTxToBinding,
  verifyRawTxAgainstBinding,
  verifyOnChainTxAgainstBinding,
  receiptSummary,
  verifyReceipt,
};
