# PROGRESS — 开发进度

## 里程碑总览

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 核验与白名单（Elysium V4 部署身份） | ✅ 完成并合并（main `1c39534`） |
| **M1** | **只读看板（钱包连接/余额/头寸索引/池状态/待领费用/RPC 状态）** | **🔨 开发完成，待自检 + 推送 review** |
| M2 | 模拟器（含 PositionManager 行为级对照） | ⏳ 未开始 |
| M3 | 手动 LP 操作（组池/领费/撤池，交易开关后） | ⏳ 未开始 |
| M4 | Elysium 监测（桥接/新池/官方动态） | ⏳ 未开始 |
| M5 | 策略辅助（评分/出区间提醒） | ⏳ 未开始 |
| M6 | VPS 部署（Docker 完整方案） | ⏳ 未开始 |

## M1 交付内容（分支 m1-dashboard）

**后端（只读）**
- [x] Transfer 事件索引：从部署区块回溯 + 增量同步 + 重组窗口处理（删除重叠段重插）
- [x] 头寸链上校验：ownerOf / getPoolAndPositionInfo / getPositionLiquidity
- [x] 待领费用：feeGrowth 数学路径（extsload + StateView，全部经链上交叉验证）
- [x] 池状态：StateView（slot0 / liquidity / feeGrowthGlobals）
- [x] 价格：Surf 为主 + DexScreener 兜底（带来源/时间戳）
- [x] 采样体系：cron 每 5 分钟 + 访问节流采样 → 多窗口年化数据源
- [x] 路由：/api/positions /api/wallet /api/pool /api/prices /api/rpc /api/indexer(+sync) /api/whitelist /api/memory
- [x] 运行时写拦截器（后端 + 前端）

**前端（只读）**
- [x] 钱包连接（OKX 优先）+ 观察模式（粘贴地址）
- [x] 网络检查（非 Elysium 提示 + 一键切换，非签名）
- [x] 余额行（HYPE/KNTQ/WHYPE/USDC + USD）
- [x] 池面板（价格/tick/池龄/市场快照/风险提示；措辞「已观察到链上活动」）
- [x] 头寸卡片（本金/待领收益/收益速度/多窗口年化/区间状态/采样信息；领费撤池按钮禁用并注明 M3）
- [x] 排序（本金/收益/年化/tokenId）+ 隐藏已撤空仓 + 手动刷新
- [x] 索引进度提示（自动继续同步）
- [x] 核验与设置（白名单读写权限表）+ 项目记忆（三份文档）

**收尾状态**
- [x] 生产构建通过（prod ok）+ 全部路由冒烟测试 + 边界测试（空地址 / 非法地址 / 已撤空仓）
- [x] 已推送分支 m1-dashboard，等待用户 review

## 下一步（M2 预览）

- 模拟器：建仓/撤池模拟、价格与交易量情景、无常损失、Break-even、退出滑点
- **PositionManager 行为级对照**（关闭 M0 遗留项：体积差异的等价性验证）
