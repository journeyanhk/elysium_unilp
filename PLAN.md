# 「KNTQ/HYPE LP 管理器」技术方案与开发计划（v0.4.1）

> 状态：v0.5.2 · M0 已合并 · M1 已合并 · **M2 已通过 review 并合并（合并提交 `dc4541c`）** · **M3 规划已提交（写操作全关）**
> 更新日期：2026-11-10
> 协作：每阶段一个 PR（review 通过再进下一阶段）；提交署名 xnananx；仓库公开（不含任何密钥）
> 关联材料：uploads/ 两份分析文档（Elysium 可行性评估、目标是赚手续费应该如何选）
> 维护约定：讨论结论先更新本文档；动工后另建 MEMORY.md / PROGRESS.md / MAINTENANCE.md

## 0. 先说结论（关键更新）

**上一版「Elysium 上没有可交互的 Uniswap 池子」的结论已过时。** 新一轮链上核验发现：

- Elysium 上已有一个**活跃的 Uniswap V4 风格部署**（DexScreener 标注 `uniswap` + `v4`）：
  - PoolManager（候选）`0xe2e105d3f7209a9da11f83ccf3e7398a753823f1`，2026-11-03 部署，近 13 分钟内 340+ 个池子有交易；
  - 头寸管理器（PositionManager）`0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518`（其 poolManager() 绑定上述 PM；组池/领费/撤池都经它）；
  - **KNTQ/HYPE 池 2026-11-09 08:49（UTC）创建**：池 ID `0xc96bfd21…83ac` = 原生 HYPE / KNTQ / 1% 费率 / tickSpacing 200 / 无 hook；核验时流动性约 $18–27 万（早期波动大），24h 成交量约 $145 万。
- 链上还有多个其它 v4 风格部署（至少 5 个 PoolManager，含一个疑似 launchpad 自建的）→ 白名单机制必须严格执行。
- 身份存疑（M0 已核验，详见 docs/M0-VERIFICATION.md）：
  - 支持证据：PoolManager 与官方构建**逐字节一致**；PositionManager 接口面与官方一致（实现等价性待 M2）；DexScreener / GeckoTerminal 均标注为 Uniswap V4 风格；
  - 存疑证据：Uniswap 官方部署文档未列 Elysium；Elysium 官方文档仍写「Announced」；部署者为普通 EOA。
  - **处理原则：核验通过前，不叫「官方 Uniswap」，交易功能不开启（只读 + 模拟先行）。**

→ 策略已定：**Elysium 优先（直接对真实 KNTQ/HYPE 池开发），Arbitrum 降级为可选备用验证链（用户已确认）。**

## 1. 落地策略（已确认）

- **主目标：Elysium 上的 KNTQ/HYPE V4 池**（真实存在，已核验池参数与活跃度）。
- **备用：Arbitrum**（V2/V3 均真实存在，已核验）——仅在「想先在成熟链练手工具」时使用，非必须。
- **Elysium 观察线保留**：桥接、资产核验、RPC 健康、新池监测（含 AMM 身份核验）。
- 用户已确认：**Elysium 优先；身份核验通过前只读 + 模拟，不开交易。**
- 明确不采纳：在 Elysium 自建 AMM；为「吃手续费」大额建池；任何自动策略。

## 2. 目标与边界

命名：合约身份核验前不叫「官方 Uniswap」，暂用「KNTQ/HYPE LP 管理器」。

**做（V1）：**
- 浏览器钱包连接（**OKX 钱包优先**）、余额查询；KNTQ/HYPE 及白名单资产核验；
- LP 持仓看板（三列动态卡片）：本金 / 待领收益 / 多窗口年化 / 美元价值；
- 组池、提取手续费、撤池（手动逐笔签名）；
- 排序、行情过期提示、RPC 故障切换、隐藏已撤空仓；
- 建仓前质量检查（池龄、交易量稳定性、样本充足度）；
- 模拟器（先模拟后真钱）；
- 每笔交易：预览确认 + 签名前模拟；
- 跨 AI 长期记忆、开发进度、维护日志。

**不做（V1）：**
- 自动复投 / 自动再平衡 / 自动换币补仓；
- 自动放宽滑点、自动重发或提速交易；
- 托管私钥、任意地址交互（只允许白名单）；
- 「每秒收益」类宣传口径；
- 「确认预算后自动建仓」不做成不可见连续签名流程。

