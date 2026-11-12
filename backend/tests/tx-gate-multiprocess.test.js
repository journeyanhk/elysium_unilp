/**
 * M3.2 最终评审 P1：额度的**跨进程**原子性验证。
 *
 * 进程内互斥锁（withTxLock）只能协调同一个进程；生产环境可能存在多实例 / 多 worker /
 * 滚动发布。这里用**多个独立 OS 进程**同时抢占同一额度桶，验证数据库层的
 * 行锁 + 条件更新确实能跨进程保证不超额。
 *
 * 另外验证：重复 release 无副作用（唯一 reservation id + 条件更新）。
 */
// 需要数据库：缺表时逐条跳过并提示（见 tests/helpers/db-required.js）
const test = require('./helpers/db-required');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { dbQuery, dbQueryRetry } = require('./helpers/db-retry');
const { dbQuerySafe } = require('./../lib/db');
const { reserveQuota, releaseQuota, loadBuckets, loadReservation } = require('../lib/tx-gate-state');
const { TX_GATE } = require('../config/tx-gate');

const BACKEND_DIR = path.join(__dirname, '..');
const NS = `testmp${Date.now().toString(36)}-`;
let dbUp = false;

test.before(async () => {
  // 数据库不可用（缺表 / 连不上）→ 不探测、不清理；用例本身会被逐条跳过
  if (typeof test.isDbReady === 'function' && !(await test.isDbReady())) return;
  try {
    await dbQuery('SELECT 1');
    dbUp = true;
  } catch {
    console.warn('⚠️ 数据库不可用，跨进程测试将跳过（生产环境必须运行这些测试）');
  }
});

test.after(async () => {
  // 缺表 / 连不上数据库时：**不执行任何清理 SQL**（没有数据需要清理，也不允许钩子把文件判失败）
  if (!dbUp) return;
  if (typeof test.isDbReady === 'function' && !(await test.isDbReady())) return;
  try { await dbQuerySafe('ROLLBACK'); } catch { /* 清理会话 */ }
  await dbQuery('DELETE FROM tx_gate_buckets WHERE bucket_key LIKE $1', [`${NS}%`]);
  await dbQuery('DELETE FROM tx_gate_reservations WHERE namespace LIKE $1', [`${NS}%`]);
});

/** 在独立子进程中执行一次额度占用，输出 JSON 结果 */
function reserveInChild({ namespace, limits }) {
  const script = `
    const { reserveQuota } = require('./lib/tx-gate-state');
    const { TX_GATE } = require('./config/tx-gate');
    const cfg = JSON.parse(JSON.stringify(TX_GATE));
    cfg.limits = Object.assign({}, cfg.limits, JSON.parse(process.env.MP_LIMITS));
    reserveQuota({ amountUsd: Number(process.env.MP_AMOUNT), config: cfg, namespace: process.env.MP_NS })
      .then((r) => { process.stdout.write(JSON.stringify({ ok: r.ok, code: r.code || null, rid: r.reservation ? r.reservation.reservationId : null })); })
      .catch((e) => { process.stdout.write(JSON.stringify({ ok: false, code: 'ERROR', error: String(e.message).slice(0, 120) })); });
  `;
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', script], {
      cwd: BACKEND_DIR,
      env: { ...process.env, MP_NS: namespace, MP_LIMITS: JSON.stringify(limits), MP_AMOUNT: '1' },
      timeout: 60000,
    }, (err, stdout) => {
      if (err) return resolve({ ok: false, code: 'CHILD_FAILED', error: String(err.message).slice(0, 160) });
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ ok: false, code: 'BAD_OUTPUT', error: String(stdout).slice(0, 160) }); }
    });
  });
}

