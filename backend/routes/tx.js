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
const { simResultHashOf, buildPreSignCurrent } = require('../lib/tx-presign');
const { loadLatestSimulation, loadConsumedAuthorization, consumeAuthorization } = require('../lib/tx-gate-state');
const { whitelistKeyOf } = require('../lib/tx-build');
const { TX_GATE, assertTxAllowed, txGateStatus, evaluateTxRequest, authorizeTx } = require('../config/tx-gate');
const { CHAIN } = require('../config/whitelist');
const {
  preflightBroadcast, checkExistingBroadcast, sendRawTransactionOnce, fetchTxByHash, fetchReceipt,
  evaluateReceipt, classifyBroadcastFailure, rawTxFingerprint, verifyRawTxAgainstBinding, verifyOnChainTxAgainstBinding,
} = require('../lib/tx-broadcast');
const { computeBinding, bindingHashOf } = require('../lib/tx-binding');
const { computeGasPlan } = require('../lib/tx-gas');
const { tripKillSwitch } = require('../lib/tx-gate-state');
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

    // M3.3 review P0-2：simulate 阶段就把 Gas 参数固定下来（进入授权绑定）
    let hypeUsd = null;
    try { hypeUsd = (await getPrices()).HYPE?.usd ?? null; } catch { hypeUsd = null; }
    const plan = computeGasPlan({
      gasEstimate: sim.gasEstimate,
      gasPriceWei: sim.gasPriceGwei != null ? BigInt(Math.round(sim.gasPriceGwei * 1e9)) : null,
      hypeUsd,
    });
    sim.gasPlan = plan.ok ? plan.plan : null;
    sim.gasPlanError = plan.ok ? null : { code: plan.code, reason: plan.reason };
    if (plan.ok) sim.gasUsd = plan.plan.gasUsd; // 以「Gas 最坏成本」为准（gasLimit × maxFeePerGas）
    sim.precheckBlockNumber = sim.precheck ? sim.precheck.block : null;
    sim.precheckBlockHash = sim.precheck ? sim.precheck.blockHash : null;
    try {
      await dbQuery(
        `INSERT INTO tx_simulations
           (chain_id, intent_id, sim_block_number, sim_block_hash, state_block_number, rpc_endpoint,
            eth_call_ok, eth_call_result, gas_estimate, gas_price_gwei, gas_usd, precheck, local_estimate, deviation, sim_result_hash,
            gas_limit, max_fee_per_gas_wei, max_priority_fee_per_gas_wei, gas_plan_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          it.chain_id, intentId, sim.simBlockNumber, sim.simBlockHash, sim.stateBlockNumber, sim.rpcEndpoint,
          sim.ethCallOk ? 1 : 0, JSON.stringify({ result: sim.ethCallResult, revertReason: sim.revertReason }).slice(0, 4000),
          sim.gasEstimate, sim.gasPriceGwei != null ? String(sim.gasPriceGwei) : null, sim.gasUsd != null ? String(sim.gasUsd) : null,
          JSON.stringify(sim.precheck), JSON.stringify(sim.localEstimate), JSON.stringify(sim.deviation),
          simResultHashOf({
            ethCallOk: sim.ethCallOk, revertReason: sim.revertReason, gasEstimate: sim.gasEstimate,
            gasUsd: sim.gasUsd, simBlockNumber: sim.simBlockNumber, simBlockHash: sim.simBlockHash,
            precheckIssues: sim.precheck ? sim.precheck.issues : null,
          }),
          sim.gasPlan ? sim.gasPlan.gasLimit : null,
          sim.gasPlan ? sim.gasPlan.maxFeePerGasWei : null,
          sim.gasPlan ? sim.gasPlan.maxPriorityFeePerGasWei : null,
          sim.gasPlan ? sim.gasPlan.version : null,
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
    res.json(safeJson({
      intentId, simulation: sim,
      gasPlan: sim.gasPlan,
      notes: [
        '只读预演：eth_call / eth_estimateGas，未广播任何交易',
        'Gas 参数已在预演阶段锁定（gasLimit / maxFeePerGas / maxPriorityFeePerGas），签名时钱包不得自行抬高',
      ],
    }));
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

    const params = it.params ? JSON.parse(it.params) : {};
    const key = it.key || whitelistKeyOf(it.target_contract);
    const intentActions = it.actions ? JSON.parse(it.actions) : null;

    // 1) 真实 calldata 解码（失败即拒绝）
    let decoded = null;
    try {
      decoded = decodeForCheck({ calldata, key, intent: { type: it.intent_type, params } });
    } catch (e) {
      return res.json(safeJson({
        ok: false, reason: `calldata 解码失败，禁止签名：${String(e.message).slice(0, 300)}`,
        intentUser: it.user_addr, notes: ['本接口只做核对，不签名、不广播'],
      }));
    }

    // 2) 权威模拟数据（最新成功模拟）；缺失/过期/哈希缺失 → 直接拒绝，不用 null 补位
    const simulation = await loadLatestSimulation({ intentId });
    const built = buildPreSignCurrent({
      intent: { ...it, key }, simulation, request: { calldata, to, value, chainId },
      decoded, simMaxAgeSec: TX_GATE.limits.simMaxAgeSec,
    });
    if (!built.ok) {
      return res.json(safeJson({
        ok: false, reason: built.reason, intentUser: it.user_addr,
        simulation: simulation ? { simulationId: simulation.simulationId, at: simulation.at, simBlockHash: simulation.simBlockHash } : null,
        notes: ['本接口只做核对，不签名、不广播'],
      }));
    }

    // 3) 授权记录（按 intent + 绑定哈希 + 用户；已消费的单独提示）
    const authProbe = loadLatestAuthorization({ intentId, user: it.user_addr });
    const authorization = await authProbe;
    const consumed = await loadConsumedAuthorization({ intentId });
    if (!authorization) {
      return res.json(safeJson({
        ok: false,
        reason: consumed
          ? '该 intent 的授权已被消费（一次性授权），禁止再次签名/广播'
          : '该 intent 尚无门禁授权记录（未经过 authorizeTx），禁止签名',
        intentUser: it.user_addr,
        consumedAt: consumed ? consumed.consumed_at : null,
        notes: ['本接口只做核对，不签名、不广播'],
      }));
    }

    const check = preSignCheck({ authorization, current: built.current, calldata, decoded });
    res.json(safeJson({
      ok: Boolean(check.ok),
      reason: check.reason || null,
      changed: check.changed || null,
      calldataHash: check.calldataHash || null,
      bindingHash: authorization.bindingHash,
      authorizationId: authorization.attemptId,
      authorizedAt: authorization.at,
      intentUser: it.user_addr,
      simulation: { simulationId: simulation.simulationId, quoteBlock: built.current.quoteBlock, simBlock: built.current.simBlock, simBlockHash: built.current.simBlockHash, simResultHash: built.current.simResultHash, at: simulation.at },
      decoded: { selector: decoded.selector, actions: decoded.actions, deadline: decoded.deadline, minOut: decoded.minOut },
      notes: ['本接口只做核对，不签名、不广播', '任何字段变化都必须重新 build → simulate → authorize'],
    }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/**
 * 一次性消费授权（M3.2 第四轮评审 P0-2）：
 *   真正触发签名之前必须执行一次**不可重复**的消费步骤。
 *   流程：重建权威当前交易 → 完整核对 → 条件 UPDATE 消费（重复消费返回 0 行 → 拒绝）。
 *   本接口不签名、不广播，但会写入消费记录（谁、何时）。
 */
router.post('/consume-authorization', async (req, res) => {
  try {
    const { intentId, calldata, to, value = '0', chainId = null, actor = 'user' } = req.body || {};
    if (!intentId) return res.status(400).json({ error: '缺少 intentId' });
    const { rows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${intentId} 不存在` });
    const it = rows[0];

    const params = it.params ? JSON.parse(it.params) : {};
    const key = it.key || whitelistKeyOf(it.target_contract);
    let decoded = null;
    try {
      decoded = decodeForCheck({ calldata, key, intent: { type: it.intent_type, params } });
    } catch (e) {
      return res.status(400).json({ ok: false, reason: `calldata 解码失败，拒绝消费授权：${String(e.message).slice(0, 300)}` });
    }

    const simulation = await loadLatestSimulation({ intentId });
    const built = buildPreSignCurrent({
      intent: { ...it, key }, simulation, request: { calldata, to, value, chainId },
      decoded, simMaxAgeSec: TX_GATE.limits.simMaxAgeSec,
    });
    if (!built.ok) return res.status(409).json({ ok: false, reason: built.reason });

    const authorization = await loadLatestAuthorization({ intentId, user: it.user_addr });
    if (!authorization) {
      const consumed = await loadConsumedAuthorization({ intentId });
      return res.status(409).json({
        ok: false,
        reason: consumed ? '授权已被消费（一次性授权），拒绝重复消费' : '该 intent 尚无门禁授权记录（未经过 authorizeTx）',
      });
    }

    const check = preSignCheck({ authorization, current: built.current, calldata, decoded });
    if (!check.ok) return res.status(409).json({ ok: false, reason: check.reason, changed: check.changed || null });

    // 消费必须同时绑定 intentId + bindingHash + 用户地址
    if (String(authorization.bindingHash).toLowerCase() !== String(check.bindingHash).toLowerCase()) {
      return res.status(409).json({ ok: false, reason: '授权绑定哈希与当前交易不一致，拒绝消费' });
    }
    const consumed = await consumeAuthorization({ attemptId: authorization.attemptId, actor });
    if (!consumed.ok) return res.status(409).json({ ok: false, reason: consumed.reason });

    try {
      await dbQuery(
        `INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
         VALUES ($1,$2,'authorization-consumed',$3,$4,$5,$6,$7)`,
        [it.chain_id, intentId, it.user_addr, it.target_contract, it.selector, it.calldata_hash,
          JSON.stringify({ authorizationId: consumed.attemptId, bindingHash: consumed.bindingHash, consumedBy: consumed.consumedBy, at: consumed.consumedAt })]
      );
    } catch { /* 审计失败不影响消费结果（消费已落库，可查） */ }

    res.json(safeJson({
      ok: true,
      authorizationId: consumed.attemptId,
      bindingHash: consumed.bindingHash,
      consumedAt: consumed.consumedAt,
      consumedBy: consumed.consumedBy,
      intentUser: it.user_addr,
      notes: ['授权已一次性消费：重复消费/重复签名将被拒绝', '本接口不签名、不广播'],
    }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/**
 * 授权（M3.3 步骤：authorize 该具体 calldata）：
 *   用权威记录重建当前交易 → 走完整门禁（判断 → 原子占用额度 → 审计）。
 *   门禁关闭时本接口恒返回 403（当前状态）。
 *   注意：本路由**不得**注入自定义 config（有静态断言防止用「已开启副本」绕过门禁）。
 */
router.post('/authorize', async (req, res) => {
  try {
    const { intentId, calldata, to, value = '0', chainId = null, slippageBps = null, hasMinOut = true } = req.body || {};
    if (!intentId) return res.status(400).json({ error: '缺少 intentId' });

    // 门禁总闸先行：关闭状态直接拒绝（不进入任何构造/授权流程）
    const gateNow = await txGateStatus();
    if (!gateNow.enabled) {
      return res.status(403).json({ ok: false, code: 'GATE_CLOSED', reason: `交易总开关关闭（${gateNow.version}）——授权功能未解锁`, gate: gateNow, notes: ['门禁关闭：未产生任何授权'] });
    }
    if (!gateNow.unlockPath) {
      return res.status(403).json({ ok: false, code: 'NO_UNLOCK_RECORD', reason: '缺少解锁记录（官方确认或用户知情接受），拒绝授权', gate: gateNow });
    }
    const { rows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${intentId} 不存在` });
    const it = rows[0];

    const params = it.params ? JSON.parse(it.params) : {};
    const key = it.key || whitelistKeyOf(it.target_contract);
    let decoded = null;
    try {
      decoded = decodeForCheck({ calldata: calldata || it.calldata, key, intent: { type: it.intent_type, params } });
    } catch (e) {
      return res.status(400).json({ ok: false, error: `calldata 解码失败，拒绝授权：${String(e.message).slice(0, 300)}` });
    }

    const simulation = await loadLatestSimulation({ intentId });
    const built = buildPreSignCurrent({
      intent: { ...it, key }, simulation, request: { calldata: calldata || it.calldata, to: to || it.target_contract, value, chainId },
      decoded, simMaxAgeSec: TX_GATE.limits.simMaxAgeSec,
    });
    if (!built.ok) return res.status(409).json({ ok: false, reason: built.reason });

    const nowSec = Math.floor(Date.now() / 1000);
    const quoteSnapshot = it.quote_snapshot ? JSON.parse(it.quote_snapshot) : null;
    const quoteAgeSec = quoteSnapshot && quoteSnapshot.at ? Math.max(0, nowSec - Math.floor(new Date(quoteSnapshot.at).getTime() / 1000)) : null;

    let decision;
    try {
      decision = await authorizeTx({
        key, selector: it.selector, intentType: it.intent_type, intentId: Number(intentId),
        amountUsd: it.amount_usd != null ? Number(it.amount_usd) : null, user: it.user_addr,
        chainId: CHAIN.id, to: it.target_contract, value: String(value || '0'), calldataHash: it.calldata_hash,
        deadline: built.current.deadline, minOut: built.current.minOut,
        quoteBlock: built.current.quoteBlock, simBlock: built.current.simBlock,
        simBlockHash: built.current.simBlockHash, simResultHash: built.current.simResultHash,
        actions: built.current.actions, poolId: built.current.poolId,
        gasLimit: built.current.gasLimit, maxFeePerGas: built.current.maxFeePerGas,
        maxPriorityFeePerGas: built.current.maxPriorityFeePerGas,
        slippageBps, hasMinOut: hasMinOut === true, gasPriceGwei: simulation.gasPriceGwei,
        gasUsd: built.current.gasUsd != null ? built.current.gasUsd : simulation.gasUsd,
        quoteAgeSec, priceImpactPct: null,
      });
    } catch (e) {
      const d = e.decision || { ok: false, code: e.code || 'AUTHORIZE_FAILED', reason: String(e.message) };
      return res.status(403).json({ ok: false, code: d.code, reason: d.reason, gate: await txGateStatus(), notes: ['门禁拒绝即未授权；不得签名、不得广播'] });
    }

    res.json(safeJson({
      ok: true, authorizationId: decision.attemptId, bindingHash: decision.bindingHash, binding: decision.binding,
      quota: decision.quota, gateVersion: decision.gateVersion,
      notes: ['已授权：授权绑定这份完整交易内容', '授权必须一次性消费后才能广播'],
    }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/**
 * 广播（M3.3）—— 唯一的写路径，且必须满足全部前置条件：
 *   门禁开启 + 解锁记录 + 熔断未触发 + 授权**已一次性消费**（且未超时）+ 内容与绑定一致。
 *   方式一 wallet-sign-raw：钱包只签名 → 后端核对签名交易 → 后端广播（一次性，不重试）。
 *   方式二 wallet-sent：钱包内确认并广播 → 后端按哈希事后核对。
 * 门禁关闭时恒返回 403（当前状态：不存在可用广播路径）。
 */
router.post('/broadcast', async (req, res) => {
  const body = req.body || {};
  const { intentId, mode = null, rawTx = null, txHash = null, calldata = null, to = null, value = '0', chainId = null } = body;
  if (!intentId) return res.status(400).json({ error: '缺少 intentId' });
  let it = null;
  try {
    const { rows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${intentId} 不存在` });
    it = rows[0];
  } catch (e) {
    return res.status(500).json({ error: `无法读取 intent：${String(e.message).slice(0, 200)}` });
  }

  const gate = await txGateStatus();
  const params = it.params ? JSON.parse(it.params) : {};
  const key = it.key || whitelistKeyOf(it.target_contract);
  const usedCalldata = calldata || it.calldata;

  let decoded = null;
  try {
    decoded = decodeForCheck({ calldata: usedCalldata, key, intent: { type: it.intent_type, params } });
  } catch (e) {
    return res.status(400).json({ ok: false, error: `calldata 解码失败：${String(e.message).slice(0, 300)}` });
  }
  const simulation = await loadLatestSimulation({ intentId });
  const built = buildPreSignCurrent({
    intent: { ...it, key }, simulation, request: { calldata: usedCalldata, to: to || it.target_contract, value, chainId },
    decoded, simMaxAgeSec: TX_GATE.limits.simMaxAgeSec,
  });

  // 广播前置检查（纯函数，逐条拒绝原因都可在测试中复现）
  const authorization = await loadLatestAuthorization({ intentId, user: it.user_addr, includeConsumed: true });
  const pf = preflightBroadcast({
    gate: { ...gate, firstTxMode: gate.firstTxMode === true },
    authorization: authorization ? { status: authorization.status, bindingHash: authorization.bindingHash, consumedAt: authorization.consumedAt } : null,
    bindingHash: built.ok ? bindingHashOf(computeBinding({ ...built.current, calldataHash: it.calldata_hash })) : null,
    mode, rawTx, txHash, limits: TX_GATE.limits,
  });
  if (!pf.ok) {
    try {
      await recordAttempt({ key, selector: it.selector, intentType: it.intent_type, intentId: Number(intentId), user: it.user_addr, amountUsd: it.amount_usd != null ? Number(it.amount_usd) : null }, { ok: false, code: pf.code, reason: pf.reason, gateVersion: TX_GATE.version });
      await dbQuery(`INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
                     VALUES ($1,$2,'broadcast-rejected',$3,$4,$5,$6,$7)`,
        [it.chain_id, intentId, it.user_addr, it.target_contract, it.selector, it.calldata_hash, JSON.stringify({ code: pf.code, reason: pf.reason, mode })]);
    } catch { /* 审计失败不改变拒绝结果 */ }
    return res.status(403).json({ ok: false, code: pf.code, reason: pf.reason, gate, notes: ['广播被拒绝：未发出任何交易'] });
  }
  if (!built.ok) return res.status(409).json({ ok: false, code: 'PRESIGN_FAILED', reason: built.reason });

  // 同一 intent 只允许一笔广播
  try {
    const { rows } = await dbQuery('SELECT id, tx_hash, status FROM tx_broadcasts WHERE intent_id = $1', [intentId]);
    const single = checkExistingBroadcast(rows);
    if (!single.ok) return res.status(409).json({ ok: false, code: single.code, reason: single.reason });
  } catch (e) {
    return res.status(503).json({ ok: false, code: 'BROADCAST_STORE_UNAVAILABLE', reason: `无法确认是否已广播，已拒绝：${String(e.message).slice(0, 200)}` });
  }

  const binding = computeBinding({ ...built.current, calldataHash: it.calldata_hash });
  const rpcUrl = CHAIN.rpcEndpoints.filter((e) => e.enabled).sort((a, b) => (a.priority || 9) - (b.priority || 9))[0].url;
  // Gas 美元上限复核需要 HYPE 价格；取不到 → 核对失败（fail-closed，不做事后补偿）
  let hypeUsd = null;
  try { hypeUsd = (await getPrices()).HYPE?.usd ?? null; } catch { hypeUsd = null; }

  let result;
  if (mode === 'wallet-sign-raw') {
    // 发送前核对：签名交易必须与授权绑定完全一致（含 Gas 参数）
    const check = await verifyRawTxAgainstBinding({ rawTx, binding, user: it.user_addr, limits: TX_GATE.limits, hypeUsd });
    if (!check.ok) {
      await tripKillSwitch({ reason: `签名交易与授权绑定不一致（${check.code}）：${check.reason}`, actor: 'broadcast-guard' }).catch(() => {});
      await dbQuery(`INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
                     VALUES ($1,$2,'broadcast-rejected',$3,$4,$5,$6,$7)`,
        [it.chain_id, intentId, it.user_addr, it.target_contract, it.selector, it.calldata_hash, JSON.stringify({ code: check.code, reason: check.reason })]).catch(() => {});
      return res.status(409).json({ ok: false, code: check.code, reason: check.reason, notes: ['签名交易未通过核对：已拒绝广播并触发熔断'] });
    }
    result = await sendRawTransactionOnce({ rawTx, rpcUrl });
  } else {
    const tx = await fetchTxByHash({ txHash, rpcUrl });
    const check = verifyOnChainTxAgainstBinding({ tx, binding, user: it.user_addr, limits: TX_GATE.limits, hypeUsd });
    if (!check.ok) {
      await tripKillSwitch({ reason: `链上交易与授权绑定不一致（${check.code}）：${check.reason}`, actor: 'broadcast-guard' }).catch(() => {});
      result = { ok: false, code: check.code, reason: check.reason, ambiguous: false };
    } else {
      result = { ok: true, txHash, rpcUrl, verifiedOnChain: true };
    }
  }

  let broadcastId = null;
  const failure = result.ok ? null : classifyBroadcastFailure(result);
  try {
    const { rows } = await dbQuery(
      `INSERT INTO tx_broadcasts (chain_id, intent_id, user_addr, mode, binding_hash, raw_tx_fingerprint, tx_hash, status, verification, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [it.chain_id, intentId, it.user_addr, mode, bindingHashOf(binding), rawTxFingerprint(rawTx),
        result.txHash || txHash || null, result.ok ? 'submitted' : 'rejected',
        JSON.stringify({ preflight: pf, mode }), result.ok ? null : `${result.code}: ${result.reason}`]
    );
    broadcastId = rows[0].id;
    await dbQuery(`INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [it.chain_id, intentId, result.ok ? 'broadcast' : 'broadcast-failed', it.user_addr, it.target_contract, it.selector, it.calldata_hash,
        JSON.stringify({ broadcastId, mode, txHash: result.txHash || txHash || null, code: result.code || null, reason: result.reason || null })]);
  } catch (e) {
    return res.status(500).json({ ok: false, code: 'BROADCAST_RECORD_FAILED', reason: `广播记录写入失败：${String(e.message).slice(0, 200)}`, txHash: result.txHash || txHash || null });
  }

  if (!result.ok && failure.tripKillSwitch) {
    await tripKillSwitch({ reason: `${failure.reason}（${result.code}）`, actor: 'broadcast-guard' }).catch(() => {});
  }

  if (!result.ok) {
    return res.status(409).json({ ok: false, code: result.code, reason: result.reason, broadcastId, killSwitchTripped: failure.tripKillSwitch, notes: ['广播失败：未自动重试，禁止自动重发'] });
  }
  res.json(safeJson({
    ok: true, broadcastId, txHash: result.txHash, mode, bindingHash: bindingHashOf(binding),
    notes: ['已广播一次（不重试、不加速、不替换）', '请继续调用 /api/tx/receipt 跟踪回执'],
  }));
});

/**
 * 回执跟踪与核对（M3.3 步骤 9-11）：轮询回执（只读）→ 核对 → 失败熔断 → 写审计。
 * 轮询 ≠ 重发：本接口只读回执，绝不重新发送交易。
 */
router.post('/receipt', async (req, res) => {
  try {
    const { broadcastId = null, txHash = null, hypeUsd = null } = req.body || {};
    let row = null;
    if (broadcastId) {
      const { rows } = await dbQuery('SELECT * FROM tx_broadcasts WHERE id = $1', [broadcastId]);
      row = rows[0] || null;
    } else if (txHash) {
      const { rows } = await dbQuery('SELECT * FROM tx_broadcasts WHERE tx_hash = $1', [txHash]);
      row = rows[0] || null;
    }
    if (!row) return res.status(404).json({ error: '找不到对应的广播记录（请提供 broadcastId 或 txHash）' });
    if (!row.tx_hash) return res.status(409).json({ ok: false, code: 'NO_TX_HASH', reason: '该广播记录没有交易哈希（广播未成功），无回执可查' });

    const { rows: intentRows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [row.intent_id]);
    if (!intentRows.length) return res.status(404).json({ error: 'intent 记录缺失' });
    const it = intentRows[0];
    // 授权绑定（用于回执核对：链上交易内容必须与授权内容一致）
    const auth = await loadLatestAuthorization({ intentId: row.intent_id, includeConsumed: true });
    const binding = auth ? auth.binding : null;

    const rpcUrl = CHAIN.rpcEndpoints.filter((e) => e.enabled).sort((a, b) => (a.priority || 9) - (b.priority || 9))[0].url;
    const receipt = await fetchReceipt({ txHash: row.tx_hash, rpcUrl, attempts: 6, pollMs: 2000 });
    const tx = await fetchTxByHash({ txHash: row.tx_hash, rpcUrl });

    let hype = hypeUsd;
    if (hype == null) {
      try { hype = (await getPrices()).HYPE?.usd ?? null; } catch { hype = null; }
    }

    const evaluated = evaluateReceipt({ receipt, tx, binding, user: it.user_addr, limits: TX_GATE.limits, hypeUsd: hype });
    const status = evaluated.pending ? row.status : (evaluated.ok ? 'confirmed' : (evaluated.code === 'RECEIPT_REVERTED' ? 'reverted' : 'verification_failed'));

    await dbQuery(
      `UPDATE tx_broadcasts SET status = $2, receipt_status = $3, block_number = $4, gas_used = $5, gas_usd = $6, verification = $7, updated_at = now() WHERE id = $1`,
      [row.id, status, evaluated.receipt ? evaluated.receipt.status : null,
        evaluated.receipt ? evaluated.receipt.blockNumber : null, evaluated.receipt ? evaluated.receipt.gasUsed : null,
        evaluated.gasUsd != null ? String(evaluated.gasUsd) : null, JSON.stringify({ evaluated: { ok: evaluated.ok, code: evaluated.code || null, deviations: evaluated.deviations || [] } })]
    );
    await dbQuery(`INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [it.chain_id, row.intent_id, evaluated.pending ? 'receipt-pending' : (evaluated.ok ? 'receipt-confirmed' : 'receipt-failed'),
        it.user_addr, it.target_contract, it.selector, it.calldata_hash,
        JSON.stringify({ broadcastId: row.id, txHash: row.tx_hash, code: evaluated.code || null, receipt: evaluated.receipt || null, gasUsd: evaluated.gasUsd ?? null })]);

    if (evaluated.tripKillSwitch) {
      await tripKillSwitch({ reason: `交易回执核对失败（${evaluated.code}）：${evaluated.reason}`, actor: 'receipt-guard' }).catch(() => {});
    }

    res.json(safeJson({
      ok: Boolean(evaluated.ok), pending: Boolean(evaluated.pending), code: evaluated.code || null, reason: evaluated.reason || null,
      broadcastId: row.id, txHash: row.tx_hash, status, receipt: evaluated.receipt || null, gasUsd: evaluated.gasUsd ?? null,
      deviations: evaluated.deviations || [], requiresReview: Boolean(evaluated.requiresReview), killSwitchTripped: Boolean(evaluated.tripKillSwitch),
      notes: ['本接口只读回执，不会重新发送交易'],
    }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

/**
 * 签名前重新核对（M3.3 review 第二轮 P0-1）：
 *   每次点击签名之前，前端必须调用本接口**重新读取服务端最新状态**，不得依赖页面上的旧状态。
 *   服务端在此处重新读取：门禁状态（含熔断、持久化来源）、该 intent 的授权状态与消费时间、
 *   以及完整的签名前核对（权威模拟记录 + 真实 calldata + 绑定比对），
 *   并把这份快照写入审计（pre-sign-verified / pre-sign-rejected）。
 *   本接口不签名、不广播；任何读取失败都返回 ok:false（fail-closed）。
 */
router.post('/pre-sign-audit', async (req, res) => {
  try {
    const { intentId, calldata = null, to = null, value = '0', walletAccount = null, walletChainId = null } = req.body || {};
    if (!intentId) return res.status(400).json({ error: '缺少 intentId' });

    // 1) 门禁状态（重新读取，绝不使用缓存）
    let gate = null;
    try { gate = await txGateStatus(); } catch (e) {
      return res.status(503).json({ ok: false, code: 'GATE_STATE_UNAVAILABLE', reason: `门禁状态读取失败：${String(e.message).slice(0, 200)}`, notes: ['拒绝签名'] });
    }

    const { rows } = await dbQuery('SELECT * FROM tx_intents WHERE id = $1', [intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${intentId} 不存在` });
    const it = rows[0];
    const params = it.params ? JSON.parse(it.params) : {};
    const key = it.key || whitelistKeyOf(it.target_contract);
    const usedCalldata = calldata || it.calldata;

    // 2) 授权状态（重新读取：可消费 / 已消费 / 已消费但超时）
    let auth = null;
    let authError = null;
    try { auth = await loadLatestAuthorization({ intentId, user: it.user_addr, includeConsumed: true }); }
    catch (e) { authError = String(e.message).slice(0, 200); }

    const consumedMs = auth && auth.consumedAt ? new Date(auth.consumedAt).getTime() : null;
    const consumeAgeSec = consumedMs != null && Number.isFinite(consumedMs) ? Math.floor((Date.now() - consumedMs) / 1000) : null;
    const maxConsumeAge = TX_GATE.limits.broadcastConsumeMaxAgeSec;

    // 3) 完整签名前核对（权威记录重建）
    let check = { ok: false, reason: '未执行' };
    let decoded = null;
    try {
      decoded = decodeForCheck({ calldata: usedCalldata, key, intent: { type: it.intent_type, params } });
      const simulation = await loadLatestSimulation({ intentId });
      const built = buildPreSignCurrent({
        intent: { ...it, key }, simulation, request: { calldata: usedCalldata, to: to || it.target_contract, value, chainId: null },
        decoded, simMaxAgeSec: TX_GATE.limits.simMaxAgeSec,
      });
      if (!built.ok) check = { ok: false, reason: built.reason, code: 'PRESIGN_REBUILD_FAILED' };
      else if (!auth) check = { ok: false, reason: '该 intent 尚无授权记录（未经过 authorize）', code: 'NO_AUTHORIZATION' };
      else check = preSignCheck({ authorization: auth, current: built.current, calldata: usedCalldata, decoded });
    } catch (e) {
      check = { ok: false, reason: `签名前核对异常：${String(e.message).slice(0, 200)}`, code: 'PRESIGN_ERROR' };
    }

    // 逐项判定（顺序即优先级；任一项不满足 → 拒绝签名）
    let ok = true;
    let reason = null;
    const fail = (r) => { if (ok) { ok = false; reason = r; } };
    if (!gate.enabled) fail('交易门禁关闭');
    if (!gate.unlockPath) fail('缺少解锁记录');
    if (gate.killSwitchTripped !== false) fail('熔断状态异常或已触发（未知 = 拒绝）');
    if (gate.stateUnavailable) fail('门禁持久化状态不可读');
    if (authError) fail(`授权状态读取失败：${authError}`);
    if (!auth) fail('该 intent 尚无授权记录');
    else if (auth.status !== 'consumed') fail(`授权状态为 ${auth.status}（未完成一次性消费）`);
    if (auth && consumeAgeSec == null) fail('授权消费时间缺失');
    if (auth && consumeAgeSec != null && consumeAgeSec > maxConsumeAge) {
      fail(`授权消费已过去 ${consumeAgeSec}s（上限 ${maxConsumeAge}s），必须重新走完整流程`);
    }
    if (!check.ok) fail(check.reason || '签名前核对未通过');

    // 签名用载荷：**签名那一刻**从权威记录取出的字节，前端不得使用页面旧状态
    let signing = null;
    if (ok) {
      try {
        const simulation = await loadLatestSimulation({ intentId });
        const built = buildPreSignCurrent({
          intent: { ...it, key }, simulation, request: { calldata: usedCalldata, to: to || it.target_contract, value, chainId: null },
          decoded, simMaxAgeSec: TX_GATE.limits.simMaxAgeSec,
        });
        signing = built.ok ? {
          chainId: built.current.chainId,
          to: built.current.to,
          value: built.current.value,
          calldata: usedCalldata,
          calldataHash: it.calldata_hash,
          selector: built.current.selector,
          gasLimit: built.current.gasLimit,
          maxFeePerGas: built.current.maxFeePerGas,
          maxPriorityFeePerGas: built.current.maxPriorityFeePerGas,
          bindingHash: auth.bindingHash,
        } : null;
      } catch { signing = null; }
    }

    const snapshot = {
      at: new Date().toISOString(),
      gate: { version: gate.version, enabled: gate.enabled, unlockPath: gate.unlockPath, killSwitchTripped: gate.killSwitchTripped, stateSource: gate.stateSource, firstTxMode: gate.firstTxMode },
      authorization: auth ? { id: auth.attemptId, status: auth.status, bindingHash: auth.bindingHash, consumedAt: auth.consumedAt, consumeAgeSec } : null,
      bindingHash: auth ? auth.bindingHash : null,
      preSign: { ok: Boolean(check.ok), reason: check.reason || null, changed: check.changed || null },
      walletAccount: walletAccount || null,
      walletChainId: walletChainId != null ? Number(walletChainId) : null,
      intentUser: it.user_addr,
    };
    try {
      await dbQuery(
        `INSERT INTO tx_audit (chain_id, intent_id, event, user_addr, target_contract, selector, calldata_hash, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [it.chain_id, intentId, ok ? 'pre-sign-verified' : 'pre-sign-rejected', it.user_addr, it.target_contract, it.selector, it.calldata_hash, JSON.stringify(snapshot)]
      );
    } catch (e) {
      // 审计写入失败 → fail-closed（拒绝签名）
      return res.status(503).json({ ok: false, code: 'PRESIGN_AUDIT_FAILED', reason: `签名前快照写入审计失败，拒绝签名：${String(e.message).slice(0, 200)}` });
    }

    res.json(safeJson({
      ok, reason, snapshot, signing,
      notes: [
        '本接口只重新读取与核对，不签名、不广播',
        ok ? '状态新鲜且一致，可以请求钱包签名（请使用返回的 signing 载荷，不要使用页面旧状态）' : '拒绝签名：状态过期/不一致',
      ],
    }));
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message).slice(0, 400) });
  }
});

/** 授权状态查询（只读，供前端在签名前重新读取） */
router.get('/authorization-state/:intentId', async (req, res) => {
  try {
    const { rows } = await dbQuery('SELECT id, user_addr FROM tx_intents WHERE id = $1', [req.params.intentId]);
    if (!rows.length) return res.status(404).json({ error: `intent ${req.params.intentId} 不存在` });
    const auth = await loadLatestAuthorization({ intentId: req.params.intentId, user: rows[0].user_addr, includeConsumed: true });
    const consumedMs = auth && auth.consumedAt ? new Date(auth.consumedAt).getTime() : null;
    res.json(safeJson({
      intentId: Number(req.params.intentId),
      authorization: auth ? {
        id: auth.attemptId, status: auth.status, bindingHash: auth.bindingHash, user: auth.user,
        consumedAt: auth.consumedAt, consumedBy: auth.consumedBy,
        consumeAgeSec: consumedMs != null && Number.isFinite(consumedMs) ? Math.floor((Date.now() - consumedMs) / 1000) : null,
        maxConsumeAgeSec: TX_GATE.limits.broadcastConsumeMaxAgeSec,
      } : null,
      notes: ['只读：本接口不消费、不签名、不广播'],
    }));
  } catch (e) {
    res.status(500).json({ error: String(e.message).slice(0, 300) });
  }
});

/** 广播记录查询（只读，供前端展示） */
router.get('/broadcasts/:intentId', async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT id, intent_id, mode, tx_hash, status, receipt_status, block_number, gas_used, gas_usd, error, created_at, updated_at
         FROM tx_broadcasts WHERE intent_id = $1 ORDER BY id DESC`, [req.params.intentId]
    );
    res.json(safeJson({ intentId: Number(req.params.intentId), broadcasts: rows }));
  } catch (e) {
    res.status(400).json({ error: String(e.message).slice(0, 400) });
  }
});

module.exports = router;