## 3. 协作与交付流程

- 远端仓库：`github.com/journeyanhk/elysium_unilp`。仓库可见性：**公开**（用户决定）；**任何情况下不提交密钥/令牌**（.env 已在 .gitignore 排除）。
- 每完成一个阶段：提交代码 → 推送 → 开 Pull Request → 你 review → 通过后合并 → 进入下一阶段。
- 提交署名：**xnananx**（用户指定）。
- 交付目标环境：你的 **VPS** —— M6 提供**完整部署方案**（Docker 化 + 一键部署 + 文档）；钱包与签名全部在浏览器完成，**VPS 不接触私钥**。

## 4. 总体架构

- **前端（浏览器）**：钱包连接（OKX 优先，兼容主流浏览器钱包自动识别）、交易构建/模拟/签名、全部界面。
- **后端（数据服务）**：RPC 端点管理（当前 1 个已核验端点；故障切换框架预留，备用端点需通过准入校验后启用）、数据聚合与缓存、定时采样（年化/收益速度的时间序列）、**头寸事件索引（Transfer 事件，M1）**、白名单、记忆/进度/日志存储。
- **数据库**：持仓快照、池子采样、交易记录、**头寸索引（wallet → tokenId）**、白名单、记忆/进度/日志、设置。
- **数据源**：链上事件（费用/年化权威数据）；DexScreener / GeckoTerminal（池子质量元数据）；Surf 市场数据（美元价格）；公共 RPC 端点。
- **数据流**：钱包地址 → 后端聚合（多 RPC）→ 卡片数据（每条带更新时间）；交易：构建 → 模拟 → 预览 → 钱包逐笔签名 → 状态跟踪。
- **部署形态**：Docker 部署到 VPS；钱包连接与签名全部在浏览器完成，VPS 只负责页面与数据服务。

## 5. 数据与计算规范（按你的修改意见更新）

- **本金**：建仓时快照（时间、数量、价格、交易哈希），不用「当前美元余额」反推。
- **待领收益**：链上采样计算（V4：经 PositionManager 头寸计算），显示两种资产数量与美元价值。
- **年化**：1h / 24h / 7d / 30d 多窗口；样本不足不显示 APY；始终标注统计窗口与更新时间；同时提示池龄与样本质量。
- **「秒级估算」→「收益速度」**（已确认）：只显示基于窗口的估算值（如 ≈$/天），不做「每秒收益」幻觉；页面可实时刷新，但数字按链上采样更新。
- **美元价值**：Surf 市场数据 + 时间戳；**外部数据一律标注来源与快照时间**。
- **行情过期**：每条数据带 updated_at；超过阈值（默认 30 秒）卡片变灰、禁用签名入口。
- **RPC 端点管理**：当前仅 1 个已核验端点（官方公共 RPC）；**故障切换框架预留，接入备用端点后才启用 failover**。备用端点准入需通过：chainId 校验、高度对比、延迟、关键地址 getCode 一致性、连续失败阈值、落后阈值；UI 始终显示当前活跃端点。暂不接个人 Alchemy key，后续可加。

## 6. 交易安全规范（红线）

- **白名单**：只允许已核验合约（链、PoolManager、PositionManager、Router、代币、池）；**读写分离（readEnabled / writeEnabled），M1/M2 全部 writeEnabled=false**；每个地址展示来源、验证状态、首次发现与最后更新时间。
- **每笔交易**：预览（数量 / 最小到账 / 价格影响 / gas / 合约地址 / 滑点值）→ 模拟（失败则禁止签名）→ 钱包逐笔签名。
- **预算流程**：确认预算 → 自动计算两侧数量与区间 → 生成交易计划 → 模拟 → 用户逐笔签名。不做连续自动签名，不做不可见组合流程。
- **滑点**：用户主动选择（0.1% / 0.5% / 1% / 自定义），绝不自动调整。
- **失败处理**：显示具体原因；不自动重发、不自动提速。
- **建仓前质量检查**：池龄、交易量稳定性（7d 不能只靠单日尖峰）、Top LP 集中度、退出滑点、合约验证状态等；**池龄 < 7 天 = 硬性红色警告（默认阻止一键继续，需二次确认）**；首日数据不作为稳定性依据。
- **隐藏已撤空仓**；默认按价值排序，可切换年化 / 待领收益。

