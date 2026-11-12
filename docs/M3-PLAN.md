# M3 实施计划：手动 LP 操作（组池 / 领费 / 撤池）

> 版本：v1（2026-11-10）｜ 阶段：M3 规划 ｜ 状态：**规划已提交，写操作保持全关**
>
> 前置：M2 已通过 review 并合并（合并提交 `dc4541c`）。
> **本阶段在交易开关通过下一轮 review 之前，不打开任何真实写操作、签名、Approve、Permit2、mint、burn、collect 或 `modifyLiquidities`。**

---

## 1. 目标与范围

**做**：让用户在**逐笔手动确认**的前提下，完成三类链上操作

| 操作 | 入口 | 说明 |
|---|---|---|
| 组池（加流动性） | PositionManager `modifyLiquidities`（MINT_POSITION + SETTLE_PAIR） | 选择区间、金额、滑点，预览 → 模拟 → 逐笔签名 |
| 领费 | `modifyLiquidities`（DECREASE_LIQUIDITY(0) + TAKE_PAIR） | 只领取已累积手续费，不动流动性 |
| 撤池（减/清流动性） | `modifyLiquidities`（DECREASE_LIQUIDITY + TAKE_PAIR） | 支持部分与全额撤出，撤空后提示 NFT/头寸状态 |

**不做（本阶段明确排除，且由代码禁止清单强制）**：

- 任何自动化交易：自动重发、自动加速、自动替换、cron 自动下单；
- 自动放宽滑点 / 自动降低 `minOut`；
- 私钥托管、助记词保存、代替用户签名；
- 闪电贷 / 杠杆 / 借贷；
- 未在白名单中的合约调用、任意 calldata 透传、`delegatecall`；
- 跨链桥接、批量无人值守操作。

---

## 2. 阶段划分与复核点

| 阶段 | 内容 | 是否含真实写操作 | 复核点 |
|---|---|---|---|
| **M3.0**（本次） | 实施计划 + 交易安全门禁代码化（`backend/config/tx-gate.js`）+ 门禁测试 + 文档 | ❌ 全关 | 本文档 + `docs/M3-TX-SAFETY-GATE.md` |
| **M3.1** | 只读预演管线：交易构造（build-only）+ `eth_call` 模拟 + 链上状态一致性检查 + 审计表落库；**不签名、不广播** | ❌ | ✅ **已交付（见 §10）**，等待复核 |
| **M3.2** | 交易开关评审：核对解锁条件、硬上限、熔断、审计、UI 文案 | ❌ | **本次 review 决定是否解锁** |
| **M3.3** | 首笔小额交易（首笔小额模式上限 20 USD）：逐笔签名、逐笔复核 | ✅（受上限约束） | 首笔完成后单独复核，确认后才放宽到常规上限 |
| **M3.4** | 常规手动操作（单笔 ≤ 100 USD、日 ≤ 300 USD、滑点 ≤ 1%） | ✅（受上限约束） | 逐笔审计抽查 |

> 任何阶段都**不允许**跳过 M3.2 直接进入 M3.3。

---

## 3. 交易流程（每笔都必须走完）

```
① 预览（本地 V4 数学 + 链上状态）
      ↓  用户设定金额 / 区间 / 滑点（只允许手动输入，不得自动放宽）
② 构造（build-only，不请求签名）
      ↓  生成 calldata + 参数快照（含 quote 时间戳、minOut、deadline）
③ 模拟（eth_call 真实执行路径 + 余额/授权预检 + 偏差比对）
      ↓  偏差超阈值 / 报价过期 / 状态变化 → 直接终止
④ 门禁校验（assertTxAllowed：总开关 → 逐合约开关 → 金额/滑点/Gas/minOut/报价新鲜度）
      ↓  任一不满足 → 拒绝（不降级、不重试）
⑤ 用户逐笔确认（展示：资产变化、最小收到、Gas 上限、价格影响、风险提示）
      ↓
⑥ 钱包签名（用户手动，应用不接触私钥）
      ↓
⑦ 广播 + 回执跟踪（失败即触发熔断，需人工复核）
      ↓
⑧ 审计落库（意图 / 参数 / 模拟结果 / 用户确认 / 交易哈希 / 回执 / 余额变化）
```

---

## 4. 代码改动清单（M3.1 起）

### 后端

| 文件 | 改动 |
|---|---|
| `backend/lib/tx-build.js`（新增） | 仅构造 calldata 与参数快照；**不含签名、不含广播**；输出可复现的意图对象 |
| `backend/lib/tx-simulate.js`（新增） | `eth_call` 真实执行路径模拟、余额/授权预检、与本地估算偏差比对、Gas 估算与上限校验 |
| `backend/lib/tx-broadcast.js`（M3.3 才启用） | 唯一允许广播的模块；入口即调用 `assertTxAllowed` + `assertWriteEnabled`；失败即熔断 |
| `backend/lib/audit-log.js`（新增） | 审计写入（见 §6） |
| `backend/config/tx-gate.js`（✅ 已提交） | 总开关、上限、允许调用清单、熔断、禁止能力 |
| `backend/routes/tx.js`（新增） | `POST /api/tx/preview`、`POST /api/tx/build`、`POST /api/tx/simulate`（全部只读）；`POST /api/tx/broadcast` 在 M3.3 前**恒返回门禁拒绝** |
| `backend/routes/tx-gate.js`（新增） | `GET /api/tx-gate` 只读状态（供 UI 显示当前门禁状态） |

