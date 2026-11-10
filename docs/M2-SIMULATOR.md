# M2 模拟器 — 方法、验证与边界（review 修订版）

> 生成日期：2026-11-10（P0-1 ~ P0-4 修订）｜ 阶段：M2（模拟器）｜ 状态：修订完成，待二次 review
>
> **M2 全程只模拟：不构造交易、不请求任何签名、不发交易。** 白名单所有地址 `writeEnabled=false`，前后端运行时拦截器均在位。

## 0. 本次修订（对应 review 4 个阻塞项）

| Review 项 | 问题 | 处理 |
|---|---|---|
| **P0-1** | `analysis.js` 使用 `CHAIN.ID`（不存在）→ 收益速度查询恒为空 | 改为 `CHAIN.id`；全仓搜索确认无同类大小写错误；查询前增加 `if (!Number.isInteger(CHAIN.id)) throw`（禁止把参数错误静默当成「采样不足」）；收益速度与 Break-even 抽成纯函数并加回归测试 |
| **P0-2** | PM 对照报告只并排展示截断的 ABI 串，无机器可判定断言 | 脚本重写：**权威选择器集合取自官方已部署合约的 ABI（Sourcify 验证源）**；Probe 返回值**解码后**按 same-value / same-shape / chain-specific 三类断言，逐项 PASS/FAIL；目标地址代码存在性检查；报告分开陈述结论 |
| **P0-3** | 跨 tick Swap 的手续费/取整未按 V4 逐步语义验证 | `lib/v4math.js` 按官方源码（`SwapMath.computeSwapStep` / `SqrtPriceMath`）**逐行重写**；用链上真实 Swap 事件生成参考向量回归：**8455/8455 逐位一致**（含 919 笔跨 tick） |
| **P0-4** | 缺少可重复运行的自动化回归测试 | 新增 6 个测试文件、41 个用例（含 8455 条链上向量离线重放）：`bun run test` |
| 口径修正 | 「无常损失」「V4 精确估算」「行为级验证完成」等表述过强 | 字段与文案改为：`lpVsHodlExcludingCurrentFeesUsd`（近似 IL）、`requiredVolumeApproxUsd`（静态近似）、`projectedBalanceAfterRemove`（不含 Gas）；文档统一写「本地 V4 数学估算，非官方 Quoter」与「只读 Probe 对照完成，写路径仍未验证」 |

## 1. 运行测试

```bash
cd backend
bun run test                       # 41 个用例（含 8455 条链上向量离线重放）
node scripts/swap-vectors.js       # 重新从链上生成参考向量（只读，约 20 秒）
node scripts/pm-behavior-compare.js # 重新生成 PM 只读对照报告
```

测试覆盖：

| 文件 | 覆盖内容 |
|---|---|
| `tests/v4math.test.js` | TickMath 边界与往返、tick 对齐、金额↔流动性往返、**两步取整**、费率 0/1%、跨 tick、价格限制、exact-out 对称性、极小金额 |
| `tests/swap-vectors.test.js` | 8455 条链上真实 Swap 向量逐位复现 + 跨 tick 子集单独校验 |
| `tests/analysis.test.js` | 收益速度（样本不足/跨度不足/正常）、Break-even（高于 HODL/低于 HODL/出区间/负桥接成本/缺价格） |
| `tests/ledger.test.js` | 加仓、减仓、完全撤池、多次加减仓、同区块多事件、重复同步幂等 |
| `tests/simulator.test.js` | gas 错误分类、撤池后预计余额口径、尘埃阈值 |
| `tests/pm-behavior.test.js` | 选择器提取/比对、三类 Probe 断言、**「内部等价性必须显式 false」** |

## 2. Swap 数学：如何验证（P0-3 的核心）

**方法**：用池子真实发生的事件做参考向量，而不是自造样例。

1. 拉取最近 12 万区块（约 200 分钟）内该池的 **全部 Swap 事件**与 **ModifyLiquidity 事件**（无 sender 过滤，含非 PM 的流动性来源）；
2. 按 (block, logIndex) 归并，**只保留「相邻两笔 Swap 之间没有任何流动性变化」的样本** → 前一笔的后状态就是后一笔的精确前状态（含 tick / 流动性 / 价格）；
3. 用前状态 + 本笔输入（或输出）跑本地估算，与链上真实结果逐项比对：`amountOut / sqrtPriceAfter / tickAfter / liquidityAfter` **必须完全一致**；
4. 生成的向量落到 `backend/tests/fixtures/swap-vectors.json`，测试离线重放（不依赖网络）。

**结果（2026-11-10）**：**8455 / 8455 逐位一致，0 不一致**。
覆盖：zeroForOne 4706 / oneForZero 3749 / **跨 tick 919** / partial 10 / 极小金额 34；模式分布：exact-in 8414 / exact-out 41（另有价格限制终止样本并入其中）。

**过程中被链上数据纠正的实现细节（都写进了代码注释与测试）**：

