import { useCallback, useEffect, useState } from 'react'
import type { EngineStatus, ModelStatus, Settings } from '@shared/types'

const api = window.gloopVoice

export function useSettings(): [Settings | null, (patch: Partial<Settings>) => Promise<string | null>] {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    void api.getSettings().then(setSettings)
    return api.onSettings(setSettings)
  }, [])
  /** Resolves with an error message when the change is rejected. */
  const update = useCallback(async (patch: Partial<Settings>) => {
    try {
      setSettings(await api.updateSettings(patch))
      return null
    } catch (error) {
      return errorMessage(error)
    }
  }, [])
  return [settings, update]
}

export function useStatus(): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  useEffect(() => {
    void api.getStatus().then(setStatus)
    return api.onStatus(setStatus)
  }, [])
  return status
}

export function useModels(): ModelStatus[] {
  const [models, setModels] = useState<ModelStatus[]>([])
  useEffect(() => {
    void api.listModels().then(setModels)
    return api.onModels(setModels)
  }, [])
  return models
}

/** Electron prefixes errors thrown across IPC; show only what we wrote. */
export function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${Math.round(bytes / 1e6)} MB`
}

export function formatNumber(value: number): string {
  return value.toLocaleString()
}
