/**
 * M3 交易门禁（Transaction Gate）—— 唯一的写操作总开关。
 *
 * ⚠️ 当前状态：全部关闭。未经 review，不得把 enabled 置为 true，也不得把任何 writeEnabled 置为 true。
 *
 * 本模块分两层：
 *   - evaluateTxRequest(req, state)  —— **纯函数**：所有限制的真实判断逻辑（可离线单测，覆盖每条边界）
 *   - assertTxAllowed(req, deps)     —— 异步门禁：从持久化状态（DB）读取计数与熔断状态后调用上面的纯函数
 *
 * review 要求（M3.2 前必须补齐）：
 *   [x] 强制检查 maxGasUsd
 *   [x] 强制检查 dailyMaxUsd
 *   [x] 强制检查每分钟 / 每日交易数
 *   [x] killSwitch 提供 trip() / clear()，clear 必须要求人工复核记录
 *   [x] 熔断状态持久化（由 lib/tx-gate-state.js 提供，非进程内存）
 *   [x] 真实 assertTxAllowed 的边界测试（tests/tx-gate.test.js 直接调用真实函数）
 *   [x] 额度/频率为**原子占用**（条件 UPDATE + 行锁，见 lib/tx-gate-state.js reserveQuota；并发测试 tests/tx-gate-concurrency.test.js）
 *   [x] 审计失败 → 门禁拒绝（fail-closed）：authorizeTx() 在审计写入失败时释放额度并拒绝
 *   [x] txGateStatus() 读取**持久化**熔断状态，不再返回静态配置值
 *   [x] 交易内容级绑定（intentId / chainId / to / value / calldataHash）——授权不得被复用到别的交易
 */
const { CONTRACTS, TOKENS, CHAIN } = require('./whitelist');
const { computeBinding, bindingHashOf, assertBindingComplete } = require('../lib/tx-binding');

const GATE_VERSION = 'M3-gate-4';

