# MAINTENANCE — 维护日志

## 2026-11-09

### M0（核验与白名单）✅ 已合并 main（1c39534）
- 完成 Elysium V4 部署全量核验（报告：`docs/M0-VERIFICATION.md`，修订 R1）
- 依 review 修订：read/write 分离、PoolKey 补全、PositionManager 措辞降级、BridgeRouter 降级 verified-address、RPC 表述修正、池数据快照时间、M1 事件索引决策
- 结论：PoolManager 逐字节一致；PositionManager 接口面一致（实现等价性待 M2）；官方归属 pending-official

### M1（只读看板）开发
- **链上校准**（全部交叉验证通过）：
  - `_pools` 存储槽位 = 6（用 StateView.getSlot0 校准）；positions 偏移 +6
  - positionKey 带 tokenId salt（`keccak(encodePacked(PM, int24, int24, bytes32))`）——最初漏 salt 导致读 0，修正后 extsload 流动性 == PM.getPositionLiquidity
  - 待领费用纯数学路径验证：feeGrowthInsideLast ≤ now，费用为正且量级合理
- **踩坑记录**：
  - viem getLogs 在该 RPC 上丢失 topics 过滤 → 改原始 eth_getLogs + 二次过滤（已写入 lib/chain.js 注释）
  - viem getPoolAndPositionInfo 返回数组而非命名对象 → 兼容 `gpi.poolKey || gpi[0]`
  - Multicall3 转发改变 msg.sender，收费模拟无法用「前后余额差」读取金额 → 弃用，改数学路径
  - debug_traceCall 需 API key（该公共 RPC 不可用）
  - positions 路由最初漏挂 `ownerMatches` 字段 → 头寸全被过滤；已修复（路由内按 ownerOf 比对地址）
  - tracked_positions 并发 upsert 产生重复行 → 唯一索引 `tracked_positions_chain_token_uniq` + `ON CONFLICT DO UPDATE` 修复（backend/lib/db.js 幂等建索引）
  - schema 新增 block_time 列：SDK 自动加列成功（无需重建表）
- 索引首轮同步：1937 条 Transfer（含 432 销毁），1398 个 tokenId，约 6.4 秒
- cron 注册成功：`sample-pool`（*/5 * * * *，池+被跟踪头寸采样）

### 待观察
- 采样数据积累（年化窗口需要 ≥ 窗口一半跨度的样本）
- 官方渠道动态（Uniswap/Elysium 文档更新）——影响 M3 交易开关
