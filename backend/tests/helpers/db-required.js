/**
 * 需要数据库的测试文件的入口包装（M3.3 review 第五轮修订）。
 *
 * 目标（review 明确要求）：
 *   - 表齐全 → 正常执行；
 *   - 缺表 / 连不上库 → **fail=0**：数据库相关的测试逐条 skip，
 *     并在 skip 原因里给出「缺哪些表 + 当前 schema/数据库 + 修复办法」。
 *
 * 关键点（上一版没有生效的原因）：这些文件里有 `test.before()` 钩子会先做数据库清理，
 * 钩子一抛错，整个文件的用例都会被判为失败，逐条 skip 根本轮不到执行。
 * 因此本包装同时接管 before / after / beforeEach / afterEach：数据库不可用时钩子**不执行**。
 *
 * 自检（用于验证 skip 机制本身）：
 *   TEST_REQUIRED_TABLES=__not_a_real_table__ node --test tests/tx-gate-concurrency.test.js
 *   预期：pass=0 / fail=0 / skipped=该文件用例数
 */
const nodeTest = require('node:test');
const { dbQuerySafe } = require('../../lib/db');

const DEFAULT_TABLES = [
  'tx_intents', 'tx_simulations', 'tx_audit', 'tx_gate_attempts',
  'tx_gate_buckets', 'tx_gate_reservations', 'tx_broadcasts', 'gate_kill_switch',
];

const REQUIRED_TABLES = (process.env.TEST_REQUIRED_TABLES
  ? process.env.TEST_REQUIRED_TABLES.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_TABLES);

let cached = null;

async function queryStatus() {
  // 用 to_regclass 判断：它与业务查询走**同一套 search_path 解析**，
  // 避免出现「helper 认为表存在、业务查询却 relation does not exist」的不一致。
  const exprs = REQUIRED_TABLES.map((t) => `to_regclass('${t}') AS t_${t}`);
  const { rows } = await dbQuerySafe(
    `SELECT ${exprs.join(', ')}, current_schema() AS schema, current_setting('search_path') AS search_path, current_database() AS db, current_user AS usr`
  );
  const row = rows[0] || {};
  const missing = REQUIRED_TABLES.filter((t) => !row[`t_${t}`]);
  const ctx = { schema: row.schema, searchPath: row.search_path, db: row.db, user: row.usr };
  return { missing, ctx };
}

async function dbStatus() {
  if (cached) return cached;
  let lastError = null;
  // 后端重启窗口 / 瞬时连接错误：先重试（最多约 10 秒），避免误判为「缺表」。
  // 注意：只在**查询出错**时重试；「表确实不存在」是正常返回，不会等待。
  const ATTEMPTS = 6;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const { missing, ctx } = await queryStatus();
      cached = { ready: missing.length === 0, missing, ctx };
      return cached;
    } catch (e) {
      lastError = e;
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  cached = { ready: false, missing: REQUIRED_TABLES, ctx: {}, error: String(lastError && lastError.message).slice(0, 200) };
  return cached;
}

function skipReason(st) {
  const where = [
    st.ctx && st.ctx.db ? `数据库=${st.ctx.db}` : null,
    st.ctx && st.ctx.schema ? `当前 schema=${st.ctx.schema}` : null,
    st.ctx && st.ctx.searchPath ? `search_path=${st.ctx.searchPath}` : null,
    st.ctx && st.ctx.user ? `用户=${st.ctx.user}` : null,
  ].filter(Boolean).join('，');
  const parts = [
    `数据库未就绪${where ? `（${where}）` : ''}，跳过需要数据库的测试。`,
    `缺少的表：${st.missing.join(', ')}。`,
  ];
  if (st.error) parts.push(`连接/查询错误：${st.error}。`);
  parts.push('修复（二选一）：① cd backend && node scripts/ensure-m3-tables.js（幂等建表脚本）；'
    + '② 在本目录先启动一次后端（平台会在后端启动时按 backend/db/schema.js 自动同步建表）。然后重跑本文件。');
  parts.push('自检跳过机制：TEST_REQUIRED_TABLES=__not_a_real_table__ node --test tests/*.test.js 预期 fail=0。');
  return parts.join(' ');
}

/** 数据库未就绪时，钩子不执行（否则钩子抛错会把整个文件判失败） */
function guardHook(register) {
  return (name, fn) => register(name, async (...args) => {
    const st = await dbStatus();
    if (!st.ready) return undefined;
    return fn(...args);
  });
}

const wrapped = function test(name, options, fn) {
  const body = typeof options === 'function' ? options : fn;
  const runner = async (t) => {
    const st = await dbStatus();
    if (!st.ready) {
      t.skip(skipReason(st));
      return;
    }
    return body(t);
  };
  // 注意：不能写成 nodeTest.test(name, options, runner) —— 当 options 为 undefined 时，
  // node 的测试运行器不会执行 runner（用例会变成空用例并直接通过，跳过逻辑形同虚设）。
  return typeof options === 'function' || options == null
    ? nodeTest.test(name, runner)
    : nodeTest.test(name, options, runner);
};

// 代理 node:test 的其它入口，并接管钩子
for (const key of ['before', 'after', 'beforeEach', 'afterEach']) {
  if (nodeTest[key]) wrapped[key] = guardHook(nodeTest[key].bind(nodeTest));
}
for (const key of ['describe', 'it', 'skip', 'todo', 'only']) {
  if (nodeTest[key]) wrapped[key] = nodeTest[key];
}
// 保留自定义钩子形式（test.before(...) 与 nodeTest.test.before(...) 两种都支持）
if (nodeTest.test && nodeTest.test.before) {
  for (const key of ['before', 'after', 'beforeEach', 'afterEach']) {
    if (nodeTest.test[key]) wrapped[key] = guardHook(nodeTest.test[key].bind(nodeTest.test));
  }
}

wrapped.dbStatus = dbStatus;
wrapped.skipReason = skipReason;
wrapped.REQUIRED_TABLES = REQUIRED_TABLES;

module.exports = wrapped;