### 前端

| 文件 | 改动 |
|---|---|
| `frontend/src/components/TxPanel.tsx`（新增） | 逐笔确认面板：资产变化、最小收到、Gas 上限、价格影响、风险提示、门禁状态徽标 |
| `frontend/src/lib/tx-guard.ts`（已有） | `WRITES_ENABLED` 保持 `false`，M3.3 前不得改动 |
| `frontend/src/components/SimulatorPanel.tsx`（已有） | 增加「进入交易流程」按钮，但在门禁关闭时按钮为禁用态并显示原因 |

### 数据库（Drizzle schema，`backend/db/schema.js`）

```text
tx_intents   意图（操作类型、池、参数、quote 快照、minOut、deadline、创建时间、状态）
tx_simulations 模拟结果（intent_id、模拟输出、与本地估算偏差、检查项通过情况）
tx_audit     审计（intent_id、用户确认时间、签名者地址、交易哈希、回执状态、余额变化、门禁版本）
```

> 表结构在 M3.1 提交；**只增不改**，不触碰已有用户数据表。

---

## 5. 测试计划

| 层次 | 内容 | 何时 |
|---|---|---|
| 门禁单测（✅ 已提交） | 总开关关闭、全部 `writeEnabled=false`、PM `pending-official`、运行时拦截器抛错、允许清单无多余入口、上限处于保守区间、禁止能力覆盖、前端拦截器保持关闭 | M3.0 |
| 编码单测 | `modifyLiquidities` 各 action 编码与 M2 模拟器一致（`0x020d` / `0x0111`），参数边界、deadline、minOut 处理 | M3.1 |
| 只读链上演练 | 对真实链上状态构造交易并 `eth_call`：必须成功且与本地估算一致；**不广播** | M3.1 |
| 门禁拒绝测试 | 广播入口在总开关关闭时 100% 拒绝；金额/滑点/minOut/报价超限 100% 拒绝 | M3.1 |
| 首笔小额演练 | 上限 20 USD、单笔、逐笔签名、事后审计核对 | M3.3 |

**硬性要求**：M3.3 之前，任何测试都不得向链上发送交易（仅 `eth_call` / 只读 RPC）。

---

## 6. 审计要求（每笔写操作必须可追溯）

记录：操作类型、池 ID、参数快照、quote 时间与来源、`minOut`、deadline、模拟输出与偏差、用户确认时间与地址、交易哈希、回执状态与 Gas 实际消耗、资产前后变化、门禁版本与当时上限、熔断状态。

---

## 7. 安全不变量（由测试强制）

1. 白名单所有地址 `writeEnabled=false`，直到 M3.3 按合约逐个开启（PM 必须保持 `pending-official`，除非官方渠道确认）；
2. 前后端运行时拦截器始终在位，任何写路径先过拦截器；
3. 交易总开关默认关闭，且**缺少解锁记录时拒绝一切写操作**；
4. 无自动重发 / 自动加速 / 自动放宽滑点 / 自动降低 minOut 的代码分支；
5. 未在白名单的合约与函数一律拒绝（含 multicall 透传与 `delegatecall`）；
6. 应用永不接触私钥；每笔交易必须由用户手动签名；
7. 熔断触发后必须人工复核才能恢复。

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| PM 归属未获官方确认 | 保持 `pending-official`；首笔小额 + 用户知情接受记录；写路径行为未验证的结论如实展示 |
| 池龄 < 7 天、流动性薄 | 硬性红色警告 + 价格影响上限 2% + 首笔 20 USD 上限 |
| 链上重组 / 状态漂移 | 模拟与实际状态一致性检查；不一致即熔断 |
| RPC 限流导致报价过期 | 报价 30 秒过期即拒绝，不降级、不重试写操作 |
| 用户误操作 | 逐笔确认面板 + 最小收到展示 + 上限约束 |

**回滚**：`TX_GATE.enabled=false` + 白名单 `writeEnabled=false` + 前端 `WRITES_ENABLED=false`（一键全关）；已发出的交易无法回滚，只能通过后续手动操作处理，故上限与模拟前置是唯一防线。

---

## 10. M3.1 交付记录（2026-11-10）

对应 M3.0 review 的 8 项验收条件：

