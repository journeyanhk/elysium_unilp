# M2 模拟器 — 方法与边界说明

> 生成日期：2026-11-10 ｜ 阶段：M2（模拟器）｜ 状态：开发完成，待 review
>
> **M2 全程只模拟：不构造交易、不请求任何签名、不发交易。** 白名单所有地址 `writeEnabled=false`，前后端运行时拦截器均在位。

## 1. 交付内容

| 功能 | 入口 | 说明 |
|---|---|---|
| 建仓模拟 | `POST /api/simulate/mint` | 区间（价格或 tick）→ 流动性/使用金额/预计 NFT/gas/授权/余额/价格影响/多余资产兑换估算 |
| 撤池模拟 | `POST /api/simulate/remove` | 指定 tokenId 与比例 → 收到数量/待领手续费/退出滑点/交易后余额/撤空状态/NFT 状态 |
| 兑换估算 | `POST /api/simulate/quote` | 本地 V4 数学（跨 tick 走位），用于退出滑点与多余资产兑换 |
| 风险分析 | `GET /api/analysis/:tokenId` | 建仓台账、无常损失 + HODL 对照、Break-even、价格情景表 |
| PM 行为对照 | `backend/scripts/pm-behavior-compare.js` | Elysium vs 官方（ETH/Base）：字节码/选择器/只读行为/错误语义 → `docs/M2-PM-BEHAVIOR.md` |

## 2. 计算口径（重要）

### 2.1 本地 V4 数学（`lib/v4math.js`）
- `sqrtPriceX96AtTick`：decimal.js（80 位）+ ceil，与**大整数有理数真值**逐位一致（tick 52534 校验通过），`MIN_SQRT_RATIO` 与官方常量一致；
- 金额/流动性：BigInt 定点（Q96），无浮点误差；
- 兑换估算：区间内恒定 L + 跨 tick 走位（使用链上 ModifyLiquidity 事件推导的初始化 tick 净流动性），扣除 1% 费率（池参数），输出价格影响、跨 tick 数、是否部分成交。

### 2.2 待领手续费
- 纯数学读取：`fee = L × (feeGrowthInside_now − feeGrowthInside_last) >> 128`，`feeGrowthInside` 由 StateView 全局/边界读数计算；
- 异常保护：feeGrowth 回退（超过 2^255）视为异常并返回 0（界面标注）。

### 2.3 建仓台账（`lib/ledger.js`）
- 数据源：PoolManager `ModifyLiquidity` 事件（sender = PositionManager，**salt = bytes32(tokenId)**，已链上验证：台账合计 == `getPositionLiquidity`）；
- 每次加减仓按「事件所在区块的前一区块」的池价格折算资产数量（归档 `eth_call`，结果缓存在 `block_prices`）；
- 结论口径：**净投入数量 = Σ存入 − Σ取出**（不是「当前美元余额」反推）。

### 2.4 HODL 对照（review 要求）
- HODL 基准 = 净投入数量**一直持有到现在**的价值；
- LP 实际 = 当前剩余本金 + 待领手续费；
- `LP − HODL` = LP 相对表现；`其中无常损失部分 = (LP − HODL) − 手续费`；
- **已知偏差**：链上不记录「已领取的手续费」，若历史上领过费，本对照会低估 LP 表现（页面已注明）。

### 2.5 Break-even
- 追平 HODL 所需手续费 = `max(0, HODL − LP合计)`；
- Gas 成本 = 静态 gas 用量（建仓 420k + 撤池 165k + 领费 100k）× `eth_gasPrice` × HYPE 美元价（gas 用量为静态估算，链上真实估算仅对「撤池/领费」可得）；
- 桥接成本 = 用户输入（默认 0）；
- **所需交易量** = 需覆盖金额 ÷ (1% 费率 × 本头寸在池内流动性占比)，仅在区间内有效；
- **按当前收益速度需要多少天** = 需覆盖金额 ÷ 采样得到的 $/天（采样不足时显示「采样中」，不使用单点数据推导）。

### 2.6 价格情景
- ±10% / ±25% / ±50%：假设 HYPE 美元价不变、KNTQ 美元价随池内价格联动；
- 每个情景给出 LP 价值、HODL 价值、差额、是否在区间内；
- 情景表含当前待领手续费（实际手续费随价格路径变化，仅供判断「需要多少手续费追平 HODL」）。

## 3. Gas 与前置检查
- 撤池/领费：`eth_estimateGas` 用**与真实操作相同的编码**（`0x0111` = DECREASE_LIQUIDITY + TAKE_PAIR）估算，实测约 10 万–17 万 gas；
- 建仓：同样编码（`0x020d` = MINT_POSITION + SETTLE_PAIR）估算；若地址余额不足，节点返回资金不足（**编码本身有效**），此时退回静态值并注明原因；
- 授权：读取 Permit2 `allowance(owner, KNTQ, PositionManager)`，判断金额与有效期；
- 余额：读取 HYPE/KNTQ 余额并与「含滑点上限的金额」比较。

## 4. 已知边界（如实声明）
1. 所有结果都是**估算**，不是链上执行结果；M3 真实操作时会用同一套编码与滑点口径，但以链上为准；
2. 内部实现等价性：M2 完成「选择器集合（37/37）+ 只读行为 + 错误语义 + permit2 不变量」对照，**仍无法通过只读手段证明存储布局/事件顺序/gas 行为完全等价** → PositionManager 保持 `pending-official`；
3. 收益速度与年化依赖采样时间序列，样本不足时不显示（不使用首日尖峰推导 APR）；
4. 池龄 < 7 天为**硬性红色警告**（当前池 2026-11-09 创建）；
5. 本地兑换估算未考虑 hook（本池无 hook）与协议费（实测为 0）；
6. 「已领取手续费」链上不可追溯（见 2.4）。

## 5. 与 review 要求的对应关系
| Review 要求 | 实现 |
|---|---|
| 建仓模拟（PoolKey/tick/两侧输入/预计 L/预计 NFT/价格影响/Gas/最低结果/失败原因） | ✅ 全部实现；「最低结果」以 `amount0Max/amount1Max + minLiquidity` 表达 |
| 撤池模拟（tokenId/流动性/收到数量/待领费/退出滑点/交易后余额/已撤空） | ✅ 全部实现 |
| 无常损失（LP 当前价值 / HODL 对照 / 手续费收益 / LP 相对 HODL） | ✅ 全部实现，HODL 基于建仓台账净投入数量 |
| Break-even（覆盖无常损失 / gas / 桥接成本 / 所需交易量） | ✅ 全部实现（桥接成本为输入项） |
| PositionManager 行为级验证 | ✅ 选择器 + 只读行为 + 错误语义 + 不变量；❌ 内部实现等价性（只读手段不可证，如实标注） |
| 继续禁止签名与写操作 | ✅ 模拟路由内置防御性写权限检查；白名单全部 writeEnabled=false |