test('跨进程并发 5 个独立进程、每分钟上限 1 笔 → 恰好 1 个通过', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}p1-`;
  const limits = { maxTxPerMinute: 1, maxTxPerDay: 99, dailyMaxUsd: 9999 };
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveInChild({ namespace: ns, limits })));
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1, `跨进程应恰好 1 个通过，实际 ${ok.length}：${JSON.stringify(results)}`);
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'RATE_PER_MINUTE' || r.code === 'RATE_PER_DAY'), JSON.stringify(results));
  const buckets = await loadBuckets({ namespace: ns, db: dbQueryRetry });
  const minute = buckets.find((b) => b.key.startsWith(`${ns}minute:`));
  assert.equal(minute.txCount, 1, '分钟桶必须恰好为 1');
});

test('跨进程并发 5 个独立进程、日金额上限 3 USD → 恰好 3 个通过且金额恰好 3', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}p2-`;
  const limits = { maxTxPerMinute: 99, maxTxPerDay: 99, dailyMaxUsd: 3 };
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveInChild({ namespace: ns, limits })));
  assert.equal(results.filter((r) => r.ok).length, 3, JSON.stringify(results));
  const buckets = await loadBuckets({ namespace: ns, db: dbQueryRetry });
  const day = buckets.find((b) => b.key.startsWith(`${ns}day:`));
  assert.equal(day.amountUsd, 3, '日累计金额必须恰好等于上限');
  assert.equal(day.txCount, 3);
});

test('跨进程并发 5 个独立进程、每日笔数上限 2 → 恰好 2 个通过', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}p3-`;
  const limits = { maxTxPerMinute: 99, maxTxPerDay: 2, dailyMaxUsd: 9999 };
  const results = await Promise.all(Array.from({ length: 5 }, () => reserveInChild({ namespace: ns, limits })));
  assert.equal(results.filter((r) => r.ok).length, 2, JSON.stringify(results));
});

test('重复 release 无副作用（唯一 reservation id + 条件更新）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}p4-`;
  const cfg = JSON.parse(JSON.stringify({ limits: { ...TX_GATE.limits, maxTxPerMinute: 1, maxTxPerDay: 9, dailyMaxUsd: 9999 } }));
  const r = await reserveQuota({ amountUsd: 2, config: cfg, namespace: ns });
  assert.equal(r.ok, true);
  const first = await releaseQuota(r.reservation);
  const second = await releaseQuota(r.reservation);
  const third = await releaseQuota(r.reservation);
  assert.deepEqual([first.released, second.released, third.released], [true, false, false]);
  const buckets = await loadBuckets({ namespace: ns, db: dbQueryRetry });
  assert.ok(buckets.every((b) => b.txCount === 0 && b.amountUsd === 0), `重复释放不得把额度扣成负数或反复扣减：${JSON.stringify(buckets)}`);
  const rec = await loadReservation({ reservationId: r.reservation.reservationId, db: dbQueryRetry });
  assert.equal(rec.released, 'true');
  assert.ok(rec.released_at, '必须记录释放时间（可审计）');
});

test('释放不存在的 reservation → 无副作用（不报错、不扣减）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const out = await releaseQuota({ reservationId: 'deadbeefdeadbeefdeadbeefdeadbeef' });
  assert.equal(out.released, false);
});

test('每次占用都产生唯一 reservation 记录（可审计、可追溯）', async (t) => {
  if (!dbUp) return t.skip('数据库不可用');
  const ns = `${NS}p5-`;
  const cfg = JSON.parse(JSON.stringify({ limits: { ...TX_GATE.limits, maxTxPerMinute: 99, maxTxPerDay: 99, dailyMaxUsd: 9999 } }));
  const ids = [];
  for (let i = 0; i < 3; i += 1) {
    const r = await reserveQuota({ amountUsd: 1, config: cfg, namespace: ns });
    assert.equal(r.ok, true);
    ids.push(r.reservation.reservationId);
  }
  assert.equal(new Set(ids).size, 3, 'reservation id 必须唯一');
  for (const id of ids) {
    const rec = await loadReservation({ reservationId: id, db: dbQueryRetry });
    assert.ok(rec, `reservation ${id} 必须有记录`);
    assert.equal(rec.namespace, ns);
  }
});
