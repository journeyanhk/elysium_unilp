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

## M3 规划（M3.0 已完成，写操作全关）

| 交付 | 内容 |
|---|---|
| `docs/M3-PLAN.md` | 范围与不做清单、阶段划分（M3.0 → M3.4）、8 步交易流程、后端/前端/数据库改动清单、测试计划、安全不变量、风险与回滚、5 个复核点 |
| `docs/M3-TX-SAFETY-GATE.md` | 三重关闭 + 双重门禁、解锁条件（官方确认 / 用户知情接受）+ 硬性条件、首笔小额 20 USD、硬上限表、允许合约与函数白名单（5 合约 5 选择器）、熔断条件、逐笔确认 UI 要求、审计字段、开启前检查清单、一键全关 |
| `backend/config/tx-gate.js` | 门禁代码化：总开关 `enabled=false`、上限、允许调用清单、禁止能力、熔断、`assertTxAllowed()`、`txGateStatus()` |
| `backend/tests/tx-gate.test.js` | **10 条门禁测试**：总开关关闭、全部 `writeEnabled=false`、PM 保持 `pending-official`、运行时拦截器逐个抛错、允许清单无多余入口（拒绝 `multicall`/`permit` 代发）、上限保守区间、禁止能力覆盖、门禁逻辑演练、前端拦截器保持关闭 |

**M3 边界**：在交易开关（M3.2）通过下一轮 review 前，不打开真实交易、签名、Approve、Permit2、mint、burn、collect 或 `modifyLiquidities`。M3.1 只做只读预演（构造 + `eth_call`），**不签名、不广播**。

## M3.1 只读预演交付（2026-11-10）

| 交付 | 内容 |
|---|---|
| `lib/tx-parse.js` | `modifyLiquidities` action 级解析（PoolKey / tick 对齐 / liquidity 方向 / amount 上下限 / owner·recipient / deadline；未知与夹带 action 拒绝）+ approve/Permit2 参数级白名单（spender、无限授权、token、有效期） |
| `lib/tx-rpc-guard.js` | 只读 RPC 护栏：白名单方法 + 显式禁止 `eth_send*` / `personal_sign` / `eth_signTypedData*` / `wallet_*`；**请求发出前**拒绝并计数 |
| `lib/tx-build.js` | build-only 构造（`signed=false`、`broadcast=false`）；V4 编码复用 M2 模拟器（逐字节一致） |
| `lib/tx-simulate.js` | 只读预演：`eth_call` + `eth_estimateGas` + 余额/授权/代码预检 + 区块号与 block hash；全部走护栏 |
| `lib/tx-gate-state.js` | 熔断与计数**持久化**（Postgres）：`trip` 需原因、`clear` 需人工复核记录与操作人；日额度/频率由 `tx_gate_attempts` 聚合 |
| `config/tx-gate.js` | `M3-gate-2`：纯函数 `evaluateTxRequest` + 真实 `assertTxAllowed`；强制 Gas 成本、日额度、每分钟/每日笔数、deadline |
| `routes/tx.js` | `GET /api/tx/gate`、`POST /api/tx/{preview,build,simulate}`（只读）；`POST /api/tx/broadcast` **恒定 403 拒绝** |
| 数据库 | 新增 5 张 append-only 表：`tx_intents` / `tx_simulations` / `tx_audit` / `tx_gate_attempts` / `gate_kill_switch` |
| 测试 | 62 → **104**（新增 tx-parse / tx-rpc-guard / tx-build / 门禁边界与持久化） |

**实测**：build → `selector=0xdd46508f`、`actions=["MINT_POSITION","SETTLE_PAIR"]`、`calldataHash=0x8ee9a3db…`；simulate → 区块 3885286 真实 `eth_call`（测试钱包未授权，按预期回滚）、链上 Gas 价格 0.5001 gwei；广播尝试被记为 `rejected / GATE_CLOSED`；审计事件 build → simulate 已落库。

**边界**：未签名、未广播、未 Approve、未 Permit2、未 mint/burn/collect/modifyLiquidities；`TX_GATE.enabled=false`、全部 `writeEnabled=false`、PM 保持 `pending-official`。

