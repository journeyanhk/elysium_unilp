/**
 * M3 交易门禁测试 —— 在写操作打开之前，这些断言必须全部成立。
 *
 * 目的：把「不要打开写操作」变成可执行的检查，而不是口头约定。
 * 一旦有人误把开关打开（TX_GATE.enabled / 白名单 writeEnabled / PM 状态 / 前端拦截器），
 * 这里会立刻失败。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { TX_GATE, assertTxAllowed, txGateStatus } = require('../config/tx-gate');
const { CONTRACTS, TOKENS, POOLS } = require('../config/whitelist');
const { assertWriteEnabled, isWriteEnabled } = require('../lib/tx-guard');

test('总开关必须关闭（M3 review 通过前不得打开）', () => {
  assert.equal(TX_GATE.enabled, false, '交易总开关被打开了：必须先通过 review 并记录解锁路径');
  assert.equal(txGateStatus().enabled, false);
  assert.equal(TX_GATE.firstTxMode, true, '首笔小额模式必须保持开启');
  assert.equal(TX_GATE.unlockRecord.path, null, '不得在未经 review 的情况下写入解锁记录');
});

test('白名单中所有地址 writeEnabled 必须为 false', () => {
  for (const [key, v] of Object.entries(CONTRACTS)) {
    assert.equal(v.writeEnabled, false, `合约 ${key} 的 writeEnabled 被打开了`);
  }
  for (const [key, v] of Object.entries(TOKENS)) {
    assert.equal(v.writeEnabled, false, `代币 ${key} 的 writeEnabled 被打开了`);
  }
  for (const [key, v] of Object.entries(POOLS)) {
    assert.equal(v.writeEnabled, false, `池 ${key} 的 writeEnabled 被打开了`);
  }
});

test('PositionManager 必须保持 pending-official', () => {
  const pm = CONTRACTS.positionManager;
  assert.ok(pm, '缺少 POSITION_MANAGER 白名单条目');
  assert.equal(pm.status, 'pending-official', 'PM 状态被提升：内部等价性与写路径行为仍未验证');
  assert.equal(pm.readEnabled, true);
  assert.equal(pm.writeEnabled, false);
});

test('运行时写拦截器对每个白名单键都必须抛错', () => {
  for (const key of [...Object.keys(CONTRACTS), ...Object.keys(TOKENS)]) {
    assert.equal(isWriteEnabled(key), false, `${key} 被判定为可写`);
    assert.throws(() => assertWriteEnabled(key), /写操作拦截/, `${key} 未触发写拦截`);
  }
  assert.throws(() => assertWriteEnabled('UNKNOWN_KEY'), /未知目标/);
});

test('交易门禁：即使参数完全合法也必须拒绝（总开关关闭）', () => {
  assert.throws(() => assertTxAllowed({
    key: 'positionManager',
    selector: '0xdd46508f',
    amountUsd: 5,
    slippageBps: 50,
    hasMinOut: true,
    quoteAgeSec: 5,
    gasPriceGwei: 1,
    priceImpactPct: 0.1,
  }), /交易总开关关闭/);
});

test('允许调用清单只包含 M3 所需的函数选择器（无多余入口）', () => {
  const expected = {
    KNTQ: ['0x095ea7b3'],
    WHYPE: ['0x095ea7b3'],
    USDC: ['0x095ea7b3'],
    permit2: ['0x87517c45'],
    positionManager: ['0xdd46508f'],
  };
  for (const [key, sels] of Object.entries(expected)) {
    const entry = TX_GATE.allowedCalls[key];
    assert.ok(entry, `缺少允许清单：${key}`);
    assert.deepEqual(Object.keys(entry.selectors).sort(), sels.sort(), `${key} 的选择器清单发生变化`);
  }
  // 明确不允许的入口（通用透传/批量/签名代发）
  const allSelectors = Object.values(TX_GATE.allowedCalls).flatMap((v) => Object.keys(v.selectors));
  for (const forbiddenSel of ['0xac9650d8', '0x2b67b570']) {
    assert.ok(!allSelectors.includes(forbiddenSel), `不允许的选择器被加入清单：${forbiddenSel}`);
  }
});

test('安全上限必须处于保守区间', () => {
  const L = TX_GATE.limits;
  assert.ok(L.firstTxMaxUsd > 0 && L.firstTxMaxUsd <= 20, '首笔上限必须在 (0, 20] USD');
  assert.ok(L.perTxMaxUsd > 0 && L.perTxMaxUsd <= 100, '单笔上限必须在 (0, 100] USD');
  assert.ok(L.dailyMaxUsd >= L.perTxMaxUsd && L.dailyMaxUsd <= 300, '日上限必须在 [单笔, 300] USD');
  assert.ok(L.maxSlippageBps > 0 && L.maxSlippageBps <= 100, '滑点上限必须 ≤ 1%');
  assert.equal(L.requireMinOut, true, '必须强制最小输出保护');
  assert.ok(L.maxGasPriceGwei > 0 && L.maxGasPriceGwei <= 10);
  assert.ok(L.quoteMaxAgeSec > 0 && L.quoteMaxAgeSec <= 60, '报价有效期不得超过 60 秒');
  assert.ok(L.maxPriceImpactPct > 0 && L.maxPriceImpactPct <= 5);
  assert.equal(L.maxTxPerMinute, 1, '每分钟最多 1 笔');
  assert.ok(L.maxTxPerDay <= 5, '每日笔数上限必须 ≤ 5');
});

test('禁止能力清单覆盖 review 关注项', () => {
  const text = TX_GATE.forbidden.join(' | ');
  for (const kw of ['自动重发', '滑点', '私钥', 'delegatecall', 'cron']) {
    assert.ok(text.includes(kw), `禁止能力清单缺少：${kw}`);
  }
});

test('门禁逻辑本身可验证：模拟「已开启」时必须仍受限额与清单约束', () => {
  // 直接构造一个「已开启」的门禁副本进行逻辑演练（不修改真实配置）
  const clone = JSON.parse(JSON.stringify(TX_GATE));
  clone.enabled = true;
  clone.unlockRecord.path = 'user-informed-acceptance';
  const L = clone.limits;
  // 复制 assertTxAllowed 的判断顺序（保持与实现一致的最小演练）
  const check = (req) => {
    if (!clone.enabled) return '总开关关闭';
    if (!clone.unlockRecord.path) return '缺少解锁记录';
    const allowed = clone.allowedCalls[req.key];
    if (!allowed) return '合约不在清单';
    if (!allowed.selectors[req.selector]) return '函数不在清单';
    const cap = clone.firstTxMode ? L.firstTxMaxUsd : L.perTxMaxUsd;
    if (req.amountUsd > cap) return '超过金额上限';
    if (req.slippageBps > L.maxSlippageBps) return '超过滑点上限';
    if (L.requireMinOut && req.hasMinOut !== true) return '缺少 minOut';
    return 'ok';
  };
  assert.equal(check({ key: 'positionManager', selector: '0xdd46508f', amountUsd: 5, slippageBps: 50, hasMinOut: true }), 'ok');
  assert.equal(check({ key: 'positionManager', selector: '0xdd46508f', amountUsd: 25, slippageBps: 50, hasMinOut: true }), '超过金额上限');
  assert.equal(check({ key: 'positionManager', selector: '0xdd46508f', amountUsd: 5, slippageBps: 200, hasMinOut: true }), '超过滑点上限');
  assert.equal(check({ key: 'positionManager', selector: '0xdd46508f', amountUsd: 5, slippageBps: 50, hasMinOut: false }), '缺少 minOut');
  assert.equal(check({ key: 'positionManager', selector: '0xac9650d8', amountUsd: 5, slippageBps: 50, hasMinOut: true }), '函数不在清单');
  assert.equal(check({ key: 'UNKNOWN', selector: '0xdd46508f', amountUsd: 5, slippageBps: 50, hasMinOut: true }), '合约不在清单');
});

test('前端运行时拦截器必须保持关闭', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'tx-guard.ts'), 'utf8');
  assert.match(src, /export const WRITES_ENABLED = false/, '前端 WRITES_ENABLED 被打开');
  assert.match(src, /assertWritesEnabled\(\): never/, '前端拦截器签名被改动');
});
