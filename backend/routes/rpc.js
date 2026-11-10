/**
 * GET /api/rpc —— RPC 健康状态（当前活跃端点 / 延迟 / failover 是否启用）。
 */
const express = require('express');
const router = express.Router();
const chain = require('../lib/chain');
const { CHAIN } = require('../config/whitelist');

router.get('/', async (_req, res) => {
  const status = chain.getRpcStatus();
  let latestBlock = null;
  try {
    latestBlock = await chain.latestBlock();
  } catch (e) { /* 状态照常返回 */ }
  const latencyMs = status.endpoints.find((e) => e.url === status.active)?.latencyMs ?? null;
  res.json({
    chainId: CHAIN.id,
    chainName: CHAIN.name,
    latestBlock,
    latencyMs,
    ...status,
    note: status.failoverEnabled
      ? '多端点故障切换已启用'
      : '当前仅 1 个已核验端点；故障切换框架预留，备用端点需通过准入校验（chainId / 高度对比 / 延迟 / 关键地址 getCode 一致性）后启用',
  });
});

module.exports = router;
