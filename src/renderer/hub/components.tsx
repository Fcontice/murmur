import type { ReactNode } from 'react'
import { keyLabel, sortKeys } from '@shared/settings'
import type { ModelStatus } from '@shared/types'
import { formatBytes } from './hooks'

export function Keys({ keys }: { keys: number[] }) {
  return (
    <span className="keys">
      {sortKeys(keys).map((key) => (
        <kbd key={key}>{keyLabel(key)}</kbd>
      ))}
    </span>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)}>
      <span />
    </button>
  )
}

export function Row({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">{title}</div>
        {description && <div className="row-description">{description}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  )
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className="card">{children}</div>
    </section>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label?: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

/** A downloadable item. Without `onSelect` it is an optional add-on rather than one of a set of choices. */
export function ModelRow({ model, selected = false, onSelect }: { model: ModelStatus; selected?: boolean; onSelect?: () => void }) {
  const api = window.murmur
  return (
    <div className={`model ${selected ? 'selected' : ''}`}>
      <label className="model-main">
        {onSelect && <input type="radio" checked={selected} onChange={onSelect} />}
        <span>
          <span className="model-name">
            {model.name}
            {model.recommended && <span className="badge">Recommended</span>}
          </span>
          <span className="model-meta">
            {model.description} {model.languages}. {formatBytes(model.sizeBytes)}.
          </span>
          {model.error && <span className="model-error">{model.error}</span>}
        </span>
      </label>
      <div className="model-actions">
        {model.downloading ? (
          <>
            <div className="progress" aria-label={`Downloading ${model.name}`}>
              <div style={{ width: `${Math.round(model.progress * 100)}%` }} />
            </div>
            <span className="progress-label">{Math.round(model.progress * 100)}%</span>
            <button type="button" className="button ghost" onClick={() => void api.cancelModel(model.id)}>
              Cancel
            </button>
          </>
        ) : model.installed ? (
          <>
            <span className="installed">Installed</span>
            <button type="button" className="button ghost" onClick={() => void api.removeModel(model.id)}>
              Remove
            </button>
          </>
        ) : (
          <button type="button" className="button" onClick={() => void api.downloadModel(model.id)}>
            {model.error ? 'Retry' : 'Download'}
          </button>
        )}
      </div>
    </div>
  )
}
