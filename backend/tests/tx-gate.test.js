/**
 * M3 交易门禁测试 —— 在写操作打开之前，这些断言必须全部成立。
 *
 * 本文件直接调用**真实**的 assertTxAllowed / evaluateTxRequest（不是复制逻辑），
 * 通过注入「已开启」的配置副本，逐条验证每个限制真的会拒绝。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { TX_GATE, assertTxAllowed, authorizeTx, evaluateTxRequest, txGateStatus } = require('../config/tx-gate');
const { CHAIN, CONTRACTS, TOKENS, POOLS } = require('../config/whitelist');
const { assertWriteEnabled, isWriteEnabled } = require('../lib/tx-guard');
const gateState = require('../lib/tx-gate-state');

/** 构造一份「已解锁」的配置副本，仅用于测试其余限制是否真的生效 */
function unlockedConfig() {
  const cfg = JSON.parse(JSON.stringify(TX_GATE));
  cfg.enabled = true;
  cfg.unlockRecord = { path: 'user-informed-acceptance', recordedAt: new Date().toISOString(), recordedBy: 'test', note: '仅测试用' };
  for (const entry of Object.values(cfg.allowedCalls)) entry.writeEnabled = true;
  return cfg;
}

const baseReq = {
  key: 'positionManager',
  selector: '0xdd46508f',
  intentType: 'mint',
  intentId: 42,
  chainId: CHAIN.id,
  to: CONTRACTS.positionManager.address,
  value: '0',
  calldataHash: '0x' + 'ab'.repeat(32),
  amountUsd: 5,
  slippageBps: 50,
  hasMinOut: true,
  gasPriceGwei: 1,
  gasUsd: 0.2,
  quoteAgeSec: 5,
  priceImpactPct: 0.1,
};

// ---------- 关闭状态 ----------

test('总开关必须关闭（M3 review 通过前不得打开）', async () => {
  assert.equal(TX_GATE.enabled, false, '交易总开关被打开了：必须先通过 review 并记录解锁路径');
  const st = await txGateStatus({ loadKillSwitch: async () => ({ tripped: false }) });
  assert.equal(st.enabled, false);
  assert.equal(st.unlockPath, null, '解锁路径必须为 null');
  assert.equal(TX_GATE.firstTxMode, true, '首笔小额模式必须保持开启');
  assert.equal(TX_GATE.unlockRecord.path, null, '不得在未经 review 的情况下写入解锁记录');
});

test('白名单中所有地址 writeEnabled 必须为 false', () => {
  for (const [key, v] of Object.entries(CONTRACTS)) assert.equal(v.writeEnabled, false, `合约 ${key} 的 writeEnabled 被打开了`);
  for (const [key, v] of Object.entries(TOKENS)) assert.equal(v.writeEnabled, false, `代币 ${key} 的 writeEnabled 被打开了`);
  for (const [key, v] of Object.entries(POOLS)) assert.equal(v.writeEnabled, false, `池 ${key} 的 writeEnabled 被打开了`);
});

test('门禁配置的 writeEnabled 必须与白名单同步', () => {
  for (const [key, entry] of Object.entries(TX_GATE.allowedCalls)) {
    const wl = CONTRACTS[key] || TOKENS[key];
    assert.ok(wl, `门禁配置中的「${key}」在白名单中不存在`);
    assert.equal(entry.writeEnabled, wl.writeEnabled, `门禁配置与白名单的 writeEnabled 不同步：${key}`);
    assert.equal(entry.address.toLowerCase(), wl.address.toLowerCase(), `门禁配置与白名单地址不同步：${key}`);
  }
});

test('PositionManager 必须保持 pending-official', () => {
  const pm = CONTRACTS.positionManager;
  assert.ok(pm, '缺少 positionManager 白名单条目');
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

test('真实 assertTxAllowed：即使参数完全合法也必须拒绝（总开关关闭）', async () => {
  await assert.rejects(
    () => assertTxAllowed(baseReq, { stateProvider: async () => ({}) }),
    /交易总开关关闭/
  );
});

// ---------- 解锁后的边界（直接调用真实函数） ----------

test('真实 assertTxAllowed：合法请求通过（注入解锁配置）', async () => {
  const r = await assertTxAllowed(baseReq, { stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }), config: unlockedConfig() });
  assert.equal(r.ok, true);
  assert.equal(r.capUsd, 20, '首笔小额模式上限应为 20 USD');
});