| 细节 | 错误做法（旧） | 正确做法（与官方源码一致） |
|---|---|---|
| `getAmount0Delta` 取整 | 单步 `ceil(a·b/(c·d))` | **两步**：`divRoundingUp(mulDivRoundingUp(n1,n2,b), a)`（差 1 wei 会导致「是否到达 tick 边界」判定翻转） |
| 未到边界时的手续费 | 用 delta 反算 amountIn | `amountIn = floor(输入×0.99)`，`fee = 剩余 − amountIn` |
| 到边界时的手续费 | `floor(amountIn×费率)` | `ceil(amountIn×费率/(1e6−费率))` |
| 跨 tick 的 tick 值 | 用价格反推 tick | 到达边界 → `边界−1`（零对一）/ `边界`（一对零）；价格未移动 → tick 保持不变 |
| 价格限制 | 未支持 | 支持 `sqrtPriceLimitX96`：限价更近则停在限价；**限价恰为 tick 边界时先跨 tick 再停止**（与 V4 循环条件一致） |
| 交易模式 | 只支持 exact-in | 同时支持 **exact-out**（路由器拆单/限价常用） |
| 流动性/金额换算 | 单步 floor | 与官方 `LiquidityAmounts.getLiquidityForAmount0/1` 一致 |

## 3. 计算口径（字段与含义）

### 3.1 本地 V4 数学（`lib/v4math.js`）
- `sqrtPriceX96AtTick`：decimal.js（80 位）+ ceil，与 Python 高精度真值逐位一致；注：链上 TickMath 为定点位运算，在 MAX_TICK 处与数学真值存在约 4e-20 相对偏差（活跃区间内逐位一致，已由 8455 条向量验证）；
- 金额/流动性：BigInt 定点（Q96），无浮点误差；
- 兑换估算：**逐步**语义 + 跨 tick 走位 + 价格限制，输出 `amountIn / amountOut / feePaid / sqrtPriceAfter / tickAfter / liquidityAfter / priceChangePct / priceImpactPct / ticksCrossed / partial / limitReached`。

### 3.2 待领手续费
- `fee = L × (feeGrowthInside_now − feeGrowthInside_last) >> 128`（StateView 读数 + 数学计算）；
- feeGrowth 回退（>2^255）视为异常，返回 0 并在界面标注。

### 3.3 建仓台账（`lib/ledger.js`）
- 数据源：PoolManager `ModifyLiquidity` 事件（salt = bytes32(tokenId)，已链上验证：台账合计 == `getPositionLiquidity`）；
- 每次加减仓按事件所在区块**前一区块**的池价格折算资产数量（归档 `eth_call`，缓存于 `block_prices`）；
- 折叠函数 `foldLedgerEvents` 按 (block, logIndex) 去重 → **重复同步不改变台账**（有测试）。

### 3.4 LP vs HODL（口径收紧）
- HODL 基准 = 台账**净投入数量**（Σ存入 − Σ取出）一直持有至今的价值；
- `lpVsHodlExcludingCurrentFeesUsd` = LP 合计（本金现值 + 待领手续费）− HODL；
- **该值不是严格无常损失**：还含区间效应、历史加减仓、**已领取手续费（链上不可追溯，会低估 LP 表现）**、价格路径；
- 页面文案：「相对 HODL 差额（扣除当前未领取手续费）」，并在底部注明近似性质。

### 3.5 Break-even（静态近似）
- 追平 HODL 所需手续费 = `max(0, HODL − LP合计)`；再加 gas（静态用量）与用户输入的桥接成本；
- `requiredVolumeApproxUsd = 需覆盖金额 ÷ (1% × 本头寸流动性占比)`，**仅当价格在区间内**才给值；
- 假设：头寸始终在区间内、份额不变、全部成交经过本区间、费率恒 1%、无协议费 —— 页面明确写「静态近似，不是成交量预测」；
- 「按当前收益速度需要多少天」依赖采样时间序列（样本不足显示「采样中」）。

### 3.6 撤池后预计余额
- `projectedBalanceAfterRemove`：**只加入本次撤池预计收到的资产（含待领手续费）**，不扣 Gas、不含并发交易影响（字段自带 note）。

## 4. 已知边界（如实声明）
1. 所有结果都是**本地估算**，不是链上执行结果；M3 真实操作以链上为准；
2. 本地数学不是官方 Quoter：已用 8455 条链上真实 Swap 向量逐位验证，但**未覆盖极端 tick（|tick| > 1e5）与极端流动性场景**；
3. PositionManager 只完成**只读 Probe 对照**（选择器集合、错误语义、permit2 不变量、chain-specific 目标关系），**写路径行为未验证** → 保持 `pending-official`；
4. 收益速度与年化依赖采样积累，样本不足不显示（不使用单日尖峰推导）；
5. 池龄 < 7 天为硬性红色警告（当前池 2026-11-09 创建）；
6. 已领取手续费链上不可追溯（见 3.4）。

## 5. 数据源与端点
- 池状态/头寸：StateView + PositionManager（链上）；
- 台账：PoolManager `ModifyLiquidity` 事件索引；
- 参考向量：池 Swap 事件（链上，8455 条）；
- PM 对照：Sourcify 验证源 ABI + 三链 eth_getCode/eth_call；
- 美元价格：Surf 市场数据（主）+ DexScreener（备），均带来源与时间戳。
