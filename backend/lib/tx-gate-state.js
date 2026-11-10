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
        COALESCE(SUM(NULLIF(amount_usd, '')::numeric) FILTER (WHERE decision = 'allowed' AND created_at >= date_trunc('day', now())), 0) AS daily_usd,
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

/**
 * 原子额度占用（M3.2 review P0-1）：
 *   用「带条件的原子 UPDATE」代替「先读计数再判断」——并发下由行锁 + 条件重判保证不超额。
 *   任一步不满足即拒绝，并回滚已占用的桶（补偿只可能多算，不会少算 → 只会更保守）。
 *
 * @returns {{ok:boolean, code?:string, reason?:string, reservation?:object, snapshot?:object}}
 */
const _minuteKey = (ns) => `${ns || ''}minute:`;
const _dayKey = (ns) => `${ns || ''}day:`;

async function reserveQuota({ amountUsd, config, namespace = '', db = dbQuery } = {}) {
  const L = config.limits;
  const cents = Math.round(Number(amountUsd) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    return { ok: false, code: 'AMOUNT_INVALID', reason: '额度占用金额必须大于 0' };
  }
  const ns = namespace;
  const minuteKey = _minuteKey(ns);
  const dayKey = _dayKey(ns);
  const minuteExpr = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')`;
  const dayExpr = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

  // 0) 幂等建桶
  await db(
    `INSERT INTO tx_gate_buckets (bucket_key, scope, bucket, tx_count, amount_cents)
     SELECT $1 || ${minuteExpr}, 'minute', ${minuteExpr}, 0, 0
     ON CONFLICT (bucket_key) DO NOTHING`, [minuteKey]);
  await db(
    `INSERT INTO tx_gate_buckets (bucket_key, scope, bucket, tx_count, amount_cents)
     SELECT $1 || ${dayExpr}, 'day', ${dayExpr}, 0, 0
     ON CONFLICT (bucket_key) DO NOTHING`, [dayKey]);

  // 1) 每分钟笔数（条件 UPDATE：原子）
  const m = await db(
    `UPDATE tx_gate_buckets SET tx_count = tx_count + 1, updated_at = now()
      WHERE bucket_key = $1 || ${minuteExpr} AND tx_count < $2
      RETURNING tx_count`, [minuteKey, L.maxTxPerMinute]);
  if (!m.rows.length) {
    return { ok: false, code: 'RATE_PER_MINUTE', reason: `最近一分钟已达上限 ${L.maxTxPerMinute} 笔（原子占用拒绝）` };
  }

  // 2) 每日笔数（原子；失败回滚第 1 步）
  const d = await db(
    `UPDATE tx_gate_buckets SET tx_count = tx_count + 1, updated_at = now()
      WHERE bucket_key = $1 || ${dayExpr} AND tx_count < $2
      RETURNING tx_count`, [dayKey, L.maxTxPerDay]);
  if (!d.rows.length) {
    await db(`UPDATE tx_gate_buckets SET tx_count = GREATEST(tx_count - 1, 0) WHERE bucket_key = $1 || ${minuteExpr}`, [minuteKey]);
    return { ok: false, code: 'RATE_PER_DAY', reason: `今日已达上限 ${L.maxTxPerDay} 笔（原子占用拒绝）` };
  }

  // 3) 每日金额（原子；失败回滚第 1、2 步）
  const maxCents = Math.round(Number(L.dailyMaxUsd) * 100);
  const a = await db(
    `UPDATE tx_gate_buckets SET amount_cents = amount_cents + $2, updated_at = now()
      WHERE bucket_key = $1 || ${dayExpr} AND amount_cents + $2 <= $3
      RETURNING amount_cents`, [dayKey, cents, maxCents]);
  if (!a.rows.length) {
    await db(`UPDATE tx_gate_buckets SET tx_count = GREATEST(tx_count - 1, 0) WHERE bucket_key = $1 || ${minuteExpr}`, [minuteKey]);
    await db(`UPDATE tx_gate_buckets SET tx_count = GREATEST(tx_count - 1, 0) WHERE bucket_key = $1 || ${dayExpr}`, [dayKey]);
    return { ok: false, code: 'AMOUNT_OVER_DAILY_CAP', reason: `本日额度已满，无法占用 ${amountUsd} USD（原子占用拒绝）` };
  }

  return {
    ok: true,
    reservation: { namespace: ns, cents, minuteKey: `${ns}minute`, dayKey: `${ns}day` },
    snapshot: {
      minuteCount: Number(m.rows[0].tx_count),
      dayCount: Number(d.rows[0].tx_count),
      dayAmountUsd: Number(a.rows[0].amount_cents) / 100,
    },
  };
}

/** 释放一次额度占用（审计写入失败等场景的补偿；失败不会导致放行，只会更保守） */
async function releaseQuota(reservation = {}, db = dbQuery) {
  const ns = reservation.namespace || '';
  const cents = Number(reservation.cents || 0);
  const minuteExpr = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')`;
  const dayExpr = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  await db(`UPDATE tx_gate_buckets SET tx_count = GREATEST(tx_count - 1, 0) WHERE bucket_key = $1 || ${minuteExpr}`, [_minuteKey(ns)]);
  await db(`UPDATE tx_gate_buckets SET tx_count = GREATEST(tx_count - 1, 0) WHERE bucket_key = $1 || ${dayExpr}`, [_dayKey(ns)]);
  if (cents > 0) {
    await db(`UPDATE tx_gate_buckets SET amount_cents = GREATEST(amount_cents - $2, 0) WHERE bucket_key = $1 || ${dayExpr}`, [_dayKey(ns), cents]);
  }
  return true;
}

/** 读取当前桶（供状态接口 / 测试核对） */
async function loadBuckets({ namespace = '', db = dbQuery } = {}) {
  const { rows } = await db(
    `SELECT bucket_key, tx_count, amount_cents FROM tx_gate_buckets
      WHERE bucket_key LIKE $1 || '%' ORDER BY bucket_key`, [namespace]);
  return rows.map((r) => ({ key: r.bucket_key, txCount: Number(r.tx_count), amountUsd: Number(r.amount_cents) / 100 }));
}

/** 记录一次门禁判断（append-only） */
async function recordAttempt(req = {}, decision = {}) {
  const { rows } = await dbQuery(
    `INSERT INTO tx_gate_attempts
       (chain_id, key, selector, intent_type, amount_usd, decision, reject_code, reject_reason, gate_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
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
  return rows[0] ? rows[0].id : null;
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
  reserveQuota,
  releaseQuota,
  loadBuckets,
  loadKillSwitch,
  loadCounters,
  loadGateState,
  recordAttempt,
  tripKillSwitch,
  clearKillSwitch,
};
