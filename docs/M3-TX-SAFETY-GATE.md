# M3 小额交易安全门禁（Transaction Safety Gate）

> 版本：`M3-gate-4`（2026-11-10，M3.2 最终评审：额度占用改为数据库原子语句、授权绑定完整交易内容）｜ 代码：`backend/config/tx-gate.js` + `backend/lib/tx-gate-state.js` + `backend/lib/tx-parse.js`｜ 测试：`tests/tx-gate.test.js`、`tests/tx-parse.test.js`、`tests/tx-rpc-guard.test.js`、`tests/tx-build.test.js`（全部通过）
>
> **当前状态：全部关闭。** 未经下一轮 review，不得打开真实交易、签名、Approve、Permit2、mint、burn、collect 或 `modifyLiquidities`。

---

## 1. 门禁模型：三重关闭 + 双重门禁

| 层 | 位置 | 当前值 | 作用 |
|---|---|---|---|
| ① 交易总开关 | `TX_GATE.enabled` | `false` | 总闸；关闭时**任何**写操作被拒绝 |
| ② 逐合约开关 | `config/whitelist.js` 各条目 `writeEnabled` | 全 `false` | 第二重；按合约逐个开启（M3.3 起） |
| ③ 运行时拦截器 | `backend/lib/tx-guard.js` + `frontend/src/lib/tx-guard.ts` | 均启用 | 任何写路径必须先过拦截器，否则抛错 |

**缺一不可**：即使总开关打开，只要目标合约 `writeEnabled=false`，写操作仍被拒绝；反之亦然。

---

## 2. 解锁条件（两条路径之一 + 全部硬性条件）

**路径 A：官方渠道确认** PositionManager 身份（官方公告 / 文档 / 官方仓库声明）。

**路径 B：用户知情接受**（书面记录）：用户明确知晓「PM 归属未获官方确认、写路径行为未验证」的风险，同意以小额首笔验证。

**硬性条件（必须全部满足）**：

1. 安全上限配置完成并通过测试（§4）；
2. 首笔小额模式启用（`firstTxMode=true`）；
3. 前后端运行时拦截器在位，且支持一键全关；
4. 交易预演（`eth_call`）与链上状态一致性检查通过；
5. 逐笔用户签名流程可用，且代码中**无**自动重发 / 自动加速 / 自动放宽滑点分支。

**解锁记录**（`TX_GATE.unlockRecord`）：必须记录路径、时间、记录人、说明；**无记录即拒绝一切写操作**（由 `assertTxAllowed` 强制）。

---

## 3. 首笔小额模式

- 首笔交易上限 **20 USD**（`firstTxMaxUsd`），且仍受全部其它上限约束；
- 首笔完成后：人工复核审计记录（模拟偏差、实际收到数量、Gas 消耗、余额变化），确认无误后才可关闭 `firstTxMode`；
- **首笔失败或回滚 → 立即熔断**，需人工复核并记录原因后才能重新开启。

---

## 4. 硬上限（代码即配置，无自动放宽分支）

| 项 | 值 | 说明 |
|---|---|---|
| 首笔上限 | 20 USD | 首笔小额模式 |
| 单笔上限 | 100 USD | `firstTxMode=false` 后的常规上限 |
| 日累计上限 | 300 USD | 跨交易累计 |
| 滑点上限 | 100 bps（1%） | 只允许用户手动输入，**不得超过**；禁止自动放宽 |
| 最小输出保护 | 强制 | 必须携带 `amountOutMinimum` / `amount0Min` / `amount1Min`，否则拒绝 |
| Gas 价格上限 | 5 gwei | 超过即拒绝 |
| Gas 费用上限 | 1 USD | 超过即拒绝 |
| 价格影响上限 | 2% | 超过即拒绝 |
| 报价有效期 | 30 秒 | 过期即拒绝（不重试、不降级） |
| 频率限制 | 每分钟 1 笔、每日 3 笔 | 超过即拒绝 |
| 池龄提示 | < 7 天 | 硬性红色警告，需显式确认 |

