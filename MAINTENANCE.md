# MAINTENANCE — 维护日志

## 2026-11-10（review 修订：P0-1 ~ P0-4）

### 被链上数据纠正的 V4 语义细节（**重要，后续实现勿再走弯路**）
- **`getAmount0Delta` 是两步取整**：`divRoundingUp(mulDivRoundingUp(n1,n2,b), a)`，不是单步 `ceil(a·b/(c·d))`；差 1 wei 会让「是否到达 tick 边界」的判定翻转（症状：价格与链上差 1 ULP、amountOut 差几十 wei）
- **手续费逐步计算**：每个 step 内先 `lessFee = floor(剩余输入 × (1e6−fee)/1e6)` 推进价格；到达边界时 `fee = ceil(amountIn × fee/(1e6−fee))`；未到边界时 `amountIn = lessFee`、`fee = 剩余 − amountIn`
- **tick 更新规则**：到达 tick 边界 → `tick = 边界−1`（零对一）/`边界`（一对零）；价格移动但未到边界 → `getTickAtSqrtRatio(价格)`；**价格未移动（只消耗手续费尘埃）→ tick 保持不变**
- **价格限制（`sqrtPriceLimitX96`）**：限价比边界更近 → 停在限价；限价恰为 tick 边界 → **先跨 tick（更新流动性/tick）再停止**；限价等于起始价 → 不成交
- **链上同时存在 exact-in 与 exact-out 两种交易**（路由器拆单/限价单常见）→ 估算器两种模式都实现
- **Swap 事件金额是交易者视角**：负数 = 付出（输入），正数 = 收到（输出）

### 验证方法（可复用）
- `backend/scripts/swap-vectors.js`：拉取池的真实 Swap + ModifyLiquidity 事件 → 只取「相邻两笔 Swap 之间无流动性变化」的样本 → 用前一笔后状态复现后一笔 → **8455/8455 逐位一致**（含 919 笔跨 tick），产物 `backend/tests/fixtures/swap-vectors.json` 供离线重放
- `backend/scripts/pm-behavior-compare.js`：权威选择器集合取自官方已部署合约 ABI（Sourcify 验证源）；Probe 解码后三分类断言（same-value / same-shape / chain-specific）→ 报告 `docs/M2-PM-BEHAVIOR.md`

### 修复
- `analysis.js`：`CHAIN.ID` → `CHAIN.id`（原写法恒为 undefined → 收益速度查询永远匹配不到）；新增显式校验，禁止把参数错误静默当作「采样不足」
- 测试体系：新增 `backend/tests/*.test.js`（41 用例），`bun run test` 一键运行；`package.json` 增加 `test` 脚本
- 口径与字段：`lpVsHodlExcludingCurrentFeesUsd`、`requiredVolumeApproxUsd`、`projectedBalanceAfterRemove`；前端与文档同步

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

## 2026-11-10（二次）参考向量独立性修订 — 方法论与坑

**背景**：review 指出原 8455 条 fixture 是「自证循环」——生成器用生产实现先猜模式（exact-in → exact-out → 加限价），再由同一实现重放验证。

**可复用的方法论**：
1. **独立参考实现**：`backend/reference/v4/` 是按官方源码逐句移植的第二实现（TickMath 用位分解算法、SqrtPriceMath 含 uint256 溢出分支、SwapMath、Pool.swap 循环、Universal Router 解码器）。用途：模式判定、feePaid 推导、与生产实现交叉验证。**生成/验证路径不得加载生产实现**（脚本内有运行时断言）。
2. **模式判定不允许猜测**：
   - 方案 A：calldata 解码（`execute(bytes,bytes[],uint256)` → `V4_SWAP` 命令 `0x10` → 动作 `SWAP_EXACT_IN_SINGLE/EXACT_OUT_SINGLE`，注意**部分部署在外层多包一个 0x20 偏移字**，需试 `skip1word` 变体；单跳 path 布局含中置 `uint256[] minHopPriceX36`）。
   - 方案 B：**排他性假设检验**——exact-in 与 exact-out 两种假设必须**恰好一种**能复现链上全部可观测值（amountIn/amountOut/sqrtPriceAfter/tickAfter/liquidityAfter）；两种都符合（歧义）或都不符合 → 排除。
3. **feePaid 链上反推的精确条件**（否则会得到 2×/3× 的错误值）：跨区块 + 区间内流动性不变 + **该笔是其区块最后一笔 Swap**（feeGrowthGlobal 只在区块末读取，同块后续 Swap 的手续费会混入 Δfg）+ 协议费为 0；重建用 `ceil(Δfg×L/2^128)`。本次 59 条全部逐位一致。
4. **池历史下界**：本池最早的 ModifyLiquidity 在块 **458201**（不是此前误用的 3077585）——用错下界会导致 tick 表不完整，跨 tick 样本全部无法复现（表现为「假设检验均不匹配」激增、跨 tick 覆盖为 0）。生成器改用 PositionManager 部署块 256083 作为下界。
5. **fixture 元数据**：SHA-256 + gzip SHA-256 + 区块范围 + Pool ID + 生成器 commit；测试强制断言独立性标记，避免「测试通过=自证」。
6. **统计口径**：按 mode 直接计数；排除原因逐类计数并写入 fixture，便于 review 复核。

**踩坑记录**：`v4math.reference.test.js` 中 exact-out 向量必须传 `expected.amountOut` 作为指定金额（传 amountIn 会得到巨大偏差）；`swap-vectors.test.js` 的跨 tick 子集必须用向量自带的 mode 重放。

## 2026-11-10（三次）fixture provenance 修订 — 经验

**问题**：fixture 由旧提交的代码生成（生成器与 `reference/v4/*` 在后续提交中改动过），测试只断言 `generatorCommit !== undefined` → 无法发现「代码已变、fixture 未重新生成」。

**做法（可复用）**：
1. 生成器在生成时记录**逐文件代码哈希**（生成器自身 + 独立参考实现所有 `.js`，共 6 个文件）写入 `stats.codeHashes` 与 `meta.codeHashes`；另记录 `generatorCommitDirty`（生成时工作树是否干净）。
2. 测试用**当前工作树**重算这些哈希并逐文件比对 → 改代码不重新生成即失败（失败信息直接给出重新生成命令）。
3. 断言 `meta.generatorCommit === stats.generatorCommit`；文档明确「generatorCommit 是生成快照，不要求等于最新 HEAD；fixture 不是运行时动态生成」。
4. 测试同时校验 gzip 解压内容与 JSON 完全一致，避免压缩包与 JSON 脱节。
5. 命名：`mismatchCount` 易被误读为「数学不一致」，改为 `excludedCount`；新增 `validationCounts` 统一统计口径。
6. 隔离检查进测试：`reference/v4/*` 不得 `require` 生产 `lib/v4math.js`（本次为纯注释提及，已确认无反向依赖）。

**流程教训**：任何会改变 fixture 生成结果的文件（生成器、参考实现、常量）修改后，**必须重新生成并提交 fixture（JSON + gzip + meta）**；重新生成耗时约 4 分钟，属于必须付出的成本。

**本次踩坑**：`generatorCommitDirty` 的 `git status --porcelain` 用了相对 `backend/` 的 pathspec，但 `cwd` 是仓库根 → git 不匹配任何文件 → 恒返回 `false`（等于没检查）。正确写法：`cwd = 仓库根` + `backend/scripts/swap-vectors.js backend/reference`。**凡是用 git 状态做门禁，必须先用「故意弄脏工作树」的方式验证它真的会报 true。**

