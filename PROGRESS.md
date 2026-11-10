# PROGRESS — 开发进度

## 里程碑总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 核验与白名单（Elysium V4 部署身份） | ✅ 完成并合并（main `1c39534`） |
| M1 | 只读看板（钱包连接/余额/头寸索引/池状态/待领费用/RPC 状态） | ✅ 完成并合并（main `d135736`，review 通过） |
| **M2** | **模拟器（建仓/撤池/LP vs HODL/Break-even/退出滑点 + PM 只读对照）** | **🔨 依 review 修订完成（4 项阻塞项 + 参考向量独立性二次修订），待二次 review** |
| M3 | 手动 LP 操作（组池/领费/撤池，交易开关后） | ⏳ 未开始 |
| M4 | Elysium 监测（桥接/新池/官方动态） | ⏳ 未开始 |
| M5 | 策略辅助（评分/出区间提醒） | ⏳ 未开始 |
| M6 | VPS 部署（Docker 完整方案） | ⏳ 未开始 |

## M2 修订记录（回应 review 4 个阻塞项 + P0-3 二次修订）

| 项 | 内容 | 状态 |
|---|---|---|
| P0-1 | `analysis.js` 的 `CHAIN.ID` → `CHAIN.id`；加显式校验；收益速度/Break-even 纯函数化 + 回归测试 | ✅ |
| P0-2 | PM 对照脚本重写：权威 ABI 集合（Sourcify）、返回值解码、三类断言、代码存在性、逐项 PASS/FAIL、结论分列 | ✅ 10/10 探测通过 |
| P0-3 | Swap 数学按官方源码逐行重写 + 链上参考向量回归 | ✅ 3000/3000 逐位一致（当前快照重新生成） |
| P0-4 | 6 个测试文件 / 41 个用例（含向量离线重放） | ✅ `bun run test` 全绿 |
| 口径 | 近似 IL / 静态近似交易量 / 预计余额 字段与文案修正 | ✅ |

## M2 交付内容（分支 m2-simulator）

**后端（只模拟，无写操作）**
- [x] `lib/v4math.js`：本地 V4 数学（TickMath 经大整数真值校验；流动性/金额 BigInt；跨 tick 兑换估算）
- [x] `lib/ledger.js`：ModifyLiquidity 台账索引（salt=tokenId 已验证）+ 历史价格/时间缓存
- [x] `lib/simulator.js`：建仓模拟 + 撤池模拟（真实 gas 估算、授权/余额预检、退出滑点、余额变化）
- [x] `lib/analysis.js`：无常损失 + HODL 对照（建仓台账口径）+ Break-even + 价格情景
- [x] `routes/simulate.js`（mint/remove/quote）、`routes/analysis.js`、`routes/indexer.js`（互斥同步 + 台账状态）
- [x] `scripts/pm-behavior-compare.js` → `docs/M2-PM-BEHAVIOR.md`（Elysium vs 官方 ETH/Base）

**M2 工程加固（回应 M1 review 非阻塞项）**
- [x] 候选头寸不再硬截断：返回 `totalCandidates / returned / truncated`
- [x] 索引同步进程内互斥（重复请求返回 `syncInProgress`）
- [x] 第二 RPC 端点（drpc）通过准入检查并启用（能力路由：日志走主端点）
- [x] RPC 限流退避 + Multicall3 请求合并 + 池状态 5 秒缓存
- [x] 年化口径保持「样本不足不显示」（未用单点/首日数据推导）

**前端**
- [x] 模拟器面板（建仓模拟 / 撤池模拟 / 风险分析 三个页签）
- [x] 头寸卡片新增「分析 · 模拟」入口（自动带 tokenId 进入风险分析）
- [x] 全部结果展示口径、警告与边界说明（含「M3 才开放真实操作」提示）

**验证**
- [x] 建仓模拟实测（1 HYPE + 300 KNTQ → 使用 1 HYPE + 141.38 KNTQ，L=406399689712623047175，预计 NFT #5693，多余 158.62 KNTQ 兑换估算 0.8396 HYPE）
- [x] 撤池模拟实测（#5391：21.54 HYPE + 4140.23 KNTQ + 手续费 0.0405 HYPE/5.368 KNTQ，退出滑点 0.25%，gas 174,212）
- [x] 风险分析实测（#5391：台账 23 笔，HODL $3254.27 vs LP $3258.69，差额 +$4.42，IL 部分 −$0.73，所需交易量 $109）
- [x] PM 对照实测（37/37 选择器一致；错误语义一致；permit2 三链一致）
- [x] 前端类型检查 + 生产构建通过；全路由冒烟通过

## M2 二次修订记录（回应 review：参考向量「自证循环」）