const TX_GATE = {
  version: GATE_VERSION,
  enabled: false, // 总开关：M3 交易开关。未经 review 不得置 true。
  stage: 'M3',
  unlockRequires: {
    identityPath: [
      'A. 官方渠道确认 PositionManager 身份（官方公告/文档/仓库声明）',
      'B. 用户知情接受（书面记录：用户明确知晓 PM 归属未获官方确认的风险，同意小额首笔）',
    ],
    hardConditions: [
      '全部安全上限配置完成并通过测试（本文件 limits 段）',
      '首笔小额模式已启用（firstTxMode=true）',
      '前端/后端运行时拦截器保持启用，且支持「一键全关」',
      '交易预演（eth_call）与链上状态一致性检查通过',
      '逐笔用户签名流程可用，且无任何自动重发/自动加速/自动放宽滑点分支',
      '参数级白名单（approve spender / Permit2 / modifyLiquidities actions）校验通过',
    ],
  },
  unlockRecord: {
    path: null, // 'official-confirmed' | 'user-informed-acceptance' | null
    recordedAt: null,
    recordedBy: null,
    note: null,
  },
  firstTxMode: true, // 首笔未完成前保持 true（更严格上限）

  limits: {
    firstTxMaxUsd: 20,
    perTxMaxUsd: 100,
    dailyMaxUsd: 300,
    maxSlippageBps: 100, // 1%
    requireMinOut: true,
    maxGasPriceGwei: 5,
    maxGasUsd: 1, // Gas 总成本上限（不是只看单价）
    quoteMaxAgeSec: 30,
    maxPriceImpactPct: 2,
    poolAgeWarnDays: 7,
    maxTxPerMinute: 1,
    maxTxPerDay: 3,
    maxDeadlineSec: 1800, // deadline 不得超过 30 分钟
    simMaxAgeSec: 300, // 模拟结果有效期（签名前必须使用新鲜的成功模拟）
    broadcastConsumeMaxAgeSec: 180, // 授权消费后必须在 3 分钟内广播（超时需重新走完整流程）
    // —— Gas 计划（M3.3 review P0-2）：签名前必须锁定 gasLimit / maxFeePerGas / maxPriorityFeePerGas ——
    gasLimitMarginBps: 2500, // gasLimit = eth_estimateGas × (1 + 25%)，固定且文档化，不允许钱包自行决定
    minGasLimit: 50000, // gasLimit 下限（避免预估偏低导致 out of gas；成本仍受 gasLimit × maxFee 约束）
    maxPriorityFeeGwei: 1, // maxPriorityFeePerGas 上限（同时必须 ≤ maxFeePerGas）
  },

  /**
   * Gas 绑定规则（实现见 lib/tx-gas.js）：
   *   gasLimit        = max(ceil(estimate × (1 + gasLimitMarginBps/10000)), minGasLimit)
   *   maxFeePerGas    = 链上 eth_gasPrice（必须 ≤ maxGasPriceGwei）
   *   maxPriorityFee  = min(maxFeePerGas, maxPriorityFeeGwei)
   *   Gas 美元上限     = gasLimit × maxFeePerGas × HYPE 价格 ≤ maxGasUsd
   * 签名交易若 gasLimit / maxFeePerGas / maxPriorityFeePerGas 超过绑定值 → 直接拒绝（不做事后补偿）。
   */
  gasBinding: {
    fields: ['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasUsd'],
    strictEquality: true, // 实际交易的 Gas 参数必须**等于**绑定值（不是「不超过」）
    txType: 'eip1559', // Gas 计划为 EIP-1559；legacy 交易一律拒绝（禁止降级混用）
    rejectCodes: [
      'GAS_ESTIMATE_MISSING', 'GAS_PRICE_MISSING', 'HYPE_PRICE_MISSING',
      'GAS_LIMIT_MISSING', 'GAS_LIMIT_MISMATCH', 'MAX_FEE_MISMATCH', 'PRIORITY_FEE_MISMATCH',
      'GAS_PRICE_OVER', 'PRIORITY_FEE_ABOVE_MAX_FEE', 'GAS_USD_OVER',
      'TX_TYPE_MISSING', 'TX_TYPE_MISMATCH',
    ],
  },

  /**
   * M3.3 手动签名与广播（声明式约束；实现见 lib/tx-broadcast.js / lib/tx-wallet-tx.js）。
   * 两种方式都必须：门禁开启 + 解锁记录 + 熔断未触发 + 授权**已一次性消费** + 内容与绑定完全一致。
   */
  broadcast: {
    modes: {
      'wallet-sign-raw': '钱包只签名（不广播）→ 后端核对签名交易内容 → 后端广播（可发送前核对）',
      'wallet-sent': '钱包内确认并广播 → 后端按交易哈希事后核对内容（用户手动操作，非自动）',
    },
    hardFailures: [
      '广播 RPC 异常 / 结果未知（可能已进入内存池）→ 熔断，人工确认，禁止自动重发',
      '回执 status != success（交易回滚）→ 熔断',
      '链上交易内容与授权绑定不一致（事后核对）→ 熔断',
      '同一 intent 出现第二笔广播 → 拒绝',
    ],
    presignAudit: {
      // 签名前重新核对：服务端重新读取门禁 / 授权 / 核对结果，并判定钱包账户与链一致性
      rejectCodes: [
        'PRESIGN_REBUILD_FAILED', 'PRESIGN_ERROR', 'PRESIGN_AUDIT_FAILED', 'NO_AUTHORIZATION',
        'WALLET_ACCOUNT_MISMATCH', 'WALLET_ACCOUNT_MISSING', 'WALLET_CHAIN_MISMATCH', 'WALLET_CHAIN_MISSING',
      ],
    },
    firstTx: {
      allowedModes: ['wallet-sign-raw'], // 首笔模式只允许「钱包只签名 → 后端核对 → 后端广播」
      disabledModes: ['wallet-sent'], // 先广播后核对，内容有误无法撤回 → 首笔禁用（服务端强制）
    },
    noAuto: [
      '不自动重发、不自动加速（speed-up）、不自动替换交易',
      '不自动放宽滑点、不自动降低 minOut',
      '不自动重试广播（广播调用一次即结束，超时按「结果未知」处理）',
      '不托管私钥、不保存助记词、不代替用户签名',
    ],
  },

  /**
   * 允许的 (合约 → 函数选择器) 白名单；参数级语义由 lib/tx-parse.js 校验。
   * writeEnabled 必须与 config/whitelist.js 同步（tests/tx-gate.test.js 有同步断言）。
   */
  allowedCalls: {
    KNTQ: { address: TOKENS.KNTQ.address, writeEnabled: false, selectors: { '0x095ea7b3': 'approve(address,uint256)' } },
    WHYPE: { address: TOKENS.WHYPE.address, writeEnabled: false, selectors: { '0x095ea7b3': 'approve(address,uint256)' } },
    USDC: { address: TOKENS.USDC.address, writeEnabled: false, selectors: { '0x095ea7b3': 'approve(address,uint256)' } },
    permit2: {
      address: CONTRACTS.permit2.address,
      writeEnabled: false,
      selectors: { '0x87517c45': 'approve(address,address,uint160,uint48)' },
    },
    positionManager: {
      address: CONTRACTS.positionManager.address,
      writeEnabled: false,
      selectors: { '0xdd46508f': 'modifyLiquidities(bytes,uint256)' },
    },
  },

  forbidden: [
    '自动重发 / 自动加速（speed-up）/ 自动替换交易',
    '自动放宽滑点或自动降低 minOut',
    '托管私钥 / 保存助记词 / 代替用户签名',
    '闪电贷 / 杠杆 / 借贷类操作',
    '未在白名单中的合约调用、任意 calldata 透传、delegatecall',
    '批量无人值守交易（cron 自动下单）',
    'multicall 透传与 Permit2 permit（签名代发）',
  ],

  killSwitch: {
    tripped: false, // 运行时以持久化状态为准（lib/tx-gate-state.js）
    triggers: [
      '模拟结果与链上状态不一致',
      '报价过期或价格影响超过上限',
      '检测到链上重组影响头寸/池状态',
      'RPC 端点全部不可用或响应异常',
      '同一分钟内出现第 2 笔写操作请求',
      '任何一笔交易回滚后（需人工复核后才可再开）',
    ],
  },
};

