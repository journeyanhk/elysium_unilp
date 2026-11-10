# MEMORY — 项目记忆（跨 AI 会话）

> 任何 AI 会话接手本项目前，先读本文档 + `PROGRESS.md` + `MAINTENANCE.md` + `PLAN.md` + `docs/M0-VERIFICATION.md`。

## 项目是什么

**「KNTQ/HYPE LP 管理器」**：Elysium 链上 KNTQ/HYPE Uniswap V4 风格池的 LP 管理工具。
- 仓库：`github.com/journeyanhk/elysium_unilp`（公开；提交署名 **xnananx**）
- 交付：VPS（Docker，M6）；钱包与签名全部在浏览器；VPS 不接触私钥
- 工作流：每阶段一个 PR → 用户 review → 合并 → 下一阶段
- 语言：与用户交流一律中文

## 安全红线（不可违反）

1. **M1/M2 全程只读**：不请求任何钱包签名（不调 personal_sign / eth_signTypedData / eth_sendTransaction / eth_sign）；网络切换（wallet_switchEthereumChain）允许（非签名）。
2. **writeEnabled 是运行时边界**：后端 `backend/lib/tx-guard.js`、前端 `frontend/src/lib/tx-guard.ts`；任何写路径必须先过拦截器。全部白名单地址当前 `writeEnabled=false`。
3. 交易开关（M3）条件：官方渠道确认，或用户知情接受 + 首笔小额 + 全部安全限制（预览→模拟→逐笔签名 / 白名单 / 滑点手动 / 不自动重发）。
4. 不自动放宽滑点；不自动重发/提速；不托管私钥；只与白名单地址交互。
5. 不称「官方 Uniswap」（官方归属未确认，状态 pending-official）。

## 链上事实（2026-11-09 核验）

- 链：Elysium chainId **99901**；RPC `https://rpc.elysium.kinetiq.xyz`（当前唯一已核验端点；failover 框架预留未启用）
- PoolManager `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1`（与官方构建逐字节一致，仅自地址常量不同）
- PositionManager `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518`（21/21 选择器与官方一致；体积 19965B vs 官方 23877B，**实现等价性未验证，待 M2**；只用于事件索引与只读）
- StateView `0x27ed73ae0652fdcf71d6793412a7525f32be9dfe`；V4Quoter `0x379f556c…`；PositionDescriptor `0x599141db…`；UniversalRouter 候选 `0x1bd4d69b…`（**不启用**）
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`；Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`
- 目标池：currency0 = 原生 HYPE（零地址）/ currency1 = KNTQ `0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0` / fee 10000 / tickSpacing 200 / hooks 零地址
  poolId `0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac`（运行时校验 keccak(PoolKey)==poolId）
- 池创建：2026-11-09 08:49:39 UTC（block 3077585）；**池龄不足 7 天 = 硬性警告**；早期数据波动大（快照间流动性 $27万→$18万→$16.8万），不作稳定性依据
- PositionManager 部署区块 **256083**（事件索引起点）

## 关键工程结论（都经链上验证）

- **PositionManager 非 Enumerable**：无 tokenOfOwnerByIndex / tokenByIndex / totalSupply（官方版本同样没有）→ 头寸枚举用 `Transfer` 事件索引（从 256083 回溯 + 增量 + 重叠窗口 64 块删除重插防重组）。
- **存储校准（PoolManager）**：`_pools` 槽位 = 6；Pool.State 布局 slot0(+0) / fg0(+1) / fg1(+2) / liquidity(+3) / ticks(+4) / tickBitmap(+5) / positions(+6)；`positionKey = keccak256(abi.encodePacked(PM, int24 tickLower, int24 tickUpper, bytes32 tokenId))`（**带 tokenId salt**）；Position.State: liquidity(+0) / feeGrowthInside0Last(+1) / feeGrowthInside1Last(+2)。验证：extsload 流动性 == PM.getPositionLiquidity。
- **待领费用 = 纯数学读取**（无模拟）：`fees = L × (feeGrowthInside_now − feeGrowthInside_last) >> 128`；feeGrowthInside_now 由 StateView.getFeeGrowthGlobals + getTickInfo(lower/upper) + 当前 tick 计算；异常保护：差值为负（>2^255）视为异常返回 0。
- **收费模拟编码**（备用知识）：`modifyLiquidities` actions `0x01`(DECREASE_LIQUIDITY, liquidity=0) + `0x11`(TAKE_PAIR) 在官方与 Elysium PM 上均 eth_call 成功（编码已验证）。但 **Multicall3 转发会改变 msg.sender 导致授权失败**，无法用「调用前后余额差」读取金额；该 RPC 不支持 debug_traceCall（需 API key）。
- **RPC 坑**：该公共 RPC 上 **viem 的 getLogs 封装会丢失 topics 过滤**（返回全部日志）→ 必须用原始 `eth_getLogs` + 代码内二次过滤；getLogs 全量范围（256083→latest）约 1 秒可返回，分块 500k 足够。
- **viem 解码**：`getPoolAndPositionInfo` 返回数组（非命名对象）——兼容写法 `gpi.poolKey || gpi[0]`。
- PoolManager 不提供 getSlot0/getPositionLiquidity 等读取函数（该版本）→ 池状态一律走 StateView；头寸流动性走 PM.getPositionLiquidity。
- PositionInfo 打包：`200bit poolId(截断) | 24bit tickUpper | 24bit tickLower | 8bit hasSubscriber`。

## 数据与口径

- 价格：Surf `dataApi.market.price`（HYPE/KNTQ）为主，DexScreener 兜底；USDC 固定 1。一律带来源与时间戳。
- 年化：基于**采样时间序列**（position_samples / pool_samples，cron 每 5 分钟 + 访问时节流 4 分钟采样）；窗口 1h/24h/7d/30d，样本跨度 < 窗口一半则不显示（显示「—/采样中」）；不用「每秒收益」口径。
- 美元估值与本金均为「当前值估算」，非建仓快照（建仓快照在 M3 落库）。

## 架构速览

- 后端：Express（SDK createServer），路由 `backend/routes/*.js` → `/api/*`；链上读取 `backend/lib/chain.js`；索引 `lib/indexer.js`；采样 `lib/sampling.js`；价格 `lib/prices.js`；写拦截 `lib/tx-guard.js`；cron `cron.json` + `cron/sample.js`（每 5 分钟）。
- 数据库（dbQuery / Drizzle 声明于 `backend/db/schema.js`）：position_transfers、indexer_state、position_samples、pool_samples、tracked_positions。
- 前端：Vite + React 19 + react-query；`App.tsx` 组装；组件在 `src/components/`；API 用 `src/lib/api.ts` 的 `api()`；钱包只读连接 `src/lib/wallet.ts`（OKX 优先）；写拦截 `src/lib/tx-guard.ts`。
- 前端不直接访问 RPC；一切链上数据经后端。

## 当前协作状态

- M0 已合并进 main（commit `1c39534`）；M1 开发中（分支 `m1-dashboard`）。
- GitHub PR 自动创建受限（PAT 缺 Pull requests 权限）→ 用 compare 链接或请用户合并。
