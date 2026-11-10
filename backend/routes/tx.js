/**
 * /api/tx —— M3.1 只读预演管线（build-only）。
 *
 *   GET  /api/tx/gate       门禁状态（只读）
 *   POST /api/tx/preview    操作预览（复用 M2 模拟/分析）
 *   POST /api/tx/build      构造 intent + calldata（不签名、不广播）
 *   POST /api/tx/simulate   只读 eth_call 预演 + Gas 估算 + 预检
 *   POST /api/tx/broadcast  **恒定被门禁拒绝**（M3.3 前不存在可用广播路径）
 *
 * 所有写操作能力在本文件内均被显式拒绝；门禁关闭时不会返回任何可用于签名的流程。
 */
const express = require('express');
const router = express.Router();
const { dbQuery } = require('@surf-ai/sdk/db');
const { loadLatestAuthorization } = require('../lib/tx-gate-state');
const { buildIntent } = require('../lib/tx-build');
const { simulate, checkSimulationUser } = require('../lib/tx-simulate');
const { preSignCheck } = require('../lib/tx-binding');
const { decodeForCheck } = require('../lib/tx-parse');
const { whitelistKeyOf } = require('../lib/tx-build');
const { assertTxAllowed, txGateStatus, evaluateTxRequest } = require('../config/tx-gate');
const { recordAttempt, loadGateState } = require('../lib/tx-gate-state');
const simulator = require('../lib/simulator');
const { getPrices } = require('../lib/prices');