---

## 4.1 限制的真实执行（M3.1 补齐）

| 限制 | 执行方式 |
|---|---|
| 首笔 / 单笔 / 日额度 | `evaluateTxRequest` 逐项判断；日额度由 `tx_gate_attempts` 表实时聚合（进程重启不丢） |
| 每分钟 / 每日笔数 | 同上，按时间窗口聚合 |
| Gas 单价 **与总成本** | 同时校验 `maxGasPriceGwei` 与 `maxGasUsd`；**缺少 Gas 成本估算直接拒绝** |
| 滑点 / minOut / 报价新鲜度 / 价格影响 / deadline | 逐项强制，无自动放宽分支 |
| 熔断 | `lib/tx-gate-state.js`（Postgres，append-only）：`trip` 需原因，`clear` **必须**提供人工复核记录与操作人；`storeKind` 固定 `postgres`，测试禁止内存实现 |

## 4.1.1 原子额度占用（M3.2 review P0-1 / 最终评审 P0-1）

**当前实现：单条 Postgres 原子语句**（不是「多次 UPDATE + 失败补偿」）：

```sql
WITH locked AS (SELECT ... WHERE bucket_key IN ($1||分钟, $2||日) ORDER BY bucket_key FOR UPDATE),
     cur AS (...从 locked 读取最新计数...),
     dec AS (SELECT (locked_n = 2 AND 分钟<上限 AND 日笔数<上限 AND 日金额+本次<=日上限) AS pass,
                    CASE ... END AS reject_code FROM cur),
     m AS (UPDATE 分钟桶 SET tx_count = tx_count + 1 WHERE ... AND (SELECT pass FROM dec) RETURNING ...),
     d AS (UPDATE 日桶 SET tx_count = tx_count + 1, amount_cents = amount_cents + 本次 WHERE ... AND (SELECT pass FROM dec) RETURNING ...)
SELECT (SELECT pass FROM dec) AS ok, (SELECT reject_code FROM dec) AS reject_code, ...;
```

- **先锁行再判定再更新**，三步在**同一条语句**内完成 → Postgres 自动把单条语句包成事务，天然全或无；
- 三桶的更新都挂在同一个 `pass` 条件上：任一项不满足 → **三个桶都不变**（不存在「先更新再补偿」）；
- 并发请求在 `FOR UPDATE` 上排队，锁后重新读取最新计数 → 并发不会超额；
- 日笔数与日金额必须在**同一条 UPDATE** 内完成（Postgres 同一语句中两个 CTE 改同一行时只有一个会生效）；
- 为什么不用 `BEGIN; ...; COMMIT;`：本数据库代理在带参数时走预处理语句（扩展协议），Postgres 明确拒绝
  `cannot insert multiple commands into a prepared statement` —— 多语句事务在带参数时不可用；
  单条语句（含 `FOR UPDATE`）即为其上可用的真正原子操作。
- 出错时在同一把进程内互斥锁中发 `ROLLBACK`；并新增 `dbQuerySafe()`：识别
  `current transaction is aborted` 后自动回滚并重试一次 —— 该代理是**每进程一条共享会话**，
  一次失败事务会拖垮整个后端进程的查询（实测连 cron 采样都被连带打死），此包装已修复该风险。

## 4.1.1b 授权绑定完整交易内容（最终评审 P0-2）

`authorizeTx()` 现在把**完整交易内容**算成绑定对象与 `bindingHash` 并写入审计：

```text
intentId / chainId / to / value / calldataHash / selector / key / intentType / amountUsd /
deadline / minOut / quoteBlock / simBlock / simBlockHash / simResultHash / actions / poolId
```

