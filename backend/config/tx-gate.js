/**
 * M3 交易门禁（Transaction Gate）—— 唯一的写操作总开关。
 *
 * 设计原则（与 docs/M3-TX-SAFETY-GATE.md 一一对应）：
 *  1. 默认全关：enabled=false，且每个合约的 writeEnabled 仍为 false（见 config/whitelist.js）。
 *  2. 双重门禁：本文件的 enabled 为总开关；白名单 writeEnabled 为逐合约开关。两者都通过才可能发起写操作。
 *  3. 不自动放宽：滑点、Gas、金额上限均为硬上限，代码里没有任何「自动放宽」分支。
 *  4. 首笔小额模式：firstTxMode=true 时套用更严格的 firstTxMaxUsd。
 *  5. 可审计：任何放行/拒绝都可由 txGateStatus() 复现出完整判断依据。
 *
 * ⚠️ 未经下一轮 review，不得把 enabled 置为 true，也不得把任何 writeEnabled 置为 true。
 */
const { CONTRACTS, TOKENS } = require('./whitelist');

const GATE_VERSION = 'M3-gate-1';

const TX_GATE = {
  version: GATE_VERSION,
  enabled: false, // 总开关：M3 交易开关。未经 review 不得置 true。
  stage: 'M3',
  // 开启条件：以下「两条路径之一」+「全部硬性条件」同时满足
  unlockRequires: {
    identityPath: [
      'A. 官方渠道确认 PositionManager 身份（官方公告/文档/仓库声明）',
      'B. 用户知情接受（书面记录：用户明确知晓 PM 归属未获官方确认的风险，同意小额首笔）',
    ],
    hardConditions: [
      '全部安全上限配置完成并通过测试（本文件 limits 段）',
      '首笔小额模式已启用（firstTxMode=true）',
      '前端/后端运行时拦截器保持启用，且支持「一键全关」',
      '交易预演（eth_call / 模拟）与链上状态一致性检查通过',
      '逐笔用户签名流程可用，且无任何自动重发/自动加速/自动放宽滑点分支',
    ],
  },
  // 解锁记录：路径 B 必须留下可审计记录（谁、何时、接受了什么风险）
  unlockRecord: {
    path: null, // 'official-confirmed' | 'user-informed-acceptance' | null
    recordedAt: null,
    recordedBy: null,
    note: null,
  },
  firstTxMode: true, // 首笔未完成前保持 true（更严格上限）

  limits: {
    // 金额上限（USD 计价，按交易前报价换算；报价过期即拒绝）
    firstTxMaxUsd: 20,
    perTxMaxUsd: 100,
    dailyMaxUsd: 300,
    // 滑点：只允许用户手动输入，且不得超过硬上限；禁止自动放宽
    maxSlippageBps: 100, // 1%
    requireMinOut: true, // 必须携带 amountOutMinimum / amount0Min / amount1Min
    // Gas 保护
    maxGasPriceGwei: 5,
    maxGasUsd: 1,
    // 报价与状态新鲜度
    quoteMaxAgeSec: 30,
    maxPriceImpactPct: 2,
    // 池子风险提示（不阻断，但必须在 UI 显式确认）
    poolAgeWarnDays: 7,
    // 频率限制：同一分钟内最多 1 笔、同日最多 3 笔
    maxTxPerMinute: 1,
    maxTxPerDay: 3,
  },

  /**
   * 允许的 (合约 → 函数选择器) 白名单。
   * 任何未列出的合约或函数，一律拒绝（含 delegatecall / multicall 透传）。
   */
  allowedCalls: {
    // 键名与 config/whitelist.js 保持一致（tokens: TOKENS；合约: CONTRACTS）
    KNTQ: {
      address: TOKENS.KNTQ.address,
      selectors: { '0x095ea7b3': 'approve(address,uint256)' },
    },
    WHYPE: {
      address: TOKENS.WHYPE.address,
      selectors: { '0x095ea7b3': 'approve(address,uint256)' },
    },
    USDC: {
      address: TOKENS.USDC.address,
      selectors: { '0x095ea7b3': 'approve(address,uint256)' },
    },
    permit2: {
      address: CONTRACTS.permit2.address,
      selectors: {
        '0x87517c45': 'approve(address,address,uint160,uint48)',
      },
    },
    positionManager: {
      address: CONTRACTS.positionManager.address,
      // 仅允许 V4 PositionManager 的 modifyLiquidities（组池/领费/撤池统一入口）
      selectors: { '0xdd46508f': 'modifyLiquidities(bytes,uint256)' },
    },
  },

  // 明确禁止的能力（即使 enabled=true 也不得实现）
  forbidden: [
    '自动重发 / 自动加速（speed-up）/ 自动替换交易',
    '自动放宽滑点或自动降低 minOut',
    '托管私钥 / 保存助记词 / 代替用户签名',
    '闪电贷 / 杠杆 / 借贷类操作',
    '未在白名单中的合约调用、任意 calldata 透传、delegatecall',
    '批量无人值守交易（cron 自动下单）',
  ],

  killSwitch: {
    // 触发即全关（人工或自动），关闭后需重新 review 才能开启
    triggers: [
      '模拟结果与链上状态不一致',
      '报价过期或价格影响超过上限',
      '检测到链上重组影响头寸/池状态',
      'RPC 端点全部不可用或响应异常',
      '同一分钟内出现第 2 笔写操作请求',
      '任何一笔交易回滚后（需人工复核后才可再开）',
    ],
    lastTrippedAt: null,
    lastTrippedReason: null,
  },
};