## M3.1 修订（回应 review P0-1 / P0-2 / P0-3，2026-11-10）

| 项 | 处理 | 证据 |
|---|---|---|
| P0-1 chainId | 强制 `CHAIN.id`；不匹配拒绝；无硬编码（静态断言） | `tests/tx-build.test.js` |
| P0-2 预演用户 | `checkSimulationUser()`：不一致 → **403**；审计记录 `intentUser` / `simulationFrom` | `tests/tx-simulate.test.js` + 实测 403 |
| P0-3 完整预检 | mint：两币余额 + ERC-20→Permit2 + Permit2→PM 授权；remove/collect：`ownerOf` / `getPositionLiquidity` / `getPoolAndPositionInfo`；7 类明确失败分类；记录预检区块号与 hash | `tests/tx-simulate.test.js`（12 条，假 RPC 离线） |
| 审计补充 | `intentUser`、`simulationFrom`、`precheckBlockNumber`、`precheckBlockHash` 写入 `tx_simulations.precheck` 与 `tx_audit.payload` | 实测落库 |

实测：他人地址预演 → `HTTP 403`；正确用户 → 预检报 `NATIVE_BALANCE_LOW` + `TOKEN_BALANCE_LOW`（并附两级授权读数）。测试 **121/121**。

## M3.2 阻塞项修复（2026-11-10，门禁 `M3-gate-3`）

| 项 | 处理 | 证据 |
|---|---|---|
| P0-1 并发绕过 | `tx_gate_buckets` + `reserveQuota()`：条件原子 UPDATE（分钟笔数 → 日笔数 → 日金额），失败回滚；金额以「分」存整数 | 真实 Postgres 并发测试：5 并发 + 每分钟 1 → 恰好 1 通过；5×1 USD + 日上限 3 USD → 恰好 3 通过 |
| P0-2 审计 fail-closed | 审计失败 → `GATE_AUDIT_FAILED` 拒绝 + 释放额度；状态读取失败 → `GATE_STATE_UNAVAILABLE`；新增 `authorizeTx()` 一体化入口 | `tests/tx-gate.test.js`（拒绝 + 释放额度断言 + 静态断言） |
| P0-2 附带发现 | `loadCounters()` 对 text 列 `SUM()` → Postgres 报错，**门禁状态此前读不出来**，旧代码吞异常后仍会放行 → 已修（转 numeric）+ 回归测试 | `node -e` 实测修复前后对比 |
| P0-3 状态漂移 | `txGateStatus()` 读持久化熔断状态（trippedAt/reason/clearedAt/clearedBy/stateSource），读取失败返回 `null` 而非 false | 实测：trip → 接口 `tripped=true` 且门禁以 `KILL_SWITCH` 拒绝；clear → 显示复核人/时间 |
| P0-4 PM 身份 | 保持 `pending-official`；**未写 unlockRecord、未打开任何开关** | 测试断言：总开关关闭、unlockPath=null、全部 writeEnabled=false |

测试：121 → **139/139**。

## M3.2 最终评审阻塞项修复（门禁 `M3-gate-4`，2026-11-10）

| 项 | 处理 | 证据 |
|---|---|---|
| P0-1 事务原子性 | 额度占用改为**单条原子语句**：`FOR UPDATE` 锁行 → 读最新计数 → 统一判定 → 三桶更新同挂同一 `pass` 条件（全或无）；日笔数+日金额合并为一条 UPDATE | 真实 Postgres：日金额不足时分钟/日笔数保持 0；连接断开 → 无半占用且会话可用；结果缺失 → 拒绝且桶未变；并发 5 + 每分钟 1 → 恰好 1 通过 |
| P0-1 附带发现 | 该代理为**每进程一条共享会话**，失败事务会污染整个进程（cron 被连带打死）→ `dbQuerySafe()` 自愈 + 事务互斥锁 + 出错回滚 | 后端 `stateSource` 由 `unavailable` 自动恢复 `postgres` |
| P0-2 授权绑定 | `lib/tx-binding.js`：绑定 intentId/chainId/to/value/calldataHash/actions/PoolKey/deadline/minOut/报价与预演区块；门禁 `BINDING_MISSING`/`CHAIN_MISMATCH`/`TO_MISMATCH`；审计加 `intent_id`/`binding_hash`/`binding`；只读接口 `POST /api/tx/pre-sign-check` 签名前重算核对 | `tests/tx-binding.test.js` 15 条 |
| P0-3 PM 身份 | 保持 `pending-official`；未写 unlockRecord、未打开任何开关 | 门禁 `enabled=false`、`unlockPath=null` |