test('真实 assertTxAllowed：缺少解锁记录必须拒绝', async () => {
  const cfg = unlockedConfig();
  cfg.unlockRecord.path = null;
  await assert.rejects(() => assertTxAllowed(baseReq, { stateProvider: async () => ({}), config: cfg }), /缺少解锁记录/);
});

test('真实 assertTxAllowed：熔断状态必须拒绝（来自持久化状态）', async () => {
  await assert.rejects(
    () => assertTxAllowed(baseReq, { stateProvider: async () => ({ killSwitch: { tripped: true, reason: '测试熔断', trippedAt: '2026-11-10' } }), config: unlockedConfig() }),
    /熔断已触发/
  );
});

test('真实 assertTxAllowed：Gas 总成本上限必须强制（不能只看单价）', async () => {
  await assert.rejects(
    () => assertTxAllowed({ ...baseReq, gasUsd: 2 }, { stateProvider: async () => ({}), config: unlockedConfig() }),
    /Gas 成本 2 USD 超过上限/
  );
  await assert.rejects(
    () => assertTxAllowed({ ...baseReq, gasUsd: null }, { stateProvider: async () => ({}), config: unlockedConfig() }),
    /缺少 Gas 成本估算/
  );
});

test('真实 assertTxAllowed：日额度上限必须强制', async () => {
  await assert.rejects(
    () => assertTxAllowed(baseReq, { stateProvider: async () => ({ dailyUsd: 298 }), config: unlockedConfig() }),
    /超过日上限/
  );
});

test('真实 assertTxAllowed：每分钟 / 每日频率上限必须强制', async () => {
  await assert.rejects(
    () => assertTxAllowed(baseReq, { stateProvider: async () => ({ txCountLastMinute: 1 }), config: unlockedConfig() }),
    /超过每分钟上限/
  );
  await assert.rejects(
    () => assertTxAllowed(baseReq, { stateProvider: async () => ({ txCountToday: 3 }), config: unlockedConfig() }),
    /超过每日上限/
  );
});

test('真实 assertTxAllowed：金额 / 滑点 / minOut / 报价 / 价格影响 / deadline 边界', async () => {
  const cfg = unlockedConfig();
  const sp = async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 });
  await assert.rejects(() => assertTxAllowed({ ...baseReq, amountUsd: 25 }, { stateProvider: sp, config: cfg }), /超过上限 20 USD/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, slippageBps: 200 }, { stateProvider: sp, config: cfg }), /滑点 200 bps 超过上限/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, hasMinOut: false }, { stateProvider: sp, config: cfg }), /缺少最小输出保护/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, quoteAgeSec: 60 }, { stateProvider: sp, config: cfg }), /报价已过期/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, priceImpactPct: 3 }, { stateProvider: sp, config: cfg }), /价格影响 3%/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, gasPriceGwei: 20 }, { stateProvider: sp, config: cfg }), /Gas 价格 20 gwei/);
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, deadline: now + 99999 }, { stateProvider: sp, config: cfg }), /deadline 超过/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, deadline: now - 10 }, { stateProvider: sp, config: cfg }), /deadline 已过期/);
});

test('真实 assertTxAllowed：不在清单的合约 / 选择器必须拒绝', async () => {
  const cfg = unlockedConfig();
  const sp = async () => ({});
  await assert.rejects(() => assertTxAllowed({ ...baseReq, key: 'universalRouter' }, { stateProvider: sp, config: cfg }), /不在允许调用清单/);
  await assert.rejects(() => assertTxAllowed({ ...baseReq, selector: '0xac9650d8' }, { stateProvider: sp, config: cfg }), /不允许调用/);
});

