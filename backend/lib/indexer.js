/**
 * Transfer 事件索引（M1）—— 从 PositionManager 部署区块回溯 + 增量同步。
 * 去重与重组处理：每次同步回退 REORG_WINDOW 个区块，先删除重叠窗口再重插（幂等）。
 */
const { dbQuery } = require('@surf-ai/sdk/db');
const chain = require('./chain');
const { CHAIN } = require('../config/whitelist');

const CHAIN_ID = CHAIN.id;
const PM = chain.PM_ADDR;
const DEPLOY_BLOCK = chain.DEPLOY_BLOCK;
const REORG_WINDOW = 64;
const DEFAULT_CHUNK = 500000;

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
    progress: Number(progress.toFixed(4)), lastSyncedAt: st ? st.last_synced_at : null, reorgWindow: REORG_WINDOW,
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

async function syncOnce({ maxMs = 8000 } = {}) {
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

async function candidatesForWallet(address) {
  const { rows } = await dbQuery(
    `SELECT token_id FROM (
       SELECT DISTINCT ON (token_id) token_id, to_addr
       FROM position_transfers
       WHERE chain_id=$1 AND position_manager=$2
       ORDER BY token_id, block_number DESC, log_index DESC
     ) t
     WHERE lower(to_addr)=lower($3) AND to_addr <> '0x0000000000000000000000000000000000000000'
     ORDER BY token_id::numeric DESC
     LIMIT 60`, [CHAIN_ID, PM, address]);
  return rows.map((r) => r.token_id);
}

module.exports = { CHAIN_ID, PM, getIndexStatus, syncOnce, candidatesForWallet };