测试：139 → **154/154**。

## 第三轮阻塞项修复（2026-11-10）

| 项 | 处理 | 证据 |
|---|---|---|
| P0 签名前核对 | `preSignCheck()` 重写：绑定哈希自校验 + 真实 calldata 重算/解码 + 由 intent 记录重建当前绑定 + 逐字段比对（14 个字段） | `tests/tx-binding.test.js` 19 条；实测 1 字节改动、intentId 改动、deadline 改动、篡改绑定均被拒绝 |
| P0 配套 | `tx_intents` 加 `key` / `amount_usd`；新增 `decodeForCheck()`；`ensureIndexes()` 幂等补齐列（平台同步不保证给已有表加列） | 实测 intent 记录含 `key=positionManager`、`amount_usd=5` |
| P1 跨进程 | 唯一 reservation id + 条件释放（重复释放无副作用） | `tests/tx-gate-multiprocess.test.js` 6 条，真实多进程：5 进程 + 每分钟 1 → 恰好 1；5 进程 + 日金额 3 USD → 恰好 3；5 进程 + 每日 2 → 恰好 2 |

测试：157 → **167/167**。

## 第四轮阻塞项修复（2026-11-10）

| 项 | 处理 | 证据 |
|---|---|---|
| P0-1 权威模拟数据 | `lib/tx-presign.js`：由 intent + 最新成功模拟 + quote_snapshot + 真实 calldata 解码重建当前绑定；无成功模拟 / 过期 / 缺字段 → 拒绝；`/simulate` 落库 `sim_result_hash` | `tests/tx-presign.test.js` 14 条；实测无模拟→拒绝、有模拟→通过 |
| P0-2 授权一次性消费 | `user_addr` / `authorization_status` / `consumed_at` / `consumed_by`；按 intent+bindingHash+用户匹配；`consumeAuthorization()` 条件原子更新；新增 `POST /api/tx/consume-authorization` | `tests/tx-authorization-consumption.test.js` 6 条；实测首次消费成功、重复消费 409、消费后核对提示已消费 |

测试：167 → **187/187**。

## M3.3 手动签名与广播（2026-11-10，已实现 · 开关仍关闭）

| 项 | 实现 | 证据 |
|---|---|---|
| 广播前置检查 | 13 个拒绝码，全部在发送之前（门禁/解锁/熔断/授权已消费/消费时效/绑定哈希/方式） | `lib/tx-broadcast.js`；23 条测试 |
| 签名交易核对 | chainId / to / value / calldataHash / selector / 发送方 / Gas 价格上限 | `lib/tx-wallet-tx.js`；真实签名交易测试 |
| 单次广播 | 无重试 / 无替换 / 无加速 / 无手工 nonce（静态断言）；超时 = 结果未知 → 熔断 | `sendRawTransactionOnce()` |
| 回执核对 | status / 链上内容一致性 / Gas 偏差；回滚与不一致 → 熔断 | `POST /api/tx/receipt` |
| 一次性消费 | 消费超时 180s、重复消费拒绝、消费后核对提示已消费 | M3.2 第四轮 + 本轮广播前置检查 |
| 前端 | 七步手动流程面板 + 每次签名前硬拦截 | `SignBroadcastPanel.tsx`、`lib/tx-sign.ts` |

测试：187 → **210/210**。实测：`/authorize`、`/broadcast` 在门禁关闭时恒 403；无广播记录；熔断未触发。

## M3.3 review 第一轮修复（2026-11-12）

