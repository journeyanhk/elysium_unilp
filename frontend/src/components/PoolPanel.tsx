import { fmtAmount, fmtInt, fmtUsd, timeAgo, fmtTime } from '../lib/format'
import type { PoolResponse, PositionsResponse } from '../lib/types'

export default function PoolPanel({ pool }: { pool: PositionsResponse | PoolResponse }) {
  const isPositions = 'poolMeta' in pool
  const meta: { createdAt: string; createdBlock: number; ageDays: number; statusLabel: string; warnings?: string[] } =
    isPositions ? pool.poolMeta : (pool as PoolResponse).meta
  const market = isPositions ? null : (pool as PoolResponse).market
  const prices = pool.prices

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-200">KNTQ / HYPE 池 · 1% 费率 · tickSpacing 200</h2>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">{meta.statusLabel}</span>
        </div>
        <div className="font-mono text-[11px] text-zinc-500">池龄 {meta.ageDays < 1 ? `${Math.round(meta.ageDays * 24)} 小时` : `${meta.ageDays} 天`}</div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <div className="text-[11px] text-zinc-500">池内价格</div>
          <div className="font-mono text-sm text-zinc-100">{fmtAmount(pool.pool.price1Per0)} KNTQ/HYPE</div>
          <div className="text-[11px] text-zinc-500">KNTQ ≈ {fmtUsd(pool.pool.impliedKntqUsd, 4)}（池内隐含）</div>
        </div>
        <div>
          <div className="text-[11px] text-zinc-500">当前 tick</div>
          <div className="font-mono text-sm text-zinc-100">{fmtInt(pool.pool.tick)}</div>
          <div className="text-[11px] text-zinc-500">池内流动性 {fmtAmount(Number(pool.pool.liquidity) / 1e18)}</div>
        </div>
        <div>
          <div className="text-[11px] text-zinc-500">参考价（Surf）</div>
          <div className="font-mono text-sm text-zinc-100">
            HYPE {fmtUsd(prices.HYPE?.usd)} · KNTQ {fmtUsd(prices.KNTQ?.usd, 4)}
          </div>
          <div className="text-[11px] text-zinc-500">更新 {timeAgo(prices.KNTQ?.at)}</div>
        </div>
        <div>
          <div className="text-[11px] text-zinc-500">市场快照（DexScreener）</div>
          <div className="font-mono text-sm text-zinc-100">
            {market ? `${fmtUsd(market.liqUsd, 0)} 流动性` : isPositions ? '见池面板' : '—'}
          </div>
          <div className="text-[11px] text-zinc-500">{market ? `24h 成交 ${fmtUsd(market.vol24Usd, 0)} · ${fmtTime(market.snapshotAt)}` : '—'}</div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-800/70 pt-3">
        {(meta.warnings ?? []).map((w: string) => (
          <span key={w} className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
            {w}
          </span>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-5 text-zinc-600">
        提示：「已观察到链上活动」只代表存在交易，不代表手续费收入稳定；池子创建于 {fmtTime(meta.createdAt)}，早期数据波动大，不作为稳定性依据。
      </p>
    </div>
  )
}
