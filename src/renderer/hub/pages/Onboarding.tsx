import { useEffect, useState } from 'react'
import type { EngineStatus, ModelStatus, Settings } from '@shared/types'
import { Keys, ModelRow } from '../components'
import { formatBytes } from '../hooks'
import { MicPicker } from '../MicPicker'

const api = window.murmur

interface Props {
  settings: Settings
  update: (patch: Partial<Settings>) => Promise<string | null>
  status: EngineStatus
  models: ModelStatus[]
}

const STEPS = ['Models', 'Microphone', 'Try it'] as const

export function Onboarding({ settings, update, status, models }: Props) {
  const [step, setStep] = useState(0)
  const asr = models.find((model) => model.id === settings.asrModel)
  const llm = models.find((model) => model.id === settings.llmModel)
  const asrModels = models.filter((model) => model.kind === 'asr')
  const llmModels = models.filter((model) => model.kind === 'llm')
  const wantsLlm = settings.llmProvider === 'local'
  const [nvidiaGpu, setNvidiaGpu] = useState(false)
  useEffect(() => void api.getAppInfo().then((info) => setNvidiaGpu(info.nvidiaGpu)), [])
  const gpuPack = nvidiaGpu ? models.find((model) => model.id === 'llama-cuda') : undefined
  const pending = [asr, wantsLlm ? llm : undefined, wantsLlm ? gpuPack : undefined].filter((model): model is ModelStatus => Boolean(model && !model.installed))
  const downloading = models.some((model) => model.downloading)

  const downloadAll = () => pending.forEach((model) => void api.downloadModel(model.id))

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <div className="brand large">
          <span className="brand-mark" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
          Murmur
        </div>
        <ol className="steps">
          {STEPS.map((label, index) => (
            <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''}>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <>
            <h1>Everything runs on this computer</h1>
            <p className="lead">
              Murmur turns speech into text with models stored locally, so your voice and words stay private and it works offline. They need downloading once.
            </p>
            <h2>Speech recognition</h2>
            <div className="card">
              {asrModels.map((model) => (
                <ModelRow key={model.id} model={model} selected={model.id === settings.asrModel} onSelect={() => void update({ asrModel: model.id })} />
              ))}
            </div>
            <h2>
              AI clean-up <span className="optional">optional</span>
            </h2>
            <div className="card">
              {llmModels.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  selected={wantsLlm && model.id === settings.llmModel}
                  onSelect={() => void update({ llmModel: model.id, llmProvider: 'local' })}
                />
              ))}
              {wantsLlm && gpuPack && <ModelRow model={gpuPack} />}
              <div className="model">
                <label className="model-main">
                  <input type="radio" checked={!wantsLlm} onChange={() => void update({ llmProvider: 'off' })} />
                  <span>
                    <span className="model-name">Skip for now</span>
                    <span className="model-meta">Dictation works without it; you get punctuation but no filler removal or styles. You can add it, or point to your own server, in Settings.</span>
                  </span>
                </label>
              </div>
            </div>
            <div className="onboarding-actions">
              {pending.length > 0 && !downloading && (
                <button type="button" className="button primary" onClick={downloadAll}>
                  Download {formatBytes(pending.reduce((sum, model) => sum + model.sizeBytes, 0))}
                </button>
              )}
              <button type="button" className={`button ${pending.length === 0 ? 'primary' : ''}`} disabled={!asr?.installed} onClick={() => setStep(1)}>
                Continue
              </button>
              {!asr?.installed && <span className="row-description">{downloading ? 'Downloading… you can continue once the speech model is in.' : 'The speech model is required.'}</span>}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h1>Check your microphone</h1>
            <p className="lead">Pick the microphone you will dictate with and press Test to see it respond.</p>
            <div className="card">
              <MicPicker value={settings.microphoneId} onChange={(deviceId) => void update({ microphoneId: deviceId })} />
            </div>
            <div className="onboarding-actions">
              <button type="button" className="button ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button type="button" className="button primary" onClick={() => setStep(2)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Say something</h1>
            <p className="lead">
              Click in the box, hold <Keys keys={settings.shortcuts.ptt} />, speak, then let go. This works the same way in every app.
            </p>
            <textarea className="try" rows={5} autoFocus placeholder="Your words appear here…" />
            <div className="tips">
              <div><Keys keys={settings.shortcuts.ptt} /> twice quickly, or <Keys keys={settings.shortcuts.handsFree} />, keeps listening hands-free.</div>
              <div><Keys keys={settings.shortcuts.command} /> edits selected text by voice: “make this shorter”.</div>
              <div><Keys keys={settings.shortcuts.cancel} /> cancels.</div>
            </div>
            {status.asr !== 'ready' && <div className="banner"><div>{status.asrDetail || 'The speech model is loading…'}</div></div>}
            {status.helper !== 'ready' && <div className="banner"><div>The keyboard helper is still starting. Shortcuts work once it is ready.</div></div>}
            <div className="onboarding-actions">
              <button type="button" className="button ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="button primary" onClick={() => void update({ onboarded: true })}>
                Finish setup
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
