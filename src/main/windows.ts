import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'

const PILL_WIDTH = 460
const PILL_HEIGHT = 130
const PILL_MARGIN = 14

function load(window: BrowserWindow, page: 'hub' | 'pill'): void {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) void window.loadURL(`${devServer}/${page}.html`)
  else void window.loadFile(join(__dirname, '..', 'renderer', `${page}.html`))
}

const webPreferences = {
  preload: join(__dirname, '..', 'preload', 'index.js'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
}

function lockDown(window: BrowserWindow): void {
  // The UI is local files only; anything else opens in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
}

export function createHubWindow(icon: Electron.NativeImage): BrowserWindow {
  const window = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    show: false,
    backgroundColor: '#0a0a0b',
    title: 'Murmur',
    icon,
    autoHideMenuBar: true,
    webPreferences,
  })
  window.removeMenu()
  lockDown(window)
  load(window, 'hub')
  return window
}

/**
 * The pill floats above everything and must never take focus, or the text would have nowhere to go.
 * It also hosts the microphone capture, so it exists for the whole life of the app.
 */
export function createPillWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setIgnoreMouseEvents(true, { forward: true })
  lockDown(window)
  load(window, 'pill')
  positionPill(window)
  return window
}

/** Bottom centre of whichever display the pointer is on. */
export function positionPill(window: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  window.setBounds({
    x: Math.round(workArea.x + (workArea.width - PILL_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - PILL_HEIGHT - PILL_MARGIN),
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
  })
}