/** BigInt 安全的 JSON 序列化（calldata 快照含 BigInt，直接 res.json 会抛错） */
function safeJson(obj) {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

router.get('/gate', async (_req, res) => {
  try {
    const state = await loadGateState();
    res.json({ gate: await txGateStatus(), state });
  } catch (e) {
    res.json({ gate: await txGateStatus(), state: null, stateError: String(e.message).slice(0, 200) });
  }
});

/** 操作预览：只读，复用 M2 的模拟器 */
router.post('/preview', async (req, res) => {
  try {
    const { type, user, mint, remove, collect } = req.body || {};
    if (type === 'mint') {
      const out = await simulator.simulateMint({ ...mint, owner: user });
      return res.json(safeJson({ type, preview: out }));
    }
    if (type === 'remove' || type === 'collect') {
      const out = await simulator.simulateRemove({ ...(remove || collect), owner: user });
      return res.json(safeJson({ type, preview: out }));
    }
    return res.status(400).json({ error: '不支持的预览类型（mint / remove / collect）' });
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/** 构造（build-only）：产出 calldata + 参数级校验快照 + 审计记录；不签名、不广播 */
router.post('/build', async (req, res) => {
  try {
    const body = req.body || {};
    const record = buildIntent(body);
    const prices = await getPrices().catch(() => null);
    record.quoteSnapshot = prices
      ? { source: 'lib/prices', at: new Date().toISOString(), prices: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, { usd: v.usd, at: v.at }])) }
      : null;

    let intentId = null;
    try {
      const { rows } = await dbQuery(
        `INSERT INTO tx_intents
           (chain_id, intent_type, user_addr, target_contract, selector, calldata_hash, calldata, actions,
            pool_id, pool_key, token_id, params, quote_snapshot, deadline, gate_version, key, amount_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          record.chainId, record.type, record.user, record.targetContract, record.selector,
          record.calldataHash, record.calldata, JSON.stringify(record.actions),
          record.poolId, JSON.stringify(record.poolKey), record.tokenId,
          JSON.stringify(record.params), JSON.stringify(record.quoteSnapshot), record.deadline, record.gateVersion,
          record.key, record.amountUsd != null ? String(record.amountUsd) : null,
        ]
      );
      intentId = rows[0].id;
      await dbQuery(
        `INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, actions, payload)
         VALUES ($1,$2,'build',$3,$4,$5,$6,$7,$8)`,
        [record.chainId, intentId, record.user, record.targetContract, record.selector, record.calldataHash,
          JSON.stringify(record.actions), JSON.stringify({ params: record.params, poolKey: record.poolKey, deadline: record.deadline })]
      );
    } catch (e) {
      record.auditError = String(e.message).slice(0, 200);
    }

    res.json(safeJson({
      intentId,
      intent: record,
      // 明确声明：本响应不包含任何签名请求，也不会触发钱包弹窗
      notes: ['build-only：未签名、未广播', 'calldata 已通过参数级白名单校验（spender / Permit2 / actions 语义）'],
    }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/** 只读预演：eth_call + Gas 估算 + 预检 */
router.post('/simulate', async (req, res) => {
  try {
    const { user, intentId, localEstimate } = req.body || {};
    if (!intentId) return res.status(400).json({ error: '缺少 intentId（请先调用 /api/tx/build）' });
    const { rows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${intentId} 不存在` });
    const it = rows[0];

    // P0-2：预演用户必须与 intent 用户一致（禁止用他人地址模拟）
    let simulationUser;
    try {
      simulationUser = checkSimulationUser(it.user_addr, user);
    } catch (e) {
      if (e.code === 'SIM_USER_MISMATCH') return res.status(403).json({ error: e.message });
      throw e;
    }

    const intentForPrecheck = {
      type: it.intent_type,
      params: it.params ? JSON.parse(it.params) : {},
      poolKey: it.pool_key ? JSON.parse(it.pool_key) : null,
    };
    const sim = await simulate({
      user: simulationUser,
      targetContract: it.target_contract,
      calldata: it.calldata,
      localEstimate: localEstimate || null,
      intent: intentForPrecheck,
    });
    sim.intentUser = it.user_addr;
    sim.simulationFrom = simulationUser;
    sim.precheckBlockNumber = sim.precheck ? sim.precheck.block : null;
    sim.precheckBlockHash = sim.precheck ? sim.precheck.blockHash : null;
    try {
      await dbQuery(
        `INSERT INTO tx_simulations
           (chain_id, intent_id, sim_block_number, sim_block_hash, state_block_number, rpc_endpoint,
            eth_call_ok, eth_call_result, gas_estimate, gas_price_gwei, gas_usd, precheck, local_estimate, deviation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          it.chain_id, intentId, sim.simBlockNumber, sim.simBlockHash, sim.stateBlockNumber, sim.rpcEndpoint,
          sim.ethCallOk ? 1 : 0, JSON.stringify({ result: sim.ethCallResult, revertReason: sim.revertReason }).slice(0, 4000),
          sim.gasEstimate, sim.gasPriceGwei != null ? String(sim.gasPriceGwei) : null, sim.gasUsd != null ? String(sim.gasUsd) : null,
          JSON.stringify(sim.precheck), JSON.stringify(sim.localEstimate), JSON.stringify(sim.deviation),
        ]
      );
      await dbQuery(
        `INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
         VALUES ($1,$2,'simulate',$3,$4,$5,$6,$7)`,
        [it.chain_id, intentId, simulationUser, it.target_contract, it.selector, it.calldata_hash,
          JSON.stringify({
            intentUser: it.user_addr,
            simulationFrom: simulationUser,
            simBlock: sim.simBlockNumber, simBlockHash: sim.simBlockHash,
            precheckBlock: sim.precheckBlockNumber, precheckBlockHash: sim.precheckBlockHash,
            ethCallOk: sim.ethCallOk, revertReason: sim.revertReason,
            gasEstimate: sim.gasEstimate, gasUsd: sim.gasUsd,
            precheckIssues: sim.precheck ? sim.precheck.issues : null,
          })]
      );
    } catch (e) {
      sim.auditError = String(e.message).slice(0, 200);
    }
    res.json(safeJson({ intentId, simulation: sim, notes: ['只读预演：eth_call / eth_estimateGas，未广播任何交易'] }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/**
 * 签名前核对（只读，M3.2 最终评审 P0-2）：
 * 用真实 calldata 重算哈希，并与「已授权绑定」逐项比对（intentId / chainId / to / value / calldataHash）。
 * 任何字段变化都必须重新 build → simulate → authorize；本接口不签名、不广播。
 */
router.post('/pre-sign-check', async (req, res) => {
  try {
    const { intentId, calldata, to, value = '0', chainId = null } = req.body || {};
    if (!intentId) return res.status(400).json({ error: '缺少 intentId' });
    const { rows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${intentId} 不存在` });
    const it = rows[0];

    const authorization = await loadLatestAuthorization({ intentId });
    if (!authorization) {
      return res.json({
        ok: false,
        reason: '该 intent 尚无门禁授权记录（未经过 authorizeTx），禁止签名',
        intentUser: it.user_addr,
      });
    }

    // 「当前交易」= intent 记录（权威）+ 本次请求 + 真实 calldata 解码结果
    const params = it.params ? JSON.parse(it.params) : {};
    const intentForDecode = { type: it.intent_type, params };
    const key = it.key || whitelistKeyOf(it.target_contract);
    let decoded = null;
    let decodeError = null;
    try {
      decoded = decodeForCheck({ calldata, key, intent: intentForDecode });
    } catch (e) {
      decodeError = String(e.message).slice(0, 300); // 解码失败 → 直接拒绝（fail-closed）
    }

    const current = {
      intentId: it.id,
      chainId: it.chain_id,
      to: to || it.target_contract,
      value: value != null ? String(value) : '0',
      selector: it.selector,
      key,
      intentType: it.intent_type,
      amountUsd: it.amount_usd != null ? Number(it.amount_usd) : null,
      deadline: it.deadline != null ? Number(it.deadline) : null,
      minOut: null,
      quoteBlock: null,
      simBlock: null,
      simBlockHash: null,
      actions: it.actions ? JSON.parse(it.actions) : null,
      poolId: it.pool_id,
    };

    if (decodeError) {
      return res.json(safeJson({
        ok: false,
        reason: `calldata 解码失败，禁止签名：${decodeError}`,
        intentUser: it.user_addr,
        notes: ['本接口只做核对，不签名、不广播'],
      }));
    }

    const check = preSignCheck({ authorization, current, calldata, decoded });
    res.json(safeJson({
      ok: Boolean(check.ok),
      reason: check.reason || null,
      changed: check.changed || null,
      calldataHash: check.calldataHash || null,
      authorizedAt: authorization.at,
      bindingHash: authorization.bindingHash,
      intentUser: it.user_addr,
      decoded: decoded ? { selector: decoded.selector, actions: decoded.actions, deadline: decoded.deadline, minOut: decoded.minOut } : null,
      notes: ['本接口只做核对，不签名、不广播', '任何字段变化都必须重新 build → simulate → authorize'],
    }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/**
 * 广播入口：M3.3 前**恒定返回门禁拒绝**。
 * 即使有人绕过前端直接调用，也只会得到拒绝原因；此处没有任何发送交易的代码路径。
 */
router.post('/broadcast', async (req, res) => {
  const body = req.body || {};
  let state = null;
  try { state = await loadGateState(); } catch { state = null; }
  const decision = evaluateTxRequest(
    { key: body.key || 'positionManager', selector: body.selector || '0xdd46508f', amountUsd: body.amountUsd, intentType: body.type },
    state || { now: Math.floor(Date.now() / 1000) }
  );
  try { await recordAttempt({ ...body, key: body.key || 'positionManager' }, decision); } catch { /* 审计失败不影响拒绝 */ }
  res.status(403).json({
    error: '交易门禁拒绝：M3.1 只读阶段不提供广播能力',
    decision,
    notes: ['广播路径在 M3.3 前不存在；本接口不会构造、签名或发送任何交易'],
  });
});

module.exports = router;
