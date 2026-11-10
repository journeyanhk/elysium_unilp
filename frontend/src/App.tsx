import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { api } from './lib/api'
import { ADDR_RE, ELYSIUM_CHAIN_ID, connectWallet, getProviderName, getWalletChainId, switchToElysium } from './lib/wallet'
import type { MemoryResponse, PoolResponse, Position, PositionsResponse, WhitelistResponse } from './lib/types'
import BalancesRow from './components/BalancesRow'
import PoolPanel from './components/PoolPanel'
import PositionCard from './components/PositionCard'
import SimulatorPanel from './components/SimulatorPanel'
import WhitelistPanel from './components/WhitelistPanel'
import MemoryPanel from './components/MemoryPanel'
import SignBroadcastPanel from './components/SignBroadcastPanel'
import { fmtTime, shortAddr, timeAgo } from './lib/format'

const j = (r: Response) => r.json()

type SortKey = 'value' | 'fees' | 'apr' | 'tokenId'

function Dashboard() {
  const [address, setAddress] = useState('')
  const [input, setInput] = useState('')
  const [walletChainId, setWalletChainId] = useState<number | null>(null)
  const [walletErr, setWalletErr] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('value')
  const [hideEmpty, setHideEmpty] = useState(true)
  const [focus, setFocus] = useState<{ id: string | null; seq: number }>({ id: null, seq: 0 })

  const providerName = getProviderName()

  const positionsQ = useQuery<PositionsResponse>({
    queryKey: ['positions', address],
    queryFn: () => fetch(api(`positions?address=${address}`)).then(j),
    enabled: !!address && ADDR_RE.test(address),
    refetchInterval: 30000,
  })

  const poolQ = useQuery<PoolResponse>({ queryKey: ['pool'], queryFn: () => fetch(api('pool')).then(j), refetchInterval: 60000 })
  const wlQ = useQuery<WhitelistResponse>({ queryKey: ['whitelist'], queryFn: () => fetch(api('whitelist')).then(j), staleTime: 5 * 60 * 1000 })
  const memQ = useQuery<MemoryResponse>({ queryKey: ['memory'], queryFn: () => fetch(api('memory')).then(j), staleTime: 5 * 60 * 1000 })

  // 索引未完成时自动继续同步（只读操作，无需钱包）
  const needResync = positionsQ.data?.index?.needResync ?? false
  const lastSyncedBlock = positionsQ.data?.index?.lastSyncedBlock
  useEffect(() => {
    if (!needResync) return
    let stop = false
    ;(async () => {
      try {
        await fetch(api('indexer/sync'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ budgetMs: 8000 }),
        })
        if (!stop) positionsQ.refetch()
      } catch {
        /* 下一轮重试 */
      }
    })()
    return () => { stop = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needResync, lastSyncedBlock])

  async function handleConnect() {
    setWalletErr('')
    try {
      const { address: a, chainId } = await connectWallet()
      setAddress(a)
      setWalletChainId(chainId)
    } catch (e) {
      setWalletErr(String((e as Error).message || e))
    }
  }

  function handleWatch() {
    const a = input.trim()
    if (!ADDR_RE.test(a)) {
      setWalletErr('请输入有效的 0x 地址（42 位）')
      return
    }
    setWalletErr('')
    setAddress(a)
    setWalletChainId(null)
  }

  const sorted = useMemo(() => {
    const list = (positionsQ.data?.positions ?? []).filter((p) => {
      if (!hideEmpty) return true
      return !(p.closed && (p.fee0 ?? 0) === 0 && (p.fee1 ?? 0) === 0)
    })
    const aprOf = (p: Position) => p.windows.h24?.apr ?? p.windows.h1?.apr ?? p.windows.d7?.apr ?? -1
    const cmp: Record<SortKey, (a: Position, b: Position) => number> = {
      value: (a, b) => (b.principalUsd ?? -1) - (a.principalUsd ?? -1),
      fees: (a, b) => (b.feesUsd ?? -1) - (a.feesUsd ?? -1),
      apr: (a, b) => aprOf(b) - aprOf(a),
      tokenId: (a, b) => Number(b.tokenId) - Number(a.tokenId),
    }
    return [...list].sort(cmp[sortKey])
  }, [positionsQ.data, sortKey, hideEmpty])

  const poolForPanel = positionsQ.data ?? poolQ.data

  return (
    <div className="min-h-screen bg-[#0a0d12] text-zinc-100">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">KNTQ/HYPE LP 管理器</h1>
            <p className="text-[11px] text-zinc-500">Elysium · 只读看板 + M3.3 手动签名与广播（门禁关闭）· 数据：链上 RPC / Surf / DexScreener</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300">只读看板 · 交易门禁关闭（不会请求签名）</span>
            {positionsQ.data && (
              <span className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400">
                RPC {positionsQ.data.rpc.active.replace('https://', '')} · {positionsQ.data.rpc.endpoints[0]?.latencyMs ?? '—'}ms
              </span>
            )}
            {(positionsQ.data ?? poolQ.data) && (
              <span className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400">
                区块 {(positionsQ.data?.index.latestBlock ?? poolQ.data?.pool.at) ? (positionsQ.data?.index.latestBlock ?? '—').toLocaleString() : '—'}
              </span>
            )}
          </div>
        </header>

        <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <button onClick={handleConnect} className="rounded-lg border border-zinc-600 bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
              连接钱包{providerName ? `（${providerName}）` : ''}
            </button>
            <span className="text-[11px] text-zinc-500">或</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleWatch() }}
              placeholder="粘贴地址（观察模式，无需连接钱包）"
              className="w-80 max-w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-1.5 font-mono text-xs outline-none placeholder:text-zinc-600 focus:border-zinc-500"
            />
            <button onClick={handleWatch} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">查看</button>
            {address && (
              <span className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-1.5 font-mono text-xs">
                {shortAddr(address)}
                <button className="text-zinc-500 hover:text-zinc-300" onClick={() => { setAddress(''); setWalletChainId(null) }}>×</button>
              </span>
            )}
          </div>
          {walletChainId != null && walletChainId !== ELYSIUM_CHAIN_ID && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-amber-300">
              <span>钱包当前网络不是 Elysium（chainId {walletChainId}）。</span>
              <button
                className="underline"
                onClick={() => switchToElysium().then(() => getWalletChainId().then(setWalletChainId)).catch((e) => setWalletErr(String((e as Error).message || e)))}
              >
                切换网络
              </button>
              <span className="text-zinc-500">（本页数据读取不依赖钱包网络，切换仅为方便后续操作）</span>
            </div>
          )}
          {walletErr && <div className="mt-2 text-[11px] text-red-400">{walletErr}</div>}
        </section>

        {poolForPanel && <PoolPanel pool={poolForPanel} />}

        {!address && (
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center text-sm text-zinc-400">
            连接 OKX 钱包，或粘贴任意地址进入观察模式，查看只读持仓数据。
          </section>
        )}

        {address && positionsQ.isLoading && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 text-sm text-zinc-400">加载中…（首次会建立头寸索引，可能需要数十秒）</div>
        )}

        {address && positionsQ.isError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            读取失败：{String((positionsQ.error as Error)?.message || '未知错误')}
          </div>
        )}

        {address && positionsQ.data && (
          <>
            {!positionsQ.data.index.synced && (
              <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-300">
                头寸索引同步中：{Math.round(positionsQ.data.index.progress * 100)}%（{positionsQ.data.index.lastSyncedBlock.toLocaleString()} / {positionsQ.data.index.latestBlock.toLocaleString()}）— 页面会自动继续，无需操作。
              </div>
            )}

            <BalancesRow balances={positionsQ.data.balances} />

            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-zinc-200">头寸（{sorted.length}）</h2>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
                    隐藏已撤空仓
                  </label>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="rounded border border-zinc-700 bg-zinc-950/60 px-2 py-1 text-zinc-300"
                  >
                    <option value="value">按本金排序</option>
                    <option value="fees">按待领收益排序</option>
                    <option value="apr">按年化排序</option>
                    <option value="tokenId">按 tokenId 排序</option>
                  </select>
                  <button onClick={() => positionsQ.refetch()} className="rounded border border-zinc-700 px-2 py-1 hover:bg-zinc-800">刷新</button>
                </div>
              </div>

              {sorted.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-6 text-center text-sm text-zinc-500">
                  没有找到该地址在目标池的头寸{hideEmpty ? '（已隐藏空仓，可取消勾选查看）' : ''}。
                </div>
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {sorted.map((p) => (
                    <PositionCard key={p.tokenId} p={p} onAnalyze={(id) => setFocus({ id, seq: Date.now() })} />
                  ))}
                </div>
              )}
            </section>

            <div className="text-[11px] text-zinc-600">
              数据更新 {fmtTime(positionsQ.data.at)} · 索引最后同步 {timeAgo(positionsQ.data.index.lastSyncedAt)} · 价格来源 Surf（{timeAgo(positionsQ.data.prices.KNTQ?.at)}）
            </div>
          </>
        )}

        <SimulatorPanel
          address={address}
          positions={positionsQ.data?.positions ?? []}
          pool={(positionsQ.data ?? poolQ.data)?.pool ?? null}
          focusTokenId={focus.id}
          focusSeq={focus.seq}
        />

        <SignBroadcastPanel address={address} chainId={walletChainId} />

        {wlQ.data && <WhitelistPanel data={wlQ.data} />}
        {memQ.data && <MemoryPanel data={memQ.data} />}
        <footer className="pb-8 text-[11px] leading-5 text-zinc-600">
          安全说明：连接钱包仅用于读取地址；所有链上数据由后端只读 RPC 获取。M3.3 手动签名与广播路径已实现，但**交易门禁当前关闭**——不会授权、不会请求签名、不会广播（Approve / Permit2 / 组池 / 领费 / 撤池均需门禁解锁 + 用户本人书面风险接受）。
          合约身份：PoolManager 与官方构建逐字节一致；PositionManager 接口面一致、实现等价性待 M2 验证；官方归属待确认。详见「核验与设置」。
        </footer>
      </div>
    </div>
  )
}

export default function App() {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }))
  return (
    <QueryClientProvider client={qc}>
      <Dashboard />
    </QueryClientProvider>
  )
}
