# MAINTENANCE — 维护日志

## 2026-11-10

### M2（模拟器）开发
- **实测发现（重要）**
  - **区块速度 = 0.1 秒/块（10 块/秒）** → 原「高度差 ≤50 块」的端点准入阈值改按时间口径；索引重组窗口由 64 块放大到 **3000 块（≈5 分钟）**
  - **公共 RPC 有速率限制**（主端点实测 `429 / -32017 Rate Limit Exceeded`）→ 全部读取改为：多端点轮换 + 指数退避（上限 4 次）+ Multicall3 合并请求 + 池状态 5 秒缓存
  - **日志查询有 1 万条上限**（`-32005 logs count limit exceeded`）→ 日志分块自适应（命中上限自动折半区间）；注意：早期一次「Swap 日志 0 条」实为该上限错误被吞掉，实际池内 Swap 事件超过 1 万条（交易非常活跃）
  - **第二端点 `https://elysium.drpc.org` 通过准入检查**（chainId ✓、高度差 0 块 ✓、延迟 49ms ✓、PoolManager/PositionManager/Permit2 的 getCode 哈希一致 ✓）；但其 `eth_getLogs` 不可用 → 能力路由：日志固定走主端点
  - **V4Quoter 候选 `0x379f556c…` 排除**：字节码 11 个选择器与官方 V4Quoter 不一致（仅 `poolManager()` / `unlockCallback(bytes)` 匹配），实测调用 `revert(0x)` → 白名单降级为 `verified-address` + `readEnabled=false`；报价改用**本地数学**
  - **归档状态可读**：Elysium RPC 支持历史 `eth_call`（已验证到 40 万块之前）→ 可实现「建仓时价格还原」
  - **ModifyLiquidity 事件 salt = bytes32(tokenId)**（链上验证：台账合计 == `getPositionLiquidity`，覆盖 677 个头寸 / 2119 条事件）
  - **TickMath 精度**：decimal.js（80 位）+ ceil 与「大整数有理数真值」逐位一致（tick 52534）；`MIN_SQRT_RATIO=4295128739` 一致
- **实现**
  - `lib/v4math.js`（本地数学 + 跨 tick 兑换估算）、`lib/ledger.js`（台账 + 历史价格缓存）、`lib/simulator.js`（建仓/撤池模拟）、`lib/analysis.js`（IL/HODL/Break-even/情景）
  - `routes/simulate.js`、`routes/analysis.js`、`routes/indexer.js` 重写（互斥同步）、`routes/rpc.js` 重写（端点健康）
  - `scripts/pm-behavior-compare.js` → `docs/M2-PM-BEHAVIOR.md`
  - 前端 `SimulatorPanel.tsx`（三页签）+ 头寸卡片「分析 · 模拟」入口
- **踩坑记录**
  - viem `multicall` 默认返回 `{status,result}` 形态 → 统一用 `mcRes()` 兼容两种形态（否则池状态读出 `undefined`）
  - `eth_estimateGas` 的 `value` 需偶数长度 hex（奇数长度会被节点判为参数错误）
  - 建仓 gas 估算失败的真实原因常是**地址余额不足**（编码有效）→ 错误文案已区分「余额不足 / 执行回滚 / 其他」
  - 1 wei 级尘埃会触发无意义的兑换估算 → 增加 1e-6 代币的尘埃阈值
- **验证结果**
  - 建仓模拟：#（1 HYPE + 300 KNTQ）→ 使用 1 HYPE + 141.377 KNTQ，L=406399689712623047175，多余 158.62 KNTQ 兑换估算 0.8396 HYPE（价格影响 0.0096%）
  - 撤池模拟：#5391 → 21.54 HYPE + 4140.23 KNTQ，手续费 0.0405 HYPE + 5.368 KNTQ，退出滑点 0.25%，gas **174,212**（链上估算）
  - 风险分析：#5391 → 台账 23 笔；HODL $3254.27 vs LP $3258.69（差额 +$4.42，其中 IL 部分 −$0.73）；所需交易量 $109.13
  - PM 对照：Elysium / ETH / Base **37/37 选择器一致**；`ownerOf(不存在)`、空 actions、未知 action、multicall 的 revert 选择器三链一致；`permit2()` 三链一致
- **待观察**
  - 采样数据积累（年化与收益速度需要样本跨度）
  - 官方渠道动态（影响 M3 交易开关）

## 2026-11-09

### M0（核验与白名单）✅ 已合并 main（1c39534）
- 完成 Elysium V4 部署全量核验（报告：`docs/M0-VERIFICATION.md`，修订 R1）
- 依 review 修订：read/write 分离、PoolKey 补全、PositionManager 措辞降级、BridgeRouter 降级 verified-address、RPC 表述修正、池数据快照时间、M1 事件索引决策
- 结论：PoolManager 逐字节一致；PositionManager 接口面一致（实现等价性待 M2）；官方归属 pending-official

### M1（只读看板）✅ 已合并 main（d135736，review 通过）
- **链上校准**（全部交叉验证通过）：
  - `_pools` 存储槽位 = 6（用 StateView.getSlot0 校准）；positions 偏移 +6
  - positionKey 带 tokenId salt（`keccak(encodePacked(PM, int24, int24, bytes32))`）
  - 待领费用纯数学路径验证：feeGrowthInsideLast ≤ now，费用为正且量级合理
- **踩坑记录**：
  - viem getLogs 在该 RPC 上丢失 topics 过滤 → 改原始 eth_getLogs + 二次过滤
  - viem getPoolAndPositionInfo 返回数组而非命名对象 → 兼容 `gpi.poolKey || gpi[0]`
  - Multicall3 转发改变 msg.sender，收费模拟无法用「前后余额差」读取金额 → 弃用，改数学路径
  - debug_traceCall 需 API key（该公共 RPC 不可用）
  - positions 路由最初漏挂 `ownerMatches` 字段 → 头寸全被过滤；已修复
  - tracked_positions 并发 upsert 产生重复行 → 唯一索引 `tracked_positions_chain_token_uniq` + `ON CONFLICT DO UPDATE` 修复
- 索引首轮同步：1937 条 Transfer（含 432 销毁），1398 个 tokenId，约 6.4 秒
- cron 注册成功：`sample-pool`（*/5 * * * *）
