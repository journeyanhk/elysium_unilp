import { useState } from 'react'
import type { WhitelistResponse } from '../lib/types'
import { shortAddr } from '../lib/format'

const STATUS_LABEL: Record<string, string> = {
  verified: '已核验',
  'verified-address': '地址级核验',
  'verified-parameters': '参数级核验',
  'pending-official': '待官方确认',
}

export default function WhitelistPanel({ data }: { data: WhitelistResponse }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <button className="flex w-full items-center justify-between text-left" onClick={() => setOpen(!open)}>
        <div>
          <h2 className="text-sm font-medium text-zinc-200">核验与设置 · 白名单</h2>
          <p className="text-[11px] text-zinc-500">
            {data.contracts.length} 个合约 · 全部 writeEnabled=false · 排除 {data.excludedCount} 个非白名单部署
          </p>
        </div>
        <span className="text-[11px] text-zinc-500">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] leading-5 text-zinc-400">{data.writeLockNote}</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-[11px] text-zinc-500">
                  <th className="py-1.5 pr-3 font-normal">角色</th>
                  <th className="py-1.5 pr-3 font-normal">地址</th>
                  <th className="py-1.5 pr-3 font-normal">状态</th>
                  <th className="py-1.5 pr-3 font-normal">读</th>
                  <th className="py-1.5 pr-3 font-normal">写</th>
                </tr>
              </thead>
              <tbody>
                {data.contracts.map((c) => (
                  <tr key={c.key} className="border-b border-zinc-800/50">
                    <td className="py-1.5 pr-3 text-zinc-300">{c.role}</td>
                    <td className="py-1.5 pr-3 font-mono text-zinc-400" title={c.address}>{shortAddr(c.address)}</td>
                    <td className="py-1.5 pr-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${c.status === 'verified' ? 'border-emerald-500/30 text-emerald-300' : 'border-zinc-700 text-zinc-400'}`}>
                        {STATUS_LABEL[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3">{c.readEnabled ? <span className="text-emerald-400">✓</span> : <span className="text-zinc-600">✗</span>}</td>
                    <td className="py-1.5 pr-3">{c.writeEnabled ? <span className="text-amber-400">✓</span> : <span className="text-zinc-600">✗</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-2 text-[11px] text-zinc-500 md:grid-cols-2">
            <div>
              <div className="text-zinc-400">目标池</div>
              <div className="font-mono">{data.pools[0]?.poolId}</div>
              <div>{data.pools[0]?.pair} · 状态 {STATUS_LABEL[data.pools[0]?.status ?? ''] ?? data.pools[0]?.status}</div>
            </div>
            <div>
              <div className="text-zinc-400">RPC</div>
              {data.chain.rpcEndpoints.map((e) => (
                <div key={e.url} className="font-mono">{e.url}（{e.source}）</div>
              ))}
              <div>故障切换框架预留（当前单端点）</div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
