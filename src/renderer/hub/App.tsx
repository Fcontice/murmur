import { useState } from 'react'
import { useModels, useSettings, useStatus } from './hooks'
import { Commands } from './pages/Commands'
import { Dictionary } from './pages/Dictionary'
import { History } from './pages/History'
import { Home } from './pages/Home'
import { Onboarding } from './pages/Onboarding'
import { SettingsPage } from './pages/Settings'
import { Snippets } from './pages/Snippets'
import { Style } from './pages/Style'

const PAGES = [
  { id: 'home', label: 'Home' },
  { id: 'history', label: 'History' },
  { id: 'dictionary', label: 'Dictionary' },
  { id: 'snippets', label: 'Snippets' },
  { id: 'commands', label: 'Commands' },
  { id: 'style', label: 'Style' },
  { id: 'settings', label: 'Settings' },
] as const

type PageId = (typeof PAGES)[number]['id']

export function App() {
  const [settings, update] = useSettings()
  const status = useStatus()
  const models = useModels()
  const [page, setPage] = useState<PageId>('home')

  if (!settings || !status) return null
  if (!settings.onboarded) return <Onboarding settings={settings} update={update} status={status} models={models} />

  const ready = status.helper === 'ready' && status.asr === 'ready'
  const busy = status.asr === 'loading' || status.llm === 'loading' || status.helper === 'starting'

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
          Gloop Voice
        </div>
        {PAGES.map((item) => (
          <button key={item.id} type="button" className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}>
            {item.label}
          </button>
        ))}
        <div className="sidebar-footer">
          <span className={`status-dot ${ready ? 'ok' : busy ? 'busy' : 'bad'}`} />
          {ready ? 'Ready' : busy ? 'Starting…' : 'Needs attention'}
        </div>
      </nav>
      <main className="content">
        {page === 'home' && <Home settings={settings} status={status} goTo={(target) => setPage(target)} />}
        {page === 'history' && <History />}
        {page === 'dictionary' && <Dictionary />}
        {page === 'snippets' && <Snippets />}
        {page === 'commands' && <Commands settings={settings} update={update} />}
        {page === 'style' && <Style settings={settings} update={update} status={status} />}
        {page === 'settings' && <SettingsPage settings={settings} update={update} status={status} models={models} />}
      </main>
    </div>
  )
}
