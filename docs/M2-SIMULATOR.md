# M2 模拟器 — 方法、验证与边界（review 修订版）

> 生成日期：2026-11-10（P0-1 ~ P0-4 修订 + P0-3 二次修订：参考向量独立性）｜ 阶段：M2（模拟器）｜ 状态：修订完成，待二次 review
>
> **M2 全程只模拟：不构造交易、不请求任何签名、不发交易。** 白名单所有地址 `writeEnabled=false`，前后端运行时拦截器均在位。

## 0. 本次修订（对应 review 4 个阻塞项）

| Review 项 | 问题 | 处理 |
|---|---|---|
| **P0-1** | `analysis.js` 使用 `CHAIN.ID`（不存在）→ 收益速度查询恒为空 | 改为 `CHAIN.id`；全仓搜索确认无同类大小写错误；查询前增加 `if (!Number.isInteger(CHAIN.id)) throw`（禁止把参数错误静默当成「采样不足」）；收益速度与 Break-even 抽成纯函数并加回归测试 |
| **P0-2** | PM 对照报告只并排展示截断的 ABI 串，无机器可判定断言 | 脚本重写：**权威选择器集合取自官方已部署合约的 ABI（Sourcify 验证源）**；Probe 返回值**解码后**按 same-value / same-shape / chain-specific 三类断言，逐项 PASS/FAIL；目标地址代码存在性检查；报告分开陈述结论 |
| **P0-3** | 跨 tick Swap 的手续费/取整未按 V4 逐步语义验证 | `lib/v4math.js` 按官方源码（`SwapMath.computeSwapStep` / `SqrtPriceMath`）**逐行重写**；建立**与生产代码完全分离的独立参考实现**（`backend/reference/v4/`，官方源码移植），并以链上真实 Swap 事件做参考向量回归：**3000/3000 逐位一致**（含 124 笔跨 tick、124 笔多步） |
| **P0-4** | 缺少可重复运行的自动化回归测试 | 新增 8 个测试文件、**52 个用例**（含 3000 条链上向量离线重放 + 生产实现 vs 独立参考实现交叉验证 + fixture 溯源断言）：`bun run test` |
| **P0-5** | fixture 由旧提交生成，生成器/参考实现随后已改动，测试仅断言 `generatorCommit !== undefined` | 用当前代码**重新生成** fixture；fixture 与元数据记录**生成时逐文件代码哈希**（生成器 + 独立参考实现共 6 个文件）；测试强制断言 `meta.generatorCommit === stats.generatorCommit`、`meta.codeHashes` 与当前工作树逐文件一致、`generatorCommitDirty === false`，并禁止 reference 反向依赖生产实现（见 2.4） |
| **P0-3 二次** | 原 8455 条 fixture 由生产实现「先猜模式再重放」，构成自证循环；缺 feePaid / 独立性标记 | 向量生成器重写（见第 2 节）：模式只能来自 **calldata 解码**或**排他性假设检验**（两种模式必须恰有一种符合链上全部可观测值，歧义样本一律排除）；新增**独立参考实现**用于模式判定与 feePaid 推导；fixture 增加 `expected.feePaid`、`validation.independentReference / feePaidChecked / productionCodeUsedInGeneration`、`source.modeSource`、SHA-256 与区块范围元数据；测试改为**逐位断言 amountIn/amountOut/feePaid + 强制断言独立性标记**，不再依赖 `mismatchCount` 自证 |
| 口径修正 | 「无常损失」「V4 精确估算」「行为级验证完成」等表述过强 | 字段与文案改为：`lpVsHodlExcludingCurrentFeesUsd`（近似 IL）、`requiredVolumeApproxUsd`（静态近似）、`projectedBalanceAfterRemove`（不含 Gas）；文档统一写「本地 V4 数学估算，非官方 Quoter」与「只读 Probe 对照完成，写路径仍未验证」 |

## 1. 运行测试

```bash
cd backend
bun run test                       # 52 个用例（含 3000 条链上向量离线重放 + 跨实现交叉验证 + 溯源断言）
node scripts/swap-vectors.js       # 重新从链上生成参考向量（只读，约 4.5 分钟；CI 默认离线使用已提交的 fixture）
node scripts/pm-behavior-compare.js # 重新生成 PM 只读对照报告
```

测试覆盖：

