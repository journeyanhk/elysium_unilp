/**
 * 签名前核对：用**权威记录**重建「当前交易」绑定（M3.2 第四轮评审 P0-1）。
 *
 * 原则：
 *   - quoteBlock / simBlock / simBlockHash / simResultHash / minOut 必须来自
 *     tx_intents + tx_simulations（最新成功模拟）+ quote_snapshot，**不得用 null 补位**；
 *   - 没有成功模拟、模拟过期、模拟结果哈希缺失 → 直接拒绝（fail-closed）；
 *   - calldata 解码出的 actions / deadline / 金额边界必须与 intent 记录一致。
 *
 * 本模块为纯函数（无网络、无数据库、无签名），可完整离线测试。
 */
const { keccak256, toHex } = require('viem');

/** 模拟结果摘要：与 routes/tx.js 落库时使用的算法保持一致 */
function simResultHashOf({ ethCallOk, revertReason = null, gasEstimate = null, gasUsd = null, simBlockNumber = null, simBlockHash = null, precheckIssues = null } = {}) {
  const canonical = JSON.stringify({
    ethCallOk: Boolean(ethCallOk),
    revertReason: revertReason || null,
    gasEstimate: gasEstimate != null ? String(gasEstimate) : null,
    gasUsd: gasUsd != null ? String(gasUsd) : null,
    simBlockNumber: simBlockNumber != null ? Number(simBlockNumber) : null,
    simBlockHash: simBlockHash ? String(simBlockHash).toLowerCase() : null,
    precheckIssues: Array.isArray(precheckIssues) ? precheckIssues.map((i) => i && i.code).filter(Boolean).sort() : null,
  });
  return keccak256(toHex(canonical));
}

/**
 * 由权威记录重建签名前核对所需的「当前交易」绑定字段。
 *
 * @param {object} p
 * @param {object} p.intent           tx_intents 行（含 key / amount_usd / deadline / actions / pool_id / params）
 * @param {object} p.simulation       loadLatestSimulation() 结果（可为 null）
 * @param {object} p.request          { calldata, to, value, chainId }
 * @param {object} p.decoded          decodeForCheck() 结果（真实 calldata 解码）
 * @param {number} p.simMaxAgeSec     模拟结果有效期
 * @param {number} p.nowMs            当前时间（毫秒）
 * @returns {{ok:boolean, reason?:string, current?:object, simulation?:object}}
 */
function buildPreSignCurrent({ intent, simulation, request = {}, decoded = null, simMaxAgeSec = 300, nowMs = Date.now() } = {}) {
  if (!intent) return { ok: false, reason: '缺少 intent 记录' };
  if (!simulation) return { ok: false, reason: '没有成功的模拟记录（eth_call 未通过），禁止签名' };
  if (!simulation.simBlockHash) return { ok: false, reason: '模拟记录缺少区块哈希，禁止签名' };
  if (simulation.quoteBlock == null) return { ok: false, reason: '模拟记录缺少状态/报价区块，禁止签名' };
  if (!simulation.simResultHash) return { ok: false, reason: '模拟记录缺少结果摘要（simResultHash），禁止签名' };
  // M3.3 review P0-2：Gas 参数必须来自模拟记录（不得为空，也不得由钱包自行决定）
  if (simulation.gasLimit == null) return { ok: false, reason: '模拟记录缺少 gasLimit（Gas 计划未生成），禁止签名' };
  if (!simulation.maxFeePerGasWei) return { ok: false, reason: '模拟记录缺少 maxFeePerGas，禁止签名' };
  if (!simulation.maxPriorityFeePerGasWei) return { ok: false, reason: '模拟记录缺少 maxPriorityFeePerGas，禁止签名' };

  const ageSec = simulation.createdAtMs != null ? Math.floor((nowMs - simulation.createdAtMs) / 1000) : null;
  if (ageSec == null) return { ok: false, reason: '无法判断模拟记录时间，禁止签名' };
  if (ageSec > Number(simMaxAgeSec)) {
    return { ok: false, reason: `模拟结果已过期（${ageSec}s > ${simMaxAgeSec}s），必须重新 simulate 后再签名` };
  }

  if (!decoded) return { ok: false, reason: '缺少 calldata 解码结果，禁止签名' };

  // calldata 解码结果必须与 intent 记录一致（actions / deadline / 金额边界）
  const intentActions = intent.actions ? (Array.isArray(intent.actions) ? intent.actions : JSON.parse(intent.actions)) : null;
  if (intentActions && decoded.actions && JSON.stringify(intentActions) !== JSON.stringify(decoded.actions)) {
    return { ok: false, reason: `calldata 的 actions ${JSON.stringify(decoded.actions)} 与 intent 记录 ${JSON.stringify(intentActions)} 不一致` };
  }
  if (intent.deadline != null && decoded.deadline != null && Number(intent.deadline) !== Number(decoded.deadline)) {
    return { ok: false, reason: `calldata 的 deadline ${decoded.deadline} 与 intent 记录 ${intent.deadline} 不一致` };
  }
  if (!decoded.minOut) return { ok: false, reason: 'calldata 未解出金额边界（minOut），禁止签名' };

  const current = {
    intentId: intent.id != null ? Number(intent.id) : intent.intentId,
    chainId: intent.chain_id != null ? Number(intent.chain_id) : intent.chainId,
    to: request.to || intent.target_contract,
    value: request.value != null ? String(request.value) : '0',
    selector: decoded.selector || intent.selector,
    key: intent.key,
    intentType: intent.intent_type || intent.intentType,
    amountUsd: intent.amount_usd != null ? Number(intent.amount_usd) : null,
    deadline: decoded.deadline != null ? Number(decoded.deadline) : (intent.deadline != null ? Number(intent.deadline) : null),
    minOut: decoded.minOut,
    quoteBlock: Number(simulation.quoteBlock),
    simBlock: simulation.simBlock != null ? Number(simulation.simBlock) : null,
    simBlockHash: simulation.simBlockHash,
    simResultHash: simulation.simResultHash,
    actions: decoded.actions || intentActions,
    poolId: intent.pool_id || null,
    gasLimit: Number(simulation.gasLimit),
    maxFeePerGas: simulation.maxFeePerGasWei,
    maxPriorityFeePerGas: simulation.maxPriorityFeePerGasWei,
    gasUsd: simulation.gasUsd != null ? Number(simulation.gasUsd) : null,
  };
  return { ok: true, current, simulation };
}

