/**
 * 数据库初始化辅助（幂等）：唯一索引等 DDL。
 * 用于修复并发 upsert 的重复行问题（tracked_positions）。
 */
const { dbQuery } = require('@surf-ai/sdk/db');

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
    })().catch((e) => {
      done = null; // 允许重试
      throw e;
    });
  }
  return done;
}

module.exports = { ensureIndexes };