| # | 验收条件 | 实现 | 证据 |
|---|---|---|---|
| 1 | 真实 `eth_call` 预演不能发送交易 | `lib/tx-rpc-guard.js` 只读方法白名单 + 明确禁止 `eth_sendTransaction` / `eth_sendRawTransaction` / `personal_sign` / `eth_signTypedData*` / `wallet_*`；请求发出前即拒绝 | `tests/tx-rpc-guard.test.js`（含「禁止方法不触发任何网络请求」断言 + 全后端静态扫描） |
| 2 | build-only 不触发钱包签名 | 后端构造流程无任何钱包/签名依赖；返回值 `signed=false`、`broadcast=false`，且不含签名字段 | `tests/tx-build.test.js`（静态检查 `window.ethereum` / `createWalletClient` / `sendTransaction` 等） |
| 3 | `modifyLiquidities` action parser 完成 | `lib/tx-parse.js`：解码 `unlockData` → actions + 参数；只允许 mint=`MINT_POSITION+SETTLE_PAIR`、collect=`DECREASE_LIQUIDITY(0)+TAKE_PAIR`、remove=`DECREASE_LIQUIDITY(>0)+TAKE_PAIR`；校验 PoolKey、tick 对齐、liquidity 方向、amount 上限/下限、owner/recipient、deadline；未知 action 与夹带 action 一律拒绝 | `tests/tx-parse.test.js` |
| 4 | approve / Permit2 参数级限制 | ERC-20 `approve`：spender 仅限 PositionManager / Permit2、禁止无限授权、金额 ≤ intent；Permit2 `approve`：token 必须为目标代币、spender 必须为 PM、金额 ≤ intent、有效期 ≤ 30 天且未过期 | `tests/tx-parse.test.js` |
| 5 | `assertTxAllowed` 真正执行 Gas / 日额度 / 频率限制 | 门禁重构为「纯函数 `evaluateTxRequest` + 持久化状态」，强制执行 `maxGasUsd`、`dailyMaxUsd`、`maxTxPerMinute`、`maxTxPerDay`、deadline | `tests/tx-gate.test.js`（直接调用真实 `assertTxAllowed` 的边界测试） |
| 6 | killSwitch 真实触发与持久化 | `lib/tx-gate-state.js`（Postgres）：`tripKillSwitch`（必须给原因）/ `clearKillSwitch`（**必须给人工复核记录与操作人**）；当前状态 = 最后一条事件，进程重启不丢 | `tests/tx-gate.test.js`（含 `storeKind === 'postgres'` 断言，禁止内存实现） |
| 7 | 审计字段补齐 | 新表 `tx_intents` / `tx_simulations` / `tx_audit` / `tx_gate_attempts` / `gate_kill_switch`（全部 append-only）；记录 chainId、目标合约、selector、calldata keccak256、解码后 actions、PoolKey 快照、预演区块号与 block hash、状态区块号、RPC 端点、gas、门禁判断与拒绝原因 | 实测：`build → simulate` 落库成功，广播尝试被记为 `rejected/GATE_CLOSED` |
| 8 | 广播入口不存在可用路径 | `POST /api/tx/broadcast` 恒定返回 403 + 门禁拒绝原因，且文件中无任何发送代码 | 实测返回 `{"error":"交易门禁拒绝：M3.1 只读阶段不提供广播能力",...}`；`tests/tx-gate.test.js` 静态断言 |

**新增接口（全部只读）**：`GET /api/tx/gate`、`POST /api/tx/preview`、`POST /api/tx/build`、`POST /api/tx/simulate`；`POST /api/tx/broadcast` 恒拒绝。

**实测记录（真实链上）**：build 产出 `selector=0xdd46508f`、`actions=["MINT_POSITION","SETTLE_PAIR"]`、`calldataHash=0x8ee9a3db…`；simulate 在区块 3885286 执行 `eth_call`，因测试钱包未授权/余额不足而回滚（预期结果，说明预演真实走了链上执行路径），Gas 价格 0.5001 gwei 来自链上，`gasUsd` 因回滚无法估算 → 门禁会以「缺少 Gas 成本估算」拒绝放行。

**仍未打开**：真实交易、签名、Approve、Permit2、mint、burn、collect、`modifyLiquidities` 全部保持关闭。

## 11. M3.1 修订记录（回应 review 3 个 P0）

| P0 | 问题 | 处理 | 测试 |
|---|---|---|---|
| **P0-1** | `buildIntent()` 接受任意 `chainId` | 强制绑定白名单链：未传 → 使用 `CHAIN.id`；传入值 ≠ `CHAIN.id` → 直接拒绝；**源码中不再出现硬编码链 ID**（有静态断言） | `tests/tx-build.test.js`：未传 / 正确 / 错误 chainId 三例 + 无硬编码断言 |
| **P0-2** | `/simulate` 未绑定 intent 用户，可用他人地址预演 | 新增 `checkSimulationUser()`：请求用户与 intent 用户不一致 → **HTTP 403**；预演一律使用 intent 用户；审计同时记录 `intentUser` 与 `simulationFrom`（必须相同） | `tests/tx-simulate.test.js` + 路由静态断言（不得出现 `user \|\| it.user_addr`） |
| **P0-3** | 预检只读 ERC-20 allowance，未覆盖两级授权与头寸归属 | 重写 `precheck()`：mint 读取两种货币的**余额 + ERC-20→Permit2 授权 + Permit2→PositionManager 授权**（原生币走余额）；remove/collect 读取 `ownerOf` / `getPositionLiquidity` / `getPoolAndPositionInfo`；失败按明确分类给出（`NATIVE_BALANCE_LOW` / `TOKEN_BALANCE_LOW` / `ERC20_ALLOWANCE_LOW` / `PERMIT2_ALLOWANCE_LOW` / `TOKEN_NOT_OWNER` / `POSITION_NOT_FOUND` / `LIQUIDITY_INSUFFICIENT`），**不再依赖回滚字符串推断**；预检区块号与 block hash 一并记录 | `tests/tx-simulate.test.js`（12 条，注入假 RPC 离线验证每条分类） |

**审计字段补充**（review 建议）：`intentUser`、`simulationFrom`、`precheckBlockNumber`、`precheckBlockHash`，全部写入 `tx_simulations.precheck` 与 `tx_audit.payload`。