function _findAllowed(key) {
  return TX_GATE.allowedCalls[key] || null;
}

/**
 * 判断一笔写操作是否被允许。任何一项不满足即抛错（不做静默降级）。
 * @param {object} req
 * @param {string} req.key           白名单键（KNTQ / WHYPE / USDC / PERMIT2 / POSITION_MANAGER）
 * @param {string} req.selector      4 字节函数选择器（0x…）
 * @param {number} [req.amountUsd]   交易金额（USD，报价换算）
 * @param {number} [req.slippageBps] 用户输入的滑点
 * @param {number} [req.gasPriceGwei]
 * @param {boolean} [req.hasMinOut]  是否携带最小输出保护
 * @param {number} [req.quoteAgeSec]
 */
function assertTxAllowed(req = {}) {
  const deny = (msg) => { throw new Error(`交易门禁拒绝：${msg}`); };

  if (!TX_GATE.enabled) deny(`交易总开关关闭（${TX_GATE.version}）——M3 交易开关未通过 review`);
  if (TX_GATE.killSwitch.lastTrippedAt && !req.killSwitchCleared) deny('熔断已触发，需人工复核并清除后才能继续');
  if (!TX_GATE.unlockRecord.path) deny('缺少解锁记录（官方确认或用户知情接受）');

  const allowed = _findAllowed(req.key);
  if (!allowed) deny(`合约「${req.key}」不在允许调用清单内`);
  const sel = String(req.selector || '').toLowerCase();
  if (!allowed.selectors[sel]) deny(`合约「${req.key}」不允许调用 ${sel || '(空选择器)'}`);

  // 白名单逐合约开关（第二重门禁）
  const wl = CONTRACTS[req.key] || TOKENS[req.key];
  if (wl && !wl.writeEnabled) deny(`白名单条目「${req.key}」的 writeEnabled=false`);

  const L = TX_GATE.limits;
  const cap = TX_GATE.firstTxMode ? L.firstTxMaxUsd : L.perTxMaxUsd;
  if (req.amountUsd != null) {
    if (!(req.amountUsd > 0)) deny('金额必须大于 0');
    if (req.amountUsd > cap) deny(`金额 ${req.amountUsd} USD 超过上限 ${cap} USD（${TX_GATE.firstTxMode ? '首笔小额模式' : '单笔上限'}）`);
  } else deny('缺少金额（USD）');

  if (req.slippageBps != null && req.slippageBps > L.maxSlippageBps) deny(`滑点 ${req.slippageBps} bps 超过上限 ${L.maxSlippageBps} bps（禁止自动放宽）`);
  if (L.requireMinOut && req.hasMinOut !== true) deny('缺少最小输出保护（minOut）');
  if (req.gasPriceGwei != null && req.gasPriceGwei > L.maxGasPriceGwei) deny(`Gas 价格 ${req.gasPriceGwei} gwei 超过上限 ${L.maxGasPriceGwei} gwei`);
  if (req.quoteAgeSec != null && req.quoteAgeSec > L.quoteMaxAgeSec) deny(`报价已过期（${req.quoteAgeSec}s > ${L.quoteMaxAgeSec}s）`);
  if (req.priceImpactPct != null && req.priceImpactPct > L.maxPriceImpactPct) deny(`价格影响 ${req.priceImpactPct}% 超过上限 ${L.maxPriceImpactPct}%`);

  return { ok: true, gateVersion: GATE_VERSION, firstTxMode: TX_GATE.firstTxMode, capUsd: cap };
}

/** 供前端 / 只读接口使用的门禁状态（不含任何私密信息） */
function txGateStatus() {
  return {
    version: TX_GATE.version,
    enabled: TX_GATE.enabled,
    stage: TX_GATE.stage,
    firstTxMode: TX_GATE.firstTxMode,
    unlockPath: TX_GATE.unlockRecord.path,
    killSwitchTripped: Boolean(TX_GATE.killSwitch.lastTrippedAt),
    limits: TX_GATE.limits,
    allowedCalls: Object.fromEntries(
      Object.entries(TX_GATE.allowedCalls).map(([k, v]) => [k, { address: v.address, selectors: Object.values(v.selectors) }])
    ),
    forbidden: TX_GATE.forbidden,
  };
}

module.exports = { TX_GATE, GATE_VERSION, assertTxAllowed, txGateStatus };
