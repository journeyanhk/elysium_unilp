/**
 * M3 门禁状态持久化层（Postgres / dbQuery）—— review 要求：熔断状态与计数不能靠进程内存状态绕过。
 *
 * 数据来源：
 *   - gate_kill_switch 表：熔断事件（trip / clear 追加写，当前状态 = 最后一条事件）
 *   - tx_gate_attempts 表：每次门禁判断的追加写记录（allowed / rejected + 原因 + 金额 + 时间）
 *     → 日累计金额、每分钟/每日笔数均由该表实时聚合，进程重启不丢
 *
 * storeKind 固定为 'postgres'；测试会断言它不是 'memory'，防止有人用内存实现绕过持久化要求。
 */
const { dbQuery } = require('@surf-ai/sdk/db');

const storeKind = 'postgres';

/** 当前熔断状态（最后一条事件） */
async function loadKillSwitch() {
  const { rows } = await dbQuery(
    `SELECT event_type, reason, actor, review_note, created_at
       FROM gate_kill_switch
      ORDER BY id DESC
      LIMIT 1`
  );
  if (!rows.length) return { tripped: false, trippedAt: null, reason: null, actor: null };
  const r = rows[0];
  if (r.event_type === 'trip') {
    return { tripped: true, trippedAt: r.created_at, reason: r.reason, actor: r.actor };
  }
  return { tripped: false, trippedAt: null, reason: null, actor: null, clearedAt: r.created_at, clearedBy: r.actor, reviewNote: r.review_note };
}

/** 当日（UTC）累计金额与笔数、最近一分钟笔数 */
async function loadCounters() {
  const { rows } = await dbQuery(
    `SELECT
        COALESCE(SUM(amount_usd) FILTER (WHERE decision = 'allowed' AND created_at >= date_trunc('day', now())), 0) AS daily_usd,
        COUNT(*) FILTER (WHERE decision = 'allowed' AND created_at >= date_trunc('day', now())) AS tx_today,
        COUNT(*) FILTER (WHERE decision = 'allowed' AND created_at >= now() - interval '1 minute') AS tx_last_minute
       FROM tx_gate_attempts`
  );
  const r = rows[0] || {};
  return {
    dailyUsd: Number(r.daily_usd || 0),
    txCountToday: Number(r.tx_today || 0),
    txCountLastMinute: Number(r.tx_last_minute || 0),
  };
}

/** 汇总门禁状态快照（供 assertTxAllowed 使用） */
async function loadGateState() {
  const [killSwitch, counters] = await Promise.all([loadKillSwitch(), loadCounters()]);
  return { killSwitch, ...counters, now: Math.floor(Date.now() / 1000) };
}

/** 记录一次门禁判断（append-only） */
async function recordAttempt(req = {}, decision = {}) {
  await dbQuery(
    `INSERT INTO tx_gate_attempts
       (chain_id, key, selector, intent_type, amount_usd, decision, reject_code, reject_reason, gate_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      req.chainId || null,
      req.key || null,
      req.selector || null,
      req.intentType || null,
      req.amountUsd != null ? String(req.amountUsd) : null,
      decision.ok ? 'allowed' : 'rejected',
      decision.code || null,
      decision.reason || null,
      decision.gateVersion || null,
    ]
  );
}

/** 触发熔断（append-only 事件） */
async function tripKillSwitch({ reason, actor = 'system' } = {}) {
  if (!reason) throw new Error('触发熔断必须提供原因');
  const { rows } = await dbQuery(
    `INSERT INTO gate_kill_switch (event_type, reason, actor) VALUES ('trip', $1, $2) RETURNING id, created_at`,
    [String(reason).slice(0, 500), actor]
  );
  return { tripped: true, eventId: rows[0].id, at: rows[0].created_at, reason };
}

/** 清除熔断：**必须**提供人工复核记录，否则拒绝 */
async function clearKillSwitch({ actor, reviewNote } = {}) {
  if (!reviewNote || String(reviewNote).trim().length < 10) {
    throw new Error('清除熔断必须提供人工复核记录（reviewNote，至少 10 个字符）');
  }
  if (!actor) throw new Error('清除熔断必须记录操作人');
  const { rows } = await dbQuery(
    `INSERT INTO gate_kill_switch (event_type, reason, actor, review_note) VALUES ('clear', $1, $2, $3) RETURNING id, created_at`,
    ['人工复核后清除', actor, String(reviewNote).slice(0, 1000)]
  );
  return { tripped: false, eventId: rows[0].id, at: rows[0].created_at };
}

module.exports = {
  storeKind,
  loadKillSwitch,
  loadCounters,
  loadGateState,
  recordAttempt,
  tripKillSwitch,
  clearKillSwitch,
};