**实测**：他人地址预演 → `HTTP 403`；正确用户预演 → 预检明确给出 `NATIVE_BALANCE_LOW`（余额 2549270980161990 wei < 需要 1e16）与 `TOKEN_BALANCE_LOW`（KNTQ 余额 0），并附 ERC-20 / Permit2 授权读数。

**测试总数**：104 → **121**。

## 12. M3.2 阻塞项修复记录（回应 review P0-1 / P0-2 / P0-3）

| P0 | 问题 | 处理 | 证据 |
|---|---|---|---|
| **P0-1** | 额度/频率「先读后判」存在并发绕过 | 新增 `tx_gate_buckets` 表 + `reserveQuota()`：**带条件的原子 UPDATE**（每分钟笔数 → 每日笔数 → 每日金额），失败回滚已占用桶；金额以「分」存整数 | `tests/tx-gate-concurrency.test.js`（真实 Postgres）：并发 5 请求 + 每分钟 1 笔 → **恰好 1 个通过**；5 × 1 USD + 日上限 3 USD → **恰好 3 个通过**（累计恰为 3 USD） |
| **P0-2** | 审计写入失败不阻断放行 | `assertTxAllowed()` 改为 fail-closed（审计异常 → `GATE_AUDIT_FAILED`；状态读取异常 → `GATE_STATE_UNAVAILABLE`）；新增 `authorizeTx()`：判断 → 原子占用 → 审计，任一步失败即拒绝并释放额度 | `tests/tx-gate.test.js`：审计失败拒绝 + 额度已释放；额度存储不可用拒绝；源码静态断言「不得再吞异常」 |
| **P0-3** | `/api/tx/gate` 熔断状态可能漂移 | `txGateStatus()` 改为异步并读**持久化**记录，返回 `killSwitchTripped/TrippedAt/Reason/ClearedAt/ClearedBy/stateSource`；读取失败返回 `null` + `stateUnavailable`（不谎报 false） | 实测：trip → 接口立即 `tripped=true` 且门禁以 `KILL_SWITCH` 拒绝；clear → 显示复核人与时间 |
| **P0-4** | PM 官方身份未确认 | 保持 `pending-official`；**不写 unlockRecord、不打开任何开关**，等待最终开关评审与用户书面风险接受 | `tests/tx-gate.test.js`：总开关关闭、解锁路径为 null、全部 writeEnabled=false |

**fail-closed 改造的额外收获**：立刻暴露出一个**真实缺陷** —— `loadCounters()` 对 `amount_usd`（text 列）直接 `SUM()`，Postgres 报 `function sum(text) does not exist`，即门禁状态此前**根本读不出来**；旧代码吞掉异常后会照常放行。已修复（`SUM(NULLIF(amount_usd,'')::numeric)`）并补真实数据库回归测试（`loadGateState` / `loadCounters` / `loadKillSwitch` 必须可用且返回数值）。

**测试总数**：121 → **139**（新增 17 条：并发原子性 6、fail-closed 与状态持久化 11）。

## 13. M3.2 最终评审阻塞项修复记录（P0-1 / P0-2）

| 项 | 要求 | 实现 | 证据 |
|---|---|---|---|
| **P0-1** | 额度三桶必须在同一数据库事务内，不得依赖多次 UPDATE + 补偿 | 改为**单条原子语句**：`WITH locked(... FOR UPDATE) → cur(读最新计数) → dec(统一判定) → m/d(三桶更新，同挂 pass 条件)`；全或无；日笔数与日金额合并为同一条 UPDATE（Postgres 同语句两 CTE 改同一行只有一个生效） | 真实 Postgres：①日金额不足时**分钟/日笔数保持 0**（无半占用）；②连接在第二步断开 → 桶全未占用且会话仍可用；③结果缺失 → 拒绝且桶未变；④并发 5 请求 + 每分钟 1 → 恰好 1 通过 |
| **P0-1 附加** | — | 发现该数据库代理为**每进程一条共享会话**：一次失败事务会污染整个进程（实测 cron 被连带打死）→ 新增 `dbQuerySafe()`（识别 `current transaction is aborted` → ROLLBACK → 重试）+ 事务互斥锁 + 出错即回滚 | 实测：后端 `stateSource` 从 `unavailable` 自动恢复为 `postgres` |
| **P0-1 说明** | 要求使用 `BEGIN…COMMIT` | 代理在**带参数**时走预处理语句，Postgres 拒绝多语句（`cannot insert multiple commands into a prepared statement`）→ 采用其等价的真正原子形式：单条语句 + `FOR UPDATE` 行锁 + 锁后判定 | 见 §4.1.1 与测试 |
| **P0-2** | 授权必须绑定 exact intent / calldataHash，签名前重算核对 | 新增 `lib/tx-binding.js`：`computeBinding` / `bindingHashOf` / `verifyBinding` / `preSignCheck`；门禁新增 `BINDING_MISSING` / `CHAIN_MISMATCH` / `TO_MISMATCH`；审计新增 `intent_id` / `binding_hash` / `binding`；新增只读接口 `POST /api/tx/pre-sign-check` | `tests/tx-binding.test.js`（15 条）：授权 A 不能用于交易 B；calldata/to/value/chainId 任一变化 → 拒绝；无授权绑定 → 拒绝；intent 被替换 → 拒绝 |
| **P0-3** | PM 官方身份 + 用户书面风险接受 | 保持 `pending-official`；**未写 unlockRecord、未打开任何开关** | 门禁 `enabled=false`、`unlockPath=null`、全部 writeEnabled=false |

