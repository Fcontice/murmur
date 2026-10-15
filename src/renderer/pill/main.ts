import type { CaptureConfig } from '@shared/api'
import type { PillState } from '@shared/types'
import { Recorder } from './capture'
import { playSound } from './sounds'

const api = window.gloopVoicePill
const pill = document.getElementById('pill')!
const hint = pill.querySelector<HTMLElement>('.hint')!
const notice = pill.querySelector<HTMLElement>('.notice')!
const bars = pill.querySelector<HTMLElement>('.bars')!

const BAR_COUNT = 11
// Centre bars move most, so the meter reads as a voice shape rather than a flat block.
const BAR_WEIGHTS = Array.from({ length: BAR_COUNT }, (_, index) => 0.35 + 0.65 * Math.sin((Math.PI * (index + 0.5)) / BAR_COUNT))
const barElements = BAR_WEIGHTS.map(() => bars.appendChild(document.createElement('i')))

let config: CaptureConfig = { microphoneId: null, keepMicWarm: false, sounds: true, showPillWhenIdle: true, pttLabel: 'Ctrl + Win' }
let targetLevel = 0
let smoothedLevel = 0
let animating = false

function drawBars(): void {
  smoothedLevel = smoothedLevel * 0.7 + targetLevel * 0.3
  const time = performance.now() / 140
  barElements.forEach((bar, index) => {
    const wobble = 0.75 + 0.25 * Math.sin(time + index * 1.7)
    bar.style.height = `${Math.round(3 + smoothedLevel * BAR_WEIGHTS[index]! * wobble * 19)}px`
  })
  if (animating) requestAnimationFrame(drawBars)
}

function render(state: PillState): void {
  pill.dataset.phase = state.phase
  pill.dataset.mode = state.mode
  pill.dataset.locked = String(state.locked)
  pill.dataset.kind = state.notice?.kind ?? ''
  notice.textContent = state.notice?.text ?? ''

  const listening = state.phase === 'listening'
  if (listening && !animating) {
    animating = true
    requestAnimationFrame(drawBars)
  } else if (!listening) {
    animating = false
    targetLevel = 0
    smoothedLevel = 0
  }
}

function applyConfig(next: CaptureConfig): void {
  config = next
  pill.dataset.hidden = String(!next.showPillWhenIdle)
  hint.innerHTML = ''
  hint.append('Hold ', Object.assign(document.createElement('b'), { textContent: next.pttLabel }), ' and speak')
  recorder.configure(next.microphoneId, next.keepMicWarm)
}

const recorder = new Recorder({
  onStarted: (sessionId) => api.captureStarted(sessionId),
  onChunk: (sessionId, pcm) => api.captureChunk(sessionId, pcm),
  onStopped: (sessionId) => api.captureStopped(sessionId),
  onFailed: (sessionId, message) => api.captureFailed(sessionId, message),
  onLevel: (level) => {
    targetLevel = level
  },
})

api.onState(render)
api.onConfig(applyConfig)
api.onCaptureStart((sessionId) => void recorder.start(sessionId))
api.onCaptureStop((sessionId) => recorder.stop(sessionId))
api.onSound((name) => config.sounds && playSound(name))

// The window is click-through except while the pointer is on the pill.
let interactive = false
window.addEventListener('mousemove', (event) => {
  const over = pill.contains(document.elementFromPoint(event.clientX, event.clientY))
  if (over === interactive) return
  interactive = over
  api.setInteractive(over)
})
window.addEventListener('mouseleave', () => {
  if (!interactive) return
  interactive = false
  api.setInteractive(false)
})

pill.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')
  if (button) api.action(button.dataset.action as 'finish' | 'cancel')
  else if (pill.dataset.phase === 'idle') api.action('openHub')
})

api.ready()