function _findAllowed(key) {
  return TX_GATE.allowedCalls[key] || null;
}

/**
 * 纯函数门禁判断。state 快照由持久化层提供：
 *   { killSwitch: { tripped, trippedAt, reason }, dailyUsd, txCountLastMinute, txCountToday, now }
 */
function evaluateTxRequest(req = {}, state = {}, config = TX_GATE) {
  const deny = (code, msg) => ({ ok: false, code, reason: msg });
  const L = config.limits;
  const now = Number(state.now || Math.floor(Date.now() / 1000));

  if (!config.enabled) return deny('GATE_CLOSED', `交易总开关关闭（${GATE_VERSION}）——M3 交易开关未通过 review`);
  if (!config.unlockRecord.path) return deny('NO_UNLOCK_RECORD', '缺少解锁记录（官方确认或用户知情接受）');
  if (state.killSwitch && state.killSwitch.tripped) {
    return deny('KILL_SWITCH', `熔断已触发（${state.killSwitch.trippedAt || '未知时间'}：${state.killSwitch.reason || '未记录原因'}），需人工复核并清除`);
  }

  const allowed = config.allowedCalls[req.key] || null;
  if (!allowed) return deny('CONTRACT_NOT_ALLOWED', `合约「${req.key}」不在允许调用清单内`);
  const sel = String(req.selector || '').toLowerCase();
  if (!allowed.selectors[sel]) return deny('SELECTOR_NOT_ALLOWED', `合约「${req.key}」不允许调用 ${sel || '(空选择器)'}`);

  // 逐合约写开关（与 config/whitelist.js 同步，由测试保证一致性）
  if (!allowed.writeEnabled) return deny('WRITE_DISABLED', `白名单条目「${req.key}」的 writeEnabled=false`);

  // —— 交易内容级绑定（M3.2 最终评审 P0-2）：授权必须绑定完整交易，防止「A 的授权被 B 复用」 ——
  const bind = assertBindingComplete(req);
  if (!bind.ok) return deny('BINDING_MISSING', `缺少交易绑定字段：${bind.missing.join(', ')}（授权必须绑定完整交易内容）`);
  if (Number(req.chainId) !== CHAIN.id) {
    return deny('CHAIN_MISMATCH', `绑定 chainId ${req.chainId} 与白名单链 ${CHAIN.id} 不一致`);
  }
  if (String(req.to).toLowerCase() !== String(allowed.address).toLowerCase()) {
    return deny('TO_MISMATCH', `绑定收款合约 ${req.to} 与白名单条目「${req.key}」地址 ${allowed.address} 不一致`);
  }

  // —— 金额与额度 ——
  const cap = config.firstTxMode ? L.firstTxMaxUsd : L.perTxMaxUsd;
  if (req.amountUsd == null) return deny('AMOUNT_MISSING', '缺少金额（USD）');
  if (!(req.amountUsd > 0)) return deny('AMOUNT_INVALID', '金额必须大于 0');
  if (req.amountUsd > cap) {
    return deny('AMOUNT_OVER_TX_CAP', `金额 ${req.amountUsd} USD 超过上限 ${cap} USD（${config.firstTxMode ? '首笔小额模式' : '单笔上限'}）`);
  }
  const spent = Number(state.dailyUsd || 0);
  if (spent + req.amountUsd > L.dailyMaxUsd) {
    return deny('AMOUNT_OVER_DAILY_CAP', `本日累计 ${spent} + 本次 ${req.amountUsd} USD 超过日上限 ${L.dailyMaxUsd} USD`);
  }

  // —— 频率 ——
  const perMin = Number(state.txCountLastMinute || 0);
  if (perMin >= L.maxTxPerMinute) return deny('RATE_PER_MINUTE', `最近一分钟已有 ${perMin} 笔，超过每分钟上限 ${L.maxTxPerMinute}`);
  const perDay = Number(state.txCountToday || 0);
  if (perDay >= L.maxTxPerDay) return deny('RATE_PER_DAY', `今日已有 ${perDay} 笔，超过每日上限 ${L.maxTxPerDay}`);

  // —— 滑点 / minOut ——
  if (req.slippageBps != null && req.slippageBps > L.maxSlippageBps) {
    return deny('SLIPPAGE_OVER', `滑点 ${req.slippageBps} bps 超过上限 ${L.maxSlippageBps} bps（禁止自动放宽）`);
  }
  if (L.requireMinOut && req.hasMinOut !== true) return deny('MIN_OUT_MISSING', '缺少最小输出保护（minOut）');

  // —— Gas（单价 + 总成本）——
  if (req.gasPriceGwei != null && req.gasPriceGwei > L.maxGasPriceGwei) {
    return deny('GAS_PRICE_OVER', `Gas 价格 ${req.gasPriceGwei} gwei 超过上限 ${L.maxGasPriceGwei} gwei`);
  }
  if (req.gasUsd == null) return deny('GAS_USD_MISSING', '缺少 Gas 成本估算（USD），无法校验 Gas 上限');
  if (req.gasUsd > L.maxGasUsd) return deny('GAS_USD_OVER', `Gas 成本 ${req.gasUsd} USD 超过上限 ${L.maxGasUsd} USD`);

  // —— 报价新鲜度 / 价格影响 ——
  if (req.quoteAgeSec != null && req.quoteAgeSec > L.quoteMaxAgeSec) {
    return deny('QUOTE_STALE', `报价已过期（${req.quoteAgeSec}s > ${L.quoteMaxAgeSec}s）`);
  }
  if (req.priceImpactPct != null && req.priceImpactPct > L.maxPriceImpactPct) {
    return deny('PRICE_IMPACT_OVER', `价格影响 ${req.priceImpactPct}% 超过上限 ${L.maxPriceImpactPct}%`);
  }

  // —— deadline ——
  if (req.deadline != null) {
    if (Number(req.deadline) < now) return deny('DEADLINE_EXPIRED', 'deadline 已过期');
    if (Number(req.deadline) > now + L.maxDeadlineSec) return deny('DEADLINE_TOO_LONG', `deadline 超过 ${L.maxDeadlineSec}s 上限`);
  }

  return { ok: true, gateVersion: GATE_VERSION, firstTxMode: config.firstTxMode, capUsd: cap, remainingDailyUsd: L.dailyMaxUsd - spent - req.amountUsd };
}