门禁版本：`M3-gate-3` → **`M3-gate-4`**。测试：139 → **154**。

## 14. 第三轮阻塞项修复记录（P0 签名前核对 / P1 跨进程原子性）

| 项 | 要求 | 实现 | 证据 |
|---|---|---|---|
| **P0** | `preSignCheck()` 必须完整核对当前 intent 绑定，不得把授权值放回当前交易 | 重写 `preSignCheck({ authorization, current, calldata, decoded })`：① **绑定哈希自校验**（`bindingHashOf(binding) === authorization.bindingHash`，防篡改）；② 用**真实 calldata** 重算 `calldataHash` 并推导 `selector`；③ 用 **intent 记录 + 当前请求 + calldata 解码结果**重建当前绑定（intentId / chainId / to / value / intentType / amountUsd / deadline / minOut / actions / quoteBlock / simBlock / simBlockHash / poolId / key）；④ 逐字段比对，任何变化都必须重新 build → simulate → authorize | `tests/tx-binding.test.js`（19 条）：intentId / deadline / minOut / actions / amountUsd / quoteBlock / simBlockHash / poolId / intentType / selector / calldata / to / value / chainId 任一变化 → 拒绝；篡改绑定但哈希未同步 → 拒绝；实测 1 字节 calldata 改动即被拒绝 |
| P0 配套 | — | `tx_intents` 新增 `key` / `amount_usd` 列（`key` 由目标合约反查，保证可重建）；新增 `decodeForCheck()`（复用同一套参数级校验解码真实 calldata）；`ensureIndexes()` 增加**幂等列补齐**（平台 schema 同步对「已有表加列」不保证） | 实测 intent 记录含 `key=positionManager`、`amount_usd=5` |
| **P1** | 额度原子性需跨进程/跨连接验证；补重复 release 等测试 | ① 额度占用仍是**单条原子语句**（`FOR UPDATE` 行锁 + 条件更新），数据库层保证跨进程；② 新增 **唯一 reservation id**（`tx_gate_reservations` 表）：占用时在同一原子语句内写入，释放为**条件更新**（`released <> 'true'`），重复释放无副作用 | `tests/tx-gate-multiprocess.test.js`（6 条，**真实多进程**）：5 个独立进程 + 每分钟 1 → 恰好 1 通过；5 进程 + 日金额 3 USD → 恰好 3 通过且金额恰为 3；5 进程 + 每日 2 笔 → 恰好 2 通过；重复释放 3 次 → 仅第一次生效、桶不出现负数；释放不存在的 reservation → 无副作用；每次占用产生唯一可审计记录 |

**门禁版本**：`M3-gate-4`。**测试总数**：157 → **167**。

## 15. 第四轮阻塞项修复记录（P0-1 权威模拟数据 / P0-2 授权一次性消费）

| 项 | 要求 | 实现 | 证据 |
|---|---|---|---|
| **P0-1** | `/pre-sign-check` 必须加载权威模拟数据（不得用 null 补位） | 新增 `lib/tx-presign.js`：`buildPreSignCurrent()` 由 **tx_intents + 最新成功 tx_simulations + quote_snapshot + 真实 calldata 解码** 重建当前绑定（intentId / chainId / to / value / selector / key / intentType / amountUsd / deadline / minOut / **quoteBlock / simBlock / simBlockHash / simResultHash** / actions / poolId）。**没有成功模拟、模拟过期（`limits.simMaxAgeSec`，默认 300s）、缺少 simBlockHash/quoteBlock/simResultHash → 直接拒绝**；calldata 解码出的 actions / deadline 必须与 intent 记录一致，minOut 以解码结果为准。`/simulate` 落库新增 `sim_result_hash`（模拟结果摘要） | `tests/tx-presign.test.js`（14 条）；实测：无成功模拟 → 拒绝；写入权威模拟记录后 → **通过**；过期/字段不一致 → 拒绝 |
| **P0-2** | 授权必须**一次性消费**，且绑定 intentId + bindingHash + 用户地址 | `tx_gate_attempts` 新增 `user_addr` / `authorization_status`（authorized→consumed）/ `consumed_at` / `consumed_by`；`loadLatestAuthorization()` 必须同时匹配 intent + bindingHash + 用户 + 未消费；新增 `consumeAuthorization()`（**条件原子更新**，重复消费返回 0 行 → 拒绝）；新增接口 `POST /api/tx/consume-authorization`（先完整核对再消费，消费写入审计） | `tests/tx-authorization-consumption.test.js`（6 条）；实测：首次消费 200 成功 → 重复消费 **409 拒绝** → 消费后核对提示「授权已被消费，禁止再次签名/广播」 |

**测试总数**：167 → **187**。门禁版本仍为 `M3-gate-4`（新增 `limits.simMaxAgeSec`）。

## 16. M3.3 手动签名与广播实现（2026-11-10）

