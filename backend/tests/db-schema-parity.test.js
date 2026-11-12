/**
 * 建表脚本与 schema 的「防漂移」检查（M3.3 review 第五轮）。
 *
 * `scripts/ensure-m3-tables.js` 是给「后端从未启动、数据库里没有 M3 表」的环境用的建表脚本。
 * 手写 DDL 有漂移风险，所以这里断言：
 *   1. 脚本里的表名与列名和 db/schema.js 声明**完全一致**；
 *   2. 脚本覆盖了 schema 里所有 M3 门禁相关表（tx_* 与 gate_kill_switch）；
 *   3. 脚本里的补列/索引语句与 lib/db.js 的 ensureIndexes() 一致（关键唯一索引不得缺失）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { getTableName, getTableColumns } = require('drizzle-orm');

const schema = require('../db/schema');
const { M3_TABLES, DDL, POST_DDL } = require('../scripts/ensure-m3-tables');

const schemaTables = new Map();
for (const value of Object.values(schema)) {
  if (!value || typeof value !== 'object') continue;
  try {
    const name = getTableName(value);
    if (name) schemaTables.set(name, value);
  } catch { /* 非表对象，忽略 */ }
}

test('建表脚本覆盖 schema 里全部 M3 门禁相关表', () => {
  const expected = [...schemaTables.keys()].filter((n) => n.startsWith('tx_') || n === 'gate_kill_switch');
  assert.deepEqual([...M3_TABLES].sort(), expected.sort(), '脚本表清单必须与 schema 的 M3 表一致');
});

test('脚本里的列与 schema 声明完全一致（防止手写 DDL 漂移）', () => {
  for (const table of M3_TABLES) {
    const cols = Object.keys(getTableColumns(schemaTables.get(table))).sort();
    const ddl = DDL[table];
    assert.ok(ddl, `缺少 ${table} 的建表语句`);
    const ddlCols = ddl
      .split('\n')
      .slice(1)
      .map((line) => line.trim().replace(/,$/, ''))
      .filter((line) => line && !line.startsWith(')') && !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CONSTRAINT)\b/i.test(line))
      .map((line) => line.split(/\s+/)[0]);
    assert.deepEqual(ddlCols.sort(), cols, `${table} 的列与 schema 不一致（schema: ${cols.join(',')} / DDL: ${ddlCols.join(',')}）`);
  }
});

test('脚本的补列/索引语句与 lib/db.js 的 ensureIndexes() 一致', () => {
  const dbSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  for (const sql of POST_DDL) {
    const needle = sql.replace(/\s+/g, ' ').trim();
    assert.ok(dbSrc.includes(needle), `ensureIndexes() 里缺少同一条语句：${needle}`);
  }
  // 关键唯一索引必须存在（并发额度原子占用依赖它）
  assert.ok(POST_DDL.some((s) => s.includes('tx_gate_buckets_key_uniq')));
  assert.ok(POST_DDL.some((s) => s.includes('tx_broadcasts_txhash_uniq')));
});

test('建表语句是幂等的（全部 CREATE TABLE IF NOT EXISTS）', () => {
  for (const [table, ddl] of Object.entries(DDL)) {
    assert.match(ddl, /^CREATE TABLE IF NOT EXISTS /, `${table} 的建表语句必须幂等`);
  }
});
