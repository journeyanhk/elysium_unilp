/**
 * M3.3 Gas 计划与 Gas 绑定（review P0-2）。
 *
 * 问题：如果只在事后检查「gasPrice ≤ 5 gwei」，钱包仍可自行决定 gasLimit /
 * maxFeePerGas / maxPriorityFeePerGas，可能出现：
 *   - gasLimit 被抬得极高（配合钱包自行抬高的费用，实际支出远超预期）；
 *   - 优先费被抬高；
 *   - Gas 总成本突破 1 USD 上限。
 *
 * 方案：**在 simulate 阶段就把 Gas 参数固定下来**（固定余量、固定上限），
 * 写进授权绑定；签名前用真实交易（或链上交易）的 Gas 参数与绑定逐项比对，
 * 超出即拒绝 —— 不做任何事后补偿，也不允许「先签名再检查」。
 *
 * 本模块为纯函数（无网络、无数据库），可完整离线测试。
 */
const { TX_GATE } = require('../config/tx-gate');

const GAS_PLAN_VERSION = 'M3.3-gas-1';

/**
 * 计算 Gas 计划（simulate 阶段调用一次，结果入库并进入授权绑定）。
 * @returns {{ok:boolean, code?:string, reason?:string, plan?:object}}
 */
function computeGasPlan({ gasEstimate, gasPriceWei, hypeUsd, limits = TX_GATE.limits } = {}) {
  const deny = (code, reason) => ({ ok: false, code, reason });

  const est = gasEstimate != null ? Number(gasEstimate) : NaN;
  if (!Number.isFinite(est) || est <= 0) return deny('GAS_ESTIMATE_MISSING', '缺少 eth_estimateGas 结果，无法确定 Gas 上限');
  if (gasPriceWei == null) return deny('GAS_PRICE_MISSING', '缺少链上 Gas 价格，无法确定费用上限');
  if (hypeUsd == null || !Number.isFinite(Number(hypeUsd))) return deny('HYPE_PRICE_MISSING', '缺少 HYPE 价格，无法校验 Gas 美元上限');

  const marginBps = limits.gasLimitMarginBps != null ? Number(limits.gasLimitMarginBps) : 2500;
  const minGasLimit = limits.minGasLimit != null ? Number(limits.minGasLimit) : 50000;
  const gasLimit = Math.max(Math.ceil(est * (1 + marginBps / 10000)), minGasLimit);

  const maxFeePerGasWei = BigInt(gasPriceWei);
  const maxFeeGwei = Number(maxFeePerGasWei) / 1e9;
  if (limits.maxGasPriceGwei != null && maxFeeGwei > limits.maxGasPriceGwei) {
    return deny('GAS_PRICE_OVER', `链上 Gas 价格 ${maxFeeGwei.toFixed(4)} gwei 超过上限 ${limits.maxGasPriceGwei} gwei`);
  }

  const priorityCapWei = BigInt(Math.round((limits.maxPriorityFeeGwei != null ? Number(limits.maxPriorityFeeGwei) : 1) * 1e9));
  const maxPriorityFeePerGasWei = maxFeePerGasWei < priorityCapWei ? maxFeePerGasWei : priorityCapWei;

  const maxCostWei = BigInt(gasLimit) * maxFeePerGasWei;
  const gasUsd = (Number(maxCostWei) / 1e18) * Number(hypeUsd);
  if (limits.maxGasUsd != null && gasUsd > limits.maxGasUsd) {
    return deny('GAS_USD_OVER', `Gas 最坏成本 ${gasUsd.toFixed(4)} USD 超过上限 ${limits.maxGasUsd} USD`);
  }

  return {
    ok: true,
    plan: {
      version: GAS_PLAN_VERSION,
      estimate: est,
      marginBps,
      gasLimit,
      maxFeePerGasWei: maxFeePerGasWei.toString(),
      maxPriorityFeePerGasWei: maxPriorityFeePerGasWei.toString(),
      maxCostWei: maxCostWei.toString(),
      gasUsd: Number(gasUsd.toFixed(6)),
      hypeUsd: Number(hypeUsd),
      at: new Date().toISOString(),
    },
  };
}

/**
 * 交易类型归一化：Gas 计划基于 EIP-1559（maxFeePerGas + maxPriorityFeePerGas），
 * legacy（仅 gasPrice）交易**不得**与 EIP-1559 绑定混用。
 */
function normalizeTxType(type, { hasMaxFeePerGas = false } = {}) {
  const t = String(type == null ? '' : type).toLowerCase();
  if (t === '0x2' || t === 'eip1559' || t === '2') return 'eip1559';
  if (t === '0x0' || t === 'legacy' || t === '0') return 'legacy';
  if (t === '0x1' || t === 'eip2930' || t === '1') return 'eip2930';
  if (!t) return hasMaxFeePerGas ? 'eip1559' : 'legacy'; // 未标注时按是否携带 maxFeePerGas 推断
  return t;
}

