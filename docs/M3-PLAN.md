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

## 9. 本阶段复核点（请 review）

1. 门禁模型（双重门禁 + 解锁记录 + 熔断）是否足够；
2. 硬上限数值（首笔 20 / 单笔 100 / 日 300 USD，滑点 ≤1%）是否合适；
3. 允许调用清单（5 个合约、5 个函数选择器）是否过宽；
4. 阶段划分（M3.1 只读预演 → M3.2 开关评审 → M3.3 首笔小额）是否认可；
5. 审计字段是否满足追溯要求。

**在以上 5 点获得确认前，M3 不进入任何含真实写操作的步骤。**