test('首笔小额模式关闭后套用单笔上限', async () => {
  const cfg = unlockedConfig();
  cfg.firstTxMode = false;
  const r = await assertTxAllowed({ ...baseReq, amountUsd: 80 }, { stateProvider: async () => ({}), config: cfg });
  assert.equal(r.capUsd, 100);
});

// ---------- 熔断持久化 ----------

test('熔断状态必须由持久化层提供（不得使用内存实现）', () => {
  assert.equal(gateState.storeKind, 'postgres', '熔断/计数状态必须持久化，不能靠进程内存状态绕过');
  for (const fn of ['loadGateState', 'tripKillSwitch', 'clearKillSwitch', 'recordAttempt']) {
    assert.equal(typeof gateState[fn], 'function', `持久化层缺少 ${fn}`);
  }
});

test('熔断触发必须提供原因；清除必须提供人工复核记录', async () => {
  await assert.rejects(() => gateState.tripKillSwitch({ reason: '' }), /必须提供原因/);
  await assert.rejects(() => gateState.clearKillSwitch({ actor: 'someone', reviewNote: '短' }), /人工复核记录/);
  await assert.rejects(() => gateState.clearKillSwitch({ reviewNote: '这是一段足够长的人工复核记录' }), /必须记录操作人/);
});

// ---------- 允许清单与能力约束 ----------

test('允许调用清单只包含 M3 所需的函数选择器（无多余入口）', () => {
  const expected = {
    KNTQ: ['0x095ea7b3'], WHYPE: ['0x095ea7b3'], USDC: ['0x095ea7b3'],
    permit2: ['0x87517c45'], positionManager: ['0xdd46508f'],
  };
  for (const [key, sels] of Object.entries(expected)) {
    const entry = TX_GATE.allowedCalls[key];
    assert.ok(entry, `缺少允许清单：${key}`);
    assert.deepEqual(Object.keys(entry.selectors).sort(), sels.sort(), `${key} 的选择器清单发生变化`);
  }
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
  assert.ok(L.maxGasUsd > 0 && L.maxGasUsd <= 2, 'Gas 成本上限必须 ≤ 2 USD');
  assert.ok(L.quoteMaxAgeSec > 0 && L.quoteMaxAgeSec <= 60, '报价有效期不得超过 60 秒');
  assert.ok(L.maxPriceImpactPct > 0 && L.maxPriceImpactPct <= 5);
  assert.equal(L.maxTxPerMinute, 1, '每分钟最多 1 笔');
  assert.ok(L.maxTxPerDay <= 5, '每日笔数上限必须 ≤ 5');
  assert.ok(L.maxDeadlineSec > 0 && L.maxDeadlineSec <= 1800, 'deadline 上限不超过 30 分钟');
});

test('禁止能力清单覆盖 review 关注项', () => {
  const text = TX_GATE.forbidden.join(' | ');
  for (const kw of ['自动重发', '滑点', '私钥', 'delegatecall', 'cron', 'multicall', 'permit']) {
    assert.ok(text.includes(kw), `禁止能力清单缺少：${kw}`);
  }
});

// ---------- 代码层静态检查（验收条件 1 / 2 / 8） ----------

test('后端不存在发送交易或签名的方法调用（静态扫描）', () => {
  const root = path.join(__dirname, '..');
  const forbiddenPatterns = [
    /eth_sendRawTransaction/, /eth_sendTransaction/, /eth_signTransaction/,
    /personal_sign/, /eth_signTypedData/, /wallet_sendCalls/, /wallet_signTransaction/,
  ];
  const allowlistFile = path.join(root, 'lib', 'tx-rpc-guard.js'); // 白名单定义本身
  const scan = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { if (!['node_modules', 'tests', 'reference', '.git'].includes(f.name)) scan(full); continue; }
      if (!f.name.endsWith('.js') || full === allowlistFile) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const re of forbiddenPatterns) {
        assert.ok(!re.test(src), `${full} 出现禁止的 RPC/签名方法：${re}`);
      }
    }
  };
  scan(root);
});

