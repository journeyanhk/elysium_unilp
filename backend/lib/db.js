/**
 * 数据库初始化辅助（幂等）：唯一索引等 DDL。
 * 用于修复并发 upsert 的重复行问题（tracked_positions）。
 */
const { dbQuery } = require('@surf-ai/sdk/db');

/**
 * 会话自愈包装（M3.2 review P0-1 期间发现的真实风险）：
 * 该数据库代理为**每个进程一条共享会话**，一旦某个显式事务中途报错，会话会停留在
 * 「current transaction is aborted」状态，导致**整个后端进程**后续所有查询失败
 * （实测：连 cron 采样都被连带打死）。
 * 处理：识别该错误 → 先发 ROLLBACK 恢复会话 → 重试一次。
 */
async function dbQuerySafe(sql, params = []) {
  try {
    return await dbQuery(sql, params);
  } catch (e) {
    if (/current transaction is aborted/i.test(String(e && e.message))) {
      try { await dbQuery('ROLLBACK'); } catch { /* 无活动事务时 ROLLBACK 会告警但不致命 */ }
      return await dbQuery(sql, params);
    }
    throw e;
  }
}

let done = null;

function ensureIndexes() {
  if (!done) {
    done = (async () => {
      // 先清理历史重复行（并发 UPDATE→INSERT 竞争产生的）
      await dbQuery(
        `DELETE FROM tracked_positions a USING tracked_positions b
         WHERE a.id < b.id AND a.chain_id = b.chain_id AND a.token_id = b.token_id`);
      await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS tracked_positions_chain_token_uniq ON tracked_positions (chain_id, token_id)');
      // M2：事件与缓存表的唯一索引（供 ON CONFLICT 去重）
      await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS liquidity_events_uniq ON liquidity_events (chain_id, tx_hash, log_index)');
      await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS block_prices_uniq ON block_prices (chain_id, block_number)');
      await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS block_times_uniq ON block_times (chain_id, block_number)');
      // M3.2：门禁额度桶唯一索引（并发原子占用依赖 ON CONFLICT / 条件 UPDATE）
      await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS tx_gate_buckets_key_uniq ON tx_gate_buckets (bucket_key)');
      // M3.2：门禁相关列的幂等补齐（平台 schema 同步对「已有表新增列」不保证，这里显式兜底）
      await dbQuery('ALTER TABLE tx_intents ADD COLUMN IF NOT EXISTS key text');
      await dbQuery('ALTER TABLE tx_intents ADD COLUMN IF NOT EXISTS amount_usd text');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS intent_id text');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS binding_hash text');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS binding text');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS user_addr text');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS authorization_status text');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS consumed_at timestamptz');
      await dbQuery('ALTER TABLE tx_gate_attempts ADD COLUMN IF NOT EXISTS consumed_by text');
      await dbQuery('ALTER TABLE tx_simulations ADD COLUMN IF NOT EXISTS sim_result_hash text');
      // M3.3：广播记录索引（同一 intent 的广播可按时间检索；tx_hash 唯一）
      await dbQuery('CREATE INDEX IF NOT EXISTS tx_broadcasts_intent_idx ON tx_broadcasts (chain_id, intent_id)');
      await dbQuery('CREATE UNIQUE INDEX IF NOT EXISTS tx_broadcasts_txhash_uniq ON tx_broadcasts (tx_hash)');
    })().catch((e) => {
      done = null; // 允许重试
      throw e;
    });
  }
  return done;
}

module.exports = { ensureIndexes, dbQuerySafe };
