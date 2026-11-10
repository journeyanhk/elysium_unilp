# M3 小额交易安全门禁（Transaction Safety Gate）

> 版本：`M3-gate-1`（2026-11-10）｜ 代码：`backend/config/tx-gate.js`｜ 测试：`backend/tests/tx-gate.test.js`（10 条，全部通过）
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
