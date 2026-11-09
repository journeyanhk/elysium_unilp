# M0 核验报告 — Elysium「Uniswap V4」部署身份核验（修订 R1）

- 日期：2026-11-09（全部为只读链上查询，未发起任何交易）
- **修订 R1**：依 review 意见调整结论强度与安全语义（见文末修订记录）
- 范围：Elysium 主网（chainId 99901）上标注为 Uniswap 的 V4 部署、其配套合约、目标池
- 方法：RPC 只读查询（getCode / getLogs / eth_call）、创建交易回溯（二进制搜索定位创建区块 + CREATE2 复算）、字节码比对（对照官方 ETH/Base/Unichain/Arbitrum/Optimism/Polygon/Zora 部署）、函数选择器比对、聚合器与官方文档交叉核对
- 一句话结论：**链上技术核验通过（PoolManager 与官方构建逐字节一致）；PositionManager 仅完成「外部接口面」比对，实现等价性待 M2 行为级验证；「官方归属」无官方渠道证据 → 保持「待官方确认」，交易功能关闭，仅只读使用。**

## 1. 核验对象

| 对象 | 地址 | 状态 |
|---|---|---|
| PoolManager | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` | pending-official（只读） |
| PositionManager | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | pending-official（只读） |
| 目标池（原生 HYPE/KNTQ，1% 费率） | `0xc96bfd21…83ac` | verified-parameters（只读） |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | verified（只读） |
| 代币：KNTQ / WHYPE / USDC | `0xe45a355d…acF0` / `0xbA876237…5E81` / `0xb47c4C8F…0B65` | verified（只读） |
| 桥路由 | `0x61EbbC3A…4d17` | verified-address（仅地址与只读查询） |

> 权限语义：白名单中全部地址当前 `writeEnabled = false`（读写分离，见 `backend/config/whitelist.js`）。

## 2. 关键结论

1. **PoolManager `0xe2e105d3…`：与官方部署的字节码逐字节一致。** 唯一差异是合约自地址常量（20 字节）——官方各链之间也是完全相同的差异模式；编译器同为 solc 0.8.26，体积同为 24009B。可判定为「官方级」构建。
2. **PositionManager `0x1d1c51b9…`（修订 R1 措辞）**：外部函数选择器面 21/21 与官方参考版本一致，关键只读绑定关系一致（`poolManager()` → 候选 PM、`permit2()` → 官方 Permit2、`nextTokenId()` 有数据）。但 **runtime 体积存在约 16% 差异（19965B vs 官方 23877B），内部实现等价性尚未验证**——包括 `modifyLiquidities` 编码行为、unlock 回调逻辑、权限与边界条件等。当前仅作为**只读组件**用于索引与读取；真实写操作保持关闭，待 M2 完成行为级模拟与事件级对照后再评估。
3. **部署路径正规**：PoolManager 与 PositionManager 均由同一 EOA（`0x2179a608…`）于 2026-11-03 04:09（UTC）通过**标准确定性部署器**（Arachnid `0x4e59b448…956C`，零盐）部署，CREATE2 复算地址与实际完全一致；同一批次共部署 17 个合约（见 §3.4）。
4. **目标池真实且活跃**：完整 PoolKey 见 §3.5（池 ID 数学验证通过）。
5. **聚合器均标注为 Uniswap V4 风格**（DexScreener `uniswap` + `v4`；GeckoTerminal `uniswap-v4-elysium`）——**该识别不等同于 Uniswap Labs 官方确认**。
6. **官方渠道未确认**：Uniswap 官方部署文档未列 Elysium；Elysium 官方文档仍写「Uniswap: Announced for Elysium」；Uniswap interface 仓库未查到 Elysium 配置。→ 官方归属**未确认**（不排除「已部署、待官宣」）。
7. **同链存在其他 v4 风格部署（至少 4 个，部署者各不相同）** → 白名单必须只认本报告核验的地址（排除清单见 §3.8）。

## 3. 证据明细

### 3.1 部署路径

- 部署者 EOA：`0x2179a60856e37dfeaaca0ab043b931fe224b27b6`（部署批次内 nonce 12→28；当前 nonce 38）
- 部署代理：`0x4e59b44847b379578588920cA78FbF26c0B4956C`（全链通用确定性部署器），**salt = 0x00…00**
- PoolManager 部署交易：`0x30fc8b36b478ee039fb591df369300815bc28bbf46187de8987ca0ddf5b1b08e`（区块 256083；CREATE2 复算 = 实际地址 ✓）
- PositionManager 部署交易：`0x25c7ae7b9304cc388afef33bdfc236de2c94248fb6ac8e980214b5acd4559b5d`（区块 256086 ✓）
- PoolManager `owner()` = `0xa9ae0c5eb238a519b7f5af27415eb6dd0744da8d`（合约，7310B；非标准 TimelockController，类型待确认）
- 测试网：主网 V4 候选地址在测试网不存在（该栈目前仅主网）

### 3.2 PoolManager 字节码比对（对照官方 ETH / Base）

- 体积：24009B = 24009B = 24009B（三方一致）；solc：0.8.26（三方一致）
- 剥离元数据后差异：**恰好 20 字节（偏移 13618–13637），差异内容 = 合约自身地址**；ETH 与 Base 官方部署之间也存在同样位置、同样长度的 20 字节差异
- → 判定：与官方构建**同源同编译参数**；可视为「官方级」字节码

### 3.3 PositionManager 比对（对照官方 ETH / Base / Unichain / Arbitrum / Optimism / Polygon / Zora）

- 体积：Elysium **19965B** vs 官方（各链一致）**23877B**；solc 均 0.8.26
- 功能面比对（21 项选择器，全部一致）：modifyLiquidities / modifyLiquiditiesWithoutUnlock / initializePool / getPoolAndPositionInfo / positionInfo / multicall / approve / setApprovalForAll / ownerOf / balanceOf / transferFrom / safeTransferFrom / DOMAIN_SEPARATOR / nextTokenId / poolManager / permit2 / tokenDescriptor / subscribe / unsubscribe（双方均无 `permit(...)` 与 `owner()`）
- **ERC721 Enumerable 检查（新增）**：`tokenOfOwnerByIndex` / `tokenByIndex` / `totalSupply` 在 Elysium 版本与官方版本中**均不存在**（v4 PositionManager 的非 Enumerable 设计，双方一致）→ 头寸枚举必须依赖 `Transfer` 事件（M1 决策见 §8）
- 链上状态：`nextTokenId()` = 1216；`permit2()` = 官方 Permit2 地址 ✓
- → 结论（降级）：**选择器面一致仅能说明外部接口相似，不能证明内部实现等价**（含权限逻辑、unlock 回调、边界条件等）。当前仅用于只读；等价性验证推迟到 M2。

### 3.4 配套合约清单（2026-11-03 部署批次，共 17 个）

| 区块 | 地址 | 体积 | 识别 |
|---|---|---|---|
| 256083 | `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1` | 24009B | **PoolManager**（核心） |
| 256084 | `0x599141dbd536891ef30b81883bfb4a621dc3f496` | 24069B | **PositionDescriptor** |
| 256086 | `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518` | 19965B | **PositionManager**（核心） |
| 256087 | `0x379f556c5a748bd7cc9baf0f7a344094ac1814f5` | 6118B | **V4Quoter** |
| 256088 | `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe` | 3531B | **StateView**（与官方同尺寸） |
| 256094 | `0x1bd4d69bfb8927a045f20518a08390cee3913b0d` | 23233B | **UniversalRouter 候选**（不启用） |
| 256080–82 / 85 / 89–93 / 95–96 | 11 个地址（详见白名单 `UNIDENTIFIED_STACK`） | 752B–24497B | 未识别（不启用，不影响核心功能） |

### 3.5 目标池（完整 PoolKey）

| 字段 | 值 |
|---|---|
| currency0 | `0x0000000000000000000000000000000000000000`（原生 HYPE；V4 以零地址表示原生资产） |
| currency1 | `0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0`（KNTQ） |
| fee | 10000（1%） |
| tickSpacing | 200 |
| hooks | `0x0000000000000000000000000000000000000000` |
| poolId | `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac` |

- 排序规则：**currency0 < currency1（地址升序）**；零地址最小 → 原生资产固定在 currency0。后续所有 slot0 / 流动性 / 头寸查询必须使用完全一致的 PoolKey。
- 池 ID 数学验证：keccak256(abi.encode(PoolKey)) = 实际 poolId ✓
- 数据快照：**2026-11-09 13:06 UTC**；来源：DexScreener（dexId: `uniswap`，labels: `v4`）
  - 流动性：≈ $181,204
  - 24h 成交量：≈ $1,445,324
  - 池内 KNTQ 报价：≈ $0.40
- 池创建时间：**2026-11-09 08:49:39 UTC**（快照时池龄 ≈ 4.3 小时）
- ⚠️ 早期数据提示：两次快照之间流动性从约 $27 万降至约 $18 万，波动明显；首日成交量受套利、机器人、初始流动性与投机影响，**不能作为稳定性依据**（M1 质量门槛：池龄 < 7 天 = 硬性红色警告）。

### 3.6 外部标注（修订 R1）

- DexScreener：`dexId: uniswap`，`labels: ["v4"]`（主池）
- GeckoTerminal：dex 标识 `uniswap-v4-elysium`（多档费率池均在列）
- **该识别不等同于 Uniswap Labs 官方确认**——聚合器标记仅说明「被识别为 Uniswap V4 风格部署」。

### 3.7 官方渠道核对

- Uniswap 官方部署文档（developers.uniswap.org）：**未列 Elysium**
- Elysium 官方文档（elysium.kinetiq.xyz）：Uniswap 仍标注「Announced for Elysium」
- Uniswap interface 仓库 chains 配置：未查到 Elysium
- Uniswap v4-deployments 仓库：不可访问（404）
- → **官方归属：未确认**

### 3.8 其他 v4 风格部署（白名单排除）

| 地址 | 说明 |
|---|---|
| `0x5fb015a49f5b35073f9ce01c2adb287a75f89600` | v4 风格（另一部署者，2026-10-23） |
| `0x1f9b957071228a3190280e062cc62a3f66b6a13a` | 上述部署的配套 PositionManager |
| `0x06c63714fbf1f5753017123e2fcfdede4540b2c4` | v4 风格（另一部署者，2026-10-25） |
| `0x5c54a7293d96b11a29a0256ee8dfdbc3059637da` | v4 风格（另一部署者，2026-10-30） |
| `0x794ad5fe8227524619c7bbf6b4572c9d08d9ff1f` | 17KB 定制构建（另一部署者，2026-11-04） |

### 3.9 桥路由核验范围（新增）

`0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17` 当前验证范围**仅包括**：

- 地址存在；与目标链/源链的关系；只读状态查询。

**未验证**（不得据此发起任何写操作）：

- 桥接写路径与参数编码；HYPE 原生资产与 KNTQ ERC-20 是否走同一路径；可调用 token 范围；限额、费率与权限。
- M1 不调用桥接写方法；**桥接写操作不早于独立的桥接核验 + 模拟阶段**。

## 4. 结论与状态

- **链上技术核验：通过**（PoolManager 逐字节级；PositionManager 接口面级）
- **官方归属：未确认** → 合约统一标记 `pending-official`
- **处理（按已确认约定）**：不称「官方 Uniswap」；**交易功能保持关闭**；只读看板 + 模拟器继续开发

## 5. 白名单摘要（修订 R1）

已写入 `backend/config/whitelist.js`：

- 权限模型：`readEnabled` / `writeEnabled` 分离；**当前全部地址 `writeEnabled = false`**；
- 只读启用：PoolManager、PositionManager、PositionDescriptor、V4Quoter、StateView、Permit2、Multicall3、BridgeRouter（仅只读）、四个代币、目标池；
- UniversalRouter：`readEnabled = false`、`writeEnabled = false`（不启用）；
- 其余 v4 风格部署与未识别合约：全部排除；
- `writeEnabled` 将在 M3 交易开关通过后**按合约逐个开启**（条件见 §6）。

## 6. 交易开关（M3）条件

满足任一条件方可进入真实交易：
- (a) 官方渠道确认（Uniswap / Elysium 官宣或文档更新）；或
- (b) 用户知情接受（记录在案）＋ 首笔小额 ＋ 全部安全限制保留（预览 → 模拟 → 逐笔签名 / 白名单 / 滑点手动 / 不自动重发）。

另：M2 模拟器完成后，先跑一轮全流程 dry-run 作为行为级验证；**M1 质量门槛：池龄 < 7 天 = 硬性红色警告（默认阻止一键继续，需二次确认）**。

## 7. 遗留与监控项

1. PositionManager 实现等价性（M2 行为级对照：模拟 mint / collect / burn 并与官方行为、事件对照）；
2. PoolManager owner 合约 `0xa9ae0c5e…` 类型（非标准 Timelock，身份待确认）；
3. 官方渠道监控（Uniswap 部署文档 / Elysium 官宣更新）；
4. 目标池数据监控（早期波动大，持续采样）；
5. PositionDescriptor / V4Quoter / UniversalRouter 与官方对应合约的进一步比对（不阻塞 M1）。

## 8. M1 前提决策（新增）

- **头寸枚举采用 PositionManager `Transfer` 事件索引**：从部署区块回溯 `Transfer(address,address,uint256)`，增量同步至数据库；钱包连接后从索引取 tokenId，再链上只读校验 `ownerOf` 与 `positionInfo`。**不依赖 `tokenOfOwnerByIndex`**（该函数在 Elysium 版本与官方版本中均不存在，属 v4 PositionManager 非 Enumerable 设计）。
- **M1 允许**：读取 HYPE/KNTQ 余额、池状态、V4 头寸、流动性、tick 区间、待领取费用、美元估值、RPC 状态、数据更新时间。
- **M1 禁止**：`modifyLiquidities` / mint / burn / collect / 任意 unlock 写操作 / 代币 Approve / Permit2 授权 / 桥接写操作 / UniversalRouter 交易。

## 修订记录

- R0（2026-11-09）：首版。
- R1（2026-11-09，依 review 意见）：① 白名单取消单一 `enabled`，改为 `readEnabled/writeEnabled`（全部写=false）；② POOLS 补全 `currency0/currency1/poolKey` 与排序规则；③ PositionManager 结论降级为「selector 一致、实现等价性待 M2 验证」；④ 目标池状态改为 `verified-parameters`（拆分四个布尔字段）；⑤ BridgeRouter 降级为 `verified-address` 并补充核验范围（§3.9）；⑥ RPC 单端点表述修正（failover 未启用 + 准入条件，见白名单注释）；⑦ 池数据补充快照时间/来源/池龄与波动提示；⑧ 明确 M1 采用 Transfer 事件索引（§8）。