test('广播入口不存在可用路径：routes/tx.js 的 /broadcast 恒定返回门禁拒绝', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  const idx = src.indexOf("'/broadcast'");
  assert.ok(idx > 0, '未找到 /broadcast 路由');
  const handler = src.slice(idx, idx + 1200);
  assert.match(handler, /status\(403\)/, '/broadcast 必须以 403 拒绝');
  assert.match(handler, /evaluateTxRequest|assertTxAllowed/, '/broadcast 必须经过门禁判断');
  for (const bad of [/sendTransaction/, /sendRawTransaction/, /writeContract/, /signTransaction/]) {
    assert.ok(!bad.test(src), `routes/tx.js 出现禁止调用：${bad}`);
  }
});

test('业务路由不得注入门禁配置覆盖（config 参数仅供测试）', () => {
  const routesDir = path.join(__dirname, '..', 'routes');
  for (const f of fs.readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
    assert.ok(!/config\s*:/.test(src.replace(/\/\/.*$/gm, '')), `路由 ${f} 试图传入门禁配置覆盖`);
  }
});

test('前端运行时拦截器必须保持关闭', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'tx-guard.ts'), 'utf8');
  assert.match(src, /export const WRITES_ENABLED = false/, '前端 WRITES_ENABLED 被打开');
  assert.match(src, /assertWritesEnabled\(\): never/, '前端拦截器签名被改动');
});

// ---------- M3.2 review P0-2：审计失败必须 fail-closed ----------

test('审计写入失败 → 门禁拒绝（fail-closed，不再吞掉异常）', async () => {
  await assert.rejects(
    () => assertTxAllowed(baseReq, {
      stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
      config: unlockedConfig(),
      onDecision: async () => { throw new Error('审计表写入失败'); },
    }),
    (e) => e.code === 'GATE_AUDIT_FAILED' && /已拒绝/.test(e.message)
  );
});

test('持久化状态读取失败 → 门禁拒绝（GATE_STATE_UNAVAILABLE）', async () => {
  await assert.rejects(
    () => assertTxAllowed(baseReq, { stateProvider: async () => { throw new Error('DB 不可用'); }, config: unlockedConfig() }),
    (e) => e.code === 'GATE_STATE_UNAVAILABLE'
  );
});

test('authorizeTx：审计写入失败 → 拒绝，且额度被释放（不会出现「允许但无审计」）', async () => {
  const calls = [];
  const quotaStore = {
    reserveQuota: async () => { calls.push('reserve'); return { ok: true, reservation: { namespace: '', cents: 500 }, snapshot: { minuteCount: 1, dayCount: 1, dayAmountUsd: 5 } }; },
    releaseQuota: async () => { calls.push('release'); return true; },
    recordAttempt: async () => 1,
  };
  await assert.rejects(
    () => authorizeTx(baseReq, {
      stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
      config: unlockedConfig(), quotaStore,
      record: async () => { throw new Error('审计表写入失败'); },
    }),
    (e) => e.code === 'GATE_AUDIT_FAILED'
  );
  assert.deepEqual(calls, ['reserve', 'release'], '必须先占用额度，审计失败后释放');
});

test('authorizeTx：成功路径返回额度快照与审计 id', async () => {
  const quotaStore = {
    reserveQuota: async () => ({ ok: true, reservation: { namespace: '', cents: 500 }, snapshot: { minuteCount: 1, dayCount: 1, dayAmountUsd: 5 } }),
    releaseQuota: async () => true,
    recordAttempt: async () => 7,
  };
  const out = await authorizeTx(baseReq, {
    stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
    config: unlockedConfig(), quotaStore, record: async () => 7,
  });
  assert.equal(out.ok, true);
  assert.equal(out.attemptId, 7);
  assert.equal(out.quota.dayAmountUsd, 5);
});

