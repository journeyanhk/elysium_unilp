import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fmtAmount, fmtPct, fmtUsd } from '../lib/format'
import type { Position, PoolState } from '../lib/types'
import { writesDisabledReason } from '../lib/tx-guard'

type Tab = 'mint' | 'remove' | 'analysis'

type SimResult = Record<string, any>
type AnalysisResult = Record<string, any>

const post = (path: string, body: unknown) =>
  fetch(api(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

function Msg({ list, tone }: { list?: string[]; tone: 'err' | 'warn' | 'note' }) {
  if (!list || !list.length) return null
  const cls = tone === 'err'
    ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : tone === 'warn'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
      : 'border-zinc-700 bg-zinc-900/60 text-zinc-400'
  return (
    <div className={`space-y-1 rounded-lg border p-2 text-[11px] ${cls}`}>
      {list.map((t, i) => <div key={i}>· {t}</div>)}
    </div>
  )
}

function Row({ k, v, mono = true }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800/60 py-1 last:border-0">
      <span className="text-[11px] text-zinc-500">{k}</span>
      <span className={`text-xs text-zinc-200 ${mono ? 'font-mono' : ''}`}>{v}</span>
    </div>
  )
}

function Badge({ children, tone = 'zinc' }: { children: React.ReactNode; tone?: 'zinc' | 'emerald' | 'amber' | 'sky' }) {
  const cls = {
    zinc: 'border-zinc-700 text-zinc-400',
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    sky: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  }[tone]
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] ${cls}`}>{children}</span>
}

const inputCls = 'w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500'

export default function SimulatorPanel({
  address, positions, pool, focusTokenId, focusSeq,
}: {
  address: string
  positions: Position[]
  pool: PoolState | null
  focusTokenId: string | null
  focusSeq: number
}) {
  const [tab, setTab] = useState<Tab>('mint')

  // —— 建仓表单 ——
  const currentPrice = pool ? Math.pow(1.0001, pool.tick) : null
  const [amount0, setAmount0] = useState('1')
  const [amount1, setAmount1] = useState('')
  const [priceLower, setPriceLower] = useState('')
  const [priceUpper, setPriceUpper] = useState('')
  const [slippage, setSlippage] = useState('1')
  const [swapExcess, setSwapExcess] = useState(true)
  const [mintLoading, setMintLoading] = useState(false)
  const [mintRes, setMintRes] = useState<SimResult | null>(null)

  useEffect(() => {
    if (currentPrice && !priceLower && !priceUpper) {
      setPriceLower((currentPrice * 0.95).toFixed(2))
      setPriceUpper((currentPrice * 1.05).toFixed(2))
    }
  }, [currentPrice, priceLower, priceUpper])

  // —— 撤池表单 ——
  const [tokenId, setTokenId] = useState('')
  const [pct, setPct] = useState('100')
  const [toSingle, setToSingle] = useState(false)
  const [rmLoading, setRmLoading] = useState(false)
  const [rmRes, setRmRes] = useState<SimResult | null>(null)

  // —— 风险分析 ——
  const [anTokenId, setAnTokenId] = useState('')
  const [bridgeCost, setBridgeCost] = useState('0')
  const [anLoading, setAnLoading] = useState(false)
  const [anRes, setAnRes] = useState<AnalysisResult | null>(null)

  const poolPositions = useMemo(() => positions.filter((p) => p.poolMatch), [positions])

  async function runAnalysis(id: string) {
    if (!id) return
    setAnLoading(true)
    try {
      const r = await fetch(api(`analysis/${id}?bridgeCostUsd=${encodeURIComponent(bridgeCost || '0')}`)).then((x) => x.json())
      setAnRes(r)
    } finally { setAnLoading(false) }
  }

  useEffect(() => {
    if (focusTokenId) {
      setTab('analysis')
      setAnTokenId(focusTokenId)
      setTokenId(focusTokenId)
      runAnalysis(focusTokenId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTokenId, focusSeq])

  async function submitMint() {
    setMintLoading(true)
    try {
      const r = await post('simulate/mint', {
        amount0, amount1,
        priceLower: priceLower || undefined, priceUpper: priceUpper || undefined,
        slippageBps: Math.round((Number(slippage) || 1) * 100),
        owner: address || undefined,
        swapExcess,
      })
      setMintRes(r)
    } finally { setMintLoading(false) }
  }

  async function submitRemove() {
    setRmLoading(true)
    try {
      const r = await post('simulate/remove', {
        tokenId, pct: Number(pct) || 100,
        owner: address || undefined,
        toSingle,
        slippageBps: Math.round((Number(slippage) || 1) * 100),
      })
      setRmRes(r)
    } finally { setRmLoading(false) }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-zinc-200">模拟器</h2>
          <Badge tone="sky">只模拟 · 不发交易 · 不请求签名</Badge>
        </div>
        <div className="flex gap-1 rounded-lg border border-zinc-800 p-0.5">
          {([['mint', '建仓模拟'], ['remove', '撤池模拟'], ['analysis', '风险分析']] as [Tab, string][]).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-md px-3 py-1 text-xs ${tab === k ? 'bg-zinc-700/70 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ————————————————— 建仓模拟 ————————————————— */}
      {tab === 'mint' && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">投入 HYPE</span>
              <input className={inputCls} value={amount0} onChange={(e) => setAmount0(e.target.value)} placeholder="1" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">投入 KNTQ</span>
              <input className={inputCls} value={amount1} onChange={(e) => setAmount1(e.target.value)} placeholder="留空 = 自动换算" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">价格下界（KNTQ/HYPE）</span>
              <input className={inputCls} value={priceLower} onChange={(e) => setPriceLower(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">价格上界（KNTQ/HYPE）</span>
              <input className={inputCls} value={priceUpper} onChange={(e) => setPriceUpper(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-400">
            <label className="flex items-center gap-1.5">
              滑点上限
              <input className="w-16 rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 font-mono text-xs" value={slippage} onChange={(e) => setSlippage(e.target.value)} />%
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={swapExcess} onChange={(e) => setSwapExcess(e.target.checked)} />
              自动估算多余资产兑换（两步法）
            </label>
            {currentPrice && <span className="text-zinc-500">当前池价 ≈ {currentPrice.toFixed(2)} KNTQ/HYPE</span>}
            <button
              onClick={submitMint}
              disabled={mintLoading}
              className="ml-auto rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
            >
              {mintLoading ? '模拟中…' : '运行建仓模拟'}
            </button>
          </div>

          {mintRes && (
            <div className="space-y-3">
              <Msg list={mintRes.errors} tone="err" />
              <Msg list={mintRes.warnings} tone="warn" />
              <Msg list={mintRes.notes} tone="note" />
              {mintRes.ok && mintRes.result && (
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">建仓结果（估算）</div>
                    <Row k="获得流动性 L" v={mintRes.result.liquidity} />
                    <Row k="使用 HYPE" v={fmtAmount(Number(mintRes.result.used0Human))} />
                    <Row k="使用 KNTQ" v={fmtAmount(Number(mintRes.result.used1Human))} />
                    <Row k="估算价值" v={fmtUsd(mintRes.result.depositUsd)} />
                    <Row k="预计 NFT #" v={mintRes.result.expectedTokenId ?? '—'} />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">区间与价格</div>
                    <Row k="tick 区间" v={`${mintRes.range.tickLower} → ${mintRes.range.tickUpper}`} />
                    <Row k="价格区间" v={`${Number(mintRes.range.priceLower).toFixed(2)} – ${Number(mintRes.range.priceUpper).toFixed(2)}`} />
                    <Row k="区间宽度" v={`${mintRes.range.widthPct}%`} />
                    <Row k="当前状态" v={mintRes.pool.inRange ? '在区间内' : mintRes.pool.belowRange ? '区间下方（单边 HYPE）' : '区间上方（单边 KNTQ）'} />
                    <Row k="建仓后滑点上限" v={`HYPE ≤ ${fmtAmount(Number(mintRes.result.amount0Max) / 1e18)} / KNTQ ≤ ${fmtAmount(Number(mintRes.result.amount1Max) / 1e18)}`} />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">执行成本与前置条件</div>
                    <Row k="Gas 估算" v={`${Number(mintRes.gas.value).toLocaleString()}（${mintRes.gas.source === 'estimateGas' ? '链上模拟' : '静态'}）`} />
                    <Row k="授权（Permit2）" v={mintRes.allowance?.sufficient ? '已授权，足够' : mintRes.allowance ? '需要先授权（M3 才会签名）' : '—'} />
                    <Row k="余额检查" v={mintRes.balances?.hypeSufficient && mintRes.balances?.kntqSufficient ? '充足' : mintRes.balances ? '不足（含滑点上限）' : '—'} />
                    <div className="mt-2 text-[10px] leading-4 text-zinc-600">{mintRes.gas.note}</div>
                  </div>
                </div>
              )}
              {mintRes.swap && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-[11px] text-sky-200">
                  多余资产兑换估算（{mintRes.swap.direction}）：{fmtAmount(Number(mintRes.swap.amountInHuman))} → {fmtAmount(Number(mintRes.swap.amountOutHuman))}，
                  执行价影响（含费率）{mintRes.swap.priceImpactPct}%{mintRes.swap.priceChangePct != null ? ` · 池价变化 ${mintRes.swap.priceChangePct}%` : ''}，手续费 {fmtAmount(Number(mintRes.swap.feePaid) / 1e18)}
                  {mintRes.swap.ticksCrossed ? `，跨 ${mintRes.swap.ticksCrossed} 个 tick` : ''}
                  {mintRes.swap.partial ? '（未完全成交）' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ————————————————— 撤池模拟 ————————————————— */}
      {tab === 'remove' && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="space-y-1 sm:col-span-2">
              <span className="text-[11px] text-zinc-500">头寸 tokenId</span>
              <div className="flex gap-2">
                <input className={inputCls} value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="例如 5391" />
                {poolPositions.length > 0 && (
                  <select
                    className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-300"
                    value=""
                    onChange={(e) => { if (e.target.value) setTokenId(e.target.value) }}
                  >
                    <option value="">选择我的头寸</option>
                    {poolPositions.map((p) => (
                      <option key={p.tokenId} value={p.tokenId}>#{p.tokenId}（{p.closed ? '已撤空' : p.inRange ? '在区间' : '出区间'}）</option>
                    ))}
                  </select>
                )}
              </div>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">撤出比例 %</span>
              <input className={inputCls} value={pct} onChange={(e) => setPct(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">滑点上限 %</span>
              <input className={inputCls} value={slippage} onChange={(e) => setSlippage(e.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-zinc-400">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={toSingle} onChange={(e) => setToSingle(e.target.checked)} />
              估算「换成单一资产」的退出滑点（KNTQ → HYPE）
            </label>
            <button
              onClick={submitRemove}
              disabled={rmLoading || !tokenId}
              className="ml-auto rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
            >
              {rmLoading ? '模拟中…' : '运行撤池模拟'}
            </button>
          </div>

          {rmRes && (
            <div className="space-y-3">
              <Msg list={rmRes.errors} tone="err" />
              <Msg list={rmRes.warnings} tone="warn" />
              <Msg list={rmRes.notes} tone="note" />
              {rmRes.ok && (
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">撤出（{rmRes.remove.pct}%）</div>
                    <Row k="收到 HYPE" v={fmtAmount(Number(rmRes.remove.amount0Human))} />
                    <Row k="收到 KNTQ" v={fmtAmount(Number(rmRes.remove.amount1Human))} />
                    <Row k="估算价值" v={fmtUsd(rmRes.remove.valueUsd)} />
                    <Row k="滑点上限保护" v={`≥ ${fmtAmount(Number(rmRes.remove.amount0Min) / 1e18)} / ${fmtAmount(Number(rmRes.remove.amount1Min) / 1e18)}`} />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">待领手续费（同笔收取）</div>
                    <Row k="HYPE" v={fmtAmount(Number(rmRes.fees.fee0Human))} />
                    <Row k="KNTQ" v={fmtAmount(Number(rmRes.fees.fee1Human))} />
                    <Row k="估算价值" v={fmtUsd(rmRes.fees.valueUsd, 4)} />
                    <div className="mt-2 text-[10px] leading-4 text-zinc-600">{rmRes.fees.note}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">交易后</div>
                    <Row k="剩余流动性" v={rmRes.remove.liquidityRemaining} />
                    <Row k="Gas 估算" v={`${Number(rmRes.gas.value).toLocaleString()}（${rmRes.gas.source === 'estimateGas' ? '链上模拟' : '静态'}）`} />
                    <Row k="NFT 状态" v={rmRes.remove.willClose ? '流动性归零（NFT 保留）' : '保留剩余流动性'} />
                    {rmRes.projectedBalanceAfterRemove?.delta && (
                      <Row k="撤池后预计余额变化" v={`+${fmtAmount(Number(rmRes.projectedBalanceAfterRemove.delta.hype) / 1e18)} HYPE / +${fmtAmount(Number(rmRes.projectedBalanceAfterRemove.delta.kntq) / 1e18)} KNTQ`} />
                    )}
                  </div>
                </div>
              )}
              {rmRes.exitSwap && (
                <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-[11px] text-sky-200">
                  退出滑点估算（{rmRes.exitSwap.direction}）：{fmtAmount(Number(rmRes.exitSwap.amountInHuman))} → {fmtAmount(Number(rmRes.exitSwap.amountOutHuman))}，
                  执行价影响（含费率）{rmRes.exitSwap.priceImpactPct}%{rmRes.exitSwap.priceChangePct != null ? ` · 池价变化 ${rmRes.exitSwap.priceChangePct}%` : ''}
                  {rmRes.exitSwap.partial ? '（未完全成交，建议分批）' : ''}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ————————————————— 风险分析 ————————————————— */}
      {tab === 'analysis' && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="space-y-1 sm:col-span-2">
              <span className="text-[11px] text-zinc-500">头寸 tokenId</span>
              <input className={inputCls} value={anTokenId} onChange={(e) => setAnTokenId(e.target.value)} placeholder="例如 5391" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-zinc-500">桥接成本（USD，可选）</span>
              <input className={inputCls} value={bridgeCost} onChange={(e) => setBridgeCost(e.target.value)} />
            </label>
            <div className="flex items-end">
              <button
                onClick={() => runAnalysis(anTokenId)}
                disabled={anLoading || !anTokenId}
                className="w-full rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
              >
                {anLoading ? '分析中…' : '运行风险分析'}
              </button>
            </div>
          </div>

          {anRes && (
            <div className="space-y-3">
              <Msg list={anRes.warnings} tone="warn" />
              {anRes.position && anRes.comparison && (
                <div className="grid gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">LP vs HODL（建仓台账口径）</div>
                    <Row k="HODL 对照价值" v={fmtUsd(anRes.comparison.hodlUsd)} />
                    <Row k="LP 本金现值" v={fmtUsd(anRes.comparison.lpPrincipalUsd)} />
                    <Row k="待领手续费" v={fmtUsd(anRes.comparison.feesUsd, 4)} />
                    <Row k="LP 合计" v={fmtUsd(anRes.comparison.lpTotalUsd)} />
                    <Row
                      k="LP − HODL"
                      v={<span className={anRes.comparison.diffUsd >= 0 ? 'text-emerald-300' : 'text-red-300'}>{fmtUsd(anRes.comparison.diffUsd)}</span>}
                    />
                    <Row k="相对 HODL 差额（扣除当前未领取手续费）" v={`${fmtUsd(anRes.comparison.lpVsHodlExcludingCurrentFeesUsd)}（${fmtPct(anRes.comparison.lpVsHodlExcludingCurrentFeesPct)}）`} />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">Break-even</div>
                    <Row k="追平 HODL 还需手续费" v={fmtUsd(anRes.breakeven.feesNeededToMatchHodlUsd)} />
                    <Row k="Gas 成本（建仓+撤池+领费）" v={fmtUsd(anRes.breakeven.gasUsd, 2)} />
                    <Row k="桥接成本" v={fmtUsd(anRes.breakeven.bridgeCostUsd)} />
                    <Row k="合计需覆盖" v={fmtUsd(anRes.breakeven.requiredFeesUsd)} />
                    <Row k="所需池内交易量（静态近似）" v={anRes.breakeven.requiredVolumeApproxUsd != null ? fmtUsd(anRes.breakeven.requiredVolumeApproxUsd) : '—'} />
                    <Row k="按当前收益速度" v={anRes.breakeven.daysToCover != null ? `${anRes.breakeven.daysToCover} 天` : (anRes.breakeven.feeVelocityNote || '采样中')} />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                    <div className="mb-1 text-[11px] text-zinc-500">建仓台账（{anRes.ledger.events} 笔）</div>
                    <Row k="累计存入" v={`${fmtAmount(anRes.ledger.deposited.hype)} HYPE + ${fmtAmount(anRes.ledger.deposited.kntq)} KNTQ`} />
                    <Row k="累计取出" v={`${fmtAmount(anRes.ledger.withdrawn.hype)} HYPE + ${fmtAmount(anRes.ledger.withdrawn.kntq)} KNTQ`} />
                    <Row k="净投入（HODL 基准）" v={`${fmtAmount(anRes.ledger.netInvested.hype)} HYPE + ${fmtAmount(anRes.ledger.netInvested.kntq)} KNTQ`} />
                    <Row k="当前状态" v={`${anRes.position.inRange ? '在区间内' : '出区间'} · ${anRes.position.closed ? '已撤空' : '持有中'}`} />
                    <div className="mt-2 text-[10px] leading-4 text-zinc-600">{anRes.comparison.note}</div>
                  </div>
                </div>
              )}

              {anRes.scenarios && anRes.scenarios.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="mb-2 text-[11px] text-zinc-500">价格情景（HYPE 美元价不变，KNTQ 价随池价联动）</div>
                  <table className="w-full min-w-[560px] text-left text-[11px]">
                    <thead className="text-zinc-500">
                      <tr>
                        <th className="py-1 pr-3 font-normal">价格变动</th>
                        <th className="py-1 pr-3 font-normal">KNTQ/HYPE</th>
                        <th className="py-1 pr-3 font-normal">LP 价值</th>
                        <th className="py-1 pr-3 font-normal">HODL 价值</th>
                        <th className="py-1 pr-3 font-normal">差额</th>
                        <th className="py-1 font-normal">区间</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-zinc-300">
                      {anRes.scenarios.map((s: any) => (
                        <tr key={s.pct} className="border-t border-zinc-800/60">
                          <td className="py-1 pr-3">{s.pct > 0 ? `+${s.pct}` : s.pct}%</td>
                          <td className="py-1 pr-3">{Number(s.priceKntqPerHype).toFixed(2)}</td>
                          <td className="py-1 pr-3">{fmtUsd(s.lpUsd)}</td>
                          <td className="py-1 pr-3">{fmtUsd(s.hodlUsd)}</td>
                          <td className={`py-1 pr-3 ${s.diffUsd >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{fmtUsd(s.diffUsd)}</td>
                          <td className="py-1">{s.inRange ? '区间内' : '区间外'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-2 text-[10px] leading-4 text-zinc-600">
                    情景表含当前待领手续费；实际手续费会随价格路径变化，仅供判断「需要多少手续费才能追上 HODL」。
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 border-t border-zinc-800/70 pt-2 text-[10px] leading-4 text-zinc-600">
        M2 边界：本面板只做模拟与计算，不会构造任何交易、不请求任何签名；真实操作（组池 / 领费 / 撤池）在 M3 交易开关通过后才开放。
        本地 V4 数学（含跨 tick、手续费逐步取整、价格限制）已用链上真实 Swap 事件 8455 条参考向量逐位校验（全部一致），但仍属**本地估算、非官方 Quoter**，实际结果以链上执行为准；
        「相对 HODL 差额」为近似 IL（不含已领取手续费与完整价格路径），「所需交易量」为静态近似（假设区间内成交、份额不变），不是成交量预测。
        {writesDisabledReason() ? `（当前：${writesDisabledReason()}）` : ''}
      </div>
    </section>
  )
}