**范围**：按 review 给出的 11 项交易路径要求实现，**保持所有开关关闭**（`TX_GATE.enabled=false`、`unlockRecord.path=null`、所有 `writeEnabled=false`），完成后再进行一次独立的 M3.3 review。

| 文件 | 作用 |
|---|---|
| `lib/tx-wallet-tx.js` | 已签名交易 / 链上交易 与授权绑定的逐字段比对（chainId / to / value / calldataHash / selector / 发送方 / Gas 价格上限）+ 回执摘要与核对 |
| `lib/tx-broadcast.js` | 广播前置检查（纯函数，13 个拒绝码）、**单次**广播（无重试/无替换/无加速/无手工 nonce）、链上交易读取、回执轮询、失败分类（哪些必须熔断） |
| `routes/tx.js` | 新增 `POST /authorize`（门禁先行 → 权威记录重建 → authorizeTx）、`POST /broadcast`（预检 → 内容核对 → 单次广播 → 记录 → 失败熔断）、`POST /receipt`（只读回执轮询 + 核对 + 熔断 + 审计）、`GET /broadcasts/:intentId` |
| `db/schema.js` | 新增 `tx_broadcasts`（广播与回执记录；只存 rawTx 指纹，不保存原始签名数据） |
| `frontend/src/lib/tx-sign.ts` | 前端签名硬拦截：每次调用前检查 门禁 / 解锁记录 / 熔断 / 授权已消费；两种手动方式（只签名 / 钱包内广播） |
| `frontend/src/components/SignBroadcastPanel.tsx` | 七步手动流程面板（构造 → 预演 → 授权 → 核对 → 消费 → 签名/广播 → 回执）；门禁关闭时全部禁用并说明原因 |
| `config/tx-gate.js` | 新增 `limits.broadcastConsumeMaxAgeSec=180` 与 `broadcast` 声明段（两种方式 / 硬失败清单 / 无自动化清单） |

**关键约束**：
- 广播前置条件：门禁开启 + 解锁记录 + 熔断未触发（未知 = 拒绝）+ 授权**已一次性消费**（且消费时间在 180s 内）+ 绑定哈希一致 + 方式合法；
- 内容核对：发送前（签名交易）或事后（钱包自行广播）都必须与授权绑定逐字段一致，不一致 → **熔断**；
- 广播为**单次调用**：无循环、无 `retries`、无 `nonce` 处理（静态断言保证），RPC 超时按「结果未知」→ 熔断 + 人工确认，**禁止自动重发**；
- 同一 intent 只允许一笔广播（`ALREADY_BROADCAST`）；
- 路由层不得注入自定义门禁配置（静态断言），因此「开闸后的路由行为」只能由模块级测试覆盖。

**测试**：187 → **210**（新增 `tests/tx-broadcast.test.js` 23 条；3 条旧静态断言按新架构重写为「唯一写路径 + 仅单次广播」）。

**实测（门禁关闭）**：`/authorize` → 403 `GATE_CLOSED`；`/broadcast`（两种方式 + 非法方式）→ 403 `GATE_CLOSED`；`/receipt` → 404；`/broadcasts` → 空；熔断仍为未触发；拒绝均有审计记录。

## 17. M3.3 review 第一轮修复（P0-1 / P0-2，2026-11-12）

| 项 | 问题 | 修复 | 证据 |
|---|---|---|---|
| **P0-1** | `eth_signTransaction` 未传 `from`，账户可能由钱包自行决定 | `WalletTx.from` 必填；签名/发送请求显式携带 `from`；两道校验（第一道不接触钱包：门禁 + `from` 合法 + chainId=99901 + Gas 齐全；第二道读钱包只读状态：`from` == 当前账户、钱包链 == 交易链）；不通过**不弹钱包**；后端保留签名恢复二次校验 | `frontend/src/lib/tx-sign.ts`；`frontend/src/lib/tx-sign.test.ts` 12 条（`cd frontend && bun test`） |
| **P0-2** | Gas 参数未在签名前绑定，钱包可自行决定 gasLimit / 费用 | 新增 `lib/tx-gas.js`：`gasLimit = max(ceil(estimate × 1.25), 50000)`、`maxFeePerGas = eth_gasPrice`（≤5 gwei）、`maxPriorityFeePerGas = min(maxFee, 1 gwei)`、最坏 Gas 成本 ≤ 1 USD；simulate 落库 Gas 计划；绑定对象新增 4 个 Gas 字段（进入 bindingHash）；签名前/事后核对 gasLimit / maxFeePerGas / maxPriorityFeePerGas 不得超过绑定值，优先费 ≤ maxFee，缺字段或取不到 HYPE 价格 → 拒绝 | `tests/tx-gas.test.js` 10 条；`tests/tx-broadcast.test.js` +5；`tests/tx-presign.test.js` +1 |

**首笔模式**：按 review 约定首笔只用 `wallet-sign-raw`（面板已标注 `wallet-sent` 首笔不建议）。

**测试**：后端 210 → **226**；前端新增 12 条（`bun test`）。

**实测（门禁关闭）**：simulate → Gas 计划 `gasLimit=50000 / maxFee=0.5 gwei / 最坏 0.0018 USD` 并落库；`/authorize` 与 `/broadcast` 仍恒 403；`/pre-sign-check` 对旧记录（缺 Gas 计划）fail-closed 拒绝；熔断未触发；夹具已清理。

