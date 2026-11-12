/**
 * 需要数据库的测试文件的入口包装（M3.3 review 第四轮）。
 *
 * 背景：`tx-authorization-consumption` / `tx-gate-concurrency` / `tx-gate-multiprocess`
 * 三个文件需要 M3 的表（额度、预留、授权消费、广播）。若在一个**没有同步过 schema** 的环境里跑，
 * 会得到 22 条「relation does not exist」的失败，容易被误读为代码问题。
 *
 * 本包装在运行前检查所需表是否齐全：
 *   - 齐全 → 正常执行；
 *   - 缺失 → 该文件的测试**逐条跳过**并给出可执行的提示（而不是失败）。
 *
 * 表由平台在**后端启动时**自动同步（schema 文件变更也会同步）；因此修复方式就是先启动一次后端。
 */
const nodeTest = require('node:test');
const { dbQuerySafe } = require('../../lib/db');

const REQUIRED_TABLES = [
  'tx_intents', 'tx_simulations', 'tx_audit', 'tx_gate_attempts',
  'tx_gate_buckets', 'tx_gate_reservations', 'tx_broadcasts', 'gate_kill_switch',
];

let cached = null;

async function queryTables() {
  const list = REQUIRED_TABLES.map((t) => `'${t}'`).join(',');
  const { rows } = await dbQuerySafe(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN (${list})`
  );
  const have = new Set(rows.map((r) => r.table_name));
  return REQUIRED_TABLES.filter((t) => !have.has(t));
}

async function dbStatus() {
  if (cached) return cached;
  let lastError = null;
  // 后端可能正好在重启（本仓库文件变更会触发重启）→ 连接类错误先重试，避免误判为「缺表」
  for (let i = 0; i < 3; i++) {
    try {
      const missing = await queryTables();
      cached = { ready: missing.length === 0, missing };
      return cached;
    } catch (e) {
      lastError = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  cached = { ready: false, missing: REQUIRED_TABLES, error: String(lastError && lastError.message).slice(0, 200) };
  return cached;
}

function skipReason(st) {
  return `数据库缺少 M3 表：${st.missing.join(', ')}${st.error ? `（连接/查询失败：${st.error}）` : ''}`
    + ' —— 请先启动一次后端以自动同步 schema（后端启动时会创建这些表），再重跑本文件。';
}

const wrapped = function test(name, options, fn) {
  return nodeTest.test(name, options, async (t) => {
    const st = await dbStatus();
    if (!st.ready) {
      t.skip(skipReason(st));
      return;
    }
    return (typeof options === 'function' ? options : fn)(t);
  });
};

// 保留 node:test 的其它入口（before / after / describe / skip / only …）
for (const key of Object.keys(nodeTest.test)) {
  if (key === 'test') continue;
  wrapped[key] = nodeTest.test[key];
}
for (const key of ['before', 'after', 'beforeEach', 'afterEach', 'describe', 'it', 'skip', 'todo', 'only']) {
  if (nodeTest[key]) wrapped[key] = nodeTest[key];
}

wrapped.dbStatus = dbStatus;
wrapped.REQUIRED_TABLES = REQUIRED_TABLES;

module.exports = wrapped;