## 7. 页面结构

1. **持仓看板**：三列动态卡片（本金 / 待领收益 / 多窗口年化+收益速度 / 美元价值 / 区间状态 / 池子信息 / 快捷操作）。
2. **建仓向导**：选池 → 预算 → 区间（默认全区间/超宽）→ 预览 → 模拟 → 逐笔签名。
3. **仓位详情**：提取手续费、撤池、交易历史、原始数据（哈希/事件/模拟结果）。
4. **模拟器**：建仓/撤池模拟、价格情景、交易量情景、无常损失、Break-even、退出滑点。
5. **池子筛选与评分**：流动性质量 / 交易量稳定性 / 手续费稳定性 / 退出难度 / 合约风险。
6. **核验与设置**：白名单地址（来源/验证状态/读写权限）、RPC 状态、滑点默认值。
7. **项目记忆**：记忆条目 / 进度里程碑 / 维护日志。
8. **跨链监测**：Elysium 桥接状态、资产核验、新池上线提醒。

设计约定：深色终端风格；绿色只代表交易成功、不代表盈利；红色标注风险；金额同时显示代币数量与美元估值；每个指标显示更新时间。

## 8. 跨 AI 记忆 / 进度 / 维护日志

- 仓库文件（任何 AI 会话接手先读）：`MEMORY.md`（决策/约束/已核验地址）、`PROGRESS.md`（里程碑状态）、`MAINTENANCE.md`（维护日志）。
- 项目规则（CLAUDE.md）顶部写明「先读以上三份文件」。
- 工具内「项目记忆」页：从数据库读取展示，可手动追加。
- 每完成一个阶段：更新三份文件 + 推送 GitHub。

## 9. 里程碑（合并你的开发顺序）

- **M0 核验与白名单**（✅ 已合并 main `1c39534`）：核验 Elysium V4 部署身份；产出核验报告 + 白名单（读写分离）。结论：PoolManager 逐字节一致；PositionManager 接口面一致（M2 已完成行为级对照，见下）；官方归属未确认。
- **M1 只读看板**（✅ 已合并 main `d135736`，review 通过）：钱包连接 → 网络检查 → 余额读取 → **头寸枚举（PositionManager Transfer 事件索引，不依赖 tokenOfOwnerByIndex）** → 池状态读取 → 待领手续费读取 → RPC 健康状态 → 只读卡片（本金/待领收益/年化/美元）、排序、过期提示、隐藏空仓。**M1 全程禁止写操作**（已通过前后端运行时拦截器保证）。
- **M2 模拟器**（🔨 开发完成，待 review）：建仓模拟（区间/金额/价格影响/预计 NFT/gas/授权与余额预检）、撤池模拟（收到数量/待领手续费/退出滑点/交易后余额/撤空状态）、无常损失 + HODL 对照（**基于建仓台账的净投入数量**）、Break-even（手续费/gas/桥接成本/所需交易量）、价格情景表；**PositionManager 行为级对照**（37/37 选择器一致、只读行为与错误语义一致、permit2 不变量一致；内部实现等价性仍无法只读证明）。**M2 全程只模拟、不签名、不发交易。**
  - 新增工程能力：本地 V4 数学（大整数真值校验）、本地兑换估算（跨 tick 走位）、ModifyLiquidity 台账索引、历史价格还原（归档 eth_call + 缓存）、RPC 限流退避与多端点能力路由、索引并发互斥、候选头寸截断提示。
- **M3 手动 LP 操作**：组池、撤池、领取手续费；预览 + 模拟 + 逐笔签名；白名单限制（writeEnabled 按合约逐个开启）；失败原因展示。
- **M4 Elysium 监测**：桥接状态（独立核验 + 模拟后）、资产核验、官方 AMM 发现、新池提醒。
- **M5 条件式策略辅助**：池子评分、风险评分、出区间提醒（不自动调仓）。
- **M6 部署与交付**：完整部署方案（Docker 化一键部署 + VPS 部署文档 + 上线检查清单：域名/HTTPS/环境变量/RPC 端点）。
- 记忆/进度/日志体系随 M1 一起建立。

## 10. 核验记录（2026-11-09 · 只读查询）

