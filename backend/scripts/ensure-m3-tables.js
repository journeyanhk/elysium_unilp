#!/usr/bin/env node
/**
 * 建表脚本（M3 交易门禁相关表）—— 供「没有跑过平台自动同步」的环境使用。
 *
 * 背景：平台会在**后端启动时**按 `backend/db/schema.js` 自动同步建表；
 * 但如果只是在干净检出里直接跑测试（后端从未启动），数据库里就没有这些表，
 * 于是需要数据库的测试会失败。此时可以运行本脚本一次性补齐：
 *
 *   cd backend && node scripts/ensure-m3-tables.js
 *
 * 特性：
 *   - 幂等：全部使用 CREATE TABLE IF NOT EXISTS，可重复执行；
 *   - 只建 M3 门禁相关的 8 张表，不触碰任何用户数据表；
 *   - 建完后调用 lib/db 的 ensureIndexes()（补 M3 新增列 + 唯一索引）；
 *   - 表名与列名与 db/schema.js 保持一致，并由 tests/db-schema-parity.test.js 守护。
 */
const { dbQuerySafe } = require('../lib/db');

const M3_TABLES = [
  'tx_intents',
  'tx_simulations',
  'tx_audit',
  'tx_gate_attempts',
  'gate_kill_switch',
  'tx_gate_buckets',
  'tx_gate_reservations',
  'tx_broadcasts',
];

const DDL = {
  tx_intents: `CREATE TABLE IF NOT EXISTS tx_intents (
  id serial PRIMARY KEY,
  chain_id integer NOT NULL,
  intent_type text NOT NULL,
  user_addr text NOT NULL,
  target_contract text NOT NULL,
  selector text NOT NULL,
  calldata_hash text NOT NULL,
  calldata text,
  actions text,
  pool_id text,
  pool_key text,
  token_id text,
  params text,
  quote_snapshot text,
  deadline bigint,
  gate_version text,
  created_at timestamptz DEFAULT now()
)`,
  tx_simulations: `CREATE TABLE IF NOT EXISTS tx_simulations (
  id serial PRIMARY KEY,
  chain_id integer NOT NULL,
  intent_id integer NOT NULL,
  sim_block_number bigint,
  sim_block_hash text,
  state_block_number bigint,
  rpc_endpoint text,
  eth_call_ok integer,
  eth_call_result text,
  gas_estimate text,
  gas_price_gwei text,
  gas_usd text,
  gas_limit integer,
  max_fee_per_gas_wei text,
  max_priority_fee_per_gas_wei text,
  gas_plan_version text,
  precheck text,
  local_estimate text,
  deviation text,
  sim_result_hash text,
  created_at timestamptz DEFAULT now()
)`,
  tx_audit: `CREATE TABLE IF NOT EXISTS tx_audit (
  id serial PRIMARY KEY,
  chain_id integer NOT NULL,
  intent_id integer,
  event text NOT NULL,
  signer_state text,
  user_addr text,
  target_contract text,
  selector text,
  calldata_hash text,
  actions text,
  gate_result text,
  reject_reason text,
  tx_hash text,
  receipt_status text,
  gas_used text,
  balance_delta text,
  payload text,
  created_at timestamptz DEFAULT now()
)`,
  tx_gate_attempts: `CREATE TABLE IF NOT EXISTS tx_gate_attempts (
  id serial PRIMARY KEY,
  chain_id integer,
  key text,
  selector text,
  intent_type text,
  amount_usd text,
  decision text NOT NULL,
  reject_code text,
  reject_reason text,
  gate_version text,
  intent_id text,
  user_addr text,
  authorization_status text,
  consumed_at timestamptz,
  consumed_by text,
  binding_hash text,
  binding text,
  created_at timestamptz DEFAULT now()
)`,
  gate_kill_switch: `CREATE TABLE IF NOT EXISTS gate_kill_switch (
  id serial PRIMARY KEY,
  event_type text NOT NULL,
  reason text,
  actor text,
  review_note text,
  created_at timestamptz DEFAULT now()
)`,
  tx_gate_buckets: `CREATE TABLE IF NOT EXISTS tx_gate_buckets (
  bucket_key text PRIMARY KEY,
  scope text NOT NULL,
  bucket text NOT NULL,
  tx_count integer NOT NULL DEFAULT 0,
  amount_cents integer NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
)`,
  tx_gate_reservations: `CREATE TABLE IF NOT EXISTS tx_gate_reservations (
  reservation_id text PRIMARY KEY,
  namespace text,
  amount_cents integer NOT NULL DEFAULT 0,
  minute_key text,
  day_key text,
  released text NOT NULL DEFAULT 'false',
  created_at timestamptz DEFAULT now(),
  released_at timestamptz
)`,
  tx_broadcasts: `CREATE TABLE IF NOT EXISTS tx_broadcasts (
  id serial PRIMARY KEY,
  chain_id integer NOT NULL,
  intent_id integer,
  user_addr text,
  mode text,
  binding_hash text,
  raw_tx_fingerprint text,
  tx_hash text,
  status text,
  receipt_status text,
  block_number integer,
  gas_used text,
  gas_usd text,
  verification text,
  error text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
)`,
};