/**
 * 异步门禁：读取持久化状态（熔断 / 日累计 / 频率）后执行完整判断。
 * @param {object} req
 * @param {{stateProvider?: Function, onDecision?: Function, config?: object}} deps
 *   config 仅供测试注入「已开启」的配置副本，业务代码不得传入（tests 中有静态断言防止路由滥用）
 */
/** 构造门禁拒绝错误 */
function _reject(decision) {
  const e = new Error(`交易门禁拒绝：${decision.reason}`);
  e.code = decision.code;
  e.decision = decision;
  return e;
}

async function assertTxAllowed(req = {}, deps = {}) {
  const config = deps.config || TX_GATE;
  let state = { now: Math.floor(Date.now() / 1000) };
  try {
    if (deps.stateProvider) {
      state = { ...state, ...(await deps.stateProvider(req)) };
    } else {
      // 延迟加载：避免离线测试/纯配置场景被迫连库
      const { loadGateState } = require('../lib/tx-gate-state');
      state = { ...state, ...(await loadGateState()) };
    }
  } catch (e) {
    // fail-closed：读不到持久化状态（熔断/计数）就绝不放行
    throw _reject({ ok: false, code: 'GATE_STATE_UNAVAILABLE', reason: `无法读取持久化门禁状态，已拒绝：${e.message}` });
  }
  const decision = evaluateTxRequest(req, state, config);
  if (deps.onDecision) {
    try {
      await deps.onDecision(req, decision);
    } catch (e) {
      // fail-closed：审计写入失败不得放行（M3.2 review P0-2）
      throw _reject({ ok: false, code: 'GATE_AUDIT_FAILED', reason: `门禁审计写入失败，已拒绝交易：${e.message}` });
    }
  }
  if (!decision.ok) throw _reject(decision);
  return decision;
}

