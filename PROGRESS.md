# PROGRESS — 开发进度

## 里程碑总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 核验与白名单（Elysium V4 部署身份） | ✅ 完成并合并（main `1c39534`） |
| M1 | 只读看板（钱包连接/余额/头寸索引/池状态/待领费用/RPC 状态） | ✅ 完成并合并（main `d135736`，review 通过） |
| **M2** | **模拟器（建仓/撤池/无常损失/HODL 对照/Break-even/退出滑点 + PM 行为级对照）** | **🔨 开发完成，待 review** |
| M3 | 手动 LP 操作（组池/领费/撤池，交易开关后） | ⏳ 未开始 |
| M4 | Elysium 监测（桥接/新池/官方动态） | ⏳ 未开始 |
| M5 | 策略辅助（评分/出区间提醒） | ⏳ 未开始 |
| M6 | VPS 部署（Docker 完整方案） | ⏳ 未开始 |

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

## 下一步（M3 预览）

- 交易开关（官方确认 或 用户知情接受 + 首笔小额）
- 组池 / 领费 / 撤池：预览 → 模拟 → 逐笔签名（按合约逐个开启 writeEnabled）
- 建仓快照落库（本金台账从「还原」升级为「记录」）
