/* 逐字取自 deepseek-ai/deepseek-harness@0d1f500 packages/client/ui-chat/src/client/chat/use-calendar-day.ts —— MIT，Copyright (c) 2026 DeepSeek。零改动：它只依赖同目录的 message-chrome.ts。 */
// Component-local calendar-day tick: memoized message rows keep stable props
// across midnight, so the IconActions clock needs a local day seat that
// re-fires at the next local midnight without reaching for framework hooks.

import { useEffect, useState } from 'react'
import { msUntilNextLocalMidnight, startOfLocalDay } from './message-chrome.ts'

/**
 * Local calendar-day epoch that advances at each local midnight.
 * @returns Midnight ms for the current local day; updates after the boundary.
 */
export function useCalendarDay(): number {
  const [day, setDay] = useState(() => startOfLocalDay(Date.now()))
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      const now = Date.now()
      setDay(startOfLocalDay(now))
      timer = setTimeout(arm, msUntilNextLocalMidnight(now))
    }
    timer = setTimeout(arm, msUntilNextLocalMidnight(Date.now()))
    return () => { clearTimeout(timer) }
  }, [])
  return day
}