| 项 | 修复 | 证据 |
|---|---|---|
| P0-1 签名账户绑定 | 签名/发送请求显式携带 `from`；两道校验（不接触钱包 → 读钱包只读状态）；不通过不弹钱包；后端保留签名恢复二次校验 | `frontend/src/lib/tx-sign.ts` + 12 条前端测试（`bun test`） |
| P0-2 Gas 参数绑定 | simulate 阶段固定 gasLimit / maxFeePerGas / maxPriorityFeePerGas 并落库；进入授权绑定；签名前/事后核对不得超过绑定值；Gas 美元上限前置；缺 HYPE 价格 fail-closed | `lib/tx-gas.js` + 10 条测试 + 广播/预签新增用例 |

测试：后端 210 → **226**；前端 12 条。开关状态不变（全部关闭）。

## M3.3 review 第二轮修复（2026-11-12）

| 项 | 修复 | 证据 |
|---|---|---|
| P0-1 状态新鲜度 | `POST /api/tx/pre-sign-audit`（服务端重读门禁/熔断/授权 + 重跑核对 + 返回签名载荷 + 审计快照，审计失败即拒绝）；`GET /api/tx/authorization-state/:intentId`；前端每次签名前重新读取，失败即拒绝不弹钱包 | 前端 22 条测试（含顺序与载荷来源静态断言） |
| P0-2 Gas 严格绑定 | 必须**等于**绑定值（降低也拒绝）：`GAS_LIMIT_MISMATCH`/`MAX_FEE_MISMATCH`/`PRIORITY_FEE_MISMATCH`；legacy 与 EIP-1559 不得混用（`TX_TYPE_MISMATCH`） | `tests/tx-gas.test.js` 13 条 + 广播用例 |
| P1 首笔禁用 wallet-sent | 服务端 `MODE_DISABLED_IN_FIRST_TX`；前端同步禁用 | `lib/tx-broadcast.js` + 配置 `broadcast.firstTx` |

测试：后端 226 → **234**；前端 12 → **22**。开关状态不变（全部关闭）。

## M3.3 review 第三轮修复（2026-11-12）

| 项 | 修复 | 证据 |
|---|---|---|
| **P0 回执字段** | `fetchTxByHash()` 补齐 `type`/`gas`/`maxPriorityFeePerGas`（此前会把成功交易误判为内容不一致 → 误熔断）；回执结论带失败码与缺失字段清单 | `tests/tx-receipt-integration.test.js` 11 条（本地假节点 + 真实 RPC 载荷）；移除修复可复现失败 |
| 观察项 1 | 钱包账户/链一致性改由服务端判定（`WALLET_ACCOUNT_MISMATCH` / `WALLET_CHAIN_MISMATCH`…），审计全部失败原因 | `evaluatePreSignAudit()` + 6 条测试 |
| 观察项 2 | 签名载荷/快照/授权三处绑定哈希显式比对 | 前端测试 23 条 |

测试：后端 234 → **250**；前端 22 → **23**。实测：不存在的交易哈希查回执 → pending、不熔断、状态不变、审计 `receipt-pending`。开关状态不变。

## M3.3 review 第四轮修复（2026-11-12）

| 项 | 修复 | 证据 |
|---|---|---|
| 交易类型 fail-closed | `normalizeTxType()` 不再推断：缺失/`null`/未知 → `TX_TYPE_MISSING`；legacy/EIP-2930/带 `gasPrice` → `TX_TYPE_MISMATCH` | `tests/tx-gas.test.js` + 回执集成测试 2 条 |
| 前端显式类型 | 两种签名方式都带 `type: '0x2'` | 前端测试 |
| 测试环境 | 缺表环境逐条跳过并提示（`tests/helpers/db-required.js`） | 稳定环境连跑 3 次 252/252 |

测试：后端 250 → **252**；前端 23 → **24**。开关状态不变。

## 下一步（M3 预览）

- 交易开关（官方确认 或 用户知情接受 + 首笔小额）
- 组池 / 领费 / 撤池：预览 → 模拟 → 逐笔签名（按合约逐个开启 writeEnabled）
- 建仓快照落库（本金台账从「还原」升级为「记录」）
