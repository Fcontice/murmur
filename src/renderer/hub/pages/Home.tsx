import { useEffect, useState } from 'react'
import type { EngineStatus, HistoryEntry, Settings, Stats } from '@shared/types'
import { Empty, Keys } from '../components'
import { formatNumber } from '../hooks'

const api = window.murmur

interface Props {
  settings: Settings
  status: EngineStatus
  goTo: (page: 'history' | 'settings') => void
}

function problems(status: EngineStatus): string[] {
  const list: string[] = []
  if (status.helper === 'failed') list.push('The keyboard helper could not start, so shortcuts will not work. Restart Murmur.')
  if (status.asr === 'unavailable' || status.asr === 'failed') list.push(status.asrDetail || 'No speech model is ready.')
  if (status.llm === 'unavailable' || status.llm === 'failed') list.push(`${status.llmDetail || 'The language model is not ready.'} Dictation still works with basic clean-up.`)
  return list
}

export function Home({ settings, status, goTo }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [recent, setRecent] = useState<HistoryEntry[]>([])

  useEffect(() => {
    const refresh = () => {
      void api.getStats().then(setStats)
      void api.listHistory('', 5, 0).then(setRecent)
    }
    refresh()
    return api.onHistory(refresh)
  }, [])

  const issues = problems(status)
  // Typing averages about 40 words a minute; the difference is time handed back.
  const minutesSaved = stats ? Math.max(0, Math.round(stats.totalWords / 40 - stats.totalSpeechMs / 60_000)) : 0

  return (
    <div className="page">
      <header className="page-header">
        <h1>Speak, and it is written</h1>
        <p>
          Put the cursor in any text field, hold <Keys keys={settings.shortcuts.ptt} /> and talk. Release to insert.
        </p>
      </header>

      {issues.length > 0 && (
        <div className="banner">
          <div>
            {issues.map((issue) => (
              <div key={issue}>{issue}</div>
            ))}
          </div>
          <button type="button" className="button" onClick={() => goTo('settings')}>
            Open settings
          </button>
        </div>
      )}

      <div className="stats">
        <div className="stat">
          <div className="stat-value">{formatNumber(stats?.totalWords ?? 0)}</div>
          <div className="stat-label">words dictated</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats?.wordsPerMinute ?? 0}</div>
          <div className="stat-label">words per minute</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatNumber(minutesSaved)}</div>
          <div className="stat-label">minutes saved vs typing</div>
        </div>
        <div className="stat">
          <div className="stat-value">{stats?.streakDays ?? 0}</div>
          <div className="stat-label">day streak</div>
        </div>
      </div>

      <section className="section">
        <header>
          <h2>Try it here</h2>
        </header>
        <textarea className="try" rows={4} placeholder="Click here, hold the shortcut and say something…" />
      </section>

      <section className="section">
        <header>
          <h2>Shortcuts</h2>
        </header>
        <div className="card shortcuts">
          <div><Keys keys={settings.shortcuts.ptt} /><span>Hold to dictate. Double-tap to stay on hands-free.</span></div>
          <div><Keys keys={settings.shortcuts.handsFree} /><span>Start or stop hands-free dictation.</span></div>
          <div><Keys keys={settings.shortcuts.command} /><span>Command mode: select text, hold, and say how to change it.</span></div>
          <div><Keys keys={settings.shortcuts.pasteLast} /><span>Insert the last dictation again.</span></div>
          <div><Keys keys={settings.shortcuts.cancel} /><span>Cancel while recording.</span></div>
        </div>
      </section>

      <section className="section">
        <header className="split">
          <h2>Recent</h2>
          {recent.length > 0 && (
            <button type="button" className="link" onClick={() => goTo('history')}>
              View all
            </button>
          )}
        </header>
        {recent.length === 0 ? (
          <Empty title="Nothing dictated yet">Your dictations appear here and stay on this computer.</Empty>
        ) : (
          <div className="card list">
            {recent.map((entry) => (
              <div key={entry.id} className="list-row">
                <div className="list-meta">
                  {new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  {entry.appName && <span> · {entry.appName}</span>}
                </div>
                <div className="list-text clamp">{entry.finalText || entry.rawText}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
