import { useState } from 'react'
import type { MemoryResponse } from '../lib/types'

const TAB_LABEL: Record<string, string> = {
  'MEMORY.md': '项目记忆',
  'PROGRESS.md': '开发进度',
  'MAINTENANCE.md': '维护日志',
}

export default function MemoryPanel({ data }: { data: MemoryResponse }) {
  const [tab, setTab] = useState(data.files[0]?.name ?? 'MEMORY.md')
  const file = data.files.find((f) => f.name === tab)
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-zinc-200">项目记忆（跨会话）</h2>
        <div className="flex gap-1">
          {data.files.map((f) => (
            <button
              key={f.name}
              onClick={() => setTab(f.name)}
              className={`rounded border px-2 py-1 text-[11px] ${tab === f.name ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'}`}
            >
              {TAB_LABEL[f.name] ?? f.name}
            </button>
          ))}
        </div>
      </div>
      <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950/50 p-3 font-mono text-[11px] leading-5 text-zinc-400">
        {file?.content ?? `（${file?.error ?? '暂无内容'}）`}
      </pre>
    </section>
  )
}
