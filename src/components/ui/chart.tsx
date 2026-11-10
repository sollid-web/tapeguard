import * as React from 'react'
import { cn } from '../../lib/utils'

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>

const ChartContext = React.createContext<{ config: ChartConfig }>({ config: {} })

export function ChartContainer({ config, className, children }: { config: ChartConfig; className?: string; children: React.ReactNode }) {
  return <ChartContext.Provider value={{ config }}><div className={cn('w-full [&_.recharts-cartesian-axis-tick_text]:fill-zinc-500 [&_.recharts-cartesian-grid_line]:stroke-zinc-800 [&_.recharts-tooltip-cursor]:stroke-zinc-700 [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-zinc-900/40 [&_.recharts-layer:focus]:outline-none', className)}>{children}</div></ChartContext.Provider>
}

export function ChartTooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string }) {
  const { config } = React.useContext(ChartContext)
  if (!active || !payload?.length) return null
  return <div className="rounded-xl border border-zinc-700 bg-zinc-950/95 px-3 py-2.5 shadow-2xl"><p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{label}</p>{payload.map((item) => <div key={item.name} className="flex items-center justify-between gap-8 text-xs"><span className="flex items-center gap-1.5 text-zinc-400"><span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />{config[item.name || '']?.label || item.name}</span><span className="font-mono font-semibold text-zinc-100">{typeof item.value === 'number' ? item.value.toLocaleString() : item.value}</span></div>)}</div>
}
