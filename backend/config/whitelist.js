/**
 * Elysium 合约白名单 —— M0 核验产物（2026-11-09，修订 R1）
 * 依据：docs/M0-VERIFICATION.md（所有地址均经链上核验）
 *
 * 权限模型（修订 R1：取消单一 enabled 字段，读写分离）：
 *   readEnabled  —— 允许只读调用（eth_call / eth_getLogs / 余额查询等）
 *   writeEnabled —— 允许发起交易（签名写操作）
 * - M0 / M1 / M2 阶段：全部地址 writeEnabled = false（M1 只读看板全程禁止写操作）；
 * - writeEnabled 仅在 M3「交易开关」通过后、按合约逐个开启（开关条件见报告 §6）；
 * - writeEnabled=false 的地址，任何调用方都不得构造签名交易。
 *
 * status 语义：
 *   verified            —— 链上行为与公开实现一致（基础设施类）
 *   verified-address    —— 仅核验了地址存在与只读查询（如桥路由）
 *   verified-parameters —— 仅参数核验（如池）
 *   pending-official    —— 链上核验通过，但「官方归属」尚待官方渠道确认
 */

const CHAIN = {
  id: 99901,
  name: 'Elysium',
  nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  rpcEndpoints: [
    { url: 'https://rpc.elysium.kinetiq.xyz', source: 'official-public', enabled: true, priority: 1, supportsLogs: true },
    { url: 'https://elysium.drpc.org', source: 'drpc-public', enabled: true, priority: 2, supportsLogs: false },
  ],
  // 端点准入检查（2026-11-10 实测，全部通过才启用）：
  //   1) eth_chainId === 99901；
  //   2) 区块高度偏差（按时间衡量，本链 0.1s/块）：高度差 ≤ 500 块 且 时间差 ≤ 60s；
  //   3) 往返延迟 ≤ 1500ms；
  //   4) 关键地址（PoolManager / PositionManager / Permit2）eth_getCode 与主端点一致；
  //   5) 连续失败次数超阈值自动降权（见 lib/chain.js health 记录）；
  //   6) 数据落后超阈值自动剔除；
  //   7) UI 始终显示当前活跃端点。
  // 实测记录（drpc）：chainId ✓、高度差 0 块 ✓、延迟 49ms（主端点 118ms）✓、
  //   三合约 getCode 哈希一致 ✓；但 eth_getLogs 不可用（大范围返回空/400）→ supportsLogs=false，
  //   日志查询固定走主端点（能力路由）。
  // 注意：两端点均有速率限制（主端点实测触发 429/-32017）→ lib/chain.js 内置退避与轮换。
  explorer: null, // 待确认
};

const CONTRACTS = {
  poolManager: {
    address: '0xe2e105d3f7209a9da11f83ccf3e7398a753823f1',
    role: 'Uniswap V4 PoolManager（核心）',
    status: 'pending-official',
    readEnabled: true,
    writeEnabled: false,
    evidence: '字节码与官方构建逐字节一致（仅自地址常量不同）；2026-11-03 经标准确定性部署器部署（blk 256083）',
  },
  positionManager: {
    address: '0x1d1c51b9d07fd27d36412a2b66cc23d19eb3e518',
    role: 'V4 PositionManager（组池 / 领费 / 撤池）',
    status: 'pending-official',
    readEnabled: true,
    writeEnabled: false,
    evidence: 'M2 只读 Probe 对照（2026-11-10）：以官方已部署合约 ABI（Sourcify 验证源，39 个函数）为权威集合，Elysium 与 ETH/Base 的字节码选择器集合完全一致（差集 0）；10 项探测全部通过（same-value：permit2；same-shape：ownerOf 不存在/空 actions/未知 action/合法编码但头寸不存在/multicall；chain-specific：getPoolAndPositionInfo、getPositionLiquidity、nextTokenId、poolManager 目标关系）。**写路径行为与内部实现等价性未验证**，故维持 pending-official + 只读。详见 docs/M2-PM-BEHAVIOR.md',
  },
  positionDescriptor: {
    address: '0x599141dbd536891ef30b81883bfb4a621dc3f496',
    role: 'V4 PositionDescriptor（头寸 NFT 元数据）',
    status: 'pending-official',
    readEnabled: true,
    writeEnabled: false,
    evidence: '函数面识别（tokenURI / nativeCurrencyLabel / flipRatio / currencyRatioPriority）',
  },
  v4Quoter: {
    address: '0x379f556c5a748bd7cc9baf0f7a344094ac1814f5',
    role: 'V4 Quoter 候选（未采用）',
    status: 'verified-address',
    readEnabled: false,
    writeEnabled: false,
    evidence: 'M2 实测：字节码含 11 个选择器，与官方 V4Quoter 不一致（仅 poolManager() 与 unlockCallback(bytes) 匹配；标准 quoteExactInputSingle 选择器不存在），且实测调用 revert(0x) → 报价改用本地数学（lib/v4math.js，已用大整数真值校验），该地址不参与任何读写',
  },
  stateView: {
    address: '0x27ed73ae0652fdcf71d6793412a7525f32be9dfe',
    role: 'V4 StateView（只读池状态）',
    status: 'pending-official',
    readEnabled: true,
    writeEnabled: false,
    evidence: '与官方 StateView 同尺寸（3531B）；getSlot0 / getTickInfo / getLiquidity 齐备',
  },
  universalRouter: {
    address: '0x1bd4d69bfb8927a045f20518a08390cee3913b0d',
    role: 'UniversalRouter 候选（兑换用；不启用）',
    status: 'pending-official',
    readEnabled: false,
    writeEnabled: false,
    evidence: 'execute 选择器 2/2；与官方 UR 体积不同（23233B vs 19499B），未做进一步比对',
  },
  permit2: {
    address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    role: 'Permit2（代币授权）',
    status: 'verified',
    readEnabled: true,
    writeEnabled: false,
    evidence: '官方标准地址；PositionManager.permit2() 指向该地址',
  },
  multicall3: {
    address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    role: 'Multicall3（批量读取）',
    status: 'verified',
    readEnabled: true,
    writeEnabled: false,
    evidence: '全链标准地址',
  },
  bridgeRouter: {
    address: '0x61EbbC3A29f1970aF2Ce862bA9c5364832E14d17',
    role: '跨链桥路由（HyperEVM ↔ Elysium）',
    status: 'verified-address',
    readEnabled: true,
    writeEnabled: false,
    evidence: '核验范围仅包括：地址存在、目标链/源链关系、只读状态查询；桥接写路径（含 HYPE 原生与 KNTQ ERC-20 是否同路径）、限额与权限均未验证',
  },
};