- 门禁新增校验：`BINDING_MISSING`（缺绑定字段）、`CHAIN_MISMATCH`、`TO_MISMATCH`（`to` 必须等于该白名单条目地址）；
- 审计表新增 `intent_id` / `binding_hash` / `binding` 三列，可按 intent 找回授权；
- 新增只读接口 `POST /api/tx/pre-sign-check`：用**真实 calldata** 重算哈希并解码出 actions / deadline / 金额边界，
  与授权绑定**逐字段**比对（intentId / chainId / to / value / intentType / amountUsd / deadline / minOut /
  actions / quoteBlock / simBlockHash / poolId / selector）；任何字段变化都会返回
  「必须重新 build → simulate → authorize」；本接口不签名、不广播；
- **当前交易绑定必须重建**（不得把授权值放回当前交易）：`current` 来自 intent 记录 + 当前请求 + 真实 calldata 解码；
- **绑定哈希自校验**：`bindingHashOf(binding)` 必须等于记录中的 `bindingHash`，内容被篡改即拒绝；
- **权威模拟数据**：`quoteBlock / simBlock / simBlockHash / simResultHash / minOut` 必须来自
  tx_intents + 最新成功 tx_simulations + 真实 calldata 解码，**不得用 null 补位**；
  没有成功模拟、模拟超过 `limits.simMaxAgeSec`、缺少任一字段 → 直接拒绝签名；
- **授权一次性消费**：`POST /api/tx/consume-authorization` 先完整核对再执行**条件原子更新**
  （`authorization_status` authorized→consumed，记录 `consumed_at` / `consumed_by`）；
  重复消费返回 0 行 → 拒绝；授权按 intent + bindingHash + 用户地址匹配，不能只按 intentId 取最近一条；
- 因此「交易 A 获得授权 → 实际发送交易 B」的路径被关闭：B 的 calldata 哈希与 A 的绑定不同，核对必然失败。

## 4.1.2 审计 fail-closed（M3.2 review P0-2）

「先读计数 → 判断 → 再记录」在并发下会被绕过（两个请求都读到 0 笔，都通过）。现在改为**带条件的原子 UPDATE**：

```sql
UPDATE tx_gate_buckets SET tx_count = tx_count + 1
 WHERE bucket_key = 'minute:…' AND tx_count < 每分钟上限 RETURNING tx_count;
```

- 唯一 **reservation id**：占用时在**同一原子语句**内写入 `tx_gate_reservations`；释放为条件更新
  （`released <> 'true'`），重复释放无副作用、不会把额度扣成负数；
- **跨进程**：进程内互斥锁只协调单进程，跨实例正确性由数据库行锁 + 条件更新保证（多进程并发测试覆盖）；
- 行锁 + 条件重判保证并发下不会超额；补偿只可能「多算」额度（更保守），**不会少算**（不会放行）；
- 金额以「分」存整数（`amount_cents`），避免浮点误差；
- 并发测试（真实 Postgres，`tests/tx-gate-concurrency.test.js`）：5 个并发请求 + 每分钟上限 1 → 恰好 1 个通过；5 × 1 USD + 日上限 3 USD → 恰好 3 个通过，日累计恰好 3 USD。

## 4.1.2 审计 fail-closed（M3.2 review P0-2）

真实交易入口必须调用 `authorizeTx()`：**门禁判断 → 原子占用额度 → 写审计**，任一步失败即拒绝并释放额度。

- 审计写入失败 → 释放额度 + 拒绝（`GATE_AUDIT_FAILED`）；**绝不出现「允许交易但没有审计记录」**；
- 持久化状态读取失败 → 拒绝（`GATE_STATE_UNAVAILABLE`）；额度存储不可用 → 拒绝（`GATE_QUOTA_UNAVAILABLE`）；
- 该 fail-closed 改造**立即暴露出一个真实缺陷**：`loadCounters()` 对 `amount_usd`（text 列）直接 `SUM()`，Postgres 报 `function sum(text) does not exist` —— 即此前门禁状态**根本读不出来**，而旧代码把异常吞掉后会照常放行。现已改为 `SUM(NULLIF(amount_usd,'')::numeric)` 并补回归测试。

## 4.1.3 熔断状态不得漂移（M3.2 review P0-3）