/** M3 相关的新增列与索引（与 lib/db.js 的 ensureIndexes() 保持一致） */
const POST_DDL = [
  'CREATE UNIQUE INDEX IF NOT EXISTS tx_gate_buckets_key_uniq ON tx_gate_buckets (bucket_key)',
  'CREATE INDEX IF NOT EXISTS tx_broadcasts_intent_idx ON tx_broadcasts (chain_id, intent_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS tx_broadcasts_txhash_uniq ON tx_broadcasts (tx_hash)',
  'ALTER TABLE tx_intents ADD COLUMN IF NOT EXISTS key text',
  'ALTER TABLE tx_intents ADD COLUMN IF NOT EXISTS amount_usd text',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS intent_id text',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS binding_hash text',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS binding text',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS user_addr text',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS authorization_status text',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS consumed_at timestamptz',
  'ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS consumed_by text',
  'ALTER TABLE tx_simulations ADD COLUMN IF NOT EXISTS sim_result_hash text',
  'ALTER TABLE tx_simulations ADD COLUMN IF NOT EXISTS gas_limit integer',
  'ALTER TABLE tx_simulations ADD COLUMN IF NOT EXISTS max_fee_per_gas_wei text',
  'ALTER TABLE tx_simulations ADD COLUMN IF NOT EXISTS max_priority_fee_per_gas_wei text',
  'ALTER TABLE tx_simulations ADD COLUMN IF NOT EXISTS gas_plan_version text',
];

async function ensureM3Tables({ log = console.log } = {}) {
  const created = [];
  for (const name of M3_TABLES) {
    const before = await dbQuerySafe('SELECT to_regclass($1) AS reg', [name]);
    const existed = Boolean(before.rows[0] && before.rows[0].reg);
    await dbQuerySafe(DDL[name]);
    if (!existed) created.push(name);
  }
  // 补 M3 新增列与唯一索引。
  // 注意：这里**不复用** lib/db 的 ensureIndexes()（它带 once 缓存，失败会污染进程状态），
  // 而是执行同一组语句并逐条容错；后端启动时仍会照常执行 ensureIndexes()。
  const post = [];
  for (const sql of POST_DDL) {
    try { await dbQuerySafe(sql); post.push('ok'); } catch (e) { post.push(`跳过（${String(e.message).slice(0, 80)}）`); }
  }
  log(`建表完成：新建 ${created.length} 张${created.length ? `（${created.join(', ')}）` : ''}，其余已存在。`);
  log(`补列/索引：${post.filter((x) => x === 'ok').length}/${post.length} 条成功。`);
  return { created, post };
}

if (require.main === module) {
  ensureM3Tables()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(`建表失败：${String(e.message).slice(0, 400)}`);
      process.exit(1);
    });
}

module.exports = { ensureM3Tables, M3_TABLES, DDL, POST_DDL };
