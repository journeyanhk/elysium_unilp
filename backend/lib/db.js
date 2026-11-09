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
    })().catch((e) => {
      done = null; // 允许重试
      throw e;
    });
  }
  return done;
}

module.exports = { ensureIndexes };