/**
 * 完整授权流程（真实交易入口**必须**走这里）：
 *   门禁判断 → 原子占用额度 → 写审计；任一步失败 → 释放额度并拒绝。
 * 保证不会出现「允许交易但没有审计记录」，也不会出现「额度被占用但交易未放行」。
 *
 * @param {object} req
 * @param {{stateProvider?:Function, record?:Function, quotaStore?:object, config?:object, namespace?:string}} deps
 */
async function authorizeTx(req = {}, deps = {}) {
  const config = deps.config || TX_GATE;
  const { reserveQuota, releaseQuota, recordAttempt } = deps.quotaStore || require('../lib/tx-gate-state');
  const record = deps.record || recordAttempt;

  let state = { now: Math.floor(Date.now() / 1000) };
  try {
    state = deps.stateProvider
      ? { ...state, ...(await deps.stateProvider(req)) }
      : { ...state, ...(await require('../lib/tx-gate-state').loadGateState()) };
  } catch (e) {
    throw _reject({ ok: false, code: 'GATE_STATE_UNAVAILABLE', reason: `无法读取持久化门禁状态，已拒绝：${e.message}` });
  }

  const decision = evaluateTxRequest(req, state, config);
  if (!decision.ok) {
    // 被拒绝时也留审计（失败不影响拒绝结果，但绝不因此放行）
    try { await record(req, decision); } catch { /* 拒绝路径不因审计失败而放行 */ }
    throw _reject(decision);
  }

  // 绑定（授权即绑定这份完整交易内容；审计与后续签名前核对都以此为准）
  decision.binding = computeBinding(req);
  decision.bindingHash = bindingHashOf(decision.binding);

  // 1) 原子占用额度（并发下由条件 UPDATE 保证不超额）
  let quota;
  try {
    quota = await reserveQuota({ amountUsd: req.amountUsd, config, namespace: deps.namespace || '' });
  } catch (e) {
    throw _reject({ ok: false, code: 'GATE_QUOTA_UNAVAILABLE', reason: `额度占用失败，已拒绝：${e.message}` });
  }
  if (!quota.ok) {
    const d = { ok: false, code: quota.code, reason: quota.reason, gateVersion: GATE_VERSION };
    try { await record(req, d); } catch { /* 同上 */ }
    throw _reject(d);
  }

  // 2) 审计（fail-closed：写不进去 → 释放额度 + 拒绝）
  try {
    decision.attemptId = await record(req, decision);
  } catch (e) {
    try { await releaseQuota(quota.reservation); } catch { /* 补偿失败只会更保守（多算额度），不会放行 */ }
    throw _reject({ ok: false, code: 'GATE_AUDIT_FAILED', reason: `门禁审计写入失败，已释放额度并拒绝：${e.message}` });
  }

  return { ...decision, reservation: quota.reservation, quota: quota.snapshot };
}