## 18. M3.3 review 第二轮修复（P0-1 / P0-2 / P1，2026-11-12）

| 项 | 问题 | 修复 | 证据 |
|---|---|---|---|
| **P0-1** | 前端签名前使用可能过期的 React 状态（gate / consumed / intent / gasPlan） | 新增 `POST /api/tx/pre-sign-audit`：服务端重新读取门禁（含熔断、持久化来源）+ 授权状态 + 完整签名前核对，通过时返回**签名载荷** `signing`，并把快照写入审计（`pre-sign-verified`/`pre-sign-rejected`；审计失败 → 拒绝签名）；新增 `GET /api/tx/authorization-state/:intentId`；前端 `doSign()` 每次重新读取钱包账户/链 + 门禁（no-store）+ pre-sign-audit，判定不通过或读取失败 → 不弹钱包；首笔模式强制 wallet-sign-raw | `routes/tx.js`；`frontend/src/lib/tx-sign.ts` `evaluateFreshSignGate()`；前端 22 条测试（含静态顺序断言） |
| **P0-2** | Gas 参数只要求「不超过」绑定值，可被降级复用；EIP-1559 与 legacy 可混用 | 改为**严格等于**（`GAS_LIMIT_MISMATCH`/`MAX_FEE_MISMATCH`/`PRIORITY_FEE_MISMATCH`）；交易类型必须为 EIP-1559，legacy 或同时带 `gasPrice` → `TX_TYPE_MISMATCH`；保留绝对上限兜底 | `lib/tx-gas.js`；`tests/tx-gas.test.js` 13 条；`tests/tx-broadcast.test.js` legacy 降级用例 |
| **P1** | 首笔仍可选择 `wallet-sent`（先广播后核对） | 服务端 `preflightBroadcast()` 在首笔模式拒绝 `wallet-sent`（`MODE_DISABLED_IN_FIRST_TX`）；前端同时禁用该选项 | `lib/tx-broadcast.js`、`config/tx-gate.js` `broadcast.firstTx` |

**测试**：后端 226 → **234**；前端 12 → **22**。

**实测（门禁关闭）**：`pre-sign-audit` → ok:false「交易门禁关闭」+ 完整快照并写审计 `pre-sign-rejected`；`authorization-state` → null；`/broadcast`（wallet-sent）→ 403 `GATE_CLOSED`；熔断未触发；夹具已清理。

## 19. M3.3 review 第三轮修复（P0 回执字段 + 2 个观察项，2026-11-12）

| 项 | 问题 | 修复 | 证据 |
|---|---|---|---|
| **P0** | `fetchTxByHash()` 未映射 `gas` / `maxPriorityFeePerGas` / `type`，而 Gas 已纳入严格绑定 → **成功且正确的交易**在回执阶段被判 `POST_BROADCAST_MISMATCH` → `verification_failed` → 误触发熔断 | 补齐三个字段（bigint / 保留 type）；`verifyOnChainTxAgainstBinding()` 显式传 `type` 与 `gasPriceWei`；回执结论带 `contentCode` + `missingTxFields` | `tests/tx-receipt-integration.test.js`（11 条，**本地假节点 + 真实 JSON-RPC 载荷**，字段由真实签名交易解析）；移除修复后测试复现 review 预测的失败 |
| 观察项 1 | 钱包账户/链一致性只在**前端**判定 | 抽出纯函数 `evaluatePreSignAudit()`：服务端判定 `WALLET_ACCOUNT_MISMATCH` / `WALLET_ACCOUNT_MISSING` / `WALLET_CHAIN_MISMATCH` / `WALLET_CHAIN_MISSING`，审计全部失败原因 | `lib/tx-presign.js` + `tests/tx-presign.test.js` 6 条 |
| 观察项 2 | 未使用服务端返回的 `signing.bindingHash` 做最终比较 | 前端要求 `signing.bindingHash` == `snapshot.bindingHash` == `authorization.bindingHash`，并把该值记入本地日志 | `frontend/src/lib/tx-sign.ts` + 前端测试 |

**测试**：后端 234 → **250**；前端 22 → **23**。

**实测（门禁关闭）**：`/receipt`（不存在的交易哈希）→ `pending=true`、`code=RECEIPT_PENDING`、**不熔断**、状态保持 `broadcasted`、审计 `receipt-pending`；
`/pre-sign-audit` 快照含全部失败原因与钱包一致性字段；熔断表最新事件仍为人工清除；全部夹具已清理。

## 20. M3.3 review 第四轮修复（交易类型 fail-closed + 测试环境，2026-11-12）

| 项 | 问题 | 修复 | 证据 |
|---|---|---|---|
| **P1/P0 边界** | `normalizeTxType()` 在 `type` 缺失时按 `maxFeePerGas` 推断为 EIP-1559，与 fail-closed 不一致 | `normalizeTxType()` 只归一化不推断：缺失 / `null` / 未知类型码 → `'unknown'` → **`TX_TYPE_MISSING`**；已识别但非 EIP-1559 或带 legacy `gasPrice` → `TX_TYPE_MISMATCH`（两码区分） | `tests/tx-gas.test.js`（缺失/null/未知/0x0/0x1/带 gasPrice/0x2 + `normalizeTxType` 断言）；`tests/tx-receipt-integration.test.js` 新增 2 条（缺 type → 熔断 + `missingTxFields`；0x2 → confirmed） |
| 前端 | 签名参数未显式声明类型 | `eth_signTransaction` / `eth_sendTransaction` 均显式 `type: '0x2'`（禁止钱包静默降级） | 前端测试断言两种方式都带 `type` |
| 测试环境 | 缺表环境出现 22 条难懂失败（正好是三个数据库文件） | 新增 `tests/helpers/db-required.js`：缺表时逐条**跳过并提示**（先启动后端同步 schema）；连接错误先重试 3 次 | 三个文件已接入；稳定环境连跑 3 次 **252/252** |