/**
 * 签名前「服务端判定」（M3.3 review 第三轮）：
 * 把门禁 / 熔断 / 授权 / 核对结果 / 钱包账户与链的一致性判定集中为纯函数，
 * 便于测试与审计；**任何一项不满足都必须拒绝签名**（fail-closed）。
 * 返回 { ok, code, reason, reasons }（reason 为首个失败原因，reasons 为全部失败原因）。
 */
function evaluatePreSignAudit({
  gate = null, authorization = null, consumeAgeSec = null, maxConsumeAgeSec = null,
  check = null, walletAccount = null, walletChainId = null, intentUser = null, intentChainId = null,
} = {}) {
  const failures = [];
  const fail = (code, reason) => failures.push({ code, reason });
  const lower = (v) => (v == null ? '' : String(v).toLowerCase());

  if (!gate) fail('GATE_STATE_UNAVAILABLE', '门禁状态读取失败（拒绝签名）');
  else {
    if (!gate.enabled) fail('GATE_CLOSED', '交易门禁关闭');
    if (!gate.unlockPath) fail('NO_UNLOCK_RECORD', '缺少解锁记录');
    if (gate.killSwitchTripped !== false) fail('KILL_SWITCH', '熔断状态异常或已触发（未知 = 拒绝）');
    if (gate.stateUnavailable) fail('GATE_STATE_UNAVAILABLE', '门禁持久化状态不可读');
  }

  if (!authorization) fail('NO_AUTHORIZATION', '该 intent 尚无授权记录');
  else {
    if (authorization.status !== 'consumed') fail('AUTHORIZATION_NOT_CONSUMED', `授权状态为 ${authorization.status}（未完成一次性消费）`);
    if (consumeAgeSec == null) fail('CONSUMPTION_TIME_MISSING', '授权消费时间缺失');
    else if (maxConsumeAgeSec != null && consumeAgeSec > maxConsumeAgeSec) {
      fail('CONSUMPTION_STALE', `授权消费已过去 ${consumeAgeSec}s（上限 ${maxConsumeAgeSec}s），必须重新走完整流程`);
    }
  }

  if (!check || check.ok !== true) fail(check?.code || 'PRESIGN_FAILED', check?.reason || '签名前核对未通过');

  if (!walletAccount) fail('WALLET_ACCOUNT_MISSING', '未提供钱包账户（无法确认签名方就是 intent 用户）');
  else if (intentUser != null && lower(walletAccount) !== lower(intentUser)) {
    fail('WALLET_ACCOUNT_MISMATCH', `钱包当前账户 ${walletAccount} 与 intent 用户 ${intentUser} 不一致`);
  }
  if (walletChainId == null) fail('WALLET_CHAIN_MISSING', '未提供钱包链 ID（无法确认签名链）');
  else if (intentChainId != null && Number(walletChainId) !== Number(intentChainId)) {
    fail('WALLET_CHAIN_MISMATCH', `钱包当前链 ${walletChainId} 与 intent 链 ${intentChainId} 不一致`);
  }

  return {
    ok: failures.length === 0,
    code: failures.length ? failures[0].code : null,
    reason: failures.length ? failures[0].reason : null,
    reasons: failures,
  };
}

module.exports = { simResultHashOf, buildPreSignCurrent, evaluatePreSignAudit };