| 文件 | 覆盖内容 |
|---|---|
| `tests/v4math.test.js` | TickMath 边界与往返、tick 对齐、金额↔流动性往返、**两步取整**、费率 0/1%、跨 tick、价格限制、exact-out 对称性、极小金额 |
| `tests/swap-vectors.test.js` | 3000 条链上真实 Swap 向量逐位复现（amountIn/amountOut/feePaid/sqrtPrice/tick/流动性）+ exact-out 子集 + 跨 tick 子集 + **独立性元数据强制断言** |
| `tests/v4math.reference.test.js` | **生产实现 vs 独立参考实现**：TickMath 往返/边界、金额换算取整方向、全部 3000 条向量逐位一致、随机构造场景 |
| `tests/swap-vectors.test.js`（溯源部分） | fixture SHA-256 / gzip 内容一致性、`meta.generatorCommit === stats.generatorCommit`、生成时工作树干净、`codeHashes` 与当前生成器+参考实现逐文件一致、reference 不反向依赖生产实现 |
| `tests/analysis.test.js` | 收益速度（样本不足/跨度不足/正常）、Break-even（高于 HODL/低于 HODL/出区间/负桥接成本/缺价格） |
| `tests/ledger.test.js` | 加仓、减仓、完全撤池、多次加减仓、同区块多事件、重复同步幂等 |
| `tests/simulator.test.js` | gas 错误分类、撤池后预计余额口径、尘埃阈值 |
| `tests/pm-behavior.test.js` | 选择器提取/比对、三类 Probe 断言、**「内部等价性必须显式 false」** |

## 2. Swap 数学：如何验证（P0-3 的核心）

**方法**：用池子真实发生的事件做参考向量，且**模式（exact-in / exact-out）与输入金额不允许由本地模型反推猜测**。

### 2.1 向量来源与模式判定（禁止自证循环）

1. 拉取该池**全历史**（自 PositionManager 部署块 256083 起）的 Swap 与 ModifyLiquidity 事件（无 sender 过滤）；
2. 按 (block, logIndex) 归并，**只保留「相邻两笔 Swap 之间没有任何流动性变化」的样本** → 前一笔的后状态就是后一笔的精确前状态；
3. 模式判定有两条互斥路径，**只用其一**：
   - **方案 A（calldata 解码）**：交易 calldata 可由 `backend/reference/v4/router.js` 完整解码（Universal Router `execute` + `V4_SWAP` 动作、多布局变体、哨兵限价）→ 模式与金额直接取自 calldata；限价语义再用链上结果确认（哨兵 / 滑点推导），两者都不符合则**排除**；
   - **方案 B（排他性假设检验）**：无法解码时，分别假设 exact-in 与 exact-out 跑**独立参考实现**，要求**恰好一种**假设能复现链上全部可观测值（`amountIn / amountOut / sqrtPriceAfter / tickAfter / liquidityAfter`）。**两种都符合（歧义）或都不符合一律排除**；
4. **期望值全部取自链上事件**；模式判定所用参考实现与生产实现完全分离（`backend/reference/v4/`），生成时运行时断言未加载 `lib/v4math.js`；
5. 限价语义另做检查：把备选限价代入重算，结果必须与主限价一致（不敏感），或已由链上结果确认；
6. fixture 落地 `backend/tests/fixtures/swap-vectors.json` + `.gz` + `swap-vectors.meta.json`（SHA-256、gzip SHA-256、区块范围、Pool ID、生成器 commit）；测试离线重放，**不依赖网络**。

### 2.2 feePaid 的口径

| 来源 | 条件 | 数量（本次） |
|---|---|---|
| `onchain-feeGrowthGlobal`（链上直接观测） | 跨区块、区间内流动性不变、且该笔是其区块最后一笔 Swap（`feeGrowthGlobal` 只在区块末读取，同块后续 Swap 会混入 Δfg）、协议费为 0 | 43（**与参考实现逐位一致 43/43**） |
| `independent-reference`（独立参考实现推导，**非链上直接观测值**） | 其余样本（跨 tick 使 `Δfg×L/2^128` 反推不精确、同区块多笔 Swap、RPC 读取失败等） | 2957 |

> 口径：只有 `onchain-feeGrowthGlobal` 是链上直接观测；`independent-reference` 是独立实现推导值，已在 fixture 的 `expected.feePaidSource` 逐条标注，测试对两者都做逐位断言（前者额外与链上反推值比对）。

### 2.3 结果（2026-11-10 第三次生成：用当前代码快照重新计算）

