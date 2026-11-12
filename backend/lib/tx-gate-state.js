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
const { dbQuerySafe } = require('./db');

/**
 * 事务互斥锁（M3.2 review P0-1）：
 * 数据库代理为每进程一条共享会话，显式事务不能并发交错（否则 BEGIN/COMMIT 会互相吞并）。
 * 门禁本身限制「每分钟 1 笔」，串行化事务没有性能代价。
 */
let _txChain = Promise.resolve();
function withTxLock(fn) {
  const run = _txChain.then(fn, fn);
  _txChain = run.then(() => {}, () => {}); // 无论成败都释放锁
  return run;
}

const storeKind = 'postgres';

/** 当前熔断状态（最后一条事件） */
async function loadKillSwitch() {
  const { rows } = await dbQuerySafe(
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
  const { rows } = await dbQuerySafe(
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
 * 原子额度占用（M3.2 review P0-1 / 最终评审 P0-1）：
 *   三个桶（分钟笔数 / 日笔数 / 日金额）的更新在**同一个 Postgres 事务**中完成：
 *     BEGIN → 幂等建桶 → SELECT ... FOR UPDATE（行锁） → 条件 UPDATE ×3（CTE 串联，全部成功才生效） → COMMIT
 *   任一步不满足 → 三个桶都不变（不是「先更新再补偿」）。
 *   出错时在同一把锁内发 ROLLBACK，避免共享会话被污染（否则整个进程的查询都会失败）。
 *
 * ⚠️ 为什么参数是「内联」而不是 $1/$2 占位符：
 *   该数据库代理在带参数时使用预处理语句（扩展协议），Postgres 明确拒绝
 *   「cannot insert multiple commands into a prepared statement」——
 *   即带参数的 BEGIN/COMMIT 多语句事务在本代理上无法使用。
 *   因此这里改为：**所有内联值先做严格校验**（整数 / 受限字符集），再拼进单次事务语句。
 */
/** 内联值校验：只允许受限命名空间与整数，防止 SQL 注入 */
function _safeNamespace(ns) {
  const v = String(ns == null ? '' : ns);
  if (!/^[A-Za-z0-9_-]{0,64}$/.test(v)) throw new Error(`命名空间非法：${v.slice(0, 40)}`);
  return v;
}
function _safeInt(v, label) {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 1e12) throw new Error(`${label} 必须是合法整数：${v}`);
  return n;
}

const _minuteExpr = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')`;
const _dayExpr = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;

async function reserveQuota({ amountUsd, config, namespace = '', db = dbQuerySafe } = {}) {
  const L = config.limits;
  const cents = Math.round(Number(amountUsd) * 100);
  if (!Number.isFinite(cents) || cents <= 0) {
    return { ok: false, code: 'AMOUNT_INVALID', reason: '额度占用金额必须大于 0' };
  }
  const ns = _safeNamespace(namespace);
  const reservationId = _safeNamespace(require('crypto').randomBytes(16).toString('hex'));
  const minuteKey = `${ns}minute:`;
  const dayKey = `${ns}day:`;
  const maxMinute = _safeInt(L.maxTxPerMinute, 'maxTxPerMinute');
  const maxDay = _safeInt(L.maxTxPerDay, 'maxTxPerDay');
  const maxCents = _safeInt(Math.round(Number(L.dailyMaxUsd) * 100), 'dailyMaxUsd(分)');
  const centsLit = _safeInt(cents, 'amountUsd(分)');
  const mKey = `'${minuteKey}'`;
  const dKey = `'${dayKey}'`;

  const sql = `WITH locked AS (
  SELECT bucket_key, tx_count, amount_cents FROM tx_gate_buckets
   WHERE bucket_key IN ($1 || ${_minuteExpr}, $2 || ${_dayExpr}) ORDER BY bucket_key FOR UPDATE
), cur AS (
  SELECT COALESCE((SELECT tx_count FROM locked WHERE bucket_key = $1 || ${_minuteExpr}), 0) AS m_cnt,
         COALESCE((SELECT tx_count FROM locked WHERE bucket_key = $2 || ${_dayExpr}), 0) AS d_cnt,
         COALESCE((SELECT amount_cents FROM locked WHERE bucket_key = $2 || ${_dayExpr}), 0) AS d_amt,
         (SELECT count(*) FROM locked) AS locked_n
), dec AS (
  SELECT (locked_n = 2 AND m_cnt < $3 AND d_cnt < $4 AND d_amt + $5 <= $6) AS pass,
         CASE WHEN locked_n <> 2 THEN 'BUCKET_MISSING'
              WHEN m_cnt >= $3 THEN 'RATE_PER_MINUTE'
              WHEN d_cnt >= $4 THEN 'RATE_PER_DAY'
              WHEN d_amt + $5 > $6 THEN 'AMOUNT_OVER_DAILY_CAP'
              ELSE NULL END AS reject_code,
         m_cnt, d_cnt, d_amt
    FROM cur
), m AS (
  UPDATE tx_gate_buckets SET tx_count = tx_count + 1, updated_at = now()
   WHERE bucket_key = $1 || ${_minuteExpr} AND (SELECT pass FROM dec) RETURNING tx_count AS c
), d AS (
  -- 日笔数与日金额必须在**同一条 UPDATE** 内完成：
  -- Postgres 的同一语句中，两个 CTE 修改同一行时只有一个会生效（快照隔离）。
  UPDATE tx_gate_buckets
     SET tx_count = tx_count + 1, amount_cents = amount_cents + $5, updated_at = now()
   WHERE bucket_key = $2 || ${_dayExpr} AND (SELECT pass FROM dec)
   RETURNING tx_count AS c, amount_cents AS ac
), r AS (
  -- 唯一 reservation id：释放必须条件更新，重复释放无副作用
  INSERT INTO tx_gate_reservations (reservation_id, namespace, amount_cents, minute_key, day_key, released)
  SELECT $7, $8, $5, $1 || ${_minuteExpr}, $2 || ${_dayExpr}, 'false'
   WHERE (SELECT pass FROM dec)
  RETURNING reservation_id
)
SELECT (SELECT pass FROM dec) AS ok, (SELECT reject_code FROM dec) AS reject_code,
       (SELECT c FROM m) AS minute_count, (SELECT c FROM d) AS day_count, (SELECT ac FROM d) AS day_cents,
       (SELECT reservation_id FROM r) AS reservation_id`;

  return withTxLock(async () => {
    // 幂等建桶必须在原子语句之前完成：同一语句内的 CTE 互相看不到对方写入的行
    await db(`INSERT INTO tx_gate_buckets (bucket_key, scope, bucket, tx_count, amount_cents)
       SELECT $1 || ${_minuteExpr}, 'minute', ${_minuteExpr}, 0, 0 ON CONFLICT (bucket_key) DO NOTHING`, [minuteKey]);
    await db(`INSERT INTO tx_gate_buckets (bucket_key, scope, bucket, tx_count, amount_cents)
       SELECT $1 || ${_dayExpr}, 'day', ${_dayExpr}, 0, 0 ON CONFLICT (bucket_key) DO NOTHING`, [dayKey]);

    let r;
    try {
      r = await db(sql, [minuteKey, dayKey, maxMinute, maxDay, centsLit, maxCents, reservationId, ns]);
    } catch (e) {
      // 出错时立刻回滚，避免共享会话停留在 aborted 状态拖垮整个进程
      try { await db('ROLLBACK'); } catch { /* 无活动事务时 ROLLBACK 会告警，不致命 */ }
      throw e;
    }
    const row = (r.rows && r.rows.length) ? r.rows[0] : null;
    if (!row || row.ok == null) throw new Error('额度占用未返回结果（原子语句结果缺失），已拒绝');
    if (row.ok !== true) {
      const code = row.reject_code || 'QUOTA_REJECTED';
      const reasons = {
        RATE_PER_MINUTE: `最近一分钟已达上限 ${maxMinute} 笔（原子占用拒绝）`,
        RATE_PER_DAY: `今日已达上限 ${maxDay} 笔（原子占用拒绝）`,
        AMOUNT_OVER_DAILY_CAP: `本日额度已满，无法占用 ${amountUsd} USD（原子占用拒绝）`,
        BUCKET_MISSING: '额度桶缺失，拒绝占用',
      };
      return { ok: false, code, reason: reasons[code] || `额度占用被拒绝（${code}）` };
    }
    return {
      ok: true,
      reservation: { reservationId: row.reservation_id, namespace: ns, cents, minuteKey: minuteKey, dayKey: dayKey },
      snapshot: {
        minuteCount: Number(row.minute_count),
        dayCount: Number(row.day_count),
        dayAmountUsd: Number(row.day_cents) / 100,
      },
    };
  });
}

/**
 * 释放一次额度占用（审计写入失败等场景的补偿）。
 * M3.2 最终评审 P1：以**唯一 reservation id** 为准，释放是条件更新：
 *   - 已释放过的 reservation 再释放 → 无任何副作用（重复 release 安全）
 *   - reservation 不存在 → 无任何副作用
 *   - 三个桶的扣减与标记释放同处一条语句（全或无）
 */
async function releaseQuota(reservation = {}, db = dbQuerySafe) {
  const rid = reservation.reservationId ? _safeNamespace(String(reservation.reservationId)) : null;
  if (!rid) throw new Error('释放额度必须提供 reservationId（唯一占用标识）');
  const sql = `WITH u AS (
  UPDATE tx_gate_reservations SET released = 'true', released_at = now()
   WHERE reservation_id = $1 AND released <> 'true'
   RETURNING namespace, amount_cents, minute_key, day_key
), m AS (
  UPDATE tx_gate_buckets SET tx_count = GREATEST(tx_count - 1, 0), updated_at = now()
   WHERE bucket_key = (SELECT minute_key FROM u) AND (SELECT count(*) FROM u) = 1
   RETURNING tx_count AS c
), d AS (
  UPDATE tx_gate_buckets
     SET tx_count = GREATEST(tx_count - 1, 0),
         amount_cents = GREATEST(amount_cents - (SELECT amount_cents FROM u), 0),
         updated_at = now()
   WHERE bucket_key = (SELECT day_key FROM u) AND (SELECT count(*) FROM u) = 1
   RETURNING tx_count AS c
)
SELECT (SELECT count(*) FROM u) AS released_n, (SELECT c FROM m) AS minute_count, (SELECT c FROM d) AS day_count`;
  return withTxLock(async () => {
    try {
      const r = await db(sql, [rid]);
      const row = (r.rows && r.rows.length) ? r.rows[0] : null;
      return { released: row ? Number(row.released_n) === 1 : false };
    } catch (e) {
      try { await db('ROLLBACK'); } catch { /* 同上 */ }
      throw e;
    }
  });
}

/** 读取某 reservation 的释放状态（供测试核对） */
async function loadReservation({ reservationId, db = dbQuerySafe } = {}) {
  const { rows } = await db(
    `SELECT reservation_id, namespace, amount_cents, minute_key, day_key, released, released_at
       FROM tx_gate_reservations WHERE reservation_id = $1`, [String(reservationId)]
  );
  return rows.length ? rows[0] : null;
}

/** 读取当前桶（供状态接口 / 测试核对） */
async function loadBuckets({ namespace = '', db = dbQuerySafe } = {}) {
  const { rows } = await db(
    `SELECT bucket_key, tx_count, amount_cents FROM tx_gate_buckets
      WHERE bucket_key LIKE $1 || '%' ORDER BY bucket_key`, [namespace]);
  return rows.map((r) => ({ key: r.bucket_key, txCount: Number(r.tx_count), amountUsd: Number(r.amount_cents) / 100 }));
}

/** 记录一次门禁判断（append-only） */
async function recordAttempt(req = {}, decision = {}) {
  const { rows } = await dbQuerySafe(
    `INSERT INTO tx_gate_attempts
       (chain_id, key, selector, intent_type, amount_usd, decision, reject_code, reject_reason, gate_version, intent_id, binding_hash, binding, user_addr, authorization_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
      req.intentId != null ? String(req.intentId) : null,
      decision.bindingHash || null,
      decision.binding ? JSON.stringify(decision.binding) : null,
      req.user || null,
      decision.ok ? 'authorized' : null, // 只有放行的记录才是「可消费的授权」
    ]
  );
  return rows[0] ? rows[0].id : null;
}

/** 触发熔断（append-only 事件） */
async function tripKillSwitch({ reason, actor = 'system' } = {}) {
  if (!reason) throw new Error('触发熔断必须提供原因');
  const { rows } = await dbQuerySafe(
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
  const { rows } = await dbQuerySafe(
    `INSERT INTO gate_kill_switch (event_type, reason, actor, review_note) VALUES ('clear', $1, $2, $3) RETURNING id, created_at`,
    ['人工复核后清除', actor, String(reviewNote).slice(0, 1000)]
  );
  return { tripped: false, eventId: rows[0].id, at: rows[0].created_at };
}

/**
 * 按 intent + 绑定哈希 + 用户 取「可消费的授权」记录（M3.2 第四轮 P0-2）：
 *   - 只认 decision='allowed' 且 authorization_status='authorized'（未被消费）
 *   - 不能只按 intentId 取最近一条：必须同时匹配 bindingHash 与用户地址
 */
async function loadLatestAuthorization({ intentId, bindingHash = null, user = null, includeConsumed = false, db = dbQuerySafe } = {}) {
  const params = [String(intentId)];
  let sql = `SELECT id, decision, intent_id, binding_hash, binding, user_addr, authorization_status, consumed_at, consumed_by, created_at
               FROM tx_gate_attempts
              WHERE intent_id = $1 AND decision = 'allowed' AND binding_hash IS NOT NULL`;
  if (!includeConsumed) sql += ` AND (authorization_status IS NULL OR authorization_status = 'authorized')`;
  if (bindingHash) { params.push(String(bindingHash).toLowerCase()); sql += ` AND lower(binding_hash) = $${params.length}`; }
  if (user) { params.push(String(user).toLowerCase()); sql += ` AND lower(user_addr) = $${params.length}`; }
  sql += ' ORDER BY id DESC LIMIT 1';
  const { rows } = await db(sql, params);
  if (!rows.length) return null;
  const r = rows[0];
  let binding = null;
  try { binding = r.binding ? JSON.parse(r.binding) : null; } catch { binding = null; }
  return {
    attemptId: r.id, intentId: r.intent_id, bindingHash: r.binding_hash, binding,
    user: r.user_addr, status: r.authorization_status || 'authorized',
    consumedAt: r.consumed_at, consumedBy: r.consumed_by, at: r.created_at,
  };
}

/** 是否存在已被消费的授权（用于给出明确拒绝原因） */
async function loadConsumedAuthorization({ intentId, bindingHash = null, db = dbQuerySafe } = {}) {
  const params = [String(intentId)];
  let sql = `SELECT id, consumed_at, consumed_by FROM tx_gate_attempts
              WHERE intent_id = $1 AND decision = 'allowed' AND authorization_status = 'consumed'`;
  if (bindingHash) { params.push(String(bindingHash).toLowerCase()); sql += ` AND lower(binding_hash) = $${params.length}`; }
  sql += ' ORDER BY id DESC LIMIT 1';
  const { rows } = await db(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * 一次性消费授权（M3.2 第四轮 P0-2）：
 *   条件更新，只有「未消费的 allowed 记录」能被消费一次；重复消费返回 0 行 → 调用方必须拒绝。
 */
async function consumeAuthorization({ attemptId, actor = 'user', db = dbQuerySafe } = {}) {
  if (!attemptId) throw new Error('消费授权必须提供授权记录 id');
  const { rows } = await db(
    `UPDATE tx_gate_attempts
        SET authorization_status = 'consumed', consumed_at = now(), consumed_by = $2
      WHERE id = $1
        AND decision = 'allowed'
        AND (authorization_status IS NULL OR authorization_status = 'authorized')
      RETURNING id, intent_id, binding_hash, user_addr, consumed_at, consumed_by`,
    [Number(attemptId), String(actor).slice(0, 200)]
  );
  if (!rows.length) return { ok: false, reason: '授权不存在、已被消费或不属于可消费状态（拒绝重复签名/重复广播）' };
  const r = rows[0];
  return { ok: true, attemptId: r.id, intentId: r.intent_id, bindingHash: r.binding_hash, user: r.user_addr, consumedAt: r.consumed_at, consumedBy: r.consumed_by };
}

/** 取某 intent 最近一次「成功」的模拟记录（签名前核对必须使用权威模拟数据） */
async function loadLatestSimulation({ intentId, db = dbQuerySafe } = {}) {
  const { rows } = await db(
    `SELECT id, intent_id, sim_block_number, sim_block_hash, state_block_number, eth_call_ok,
            gas_estimate, gas_price_gwei, gas_usd, sim_result_hash,
            gas_limit, max_fee_per_gas_wei, max_priority_fee_per_gas_wei, gas_plan_version, created_at
       FROM tx_simulations
      WHERE intent_id = $1 AND eth_call_ok = 1
      ORDER BY id DESC LIMIT 1`, [Number(intentId)]
  );
  if (!rows.length) return null;
  return {
    simulationId: rows[0].id,
    intentId: rows[0].intent_id,
    simBlock: rows[0].sim_block_number != null ? Number(rows[0].sim_block_number) : null,
    simBlockHash: rows[0].sim_block_hash,
    quoteBlock: rows[0].state_block_number != null ? Number(rows[0].state_block_number) : null,
    gasEstimate: rows[0].gas_estimate,
    gasPriceGwei: rows[0].gas_price_gwei != null ? Number(rows[0].gas_price_gwei) : null,
    gasUsd: rows[0].gas_usd != null ? Number(rows[0].gas_usd) : null,
    gasLimit: rows[0].gas_limit != null ? Number(rows[0].gas_limit) : null,
    maxFeePerGasWei: rows[0].max_fee_per_gas_wei,
    maxPriorityFeePerGasWei: rows[0].max_priority_fee_per_gas_wei,
    gasPlanVersion: rows[0].gas_plan_version,
    simResultHash: rows[0].sim_result_hash,
    at: rows[0].created_at,
    createdAtMs: rows[0].created_at ? new Date(rows[0].created_at).getTime() : null,
  };
}

module.exports = {
  storeKind,
  withTxLock,
  loadLatestAuthorization,
  loadConsumedAuthorization,
  consumeAuthorization,
  loadLatestSimulation,
  reserveQuota,
  releaseQuota,
  loadBuckets,
  loadReservation,
  loadKillSwitch,
  loadCounters,
  loadGateState,
  recordAttempt,
  tripKillSwitch,
  clearKillSwitch,
};