`GET /api/tx/gate` 的熔断字段一律读**持久化记录**，不再返回静态配置值，返回：`killSwitchTripped` / `killSwitchTrippedAt` / `killSwitchReason` / `killSwitchClearedAt` / `killSwitchClearedBy` / `stateSource`。

持久化读取失败时返回 `killSwitchTripped: null` + `stateUnavailable: true`（**绝不谎报 false**）。实测：触发熔断 → 接口立即显示 `tripped=true` 且门禁以 `KILL_SWITCH` 拒绝；人工复核清除 → 显示 `clearedAt` / `clearedBy`。

## 4.2 参数级白名单（三层：合约 → selector → calldata 语义）

仅限制 selector 不够。`lib/tx-parse.js` 在**构造阶段**即解码并校验：

- **ERC-20 `approve(spender, amount)`**：spender 只能是 PositionManager 或 Permit2；禁止无限授权（`2^256-1`）；金额必须 > 0 且 ≤ 本次 intent 金额；
- **Permit2 `approve(token, spender, amount, expiration)`**：token 必须是本次目标代币；spender 必须是 PositionManager；金额 ≤ intent；有效期 ≤ 30 天且未过期；
- **`modifyLiquidities(bytes, uint256)`**：解码 `unlockData` → actions 列表与参数，逐项校验：
  - 只允许三种组合：组池 `MINT_POSITION + SETTLE_PAIR`、领费 `DECREASE_LIQUIDITY(0) + TAKE_PAIR`、撤池 `DECREASE_LIQUIDITY(>0) + TAKE_PAIR`；**顺序固定**；
  - 未知 action、夹带 action（SWAP / BURN / SWEEP / CLOSE_CURRENCY / CLEAR_OR_TAKE 等）、组合与 intent 类型不符 → 一律拒绝；
  - PoolKey 必须逐字段等于白名单池；tick 必须按 tickSpacing 对齐且 lower < upper；liquidity 方向与大小必须与 intent 一致；
  - `amount0Max/amount1Max` 不得超过 intent 上限；`amount0Min/amount1Min` 不得低于 intent 下限；owner / recipient 必须是用户本人；
  - deadline 不得过期、不得超过 30 分钟。

## 5. 允许的合约与函数（白名单，超出即拒绝）

| 键（与白名单一致） | 地址 | 允许选择器 | 函数 |
|---|---|---|---|
| `KNTQ` | `0xe45a355d…acF0` | `0x095ea7b3` | `approve(address,uint256)` |
| `WHYPE` | `0xbA876237…5E81` | `0x095ea7b3` | `approve(address,uint256)` |
| `USDC` | `0xb47c4C8F…0B65` | `0x095ea7b3` | `approve(address,uint256)` |
| `permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x87517c45` | `approve(address,address,uint160,uint48)` |
| `positionManager` | `0x1d1c51b9…e518` | `0xdd46508f` | `modifyLiquidities(bytes,uint256)` |

**明确不在清单内**（因此被拒绝）：Permit2 的 `permit`（`0x2b67b570`，签名代发路径）、任意 `multicall`（`0xac9650d8`）透传、Universal Router 任意入口、`delegatecall`、未知合约。

---

## 6. 熔断（Kill Switch）

触发即**全关**（需人工复核 + 记录原因才能恢复）：

- 模拟结果与链上状态不一致；
- 报价过期或价格影响超过上限；
- 检测到链上重组影响头寸 / 池状态；
- RPC 端点全部不可用或响应异常；
- 同一分钟内出现第 2 笔写操作请求；
- **任何一笔交易回滚后**。

---

## 7. 每笔交易的确认流程（UI 必须展示）

1. 操作类型与池（含池龄警告）；
2. 资产变化：付出 / 收到（区间估计）；
3. **最小收到数量**（minOut）与滑点；
4. Gas 上限（价格与费用）；
5. 价格影响（执行价影响 vs 池价变化，两者分列）；
6. 门禁状态徽标：当前总开关 / 该合约开关 / 首笔小额模式 / 剩余额度；
7. 明确提示：**本次操作不可撤销**，链上执行结果为准。

---