test('authorizeTx：额度占用被原子拒绝 → 抛出门禁拒绝（含原子拒绝原因）', async () => {
  const quotaStore = {
    reserveQuota: async () => ({ ok: false, code: 'RATE_PER_MINUTE', reason: '最近一分钟已达上限 1 笔（原子占用拒绝）' }),
    releaseQuota: async () => true,
    recordAttempt: async () => 1,
  };
  await assert.rejects(
    () => authorizeTx(baseReq, {
      stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
      config: unlockedConfig(), quotaStore, record: async () => 1,
    }),
    (e) => e.code === 'RATE_PER_MINUTE'
  );
});

test('authorizeTx：额度存储不可用 → 拒绝（不放行）', async () => {
  const quotaStore = { reserveQuota: async () => { throw new Error('DB 不可用'); }, releaseQuota: async () => true, recordAttempt: async () => 1 };
  await assert.rejects(
    () => authorizeTx(baseReq, {
      stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
      config: unlockedConfig(), quotaStore, record: async () => 1,
    }),
    (e) => e.code === 'GATE_QUOTA_UNAVAILABLE'
  );
});

test('源码静态检查：门禁不得再吞掉审计异常；真实交易入口使用 authorizeTx', () => {
  const gateSrc = fs.readFileSync(path.join(__dirname, '..', 'config', 'tx-gate.js'), 'utf8');
  assert.ok(!/记录失败不影响门禁判断/.test(gateSrc), '不得再出现「记录失败不影响门禁判断」的吞异常写法');
  assert.ok(/GATE_AUDIT_FAILED/.test(gateSrc), '必须存在审计失败的拒绝码');
  assert.ok(/GATE_STATE_UNAVAILABLE/.test(gateSrc), '必须存在状态不可用的拒绝码');
  assert.ok(/async function authorizeTx/.test(gateSrc), '必须提供 authorizeTx（判断+额度+审计一体化）');
  assert.ok(/reserveQuota/.test(gateSrc), 'authorizeTx 必须使用原子额度占用');
});

// ---------- M3.2 review P0-3：门禁状态必须来自持久化 ----------

test('txGateStatus：熔断状态来自持久化记录（不返回静态配置值）', async () => {
  const persistedTrip = { tripped: true, trippedAt: '2026-11-10T01:02:03Z', reason: '模拟结果与链上不一致' };
  const st = await txGateStatus({ loadKillSwitch: async () => persistedTrip });
  assert.equal(st.killSwitchTripped, true, '必须反映持久化熔断状态');
  assert.equal(st.killSwitchReason, persistedTrip.reason);
  assert.equal(st.killSwitchTrippedAt, persistedTrip.trippedAt);
  assert.equal(st.stateSource, 'postgres');
  assert.equal(st.stateUnavailable, false);
  // 静态配置里是 false，说明没有使用静态值
  assert.equal(TX_GATE.killSwitch.tripped, false);
});

test('txGateStatus：清除后的持久化状态一并返回（clearedAt / clearedBy）', async () => {
  const st = await txGateStatus({ loadKillSwitch: async () => ({ tripped: false, clearedAt: '2026-11-10T02:00:00Z', clearedBy: 'reviewer', reviewNote: '人工复核通过' }) });
  assert.equal(st.killSwitchTripped, false);
  assert.equal(st.killSwitchClearedAt, '2026-11-10T02:00:00Z');
  assert.equal(st.killSwitchClearedBy, 'reviewer');
});

test('txGateStatus：持久化读取失败 → 明确标记不可用（不得谎报 false）', async () => {
  const st = await txGateStatus({ loadKillSwitch: async () => { throw new Error('DB 不可用'); } });
  assert.equal(st.killSwitchTripped, null, '读取失败时不得返回 false');
  assert.equal(st.stateUnavailable, true);
  assert.equal(st.stateSource, 'unavailable');
  assert.match(st.stateError, /DB 不可用/);
});

test('路由静态检查：GET /api/tx/gate 使用 await txGateStatus()（异步持久化状态）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'tx.js'), 'utf8');
  assert.match(src, /await txGateStatus\(\)/, '必须 await 异步状态接口');
  assert.ok(!/[^t]txGateStatus\(\)\)/.test(src.replace(/await txGateStatus\(\)/g, '')), '不得存在未 await 的调用');
});
