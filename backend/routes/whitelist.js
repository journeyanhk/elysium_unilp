/**
 * GET /api/whitelist —— 白名单摘要（供「核验与设置」页展示读写权限与证据）。
 */
const express = require('express');
const router = express.Router();
const { CHAIN, CONTRACTS, TOKENS, POOLS, EXCLUDED, UNIDENTIFIED_STACK } = require('../config/whitelist');

router.get('/', (_req, res) => {
  res.json({
    chain: { id: CHAIN.id, name: CHAIN.name, rpcEndpoints: CHAIN.rpcEndpoints },
    contracts: Object.entries(CONTRACTS).map(([key, c]) => ({ key, ...c })),
    tokens: Object.entries(TOKENS).map(([key, t]) => ({ key, ...t })),
    pools: Object.entries(POOLS).map(([key, p]) => ({ key, ...p })),
    excludedCount: EXCLUDED.length,
    unidentifiedCount: UNIDENTIFIED_STACK.length,
    writeLockNote: 'M1 只读：全部地址 writeEnabled=false；写操作在运行时被统一拦截（backend/lib/tx-guard.js）。交易开关（M3）通过后按合约逐个开启。',
  });
});

module.exports = router;