/**
 * 签名前 Gas 核对（M3.3 review 第二轮 P0-2）：
 *   1) 交易类型必须是 EIP-1559（与 Gas 计划一致），legacy 交易直接拒绝；
 *   2) gasLimit / maxFeePerGas / maxPriorityFeePerGas 必须 **严格等于** 授权绑定值
 *      （不是「不超过」—— 否则交易 A 的授权可以被降级后的交易 B 复用）；
 *   3) Gas 美元最坏成本仍需 ≤ 上限；绑定缺 Gas 字段或取不到 HYPE 价格 → 拒绝。
 *
 * @param {{gasLimit?:number|bigint, maxFeePerGasWei?:bigint|null, maxPriorityFeePerGasWei?:bigint|null, type?:string, gasPriceWei?:bigint|null}} tx
 * @param {object} binding 授权绑定（含 gasLimit / maxFeePerGas / maxPriorityFeePerGas / gasUsd）
 * @param {object} limits  门禁上限
 * @param {number|null} hypeUsd HYPE 价格（用于 Gas 美元上限复核）
 */
function checkGasAgainstBinding({ gasLimit, maxFeePerGasWei, maxPriorityFeePerGasWei, type = null, gasPriceWei = null } = {}, binding = null, limits = TX_GATE.limits, hypeUsd = null) {
  const deny = (code, reason) => ({ ok: false, code, reason });
  if (!binding || binding.gasLimit == null || binding.maxFeePerGas == null || binding.maxPriorityFeePerGas == null) {
    return deny('GAS_BINDING_MISSING', '授权绑定缺少 Gas 参数（gasLimit / maxFeePerGas / maxPriorityFeePerGas），拒绝签名');
  }

  // —— 交易类型必须与 Gas 计划一致（EIP-1559），禁止降级为 legacy ——
  const txType = normalizeTxType(type, { hasMaxFeePerGas: maxFeePerGasWei != null });
  if (txType !== 'eip1559') {
    return deny('TX_TYPE_MISMATCH', `交易类型 ${txType} 与 Gas 计划（EIP-1559）不一致，拒绝签名（禁止 legacy 降级）`);
  }
  if (gasPriceWei != null) {
    return deny('TX_TYPE_MISMATCH', '交易同时携带 legacy gasPrice，与 EIP-1559 Gas 计划不一致，拒绝签名');
  }

  if (gasLimit == null) return deny('GAS_LIMIT_MISSING', '交易未携带 gasLimit，拒绝签名（不允许钱包自行决定）');
  if (maxFeePerGasWei == null) return deny('GAS_PRICE_MISSING', '交易未携带 maxFeePerGas，拒绝签名（不允许钱包自行决定）');
  if (maxPriorityFeePerGasWei == null) return deny('PRIORITY_FEE_MISSING', '交易未携带 maxPriorityFeePerGas，拒绝签名（不允许钱包自行决定）');

  const limit = BigInt(gasLimit);
  const boundLimit = BigInt(binding.gasLimit);
  if (limit !== boundLimit) {
    return deny('GAS_LIMIT_MISMATCH', `交易 gasLimit ${limit} 与授权绑定 ${boundLimit} 不相等（Gas 参数必须与授权绑定完全一致）`);
  }

  const fee = BigInt(maxFeePerGasWei);
  const boundFee = BigInt(binding.maxFeePerGas);
  if (fee !== boundFee) {
    return deny('MAX_FEE_MISMATCH', `交易 maxFeePerGas ${fee} wei 与授权绑定 ${boundFee} wei 不相等（Gas 参数必须与授权绑定完全一致）`);
  }
  const feeGwei = Number(fee) / 1e9;
  if (limits.maxGasPriceGwei != null && feeGwei > limits.maxGasPriceGwei) {
    return deny('GAS_PRICE_OVER', `交易 maxFeePerGas ${feeGwei.toFixed(4)} gwei 超过上限 ${limits.maxGasPriceGwei} gwei`);
  }

  const prio = BigInt(maxPriorityFeePerGasWei);
  const boundPrio = BigInt(binding.maxPriorityFeePerGas);
  if (prio !== boundPrio) {
    return deny('PRIORITY_FEE_MISMATCH', `交易 maxPriorityFeePerGas ${prio} wei 与授权绑定 ${boundPrio} wei 不相等（Gas 参数必须与授权绑定完全一致）`);
  }
  if (prio > fee) return deny('PRIORITY_FEE_ABOVE_MAX_FEE', `maxPriorityFeePerGas ${prio} wei 高于 maxFeePerGas ${fee} wei`);

  if (hypeUsd == null || !Number.isFinite(Number(hypeUsd))) {
    return deny('HYPE_PRICE_MISSING', '无法获取 HYPE 价格，无法复核 Gas 美元上限，拒绝签名');
  }
  const costWei = limit * fee;
  const gasUsd = (Number(costWei) / 1e18) * Number(hypeUsd);
  if (limits.maxGasUsd != null && gasUsd > limits.maxGasUsd) {
    return deny('GAS_USD_OVER', `交易 Gas 最坏成本 ${gasUsd.toFixed(4)} USD 超过上限 ${limits.maxGasUsd} USD`);
  }

  return {
    ok: true,
    gas: {
      type: txType,
      gasLimit: limit.toString(),
      maxFeePerGasWei: fee.toString(),
      maxPriorityFeePerGasWei: prio.toString(),
      gasUsd: Number(gasUsd.toFixed(6)),
      bound: { gasLimit: boundLimit.toString(), maxFeePerGasWei: boundFee.toString(), maxPriorityFeePerGasWei: boundPrio.toString(), gasUsd: binding.gasUsd ?? null },
    },
  };
}

module.exports = { GAS_PLAN_VERSION, computeGasPlan, checkGasAgainstBinding, normalizeTxType };
