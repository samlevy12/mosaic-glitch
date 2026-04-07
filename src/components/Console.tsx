import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { X, CaretDown, CaretUp } from '@phosphor-icons/react'

export interface ConsoleEntry {
  timestamp: number
  level: 'info' | 'success' | 'warning' | 'error' | 'debug'
  message: string
  data?: any
}

interface ConsoleProps {
  entries: ConsoleEntry[]
  isExpanded: boolean
  activeProcess?: string | null
  onToggle: () => void
  onClear: () => void
}

export function Console({ entries, isExpanded, activeProcess, onToggle, onClear }: ConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current && isExpanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries, isExpanded])

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`
  }

  const getLevelColor = (level: ConsoleEntry['level']) => {
    switch (level) {
      case 'info':    return 'text-[#37515F]'
      case 'success': return 'text-[#667761]'
      case 'warning': return 'text-[#B98B82]'
      case 'error':   return 'text-[#E4959E]'
      case 'debug':   return 'text-[#545E56]'
    }
  }

  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null

  return (
    <div className="border-t border-[#545E56] bg-[#FFF9F5]">
      {/* Header bar — always visible */}
      <div
        className="flex items-center justify-between px-4 py-2 cursor-pointer select-none hover:bg-[#EAE1DF] transition-colors"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isExpanded ? <CaretDown size={14} /> : <CaretUp size={14} />}
          <span className="text-xs uppercase tracking-wider text-[#1F0812] shrink-0">Console</span>
          <span className="text-xs text-[#545E56] shrink-0">({entries.length})</span>

          {/* Active process indicator */}
          {activeProcess && (
            <span className="flex items-center gap-1.5 text-xs text-[#B98B82] shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-[#B98B82] animate-pulse inline-block" />
              {activeProcess}
            </span>
          )}

          {/* Last message preview when collapsed */}
          {!isExpanded && !activeProcess && lastEntry && (
            <span className={`text-xs truncate min-w-0 ${getLevelColor(lastEntry.level)}`}>
              {lastEntry.message}
            </span>
          )}
          {!isExpanded && activeProcess && lastEntry && (
            <span className="text-xs text-[#545E56] truncate min-w-0">
              {lastEntry.message}
            </span>
          )}
          {!isExpanded && !lastEntry && (
            <span className="text-xs text-[#545E56]/50">Idle — waiting for processes</span>
          )}
        </div>

        <Button
          onClick={e => { e.stopPropagation(); onClear() }}
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 shrink-0"
        >
          <X size={14} />
        </Button>
      </div>

      {/* Log body — only when expanded */}
      {isExpanded && (
        <div
          ref={scrollRef}
          className="h-52 overflow-y-auto border-t border-[#545E56]/30"
        >
          <div className="p-3 space-y-0.5 font-mono text-xs">
            {entries.length === 0 ? (
              <div className="text-center py-8 text-[#545E56]/50 text-xs">
                No entries yet — processes will report here
              </div>
            ) : (
              entries.map((entry, i) => (
                <div key={i} className="flex gap-2 items-start leading-relaxed">
                  <span className="text-[#545E56]/60 shrink-0 tabular-nums text-[10px] pt-px">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span className={`shrink-0 w-[52px] text-[10px] uppercase tabular-nums ${getLevelColor(entry.level)}`}>
                    [{entry.level}]
                  </span>
                  <span className={`flex-1 break-all ${getLevelColor(entry.level)}`}>
                    {entry.message}
                  </span>
                  {entry.data != null && (
                    <span className="text-[#545E56] text-[10px] shrink-0 ml-2">
                      {typeof entry.data === 'object' ? JSON.stringify(entry.data) : String(entry.data)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
