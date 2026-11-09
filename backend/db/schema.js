// M1 数据库表定义（Drizzle 仅用于声明，实际查询走 dbQuery）
// 说明：为兼容自建同步逻辑，这里不建唯一索引；事件去重通过「重叠窗口删除 + 重插」实现（见 lib/indexer.js）。
const { pgTable, serial, integer, bigint, text, timestamp } = require('drizzle-orm/pg-core');

// PositionManager Transfer 事件（头寸索引原始数据）
exports.positionTransfers = pgTable('position_transfers', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  position_manager: text('position_manager').notNull(),
  token_id: text('token_id').notNull(),
  from_addr: text('from_addr').notNull(),
  to_addr: text('to_addr').notNull(),
  block_number: bigint('block_number', { mode: 'number' }).notNull(),
  tx_hash: text('tx_hash').notNull(),
  log_index: integer('log_index').notNull(),
  block_time: timestamp('block_time', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 索引同步状态（最后同步区块 / 时间）
exports.indexerState = pgTable('indexer_state', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  position_manager: text('position_manager').notNull(),
  last_synced_block: bigint('last_synced_block', { mode: 'number' }).notNull(),
  last_synced_at: timestamp('last_synced_at', { withTimezone: true }).defaultNow(),
});

// 头寸采样（待领费用时间序列 → 多窗口年化）
exports.positionSamples = pgTable('position_samples', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  token_id: text('token_id').notNull(),
  pool_id: text('pool_id').notNull(),
  sampled_at: timestamp('sampled_at', { withTimezone: true }).defaultNow(),
  liquidity: text('liquidity').notNull(),
  fee0_pending: text('fee0_pending').notNull(),
  fee1_pending: text('fee1_pending').notNull(),
  tick: integer('tick'),
  sqrt_price_x96: text('sqrt_price_x96'),
});

// 池采样（池状态时间序列）
exports.poolSamples = pgTable('pool_samples', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  pool_id: text('pool_id').notNull(),
  sampled_at: timestamp('sampled_at', { withTimezone: true }).defaultNow(),
  tick: integer('tick'),
  sqrt_price_x96: text('sqrt_price_x96'),
  liquidity: text('liquidity'),
  fee_growth_global0: text('fee_growth_global0'),
  fee_growth_global1: text('fee_growth_global1'),
});

// 被查看过的头寸（cron 采样范围）
exports.trackedPositions = pgTable('tracked_positions', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  token_id: text('token_id').notNull(),
  owner_addr: text('owner_addr'),
  first_seen_at: timestamp('first_seen_at', { withTimezone: true }).defaultNow(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
  last_block: bigint('last_block', { mode: 'number' }),
});
