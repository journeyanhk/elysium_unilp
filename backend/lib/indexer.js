/**
 * Transfer 事件索引（M1 → M2）—— 从 PositionManager 部署区块回溯 + 增量同步。
 *
 * M2 变更：
 *  - 并发保护：进程内互斥锁（多个浏览器同时点刷新不会重复同步）；重复请求返回 syncInProgress
 *  - 重组窗口按真实块速（0.1s/块）放大到 3000 块（≈5 分钟），窗口内删除后重插保证幂等
 *  - 候选头寸不再硬截断 60：分批读取（每批 40），返回 truncated / totalCandidates 供前端提示
 */
const { dbQuery } = require('@surf-ai/sdk/db');
const chain = require('./chain');
const { CHAIN } = require('../config/whitelist');

const CHAIN_ID = CHAIN.id;
const PM = chain.PM_ADDR;
const DEPLOY_BLOCK = chain.DEPLOY_BLOCK;
const REORG_WINDOW = 3000;
const DEFAULT_CHUNK = 2000000;
const CANDIDATE_CAP = 400; // 单地址候选上限（超出会在响应中标记 truncated）

let syncLock = null; // 进程内互斥

async function stateRow() {
  const { rows } = await dbQuery('SELECT * FROM indexer_state WHERE chain_id=$1 AND position_manager=$2 LIMIT 1', [CHAIN_ID, PM]);
  return rows[0] || null;
}

async function getIndexStatus() {
  const st = await stateRow();
  const latest = await chain.latestBlock();
  const lastSynced = st ? Number(st.last_synced_block) : DEPLOY_BLOCK - 1;
  const total = Math.max(1, latest - (DEPLOY_BLOCK - 1));
  const progress = Math.min(1, Math.max(0, (lastSynced - (DEPLOY_BLOCK - 1)) / total));
  return {
    chainId: CHAIN_ID, positionManager: PM, deployBlock: DEPLOY_BLOCK,
    lastSyncedBlock: lastSynced, latestBlock: latest, synced: lastSynced >= latest,
    progress: Number(progress.toFixed(4)), lastSyncedAt: st ? st.last_synced_at : null,
    reorgWindow: REORG_WINDOW, syncInProgress: !!syncLock,
  };
}

async function insertLogs(logs) {
  const B = 100;
  for (let i = 0; i < logs.length; i += B) {
    const batch = logs.slice(i, i + B);
    const values = [];
    const params = [];
    batch.forEach((lg, j) => {
      const b = j * 9;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`);
      const blockTime = lg.blockTimestamp ? new Date(Number(BigInt(lg.blockTimestamp)) * 1000).toISOString() : null;
      params.push(
        CHAIN_ID, PM, BigInt(lg.topics[3]).toString(),
        '0x' + lg.topics[1].slice(26), '0x' + lg.topics[2].slice(26),
        Number(BigInt(lg.blockNumber)), lg.transactionHash, Number(BigInt(lg.logIndex)), blockTime,
      );
    });
    await dbQuery(
      `INSERT INTO position_transfers (chain_id, position_manager, token_id, from_addr, to_addr, block_number, tx_hash, log_index, block_time) VALUES ${values.join(',')}`,
      params);
  }
}

async function syncInner({ maxMs = 8000 } = {}) {
  const t0 = Date.now();
  let chunk = DEFAULT_CHUNK;
  let inserted = 0; let rounds = 0;
  while (Date.now() - t0 < maxMs) {
    const st = await stateRow();
    const latest = await chain.latestBlock();
    const lastSynced = st ? Number(st.last_synced_block) : DEPLOY_BLOCK - 1;
    if (lastSynced >= latest) break;
    const start = Math.max(DEPLOY_BLOCK, lastSynced + 1 - (st ? REORG_WINDOW : 0));
    const end = Math.min(latest, start + chunk - 1);
    let logs;
    try {
      logs = await chain.fetchTransfers(start, end);
    } catch (e) {
      if (chunk > 2000) { chunk = Math.floor(chunk / 2); continue; } // 自适应缩小范围
      throw e;
    }
    if (st) {
      await dbQuery('DELETE FROM position_transfers WHERE chain_id=$1 AND position_manager=$2 AND block_number >= $3', [CHAIN_ID, PM, start]);
    }
    if (logs.length) await insertLogs(logs);
    inserted += logs.length; rounds++;
    const upd = await dbQuery('UPDATE indexer_state SET last_synced_block=$1, last_synced_at=now() WHERE chain_id=$2 AND position_manager=$3', [end, CHAIN_ID, PM]);
    if (upd.rowCount === 0) {
      await dbQuery('INSERT INTO indexer_state (chain_id, position_manager, last_synced_block, last_synced_at) VALUES ($1,$2,$3,now())', [CHAIN_ID, PM, end]);
    }
  }
  const status = await getIndexStatus();
  return { ...status, rounds, inserted, elapsedMs: Date.now() - t0 };
}

/** 互斥同步：已有同步在跑时立即返回（不阻塞请求） */
async function syncOnce(opts = {}) {
  if (syncLock) return { ...(await getIndexStatus()), syncInProgress: true, skipped: true };
  syncLock = syncInner(opts);
  try { return await syncLock; } finally { syncLock = null; }
}

/**
 * 候选头寸（按地址）：分批取，返回截断信息（M2 review 修复项）
 * @returns {{ ids: string[], totalCandidates: number, returned: number, truncated: boolean }}
 */
async function candidatesForWalletDetailed(address, { cap = CANDIDATE_CAP } = {}) {
  const { rows } = await dbQuery(
    `SELECT token_id FROM (
       SELECT DISTINCT ON (token_id) token_id, to_addr
       FROM position_transfers
       WHERE chain_id=$1 AND position_manager=$2
       ORDER BY token_id, block_number DESC, log_index DESC
     ) t
     WHERE lower(to_addr)=lower($3) AND to_addr <> '0x0000000000000000000000000000000000000000'
     ORDER BY token_id::numeric DESC
     LIMIT $4`, [CHAIN_ID, PM, address, cap + 1]);
  const truncated = rows.length > cap;
  const ids = rows.slice(0, cap).map((r) => r.token_id);
  const { rows: cnt } = await dbQuery(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT DISTINCT ON (token_id) token_id, to_addr
       FROM position_transfers
       WHERE chain_id=$1 AND position_manager=$2
       ORDER BY token_id, block_number DESC, log_index DESC
     ) t
     WHERE lower(to_addr)=lower($3) AND to_addr <> '0x0000000000000000000000000000000000000000'`,
    [CHAIN_ID, PM, address]);
  return { ids, totalCandidates: cnt[0] ? cnt[0].n : ids.length, returned: ids.length, truncated };
}

/** 兼容旧调用（返回数组） */
async function candidatesForWallet(address) {
  const r = await candidatesForWalletDetailed(address);
  return r.ids;
}

module.exports = { CHAIN_ID, PM, REORG_WINDOW, getIndexStatus, syncOnce, candidatesForWallet, candidatesForWalletDetailed };