/**
 * 供前端 / 只读接口使用的门禁状态（不含任何私密信息）。
 * M3.2 review P0-3：熔断状态一律读**持久化**记录，绝不返回静态配置值。
 */
async function txGateStatus(deps = {}) {
  let ks = null;
  let stateSource = 'postgres';
  let stateError = null;
  try {
    const loader = deps.loadKillSwitch || require('../lib/tx-gate-state').loadKillSwitch;
    ks = await loader();
  } catch (e) {
    stateSource = 'unavailable';
    stateError = String(e.message).slice(0, 200);
  }
  return {
    version: GATE_VERSION,
    enabled: TX_GATE.enabled,
    stage: TX_GATE.stage,
    firstTxMode: TX_GATE.firstTxMode,
    unlockPath: TX_GATE.unlockRecord.path,
    // 熔断（来自持久化记录；读取失败时 tripped=null 并标记 stateUnavailable，绝不谎报 false）
    killSwitchTripped: ks ? Boolean(ks.tripped) : null,
    killSwitchTrippedAt: ks ? ks.trippedAt : null,
    killSwitchReason: ks ? ks.reason : null,
    killSwitchClearedAt: ks && ks.clearedAt ? ks.clearedAt : null,
    killSwitchClearedBy: ks && ks.clearedBy ? ks.clearedBy : null,
    stateSource,
    stateUnavailable: stateSource === 'unavailable',
    stateError,
    limits: TX_GATE.limits,
    allowedCalls: Object.fromEntries(
      Object.entries(TX_GATE.allowedCalls).map(([k, v]) => [k, { address: v.address, selectors: Object.values(v.selectors) }])
    ),
    forbidden: TX_GATE.forbidden,
    killSwitchTriggers: TX_GATE.killSwitch.triggers,
  };
}

module.exports = { TX_GATE, GATE_VERSION, evaluateTxRequest, assertTxAllowed, authorizeTx, txGateStatus };
