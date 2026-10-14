import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryEntry } from '@shared/types'
import { Empty } from '../components'

const api = window.murmur
const PAGE_SIZE = 50

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

function Entry({ entry, onDelete }: { entry: HistoryEntry; onDelete: () => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = entry.finalText || entry.rawText
  // A failed command that pasted text fails with focus_changed instead, so only these mean an app or site did not open.
  const openFailed = entry.status === 'failed' && (entry.error === 'launch_failed' || entry.error === 'open_failed')
  // Actions and empty commands paste nothing, so word counts and clean-up do not apply.
  const pastedNothing = entry.status === 'action' || openFailed || (entry.mode === 'command' && entry.status === 'empty')

  const copy = async () => {
    await api.copyText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="list-row">
      <div className="list-meta">
        {new Date(entry.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        {entry.appName && <span> · {entry.appName}</span>}
        {entry.mode === 'command' && <span className="badge warn">Command</span>}
        {entry.status === 'copied' && <span className="badge bad">Not inserted, copied instead</span>}
        {entry.status === 'action' && <span className="badge">Action</span>}
        {openFailed && <span className="badge bad">Could not open</span>}
        <span className="list-actions">
          <button type="button" className="link" onClick={() => setOpen(!open)}>
            {open ? 'Hide details' : 'Details'}
          </button>
          <button type="button" className="link" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="link danger" onClick={onDelete}>
            Delete
          </button>
        </span>
      </div>
      <div className="list-text">{text}</div>
      {open && (
        <div className="details">
          <div className="details-label">What was heard</div>
          <div className="details-text">{entry.rawText}</div>
          <div className="details-label">
            {(entry.durationMs / 1000).toFixed(1)} s of speech{pastedNothing ? '' : ` · ${entry.wordCount} words`} · transcribed in {entry.asrMs} ms
            {pastedNothing ? '' : entry.usedLlm ? ` · cleaned up in ${entry.llmMs} ms` : ' · basic clean-up'}
          </div>
        </div>
      )}
    </div>
  )
}

export function History() {
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const latestQuery = useRef(query)

  const load = useCallback(async (search: string, offset: number) => {
    latestQuery.current = search
    const batch = await api.listHistory(search, PAGE_SIZE, offset)
    if (latestQuery.current !== search) return
    setEntries((current) => (offset === 0 ? batch : [...current, ...batch]))
    setHasMore(batch.length === PAGE_SIZE)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => void load(query, 0), 150)
    return () => clearTimeout(timer)
  }, [query, load])

  useEffect(() => api.onHistory(() => void load(latestQuery.current, 0)), [load])

  const remove = async (id: string) => {
    await api.deleteHistory(id)
    setEntries((current) => current.filter((entry) => entry.id !== id))
  }

  const groups = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    const label = dayLabel(entry.createdAt)
    groups.set(label, [...(groups.get(label) ?? []), entry])
  }

  return (
    <div className="page">
      <header className="page-header split">
        <div>
          <h1>History</h1>
          <p>Everything you have dictated. Stored only on this computer.</p>
        </div>
        {entries.length > 0 &&
          (confirmClear ? (
            <span className="confirm">
              Delete all history?
              <button
                type="button"
                className="button danger"
                onClick={async () => {
                  await api.clearHistory()
                  setConfirmClear(false)
                  void load(query, 0)
                }}
              >
                Delete all
              </button>
              <button type="button" className="button ghost" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="button ghost" onClick={() => setConfirmClear(true)}>
              Clear history
            </button>
          ))}
      </header>

      <input className="input search" type="search" placeholder="Search dictations" value={query} onChange={(event) => setQuery(event.target.value)} />

      {entries.length === 0 ? (
        <Empty title={query ? 'No matches' : 'No history yet'}>{query ? 'Try a different search.' : 'Dictations are listed here as you make them.'}</Empty>
      ) : (
        [...groups.entries()].map(([label, items]) => (
          <section key={label} className="section">
            <header>
              <h2>{label}</h2>
            </header>
            <div className="card list">
              {items.map((entry) => (
                <Entry key={entry.id} entry={entry} onDelete={() => void remove(entry.id)} />
              ))}
            </div>
          </section>
        ))
      )}
      {hasMore && (
        <button type="button" className="button ghost center" onClick={() => void load(query, entries.length)}>
          Load more
        </button>
      )}
    </div>
  )
}