**Elysium 主网（chainId 99901，RPC rpc.elysium.kinetiq.xyz，gas ≈0.1 gwei）：**
- Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11` ✅；Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` ✅
- 桥路由 `0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17` ✅（核验范围仅地址与只读查询）
- KNTQ 映射版 `0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0`（KNTQ / 18 位）✅
- WHYPE 映射版 `0xbA876237B0F021A6c6D852d6c26E107997cC5E81`（WHYPE / 18 位）✅
- USDC 映射版 `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65`（USDC / 6 位）✅
- Uniswap 标准地址（V2/V3/V4 各 canonical）：全部为空（部署在其它地址）❌

**Elysium V4 部署（候选，身份核验详见 docs/M0-VERIFICATION.md 修订 R1）：**
- PoolManager 候选 `0xe2e105d3f7209a9da11f83ccf3e7398a753823f1`（24009B；与官方构建逐字节一致；2026-11-03 部署）
- PositionManager 候选 `0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518`（19965B；**M2 只读 Probe 对照：以官方 ABI 为权威集合（39 个函数），Elysium/ETH/Base 三者选择器集合完全一致（0 差异），same-value / same-shape / chain-specific 共 10 项探测全部通过；内部实现等价性与写路径行为仍未证明**）
- KNTQ/HYPE 池（2026-11-09 08:49 UTC 创建）：完整 PoolKey 与数据快照见报告 §3.5
- 其它 v4 风格部署（至少 4 个活跃，不同部署者）：全部排除
- 部署批次（17 个合约）与创建交易哈希：见报告 §3.1 / §3.4

**Elysium 测试网（99801）：** WHYPE/USDC/Multicall3/桥合约均在 ✅；主网 V4 候选地址在测试网未见 ❌

**HyperEVM（999）：** KNTQ `0x000000000000780555bD0BCA3791f89f9542c2d6` ✅、WHYPE `0x5555…5555` ✅；标准 Uniswap 地址被第三方占位合约占据，非 Uniswap ❌

**对照链：** Arbitrum（V3 工厂 24535B + USDC/WETH 池 ✅；V2 工厂 ✅）；Base（V3 工厂 0x33128a8f… ✅）；以太坊主网（V3 ✅）。KNTQ 不存在于 Arbitrum/Base/ETH（其它链同名代币未核验，疑似仿盘）。

**价格（Surf）：** HYPE ≈ $84、KNTQ ≈ $0.29（另：池内 KNTQ 报价 ≈ $0.40，2026-11-09 13:06 UTC）。

## 11. 已确认决策与剩余问题

**已确认（2026-11-09）：**
1. 落地链：**Elysium 优先** ✅（Arbitrum 留作可选备用）
2. 身份核验通过前：**只读 + 模拟，不开交易** ✅
3. 「秒级估算」→「收益速度（基于窗口估算）」 ✅
4. GitHub：`journeyanhk/elysium_unilp`；**每阶段一个 PR，review 通过再进下一阶段** ✅
5. 运行形态：**VPS 部署** ✅（M6 提供完整部署方案）
6. RPC：**先不接个人 key**，用公共端点（当前 1 个已核验端点）✅
7. 提交署名：**xnananx** ✅；仓库保持**公开** ✅；钱包优先 **OKX** ✅
8. M0 review 通过后：**白名单读写分离、PoolKey 补全、措辞降级** 等 R1 修订已落实 ✅

**剩余小项：**
- M0 修订 R1 已推送（分支 `m0-verification`），待确认合并后进入 M1；
- 钱包支持：OKX 优先，同时兼容主流浏览器钱包自动识别；手机端（WalletConnect）如需再加；
- 资金测试节奏：池子刚创建，「>7 天」门槛暂不满足；建议先小额 + 模拟器。

## 12. 变更记录

