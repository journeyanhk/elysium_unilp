# M0 核验报告 — Elysium「Uniswap V4」部署身份核验

- 日期：2026-11-09（全部为只读链上查询，未发起任何交易）
- 范围：Elysium 主网（chainId 99901）上标注为 Uniswap 的 V4 部署、其配套合约、目标池
- 方法：RPC 只读查询（getCode / getLogs / eth_call）、创建交易回溯（二进制搜索定位创建区块 + CREATE2 复算）、字节码比对（对照官方 ETH/Base/Unichain/Arbitrum/Optimism/Polygon/Zora 部署）、函数选择器比对、聚合器与官方文档交叉核对
- 一句话结论：**链上技术核验基本通过（PoolManager 与官方构建逐字节一致；PositionManager 功能面与官方完全一致）；「官方归属」尚缺官方渠道证据 → 保持「待官方确认」状态，交易功能继续关闭。**

## 1. 核验对象

| 对象 | 地址 | 状态 |
|---|---|---|
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` | pending-official |
| PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | pending-official |
| 目标池（原生 HYPE/KNTQ，1% 费率） | `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` | verified（参数） |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | verified |
| 代币：KNTQ / WHYPE / USDC | `0xe45a355d…acF0` / `0xbA876237…5E81` / `0xb47c4C8F…0B65` | verified |

## 2. 关键结论

1. **PoolManager `0xe2e105d3…`：与官方部署的字节码逐字节一致。** 唯一差异是合约自地址常量（20 字节）——官方各链之间也是完全相同的差异模式；编译器同为 solc 0.8.26，体积同为 24009B。可判定为「官方级」构建。
2. **PositionManager `0x1d1c51b9…`：功能面与官方完全一致（21/21 项函数选择器相同，含 subscribe/unsubscribe 等新版功能）；体积不同（19965B vs 官方 23877B）**，判断为编译配置差异（遗留项，见 §7）。该合约已承载 1216 个头寸（nextTokenId），并绑定官方 Permit2。
3. **部署路径正规**：PoolManager 与 PositionManager 均由同一 EOA（`0x2179a608…`）于 2026-11-03 04:09（UTC）通过**标准确定性部署器**（Arachnid `0x4e59b448…956C`，零盐）部署，CREATE2 复算地址与实际完全一致；同一批次共部署 17 个合约（含 Quoter / StateView / UniversalRouter 候选等，见 §3.4）。
4. **目标池真实且活跃**：原生 HYPE / KNTQ、费率 1%、tickSpacing 200、无 hook；池 ID 数学验证通过；截至核验时流动性约 $27 万、24h 成交约 $152 万（DexScreener）。
5. **聚合器均标注为 Uniswap**：DexScreener 标 `uniswap` + `v4`；GeckoTerminal 的 dex 标识为 `uniswap-v4-elysium`。
6. **官方渠道未确认**：Uniswap 官方部署文档未列 Elysium；Elysium 官方文档仍写「Uniswap: Announced for Elysium」；Uniswap interface 仓库未查到 Elysium 配置。→ 官方归属**未确认**。
7. **同链存在其他 v4 风格部署（至少 4 个，部署者各不相同）** → 白名单必须只认本报告核验的地址（排除清单见 §3.8）。

## 3. 证据明细

### 3.1 部署路径

- 部署者 EOA：`0x2179a60856e37dfeaaca0ab043b931fe224b27b6`（部署批次内 nonce 12→28；当前 nonce 38，为专职部署账号）
- 部署代理：`0x4e59b44847b379578588920cA78FbF26c0B4956C`（全链通用确定性部署器），**salt = 0x00…00**
- PoolManager 部署交易：`0x30fc8b36b478ee039fb591df369300815bc28bbf46187de8987ca0ddf5b1b08e`（区块 256083；CREATE2 复算 = 实际地址 ✓）
- PositionManager 部署交易：`0x25c7ae7b9304cc388afef33bdfc236de2c94248fb6ac8e980214b5acd4559b5d`（区块 256086 ✓）
- PoolManager `owner()` = `0xa9ae0c5eb238a519b7f5af27415eb6dd0744da8d`（合约，7310B；非标准 TimelockController，类型待确认）
- 测试网：主网 V4 候选地址在测试网不存在（该栈目前仅主网）

### 3.2 PoolManager 字节码比对（对照官方 ETH / Base）

- 体积：24009B = 24009B = 24009B（三方一致）
- solc：0.8.26（三方一致）
- 剥离元数据后差异：**恰好 20 字节（偏移 13618–13637），差异内容 = 合约自身地址**；ETH 与 Base 官方部署之间也存在同样位置、同样长度的 20 字节差异
- → 判定：与官方构建**同源同编译参数**；可视为「官方级」字节码

### 3.3 PositionManager 比对（对照官方 ETH / Base / Unichain / Arbitrum / Optimism / Polygon / Zora）

- 体积：Elysium **19965B** vs 官方（各链一致）**23877B**；solc 均 0.8.26
- 功能面比对（21 项选择器，全部一致）：modifyLiquidities / modifyLiquiditiesWithoutUnlock / initializePool / getPoolAndPositionInfo / positionInfo / multicall / approve / setApprovalForAll / ownerOf / balanceOf / transferFrom / safeTransferFrom / DOMAIN_SEPARATOR / nextTokenId / poolManager / permit2 / tokenDescriptor / subscribe / unsubscribe（双方均无 `permit(...)` 与 `owner()`）
- 链上状态：`nextTokenId()` = 1216；`permit2()` = 官方 Permit2 地址 ✓
- → 判定：**功能面一致的同一代 v4-periphery**；体积差异为编译配置（如优化器参数）所致（遗留项，见 §7）

### 3.4 配套合约清单（2026-11-03 部署批次，共 17 个）

| 区块 | 地址 | 体积 | 识别 |
|---|---|---|---|
| 256083 | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` | 24009B | **PoolManager**（核心） |
| 256084 | `0x599141dbd536891ef30b81883bfb4a621dc3f496` | 24069B | **PositionDescriptor**（tokenURI/nativeCurrencyLabel/flipRatio 等） |
| 256086 | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | 19965B | **PositionManager**（核心） |
| 256087 | `0x379f556c5a748bd7cc9baf0f7a344094ac1814f5` | 6118B | **V4Quoter**（quoteExactInputSingle / unlockCallback） |
| 256088 | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` | 3531B | **StateView**（getSlot0/getTickInfo/getLiquidity；与官方同尺寸） |
| 256094 | `0x1bd4d69bfb8927a045f20518a08390cee3913b0d` | 23233B | **UniversalRouter 候选**（execute 2/2；V1 不启用） |
| 256080–82 / 85 / 89–93 / 95–96 | `0xf025e0fe…`、`0xabfb859e…`、`0x003aa18c…`、`0x9f92c529…`、`0x0000001b…`、`0x3fedad0a…`、`0x94a7d36e…`（V3 风格报价器）、`0x976183ac…`、`0x2d014117…`、`0x0000000085…`、`0xfe31f71c…` | 752B–24497B | 未识别（不启用，不影响核心功能） |

### 3.5 目标池

- 池 ID：`0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac`（= keccak(currency0=原生 HYPE, currency1=KNTQ, fee=10000, tickSpacing=200, hooks=0x0)，数学验证通过）
- 数据（核验时）：流动性 ≈ $27.1 万；24h 成交 ≈ $152.2 万；创建于 2026-11-09（上线数小时）
- 注意：HYPE/KNTQ 存在多个费率档位（0.5%–5%）的池共存，本工具默认目标为上述 1% 池（流动性/成交最大）

### 3.6 外部标注

- DexScreener：`dexId: uniswap`，`labels: ["v4"]`（主池）
- GeckoTerminal：dex 标识 `uniswap-v4-elysium`（多档费率池均在列）

### 3.7 官方渠道核对

- Uniswap 官方部署文档（developers.uniswap.org）：**未列 Elysium**
- Elysium 官方文档（elysium.kinetiq.xyz）：Uniswap 仍标注「Announced for Elysium」
- Uniswap interface 仓库 chains 配置：未查到 Elysium
- Uniswap v4-deployments 仓库：不可访问（404），无法做部署清单比对
- → **官方归属：未确认**（不排除「已部署、待官宣」）

### 3.8 其他 v4 风格部署（白名单排除）

| 地址 | 说明 |
|---|---|
| `0x5fb015a49f5b35073f9ce01c2adb287a75f89600` | v4 风格（另一部署者，2026-10-23） |
| `0x1f9b957071228a3190280e062cc62a3f66b6a13a` | 上述部署的配套 PositionManager |
| `0x06c63714fbf1f5753017123e2fcfdede4540b2c4` | v4 风格（另一部署者，2026-10-25） |
| `0x5c54a7293d96b11a29a0256ee8dfdbc3059637da` | v4 风格（另一部署者，2026-10-30） |
| `0x794ad5fe8227524619c7bbf6b4572c9d08d9ff1f` | 17KB 定制构建（另一部署者，2026-11-04） |

## 4. 结论与状态

- **链上技术核验：基本通过**（§2.1–2.3）
- **官方归属：未确认** → 合约统一标记 `pending-official`
- **处理（按已确认约定）**：不称「官方 Uniswap」；**交易功能保持关闭**；只读看板 + 模拟器继续开发

## 5. 白名单摘要

已写入 `backend/config/whitelist.js`。启用（enabled=true）：PoolManager、PositionManager、PositionDescriptor、V4Quoter、StateView、Permit2、Multicall3、桥路由、四个代币、目标池；UniversalRouter 候选登记但**不启用**；其余 v4 风格部署与未识别合约全部排除。

## 6. 交易开关（M3）条件

满足任一条件方可进入真实交易：
- (a) 官方渠道确认（Uniswap / Elysium 官宣或文档更新）；或
- (b) 用户知情接受（记录在案）＋ 首笔小额 ＋ 全部安全限制保留（预览 → 模拟 → 逐笔签名 / 白名单 / 滑点手动 / 不自动重发）。
另：M2 模拟器完成后，先跑一轮全流程 dry-run 作为行为级验证。

## 7. 遗留与监控项

1. PositionManager 体积差异的最终原因（编译配置 vs 版本差异）→ M2 阶段做行为级对照；
2. PoolManager owner 合约 `0xa9ae0c5e…` 类型（非标准 Timelock，身份待确认）；
3. 官方渠道监控（Uniswap 部署文档 / Elysium 官宣更新）；
4. 目标池数据监控（池龄、流动性、成交量稳定性）；
5. PositionDescriptor / V4Quoter / UniversalRouter 与官方对应合约的进一步比对（不阻塞 M1）。

## 附录：核验方法（可复现）

- 创建区块定位：对目标地址做区块区间二进制搜索（getCode 首次非空）
- 部署复算：对 Arachnid 代理调用数据解析 salt + initcode，复算 CREATE2 地址并与实际比对
- 字节码比对：剥离 CBOR 元数据（末 2 字节长度）后逐字节对比；solc 版本从元数据提取
- 功能面比对：对已知函数签名计算选择器，检测其是否出现在合约字节码（PUSH4 常量）
- 合约识别辅助：从字节码提取 PUSH4 选择器，经 4byte.directory 反查函数名
- 所有查询均通过公共 RPC 只读完成（Elysium 官方 RPC + 各链公共端点）