## 8. 审计要求

每笔写操作记录：意图与参数快照、quote 时间与来源、`minOut`、deadline、模拟输出与偏差、用户确认时间与地址、交易哈希、回执状态、实际 Gas、资产前后变化、当时门禁版本与上限、熔断状态。

---

## 9. 开启前检查清单（全部勾选才可进入 M3.3）

- [ ] M3 实施计划（`docs/M3-PLAN.md`）已获 review 通过；
- [ ] 门禁测试全部通过（`cd backend && bun run test`，含 `tx-gate.test.js`）；
- [ ] 只读预演管线完成，且对真实链上状态 `eth_call` 与本地估算一致；
- [ ] 广播入口在门禁关闭时 100% 拒绝（有测试覆盖）；
- [ ] 审计表就绪，且首笔可完整追溯；
- [ ] 解锁路径已记录（官方确认，或用户知情接受）；
- [ ] 用户已阅读并确认首笔小额规则与风险；
- [ ] 一键全关演练完成（总开关 + 白名单 + 前端拦截器三处同时关闭）。

---

## 10. 关闭方式（一键全关）

```text
1. backend/config/tx-gate.js      → TX_GATE.enabled = false
2. backend/config/whitelist.js    → 所有 writeEnabled = false
3. frontend/src/lib/tx-guard.ts   → WRITES_ENABLED = false
4. 重启后端（配置为启动时读取）
```

上述三处的当前值已由测试锁定：`backend/tests/tx-gate.test.js` 会在任何一处被误开时失败。

## M3.3 广播路径（已实现，开关仍关闭）

- **唯一写方法**：`eth_sendRawTransaction`，只出现在 `lib/tx-broadcast.js`，且为**单次调用**（无重试 / 无替换 / 无加速 / 无手工 nonce；静态断言）。
- **广播前置条件**（任一不满足即拒绝，全部在发送之前）：门禁开启、解锁记录存在、熔断未触发（未知 = 拒绝）、
  授权已一次性消费且未超时（`limits.broadcastConsumeMaxAgeSec`，默认 180s）、绑定哈希一致、方式属于两种手动方式之一。
- **内容核对**：`wallet-sign-raw` 在发送前核对签名交易；`wallet-sent` 在事后按交易哈希核对。字段：chainId / to / value /
  calldataHash / selector / 发送方（必须等于 intent 用户）/ Gas 价格上限。不一致 → 熔断。
- **回执核对**：status 必须 success；链上内容必须与授权一致；实际 Gas 超上限记录偏差并要求人工复核。
  回滚或事后不一致 → 熔断。轮询回执不等于重发。
- **同一 intent 只允许一笔广播**；再次操作必须重新 build 新 intent（重新模拟、重新授权、重新消费）。
- **当前状态**：`TX_GATE.enabled=false`、`unlockRecord.path=null`、所有 `writeEnabled=false`、PM `pending-official`、
  **未生成解锁记录** → `/authorize` 与 `/broadcast` 恒 403。

## Gas 绑定（M3.3 review P0-2）

- **simulate 阶段固定**：`gasLimit = max(ceil(eth_estimateGas × (1 + limits.gasLimitMarginBps/10000)), limits.minGasLimit)`；
  `maxFeePerGas = 链上 eth_gasPrice`（≤ `limits.maxGasPriceGwei`）；`maxPriorityFeePerGas = min(maxFeePerGas, limits.maxPriorityFeeGwei)`；
  最坏 Gas 成本 `gasLimit × maxFeePerGas × HYPE 价格 ≤ limits.maxGasUsd`。计划落库并进入授权绑定（bindingHash）。
- **签名前/事后核对**：真实交易（或链上交易）的 `gasLimit` / `maxFeePerGas` / `maxPriorityFeePerGas`
  不得超过绑定值，优先费不得高于 maxFeePerGas；缺任一字段、绑定缺 Gas 字段、或无法获取 HYPE 价格 → **拒绝**。
- **不做事后补偿**：Gas 超限一律在签名/广播前拒绝，不允许「先签名再看回执」。