- v0.1（2026-11-09）：首版讨论稿；完成第一轮链上核验。
- v0.2（2026-11-09）：采纳用户分析修改意见（多窗口年化、不做每秒幻觉、模拟器先于真钱、池子评分与建仓门槛、桥接前置但受限、不做自动策略）；新增 GitHub 协作流程；重大核验更新；落地策略建议改为 Elysium 优先。
- v0.3（2026-11-09）：锁定决策；接入远端仓库；新增 M6 部署与交付；首次推送。
- v0.3.1（2026-11-09）：署名 xnananx；钱包 OKX 优先；VPS 完整部署方案；仓库保持公开；M0 启动。
- v0.3.2（2026-11-09）：M0 修订 R1（依 review）：白名单读写分离（全部 writeEnabled=false）；PoolKey 补全（currency0/currency1/fee/tickSpacing/hooks + 排序规则）；PositionManager 结论降级为「接口面一致、实现等价性待 M2」；目标池状态改为 verified-parameters；BridgeRouter 降级为 verified-address 并限定核验范围；RPC 端点表述修正（failover 未启用 + 准入条件）；M1 头寸枚举改用 Transfer 事件索引；池龄 < 7 天列为硬性警告。
- v0.5.2（2026-11-10）：**M3.1 修订（回应 review 3 个 P0）**。P0-1 `buildIntent` 的 chainId 强制绑定 `CHAIN.id`（未传用白名单链、不匹配直接拒绝、源码无硬编码）；P0-2 `/simulate` 强制绑定 intent 用户（不一致返回 403，审计记录 `intentUser`/`simulationFrom`）；P0-3 重写 `precheck()`：mint 覆盖两种货币余额 + ERC-20→Permit2 + Permit2→PositionManager 两级授权（原生币走余额），remove/collect 覆盖 `ownerOf`/`getPositionLiquidity`/`getPoolAndPositionInfo`，失败按 7 类明确分类（不再靠回滚字符串推断），并记录预检区块号与 block hash。测试 104 → **121**。写操作仍全关；M3.2 开关评审待 review；M3.3 首笔实盘未批准（推荐首笔本金 5–10 USD，绝对上限 20 USD）。
- v0.5.1（2026-11-10）：**M3.1 只读预演管线交付**（M3.0 review 的 8 项验收条件全部落实）。新增：`lib/tx-parse.js`（modifyLiquidities action 级解析 + approve/Permit2 参数级白名单）、`lib/tx-rpc-guard.js`（只读 RPC 护栏，禁止 send/sign/wallet 方法，请求前拒绝）、`lib/tx-build.js`（build-only 构造，编码与 M2 模拟器逐字节一致）、`lib/tx-simulate.js`（eth_call + gas + 预检，全部走护栏）、`lib/tx-gate-state.js`（熔断与计数持久化，Postgres，`clear` 强制人工复核记录）、门禁 `M3-gate-2`（纯函数 `evaluateTxRequest` + 真实 `assertTxAllowed` 强制 Gas 成本/日额度/频率/deadline）、路由 `GET /api/tx/gate`、`POST /api/tx/{preview,build,simulate}` 与恒拒绝的 `/broadcast`、审计表 `tx_intents`/`tx_simulations`/`tx_audit`/`tx_gate_attempts`/`gate_kill_switch`。测试 62 → **104**。实测：build 产出 `MINT_POSITION+SETTLE_PAIR`，simulate 在区块 3885286 真实 `eth_call`（因测试钱包未授权而回滚，符合预期）。**写操作仍全部关闭**。
- v0.5.0（2026-11-10）：**M2 通过最终 review 并合并入 main**（合并提交 `dc4541c`；fixture provenance 闭环：`meta.generatorCommit === stats.generatorCommit`、逐文件 codeHashes 门禁、gzip 一致性、reference 隔离）。**M3 规划提交**：新增 `docs/M3-PLAN.md`（阶段划分 M3.0 规划与门禁 → M3.1 只读预演管线 → M3.2 开关评审 → M3.3 首笔小额 → M3.4 常规手动操作；交易流程 8 步；代码改动清单；测试计划；安全不变量；风险与回滚）与 `docs/M3-TX-SAFETY-GATE.md`（三重关闭 + 双重门禁、解锁条件 A/B、首笔小额 20 USD、硬上限、允许合约/函数白名单、熔断、审计、开启前检查清单、一键全关）；门禁代码化 `backend/config/tx-gate.js` + 10 条门禁测试（总开关关闭、全部 writeEnabled=false、PM 保持 pending-official、运行时拦截器抛错、允许清单无多余入口、上限保守区间、前端拦截器关闭）。**M3 写操作保持全关**，未获下一轮 review 不得开启。
- v0.4.3（2026-11-10）：M2 三次修订（回应 review：fixture provenance）。上一轮 fixture 由旧提交的代码生成（生成器与参考实现在后续提交中改动过），且测试只断言 `generatorCommit !== undefined`。本次：**用当前代码快照重新生成全部 fixture**（JSON + gzip + meta）；元数据新增 `generatorCommitDirty`、**逐文件 `codeHashes`**（生成器 + 独立参考实现共 6 个文件）、`validationCounts`；测试新增三条断言：`meta.generatorCommit === stats.generatorCommit` 且生成时工作树干净、`meta.codeHashes` 与当前工作树逐文件一致（**改动生成器/参考实现而未重新生成即失败**）、reference 不得反向依赖生产实现；`mismatchCount` 更名为 `excludedCount` 以免误读。重新生成结果：**3000/3000 逐位一致**（calldata 18 / 排他性检验 2982；跨 tick 123、多步 123；feePaid 链上反推 48 条 48/48 一致；生成提交 `3acf1d1`，生成时工作树干净）；测试 49 → **52**。完整 4.8 MB fixture 保留（gzip 约 454 KB），CI 默认离线使用。
- v0.4.2（2026-11-10）：M2 二次修订（回应 review：参考向量自证循环）。**向量生成器重写**：模式（exact-in/exact-out）只能来自 ① calldata 完整解码（Universal Router `execute`+`V4_SWAP`，多布局变体）或 ② **排他性假设检验**（两种模式必须恰有一种能复现链上全部可观测值，歧义样本一律排除），**不再用生产实现猜模式**；新增**与生产完全分离的独立参考实现** `backend/reference/v4/`（官方 v4-core 源码移植：TickMath 位分解 / SqrtPriceMath / SwapMath / Pool.swap 循环 / 路由解码器），用于模式判定与 feePaid 推导，生成时运行时断言未加载 `lib/v4math.js`；fixture 增补 `expected.feePaid`（含链上 feeGrowthGlobal 反推的 59 条，逐位一致）、`validation.independentReference / feePaidChecked / productionCodeUsedInGeneration`、`source.modeSource`、SHA-256/gzip SHA-256/区块范围/Pool ID/生成器 commit；测试改为**逐位断言 + 强制断言独立性标记**，不再依赖 `mismatchCount`；新增 `tests/v4math.reference.test.js` 做**生产 vs 独立参考实现**全量交叉验证。结果：**3000/3000 逐位一致**（跨 tick 124、多步 124、calldata 解码 17），排除统计透明列出；测试总数 41 → **49**。文档口径：仅声明「本地 Swap 数学与链上事件逐位一致」，不声称「与官方实现行为完全等价」。
- v0.4.1（2026-11-10）：M2 依 review 修订。**P0-1** `analysis.js` 的 `CHAIN.ID` → `CHAIN.id` 并加显式校验（禁止把参数错误当成采样不足）；**P0-2** PM 对照脚本重写：权威选择器集合改用官方已部署合约 ABI（Sourcify），Probe 解码后按 same-value / same-shape / chain-specific 三类逐项断言；**P0-3** Swap 数学按官方 `SwapMath`/`SqrtPriceMath` 逐行重写（两步取整、逐步手续费、价格限制、exact-out、tick 更新规则），并用链上真实 Swap 事件做参考向量：3000/3000 逐位一致（含 124 笔跨 tick；模式来源：calldata 17 / 排他性假设检验 2983）；**P0-4** 新增自动化回归测试（`bun run test`，含向量离线重放）。口径修正：`lpVsHodlExcludingCurrentFeesUsd`（近似 IL）/`requiredVolumeApproxUsd`（静态近似）/`projectedBalanceAfterRemove`（不含 Gas），文档统一为「本地 V4 数学估算，非官方 Quoter」「只读 Probe 对照完成，写路径未验证」。
- v0.4.0（2026-11-10）：M1 已合并；M2 模拟器完成（建仓/撤池模拟、无常损失 + HODL 对照、Break-even、退出滑点、价格情景；PositionManager 行为级对照）。工程更新：**区块速度实测 0.1s/块**（高度阈值改为时间口径、重组窗口放大到 3000 块）；**新增第二 RPC 端点 drpc（通过准入检查，日志查询仅走主端点）**；**RPC 限流退避 + 请求合并（Multicall3）**；V4Quoter 因选择器与官方不符被排除（报价改用本地数学）；ModifyLiquidity 台账（salt=tokenId 已链上验证）+ 历史价格还原；索引并发互斥；候选头寸截断提示。
