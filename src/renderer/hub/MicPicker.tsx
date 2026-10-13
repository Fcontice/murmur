import { useEffect, useRef, useState } from 'react'
import type { MicDevice } from '@shared/types'

interface Props {
  value: string | null
  onChange: (deviceId: string | null) => void
}

/** Microphone selector with a live input meter, so a muted or wrong device is obvious before dictating. */
export function MicPicker({ value, onChange }: Props) {
  const [devices, setDevices] = useState<MicDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [testing, setTesting] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    const list = async () => {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDevices(
        all
          .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications')
          .map((device) => ({ deviceId: device.deviceId, label: device.label || 'Microphone' })),
      )
    }
    // Device names are only revealed after access has been granted once.
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => stream.getTracks().forEach((track) => track.stop()))
      .then(list)
      .catch(() => setError('Microphone access is blocked. Allow it under Windows Settings › Privacy & security › Microphone.'))
    navigator.mediaDevices.addEventListener('devicechange', list)
    return () => navigator.mediaDevices.removeEventListener('devicechange', list)
  }, [])

  useEffect(() => {
    if (!testing) return
    let cancelled = false
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: value ? { deviceId: { exact: value } } : true })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        const context = new AudioContext()
        const analyser = context.createAnalyser()
        analyser.fftSize = 1024
        context.createMediaStreamSource(stream).connect(analyser)
        const buffer = new Float32Array(analyser.fftSize)
        let frame = 0
        const tick = () => {
          analyser.getFloatTimeDomainData(buffer)
          let sum = 0
          for (const sample of buffer) sum += sample * sample
          const db = 20 * Math.log10(Math.sqrt(sum / buffer.length) + 1e-10)
          setLevel(Math.min(1, Math.max(0, (db + 55) / 40)))
          frame = requestAnimationFrame(tick)
        }
        tick()
        cleanup.current = () => {
          cancelAnimationFrame(frame)
          stream.getTracks().forEach((track) => track.stop())
          void context.close()
        }
        setError(null)
      } catch {
        setError('Could not open that microphone. It may be unplugged or in use.')
        setTesting(false)
      }
    })()
    return () => {
      cancelled = true
      cleanup.current?.()
      cleanup.current = null
      setLevel(0)
    }
  }, [testing, value])

  const known = value === null || devices.some((device) => device.deviceId === value)

  return (
    <div className="mic">
      <div className="mic-controls">
        <select className="input" value={known ? (value ?? '') : ''} onChange={(event) => onChange(event.target.value || null)} aria-label="Microphone">
          <option value="">System default</option>
          {devices.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
        <button type="button" className="button" onClick={() => setTesting(!testing)}>
          {testing ? 'Stop test' : 'Test'}
        </button>
      </div>
      {testing && (
        <div className="meter" role="meter" aria-label="Input level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
          <div style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
      )}
      {testing && <div className="row-description">Speak normally. The bar should move well past halfway.</div>}
      {!known && <div className="form-error">The saved microphone is not connected, so the system default is used.</div>}
      {error && <div className="form-error">{error}</div>}
    </div>
  )
}