| 要求 | 处理 | 证据 |
|---|---|---|
| mode 必须来自真实 calldata，无法解码的不得猜测 | 方案 A：`reference/v4/router.js` 解码 Universal Router `execute`+`V4_SWAP`（多布局变体、哨兵限价）；方案 B：**排他性假设检验**（两种模式恰有一种能复现链上全部可观测值，歧义样本排除） | 本次：calldata 17 / 排他性检验 2983，歧义（两种都符合）**0** |
| 引入独立官方参考实现 | 新增 `backend/reference/v4/`（官方 v4-core 源码移植：TickMath 位分解、SqrtPriceMath、SwapMath、Pool.swap 循环），**与生产 `lib/v4math.js` 完全分离**；生成时断言未加载生产实现 | `tests/v4math.reference.test.js`：3000 条向量 + 120 组随机场景逐位一致 |
| fixture 增补字段 | `expected.amountIn / feePaid`、`expected.feePaidSource`、`validation.independentReference / feePaidChecked / productionCodeUsedInGeneration / exclusiveHypothesisOnly / limitSemanticsChecked`、`source.modeSource / router / action / limitConfirmedBy` | `backend/tests/fixtures/swap-vectors.json` + `.meta.json`（SHA-256、gzip SHA-256、区块范围、Pool ID、生成器 commit） |
| 测试：feePaid 逐位断言、exact-out amountIn、强制断言 validation 标记、不依赖 mismatchCount | `tests/swap-vectors.test.js` 重写：六项数值逐位断言、exact-out 子集、跨 tick 子集、独立性元数据断言（缺失即失败）；另加生产 vs 参考实现交叉测试 | `bun run test` → **49/49 通过** |
| 统计口径：按 mode 直接计数 | 生成器直接按 mode 计数，不再做减法推导 | 向量总数 3000：exact-in 2997 / exact-out 3 |
| 保留全量 fixture + SHA-256/区块范围/Pool ID/commit；CI 默认离线 | fixture + gzip + meta 全部入库；测试离线重放，不访问网络 | `swap-vectors.meta.json` |
| 文档措辞不得声称完整行为等价 | `docs/M2-SIMULATOR.md` 第 2 节重写 + 口径声明；仅声明「本地 Swap 数学与链上事件逐位一致」 | 见文档 2.3 口径声明 |

**本次结果**：3000/3000 逐位一致；覆盖 zeroForOne 1668 / oneForZero 1332 / 跨 tick 124 / 多步 124；feePaid 链上反推 59 条（59/59 一致）、其余由独立参考实现推导（fixture 内标注来源）。排除统计（透明）：假设检验均不匹配 429、限价敏感 260、区间内流动性变化 2962、同区块多笔 5917、calldata 未知路由器 1509、multi-hop 路径等。

## M2 三次修订记录（回应 review：fixture provenance）

| 要求 | 处理 | 证据 |
|---|---|---|
| 用当前代码重新生成 fixture | 在干净工作树上重新生成；生成提交即包含当前生成器与参考实现 | `stats.generatorCommit = meta.generatorCommit = 3acf1d1…`，`generatorCommitDirty = false`（修掉了 dirty 检查路径写错导致恒为 false 的 bug） |
| JSON / gzip / meta 同步更新 | 三者同批写入，meta 记录 sha256、gzip sha256、字节数 | `swap-vectors.meta.json` |
| 生成提交可追溯 | 元数据新增 **逐文件 codeHashes**（生成器 + reference/v4 共 6 个文件）+ `validationCounts` | `meta.codeHashes` |
| 测试加强 | 新增：`meta.generatorCommit === stats.generatorCommit`、生成时工作树干净、`codeHashes` 与当前工作树逐文件一致、reference 不反向依赖生产实现、gzip 内容与 JSON 一致 | `bun run test` → **52/52** |
| 文档说明 | `docs/M2-SIMULATOR.md` 新增 2.4「fixture 溯源」：generatorCommit 是生成快照、fixture 非运行时动态生成、改动生成器/参考实现必须重新生成 | 文档 2.4 |
| 命名与统计 | `mismatchCount` → `excludedCount`（避免误读为数学不一致）；新增 `validationCounts`（calldata / 排他性检验 / feePaid 链上 / feePaid 参考实现 / 跨 tick / 多步） | fixture `stats` |
| fixture 体积 | **保留完整 fixture**，不缩减为抽样版本（review 决定） | JSON ≈ 4.8 MB / gzip ≈ 454 KB |

**本次重新生成结果**：3000/3000 逐位一致；calldata 解码 18 / 排他性假设检验 2982（歧义 0）；跨 tick 123 / 多步 123；feePaid 链上反推 48 条（48/48 一致）、参考实现推导 2952 条；fixture sha256 `f639703c…`。

## 下一步（M3 预览）

- 交易开关（官方确认 或 用户知情接受 + 首笔小额）
- 组池 / 领费 / 撤池：预览 → 模拟 → 逐笔签名（按合约逐个开启 writeEnabled）
- 建仓快照落库（本金台账从「还原」升级为「记录」）
