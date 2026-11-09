export type PriceInfo = { usd: number; source: string; at: string } | null;
export type Prices = { HYPE: PriceInfo; KNTQ: PriceInfo; USDC: PriceInfo };

export type Balance = { symbol: string; raw: string; decimals: number; amount: number; usd: number | null };

export type WindowStat = { apr: number; earnedUsd: number; spanSec: number; samples: number } | null;

export type Position = {
  tokenId: string;
  ownerOnchain: string;
  ownerMatches: boolean;
  liquidity: string;
  closed: boolean;
  tickLower: number;
  tickUpper: number;
  hasSubscriber: boolean;
  poolMatch: boolean;
  fee0?: number;
  fee1?: number;
  feeAnomaly?: boolean;
  amount0?: number;
  amount1?: number;
  inRange?: boolean;
  principalUsd: number | null;
  feesUsd: number | null;
  windows: { h1: WindowStat; h24: WindowStat; d7: WindowStat; d30: WindowStat };
  speedUsdPerDay: number | null;
  speedBasis: string | null;
  sampleCount: number;
  lastSampleAt: string | null;
};

export type IndexStatus = {
  synced: boolean;
  progress: number;
  lastSyncedBlock: number;
  latestBlock: number;
  lastSyncedAt: string | null;
  needResync: boolean;
};

export type RpcStatus = {
  active: string;
  failoverEnabled: boolean;
  endpoints: { url: string; ok: boolean | null; latencyMs?: number; checkedAt?: string; lastError?: string | null }[];
};

export type PoolState = {
  tick: number;
  sqrtPriceX96: string;
  liquidity: string;
  lpFee: number;
  at: string;
  price1Per0: number;
  impliedKntqUsd: number | null;
};

export type PositionsResponse = {
  address: string;
  chainId: number;
  at: string;
  index: IndexStatus;
  rpc: RpcStatus;
  prices: Prices;
  balances: Balance[];
  pool: PoolState;
  poolMeta: { createdAt: string; createdBlock: number; ageDays: number; statusLabel: string };
  warnings: string[];
  positions: Position[];
};

export type PoolResponse = {
  pool: PoolState;
  market: { liqUsd: number | null; vol24Usd: number | null; priceUsd: number | null; snapshotAt: string; source: string; dexId: string | null } | null;
  prices: Prices;
  meta: { createdAt: string; createdBlock: number; ageDays: number; statusLabel: string; warnings: string[] };
  rpc: RpcStatus;
};

export type WhitelistResponse = {
  chain: { id: number; name: string; rpcEndpoints: { url: string; source: string }[] };
  contracts: { key: string; address: string; role: string; status: string; readEnabled: boolean; writeEnabled: boolean; evidence?: string }[];
  tokens: { key: string; address: string; decimals: number; status: string; readEnabled: boolean; writeEnabled: boolean; note?: string }[];
  pools: { key: string; poolId: string; pair: string; status: string; readEnabled: boolean; writeEnabled: boolean; createdAt: string }[];
  excludedCount: number;
  unidentifiedCount: number;
  writeLockNote: string;
};

export type MemoryResponse = { files: { name: string; content: string | null; error?: string }[]; at: string };
