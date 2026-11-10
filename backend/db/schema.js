// M2 数据库表定义（Drizzle 仅用于声明，实际查询走 dbQuery）
// 说明：唯一索引由 lib/db.js 的 ensureIndexes() 幂等创建（用于 ON CONFLICT 去重）。
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

// M2：ModifyLiquidity 事件（建仓台账原始数据；salt = tokenId，已链上验证）
exports.liquidityEvents = pgTable('liquidity_events', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  pool_id: text('pool_id').notNull(),
  token_id: text('token_id').notNull(),
  block_number: bigint('block_number', { mode: 'number' }).notNull(),
  tx_hash: text('tx_hash').notNull(),
  log_index: integer('log_index').notNull(),
  tick_lower: integer('tick_lower').notNull(),
  tick_upper: integer('tick_upper').notNull(),
  liquidity_delta: text('liquidity_delta').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// M2：历史区块价格缓存（归档 eth_call 结果，避免重复请求）
exports.blockPrices = pgTable('block_prices', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  block_number: bigint('block_number', { mode: 'number' }).notNull(),
  sqrt_price_x96: text('sqrt_price_x96').notNull(),
  tick: integer('tick'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// M2：区块时间缓存
exports.blockTimes = pgTable('block_times', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  block_number: bigint('block_number', { mode: 'number' }).notNull(),
  block_time: timestamp('block_time', { withTimezone: true }),
});

// ============ M3.1：只读预演与交易审计（全部 append-only，不触碰已有用户数据表）============

// 交易意图（build-only 阶段产出；不签名、不广播）
exports.txIntents = pgTable('tx_intents', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  intent_type: text('intent_type').notNull(), // mint | collect | remove | approve | permit2-approve
  user_addr: text('user_addr').notNull(),
  target_contract: text('target_contract').notNull(),
  selector: text('selector').notNull(),
  calldata_hash: text('calldata_hash').notNull(), // keccak256(calldata)
  calldata: text('calldata'),
  actions: text('actions'), // 解码后的 action 列表（JSON 字符串）
  pool_id: text('pool_id'),
  pool_key: text('pool_key'), // PoolKey 完整快照（JSON）
  token_id: text('token_id'),
  params: text('params'), // intent 参数快照（JSON，含 tick / liquidity / minOut / deadline 等）
  quote_snapshot: text('quote_snapshot'), // 报价快照（来源、时间、状态区块号）
  deadline: bigint('deadline', { mode: 'number' }),
  gate_version: text('gate_version'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 预演结果（eth_call / gas 估算 / 只读预检；与 intent 分开保存）
exports.txSimulations = pgTable('tx_simulations', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  intent_id: integer('intent_id').notNull(),
  sim_block_number: bigint('sim_block_number', { mode: 'number' }),
  sim_block_hash: text('sim_block_hash'),
  state_block_number: bigint('state_block_number', { mode: 'number' }), // 报价/状态所用区块
  rpc_endpoint: text('rpc_endpoint'),
  eth_call_ok: integer('eth_call_ok'), // 1/0
  eth_call_result: text('eth_call_result'),
  gas_estimate: text('gas_estimate'),
  gas_price_gwei: text('gas_price_gwei'),
  gas_usd: text('gas_usd'),
  precheck: text('precheck'), // 余额/授权预检（JSON）
  local_estimate: text('local_estimate'), // 本地估算（JSON）
  deviation: text('deviation'), // 与链上模拟的偏差（JSON）
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 审计（append-only；不含私钥/助记词/签名原文）
exports.txAudit = pgTable('tx_audit', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id').notNull(),
  intent_id: integer('intent_id'),
  event: text('event').notNull(), // preview | build | simulate | gate_decision | user_confirmation | submit | receipt
  signer_state: text('signer_state'), // requested | submitted | rejected | confirmed（仅状态，不含签名）
  user_addr: text('user_addr'),
  target_contract: text('target_contract'),
  selector: text('selector'),
  calldata_hash: text('calldata_hash'),
  actions: text('actions'),
  gate_result: text('gate_result'),
  reject_reason: text('reject_reason'),
  tx_hash: text('tx_hash'),
  receipt_status: text('receipt_status'),
  gas_used: text('gas_used'),
  balance_delta: text('balance_delta'),
  payload: text('payload'), // 事件附加信息（JSON）
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 门禁判断记录（append-only；日额度与频率由此表聚合，进程重启不丢）
exports.txGateAttempts = pgTable('tx_gate_attempts', {
  id: serial('id').primaryKey(),
  chain_id: integer('chain_id'),
  key: text('key'),
  selector: text('selector'),
  intent_type: text('intent_type'),
  amount_usd: text('amount_usd'),
  decision: text('decision').notNull(), // allowed | rejected
  reject_code: text('reject_code'),
  reject_reason: text('reject_reason'),
  gate_version: text('gate_version'),
  intent_id: text('intent_id'), // 授权绑定的 intent（便于签名前按 intent 找回授权）
  binding_hash: text('binding_hash'), // 交易内容级授权绑定哈希（M3.2 最终评审 P0-2）
  binding: text('binding'), // 绑定内容快照（JSON：intentId/chainId/to/value/calldataHash/...）
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 熔断事件（append-only；当前状态 = 最后一条事件）
exports.gateKillSwitch = pgTable('gate_kill_switch', {
  id: serial('id').primaryKey(),
  event_type: text('event_type').notNull(), // trip | clear
  reason: text('reason'),
  actor: text('actor'),
  review_note: text('review_note'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// 门禁额度/频率桶（原子占用；并发下由条件 UPDATE 的行锁保证不超额）
// bucket_key 例：'day:2026-11-10' / 'minute:2026-11-10T12:34'（可带测试命名空间前缀）
exports.txGateBuckets = pgTable('tx_gate_buckets', {
  bucket_key: text('bucket_key').primaryKey(),
  scope: text('scope').notNull(), // day | minute
  bucket: text('bucket').notNull(),
  tx_count: integer('tx_count').notNull().default(0),
  amount_cents: integer('amount_cents').notNull().default(0), // 金额以「分」存整数，避免浮点误差
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});
