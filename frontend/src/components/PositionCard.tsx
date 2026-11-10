import { fmtAmount, fmtPct, fmtUsd, fmtTime } from '../lib/format'
import type { Position } from '../lib/types'
import { writesDisabledReason } from '../lib/tx-guard'

const WINDOW_LABELS: [keyof Position['windows'], string][] = [
  ['h1', '1h'],
  ['h24', '24h'],
  ['d7', '7d'],
  ['d30', '30d'],
]

function priceAt(tick: number) {
  return Math.pow(1.0001, tick)
}

export default function PositionCard({ p, onAnalyze }: { p: Position; onAnalyze?: (tokenId: string) => void }) {
  const status = p.closed
    ? { label: '已撤空', cls: 'bg-zinc-700/40 text-zinc-300 border-zinc-600/50' }
    : p.inRange
      ? { label: '在区间内', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30' }
      : { label: '出区间', cls: 'bg-amber-500/10 text-amber-300 border-amber-500/30' }

  const hasFees = (p.fee0 ?? 0) > 0 || (p.fee1 ?? 0) > 0

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-zinc-200">#{p.tokenId}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${status.cls}`}>{status.label}</span>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400">1% 费率</span>
          {p.hasSubscriber && <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-300">有订阅者</span>}
          {!p.poolMatch && <span className="rounded-full border border-zinc-600 px-2 py-0.5 text-[11px] text-zinc-400">其他池（仅索引）</span>}
        </div>
        <div className="text-right">
          <div className="text-[11px] text-zinc-500">本金（当前）</div>
          <div className="font-mono text-sm text-zinc-100">{fmtUsd(p.principalUsd)}</div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3">
          <div className="text-[11px] text-zinc-500">区间</div>
          <div className="mt-0.5 font-mono text-xs text-zinc-300">
            {p.tickLower} → {p.tickUpper}
          </div>
          <div className="text-[11px] text-zinc-500">
            ≈ {priceAt(p.tickLower).toFixed(1)} – {priceAt(p.tickUpper).toFixed(1)} KNTQ/HYPE
          </div>
          <div className="mt-2 text-[11px] text-zinc-500">本金构成</div>
          <div className="font-mono text-xs text-zinc-300">
            {fmtAmount(p.amount0)} HYPE + {fmtAmount(p.amount1)} KNTQ
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/40 p-3">
          <div className="text-[11px] text-zinc-500">待领收益</div>
          <div className={`mt-0.5 font-mono text-xs ${hasFees ? 'text-emerald-300' : 'text-zinc-400'}`}>
            {fmtAmount(p.fee0)} HYPE + {fmtAmount(p.fee1)} KNTQ
          </div>
          <div className="text-[11px] text-zinc-500">≈ {fmtUsd(p.feesUsd, p.feesUsd != null && p.feesUsd < 0.01 ? 4 : 2)}</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[11px] text-zinc-500">收益速度</span>
            <span className="font-mono text-xs text-zinc-200">
              {p.speedUsdPerDay != null ? `≈ ${fmtUsd(p.speedUsdPerDay, p.speedUsdPerDay < 0.01 ? 4 : 2)}/天` : '采样中'}
            </span>
            {p.speedBasis && <span className="text-[10px] text-zinc-600">基于 {p.speedBasis.replace('h', '')}h 窗口</span>}
          </div>
          {p.feeAnomaly && <div className="mt-1 text-[11px] text-amber-400">费用数据异常（feeGrowth 回退），已隐藏</div>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-zinc-500">年化窗口</span>
        {WINDOW_LABELS.map(([key, label]) => {
          const w = p.windows[key]
          return (
            <span
              key={key}
              className={`rounded border px-2 py-0.5 font-mono text-[11px] ${w ? 'border-zinc-700 text-zinc-200' : 'border-zinc-800 text-zinc-600'}`}
              title={w ? `样本 ${w.samples} 条 / 跨度 ${Math.round(w.spanSec / 60)} 分钟` : '样本积累中'}
            >
              {label} {w ? fmtPct(w.apr) : '—'}
            </span>
          )
        })}
        {p.sampleCount < 2 && <span className="text-[11px] text-zinc-600">样本积累中（已采样 {p.sampleCount} 条）</span>}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-zinc-800/70 pt-2">
        <div className="font-mono text-[10px] text-zinc-600">
          流动性 {p.liquidity} · 采样 {p.sampleCount} 条 · 更新 {fmtTime(p.lastSampleAt ?? undefined)}
        </div>
        <div className="flex gap-2">
          {onAnalyze && (
            <button
              onClick={() => onAnalyze(p.tokenId)}
              className="rounded border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-300 hover:bg-sky-500/20"
            >
              分析 · 模拟
            </button>
          )}
          <button disabled title={writesDisabledReason()} className="cursor-not-allowed rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-600">
            领费 · M3
          </button>
          <button disabled title={writesDisabledReason()} className="cursor-not-allowed rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-600">
            撤池 · M3
          </button>
        </div>
      </div>
    </div>
  )
}