const TOKENS = {
  HYPE: { address: 'native', decimals: 18, status: 'verified', readEnabled: true, writeEnabled: false, note: 'Elysium 原生代币（gas）' },
  KNTQ: { address: '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0', decimals: 18, status: 'verified', readEnabled: true, writeEnabled: false, note: '桥接映射版' },
  WHYPE: { address: '0xbA876237B0F021A6c6D852d6c26E107997cC5E81', decimals: 18, status: 'verified', readEnabled: true, writeEnabled: false, note: '桥接映射版' },
  USDC: { address: '0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65', decimals: 6, status: 'verified', readEnabled: true, writeEnabled: false, note: '桥接映射版' },
};

const POOLS = {
  'KNTQ/HYPE (1%)': {
    poolId: '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac',
    // V4 池身份 = PoolKey；currency0/currency1 按地址升序排列（原生资产用零地址表示，故最小）
    poolKey: {
      currency0: '0x0000000000000000000000000000000000000000', // 原生 HYPE
      currency1: '0xe45a355d9e9cAd2aD85F2d03E3eE3102A036acF0', // KNTQ
      fee: 10000,
      tickSpacing: 200,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    pair: 'HYPE(native) / KNTQ',
    parameterVerified: true,      // PoolKey → poolId 数学验证通过
    onchainExists: true,          // 链上真实存在且有交易
    activityObserved: true,       // 观察到 Swap / ModifyLiquidity 事件
    stackOfficiallyConfirmed: false, // 所属栈官方归属未确认
    status: 'verified-parameters',
    createdAt: '2026-11-09T08:49:39Z',
    createdBlock: 3077585,
    readEnabled: true,
    writeEnabled: false,
    note: '默认目标池（流动性/成交最大）；同交易对存在其他费率档位池；早期数据波动大，不可作为稳定性依据',
  },
};

/** 排除清单：同链其他 v4 风格部署（白名单外，禁止交互） */
const EXCLUDED = [
  { address: '0x5fb015a49f5b35073f9ce01c2adb287a75f89600', reason: 'v4 风格部署（另一部署者，2026-10-23）' },
  { address: '0x1f9b957071228a3190280e062cc62a3f66b6a13a', reason: '上述部署的配套 PositionManager' },
  { address: '0x06c63714fbf1f5753017123e2fcfdede4540b2c4', reason: 'v4 风格部署（另一部署者，2026-10-25）' },
  { address: '0x5c54a7293d96b11a29a0256ee8dfdbc3059637da', reason: 'v4 风格部署（另一部署者，2026-10-30）' },
  { address: '0x794ad5fe8227524619c7bbf6b4572c9d08d9ff1f', reason: '17KB 定制构建（另一部署者，2026-11-04）' },
];

/** 同一部署批次中未识别的配套合约（仅登记，read/write 均不启用） */
const UNIDENTIFIED_STACK = [
  '0x9f92c5297eb3b39e6804b5e03899bc66b6b77348',
  '0xf025e0fe9e331a0ef05c2ad3c4e9c64b625cda6f',
  '0xabfb859e6c3324fe522bfbb19cb41345003ced65',
  '0x003aa18c6e682db80cf4aa17261ccbffd28690ce',
  '0x0000001b173c3bbf3984d417d8614e3eed34865b',
  '0x3fedad0abb1ee1066672e93999b672036fd98a10',
  '0x94a7d36e2ae728d6a2b2ee533b0a260385596d8b',
  '0x976183ac3d09840d243a88c0268badb3b3e3259f',
  '0x2d01411773c8c24805306e89a41f7855c3c4fe65',
  '0x0000000085e102724e78ecd2f45dc9ca239affad',
  '0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900',
];

module.exports = { CHAIN, CONTRACTS, TOKENS, POOLS, EXCLUDED, UNIDENTIFIED_STACK };
