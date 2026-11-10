/**
 * M3.2 review P0-1：额度与频率必须是**原子占用**，并发下不得突破上限。
 *
 * 本文件对真实 Postgres 发起并发请求（命名空间隔离，跑完清理），
 * 验证「先读计数再判断」的竞态已被条件 UPDATE + 行锁消除。
 */
const test = require('node:test');
const assert = require('node:assert');

const { dbQuery } = require('@surf-ai/sdk/db');
const { reserveQuota, releaseQuota, loadBuckets } = require('../lib/tx-gate-state');
const { TX_GATE, authorizeTx } = require('../config/tx-gate');

const NS = `testconc${Date.now().toString(36)}-`;
let dbUp = false;

function cfgWith(limits) {
  const cfg = JSON.parse(JSON.stringify(TX_GATE));
  cfg.limits = { ...cfg.limits, ...limits };
  return cfg;
}
function unlockedCfg(limits) {
  const cfg = cfgWith(limits);
  cfg.enabled = true;
  cfg.unlockRecord = { path: 'user-informed-acceptance', recordedAt: new Date().toISOString(), recordedBy: 'test', note: '仅并发测试用' };
  for (const e of Object.values(cfg.allowedCalls)) e.writeEnabled = true;
  return cfg;
}

test.before(async () => {
  try {
    await dbQuery('SELECT 1');
    dbUp = true;
  } catch {
    console.warn('⚠️ 数据库不可用，并发测试将跳过（生产环境必须运行这些测试）');
  }
});

test.after(async () => {
  if (!dbUp) return;
  await dbQuery('DELETE FROM tx_gate_buckets WHERE bucket_key LIKE $1', [`${NS}%`]);
});

test('并发 5 个请求、每分钟上限 1 笔 → 只有 1 个通过', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}t1-`;
  const config = cfgWith({ maxTxPerMinute: 1, maxTxPerDay: 99, dailyMaxUsd: 9999 });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reserveQuota({ amountUsd: 1, config, namespace: ns }))
  );
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1, `应只有 1 个通过，实际 ${ok.length}：${JSON.stringify(results.map((r) => r.code || 'ok'))}`);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'RATE_PER_MINUTE'));
  const buckets = await loadBuckets({ namespace: ns });
  const minute = buckets.find((b) => b.key.startsWith(`${ns}minute:`));
  assert.equal(minute.txCount, 1, '分钟桶计数必须恰好为 1（不得因竞态多算）');
});

test('并发 5 笔各 1 USD、日上限 3 USD → 恰好 3 笔通过，总额不超过上限', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}t2-`;
  const config = cfgWith({ maxTxPerMinute: 99, maxTxPerDay: 99, dailyMaxUsd: 3 });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reserveQuota({ amountUsd: 1, config, namespace: ns }))
  );
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 3, `应恰好 3 个通过，实际 ${ok.length}`);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'AMOUNT_OVER_DAILY_CAP'));
  const buckets = await loadBuckets({ namespace: ns });
  const day = buckets.find((b) => b.key.startsWith(`${ns}day:`));
  assert.equal(day.amountUsd, 3, '日累计金额必须恰好等于上限，不得突破');
});

test('并发 5 笔、每日笔数上限 2 → 恰好 2 笔通过', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}t3-`;
  const config = cfgWith({ maxTxPerMinute: 99, maxTxPerDay: 2, dailyMaxUsd: 9999 });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => reserveQuota({ amountUsd: 0.1, config, namespace: ns }))
  );
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'RATE_PER_DAY'));
});

test('并发 authorizeTx（真实数据库额度 + 每分钟 1 笔）→ 只有 1 笔被授权', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}t4-`;
  const config = unlockedCfg({ maxTxPerMinute: 1, maxTxPerDay: 99, dailyMaxUsd: 9999 });
  const req = {
    key: 'positionManager', selector: '0xdd46508f', intentType: 'mint', amountUsd: 5,
    slippageBps: 50, hasMinOut: true, gasPriceGwei: 1, gasUsd: 0.2, quoteAgeSec: 5, priceImpactPct: 0.1,
  };
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => authorizeTx(req, {
      stateProvider: async () => ({ dailyUsd: 0, txCountLastMinute: 0, txCountToday: 0 }),
      config, namespace: ns,
      record: async () => 1, // 审计写入用替身，避免污染真实审计表；真实审计路径由 tx-gate.test.js 覆盖
    }))
  );
  const allowed = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(allowed.length, 1, `应只有 1 笔被授权，实际 ${allowed.length}`);
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((r) => r.reason.code === 'RATE_PER_MINUTE'));
  const buckets = await loadBuckets({ namespace: ns });
  const minute = buckets.find((b) => b.key.startsWith(`${ns}minute:`));
  assert.equal(minute.txCount, 1);
});

test('补偿释放：占用后释放 → 计数回到 0（不会永久占用额度）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}t5-`;
  const config = cfgWith({ maxTxPerMinute: 1, maxTxPerDay: 99, dailyMaxUsd: 9999 });
  const r = await reserveQuota({ amountUsd: 2, config, namespace: ns });
  assert.equal(r.ok, true);
  await releaseQuota(r.reservation);
  const buckets = await loadBuckets({ namespace: ns });
  assert.ok(buckets.every((b) => b.txCount === 0 && b.amountUsd === 0), JSON.stringify(buckets));
});

test('额度存储不可用 → 占用失败（调用方必须据此拒绝，不得放行）', async () => {
  const brokenDb = async () => { throw new Error('DB 不可用'); };
  await assert.rejects(
    () => reserveQuota({ amountUsd: 1, config: cfgWith({}), namespace: NS, db: brokenDb }),
    /DB 不可用/
  );
});

test('真实数据库：loadGateState / loadCounters 必须可用且返回数值（回归防护）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const { loadGateState, loadCounters, loadKillSwitch } = require('../lib/tx-gate-state');
  const counters = await loadCounters();
  assert.equal(typeof counters.dailyUsd, 'number', 'dailyUsd 必须是数值');
  assert.equal(typeof counters.txCountToday, 'number');
  assert.equal(typeof counters.txCountLastMinute, 'number');
  assert.ok(counters.dailyUsd >= 0);
  const ks = await loadKillSwitch();
  assert.equal(typeof ks.tripped, 'boolean', '熔断状态必须能读出来');
  const st = await loadGateState();
  assert.ok('killSwitch' in st && 'dailyUsd' in st && 'txCountToday' in st && 'txCountLastMinute' in st && 'now' in st);
});