- **3000 / 3000 逐位一致，0 不一致**（amountIn、amountOut、feePaid、sqrtPriceAfter、tickAfter、liquidityAfter 全项逐位相等）；
- 模式来源：calldata 解码 **19** / 排他性假设检验 **2981**；**歧义样本 0**；
- 覆盖：zeroForOne 1666 / oneForZero 1334 / **跨 tick 123** / 多步 123 / 极小金额 6；exact-in 2997 / exact-out 3；
- 排除统计（透明列出）：假设检验均不匹配、限价敏感、区间内流动性变化、同区块多笔 Swap、calldata 未知路由器选择器等，逐类计数见 fixture 的 `stats.excluded`；
- 生产实现与独立参考实现另做**全量交叉验证**（`tests/v4math.reference.test.js`）：3000 条向量 + 120 组随机构造场景逐位一致。

> **口径声明**：以上验证的是「本地 Swap 数学 vs 链上 Swap 事件」，**不等于**「与官方实现行为完全等价」——写路径、极端参数、hook/协议费非零场景未覆盖。fixture 中 43 条 feePaid 有链上反推值，其余为独立参考实现推导（已在 `expected.feePaidSource` 标注）。

### 2.4 fixture 溯源（provenance）

| 字段 | 含义 |
|---|---|
| `stats.generatorCommit` / `meta.generatorCommit` | **生成 fixture 时所用代码的快照**（`git rev-parse HEAD`）。提交 fixture 后 HEAD 会前进，因此**不要求**它等于最新提交；关键是二者一致、且该提交包含当前生成器与参考实现。 |
| `meta.generatorCommitDirty` | 生成时工作树是否存在未提交改动（生成器 / `reference/`）。必须为 `false`。 |
| `meta.codeHashes` | 生成时「生成器 + 独立参考实现」**逐文件 SHA-256**（共 6 个文件）。测试用当前工作树重算并逐文件比对：**改了生成器或参考实现而没重新生成 fixture，测试直接失败**。 |
| `meta.sha256` / `meta.gzipSha256` | fixture 与压缩包的 SHA-256；测试同时校验 gzip 解压内容与 JSON 完全一致。 |
| `meta.validationCounts` | 独立验证来源统计（calldata / 排他性检验 / feePaid 链上 / feePaid 参考实现 / 跨 tick / 多步），与 `stats.validationCounts` 一致。 |

**两条铁律**（已写入测试与元数据说明）：

1. `generatorCommit` 是**生成时的代码快照**，fixture **不是**运行测试时动态生成的；测试离线重放已提交的 fixture，不访问 RPC；
2. 改动 `scripts/swap-vectors.js` 或 `backend/reference/v4/*` 后，**必须重新生成并提交** fixture（JSON + gzip + meta），否则测试失败——这正是本次修订要堵住的漏洞。

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
- `sqrtPriceX96AtTick`：decimal.js（80 位）+ ceil，与 Python 高精度真值逐位一致；注：链上 TickMath 为定点位运算，在 MAX_TICK 处与数学真值存在约 4e-20 相对偏差（活跃区间内逐位一致，已由 3000 条向量 + 独立参考实现验证）；
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
2. 本地数学不是官方 Quoter：已用 3000 条链上真实 Swap 向量逐位验证（并与独立参考实现交叉验证），但**未覆盖极端 tick（|tick| > 1e5）、极端流动性、协议费非零与 hook 场景**；模式判定无法覆盖的路由器（私有 calldata）样本已全部排除，不做猜测；
3. PositionManager 只完成**只读 Probe 对照**（选择器集合、错误语义、permit2 不变量、chain-specific 目标关系），**写路径行为未验证** → 保持 `pending-official`；
4. 收益速度与年化依赖采样积累，样本不足不显示（不使用单日尖峰推导）；
5. 池龄 < 7 天为硬性红色警告（当前池 2026-11-09 创建）；
6. 已领取手续费链上不可追溯（见 3.4）。

## 5. 数据源与端点
- 池状态/头寸：StateView + PositionManager（链上）；
- 台账：PoolManager `ModifyLiquidity` 事件索引；
- 参考向量：池 Swap 事件（链上，3000 条；模式来源：calldata 19 / 排他性假设检验 2981）；
- 独立参考实现：`backend/reference/v4/`（官方 v4-core 源码移植，仅用于向量生成与交叉验证，**不参与生产路径，也不反向依赖 `lib/v4math.js`**，由测试强制）；
- PM 对照：Sourcify 验证源 ABI + 三链 eth_getCode/eth_call；
- 美元价格：Surf 市场数据（主）+ DexScreener（备），均带来源与时间戳。