## Gas 严格绑定与交易类型（M3.3 review 第二轮 P0-2）

- 实际交易的 `gasLimit` / `maxFeePerGas` / `maxPriorityFeePerGas` 必须**严格等于**授权绑定值
  （**降低也拒绝**，避免交易 A 的授权被降级后的交易 B 复用）：`GAS_LIMIT_MISMATCH` / `MAX_FEE_MISMATCH` / `PRIORITY_FEE_MISMATCH`。
- 交易类型必须与 Gas 计划一致（EIP-1559）：legacy 交易或同时携带 `gasPrice` 的交易 → `TX_TYPE_MISMATCH`。
- 绝对上限兜底仍然生效：`GAS_PRICE_OVER` / `PRIORITY_FEE_ABOVE_MAX_FEE` / `GAS_USD_OVER` / `HYPE_PRICE_MISSING`。

## 签名前重新核对（M3.3 review 第二轮 P0-1）

- 每次请求签名之前必须调用 `POST /api/tx/pre-sign-audit`：服务端重新读取门禁（含熔断与持久化来源）、
  该 intent 的授权状态与消费时长、并重新执行完整签名前核对；通过时返回**签名载荷**供钱包使用。
- 快照写入审计（`pre-sign-verified` / `pre-sign-rejected`）；**审计写入失败 → 拒绝签名**。
- 前端任何读取失败（接口异常 / 非 200 / 状态不可读）→ 拒绝且**不弹钱包**。

## 首笔模式（M3.3 review 第二轮 P1）

- `firstTxMode=true` 时只允许 `wallet-sign-raw`（钱包只签名 → 后端核对 → 后端单次广播）；
  `wallet-sent` 由**服务端**拒绝（`MODE_DISABLED_IN_FIRST_TX`），前端同时禁用该选项。

## 回执核对必须完整映射 RPC 字段（M3.3 review 第三轮 P0）

- 由于 Gas 参数（`gasLimit` / `maxFeePerGas` / `maxPriorityFeePerGas`）已纳入**严格相等**绑定，
  回执阶段重新读取链上交易时**必须**完整映射 `type` / `gas` / `maxPriorityFeePerGas`；
  任何字段遗漏都会把**成功且正确的交易**误判为内容不一致（`GAS_LIMIT_MISSING` / `PRIORITY_FEE_MISSING`）→ 误触发熔断。
- 回执结论带 `contentCode`（具体失败码）与 `missingTxFields`（缺失字段清单），便于人工复核；
  节点未返回所需字段时 fail-closed 拒绝（不默认放行）。
- 集成测试使用**本地假节点 + 真实 JSON-RPC 十六进制载荷**，覆盖「成功不误熔断」与「错误必熔断」两侧。

## 钱包账户与链一致性（服务端判定）

- `/api/tx/pre-sign-audit` 由服务端判定 `walletAccount == intent.user_addr`（大小写不敏感）与
  `walletChainId == intent.chain_id`：`WALLET_ACCOUNT_MISMATCH` / `WALLET_ACCOUNT_MISSING` /
  `WALLET_CHAIN_MISMATCH` / `WALLET_CHAIN_MISSING`，并把全部失败原因写入审计快照。
- 前端同时要求 `signing.bindingHash` == `snapshot.bindingHash` == `authorization.bindingHash`；
  后端签名恢复地址校验（`SENDER_MISMATCH`）仍为最终兜底。

## 交易类型必须显式且可识别（M3.3 review 第四轮）

- `normalizeTxType()` **只做归一化，不做推断**：`type` 缺失 / `null` / 未知类型码 → `'unknown'`；
- `'unknown'` → `TX_TYPE_MISSING`（节点未返回可识别类型）；已识别但非 EIP-1559（`legacy` / `eip2930`）
  或同时携带 legacy `gasPrice` → `TX_TYPE_MISMATCH`；
- 前端签名参数显式声明 `type: '0x2'`，后端仍独立核对类型（不依赖钱包行为）。