**测试**：后端 250 → **252**；前端 23 → **24**。

## 21. M3.3 review 第五轮修复（测试门禁，2026-11-12）

review 结论：核心交易链路（签名/广播/Gas/类型/回执）**未再发现 P0**；阻塞项是**测试门禁**——
提交说明中的 252/252 在独立检出环境无法复现（232/252，22 条失败），且新增的跳过机制**没有生效**（0 skipped）。

| 项 | 根因 | 修复 | 证据 |
|---|---|---|---|
| 跳过机制失效 | 包装器写成 `nodeTest.test(name, options, runner)`，`options` 为 `undefined` 时 node **不执行 runner** → 用例变空用例静默通过；且 `before` 钩子抛错会把整文件判失败 | 修正注册方式（`options` 为函数/空时用两参数形式）；包装器接管 `before/after/beforeEach/afterEach`，数据库不可用时钩子不执行；表检查改用 `to_regclass()`（同一 search_path）；跳过原因含缺失表名/库/schema/search_path/修复办法 | `tests/helpers/db-required.js`；防退化测试 `tests/db-required-helper.test.js`（子进程实测：缺表必须 skipped；表齐全必须真正执行用例体） |
| 完整环境不可复现 | 数据库接口限流约 400 请求/60 秒，全量测试（跨进程额度测试并发 5 子进程）接近该量级，连续重跑触发 429 | 新增 `scripts/run-backend-tests.sh`（串行 + 间隔 70s + 限流标注）；`bun run test:full`；测试侧 `tests/helpers/db-retry.js` 仅对 429 退避重试（生产 `lib/db.js` 不变） | 实测 3 次连续运行均 **259/259 fail=0** |
| 缺表环境无补救手段 | 干净检出可能从未启动过后端 | 新增幂等建表脚本 `scripts/ensure-m3-tables.js`（`bun run db:ensure`），只建 8 张 M3 表；一致性由 `tests/db-schema-parity.test.js` 守护 | 实测幂等（重复执行「新建 0 张」，补列/索引 17/17 成功） |

**测试**：后端 252 → **259**（新增 4 条 schema 一致性 + 3 条包装器防退化）；前端保持 **24**。

**两条验证路径**：方案一 `bun run test:full` → 3× fail=0（实测 259/259）；方案二 `TEST_REQUIRED_TABLES=__not_a_real_table__ node --test tests/*.test.js` → `fail=0 / skipped=22`（实测 pass=237）。

## 22. M3.3 review 第六轮修复（清理钩子保护，2026-11-12）

review 结论：核心交易链路无新 P0；缺表环境仍有 **2 个失败**（两个数据库测试文件的 `after` 清理钩子执行了 `DELETE`）。

| 项 | 根因 | 修复 | 证据 |
|---|---|---|---|
| 清理钩子仍执行 | 钩子保护按 `(name, fn)` 写，而 node 的钩子签名是 `before(fn[, options])`（无名字参数）→ node 把用户的原始函数当成钩子注册，保护函数被忽略 | `guardHook` 改为 `(fn, options)`；三个文件的 `before`/`after` 增加**文件级** `test.isDbReady()` 保护；包装器暴露 `isDbReady()` | `tests/db-required-helper.test.js` 7 条：缺表四种钩子都不得执行 / 表齐全必须执行 / 文件级保护 / 对照组必须失败；反向验证可复现 |
| 测试对写操作做重试 | 上一轮把限流重试注入到额度占用与释放路径，违反「写操作不得自动重试」 | 移除写路径全部重试注入；仅只读调用保留限流重试；限流改由运行器节奏控制 | 三个文件已无写路径重试；`db-retry.js` 只用于读取 |

**验收口径（不再硬编码总数）**：完整环境 `fail=0` 且 `skipped=0`（连续 3 次）；缺表环境 `fail=0` 且数据库用例全部 `skipped`。

**实测**：完整环境 3 次连续运行均 `fail=0`（`bun run test:full`，脚本在限流时等待重跑）；缺表环境 `fail=0`、数据库用例全部 `skipped`、无钩子失败；前端全部通过。

## 9. 本阶段复核点（请 review）

1. 门禁模型（双重门禁 + 解锁记录 + 熔断）是否足够；
2. 硬上限数值（首笔 20 / 单笔 100 / 日 300 USD，滑点 ≤1%）是否合适；
3. 允许调用清单（5 个合约、5 个函数选择器）是否过宽；
4. 阶段划分（M3.1 只读预演 → M3.2 开关评审 → M3.3 首笔小额）是否认可；
5. 审计字段是否满足追溯要求。

**在以上 5 点获得确认前，M3 不进入任何含真实写操作的步骤。**
