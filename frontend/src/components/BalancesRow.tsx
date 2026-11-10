import { fmtAmount, fmtUsd } from '../lib/format'
import type { Balance } from '../lib/types'

export default function BalancesRow({ balances }: { balances: Balance[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {balances.map((b) => (
        <div key={b.symbol} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
          <div className="text-[11px] text-zinc-500">{b.symbol} 余额</div>
          <div className="mt-0.5 font-mono text-sm text-zinc-100">{fmtAmount(b.amount)}</div>
          <div className="font-mono text-[11px] text-zinc-500">≈ {fmtUsd(b.usd)}</div>
        </div>
      ))}
    </div>
  )
}
