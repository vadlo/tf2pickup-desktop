const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  shell,
  dialog,
  screen,
} = require('electron')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const defaultSettings = {
  siteUrl: 'https://tf2pick-up.ru/',
  autoConnect: false,
  autoJoin: false,
  autoPreReady: true,
  autoReady: false,
  autoRequeue: true,
  requeueQueue: '6v6',
  requeueClass: 'soldier',
  requeueSlot: 1,
  notifyAutoActions: true,
  minimizeOnJoin: true,
  closeToTray: true,
  notifyReadyUp: true,
  notifyServerReady: true,
  trayChat: true,
  faceitTheme: true,
  launchOnStartup: false,
  launchMode: 'steam-uri',
  steamExePath: '',
  launchOptions: '',
}

let settings = { ...defaultSettings }
let mainWindow
let settingsWindow
let chatPopup
let tray
let isQuitting = false
let chatMessages = []
let queueState = null
let trayUpdateTimer = null
let popupHiddenAt = 0
let popupShownAt = 0
let chatSendSeq = 0
const chatSendPending = new Map()

let siteThemeCss = ''
const insertedThemeKeys = new WeakMap()

const themeFile = name => path.join(__dirname, 'theme', name)

function loadSiteThemeCss() {
  if (siteThemeCss) return siteThemeCss
  try {
    siteThemeCss = [
      fs.readFileSync(themeFile('fonts.css'), 'utf8'),
      fs.readFileSync(themeFile('faceit.css'), 'utf8'),
    ].join('\n')
  } catch (error) {
    console.error('Не удалось загрузить тему FACEIT:', error)
    siteThemeCss = ''
  }
  return siteThemeCss
}

async function applySiteTheme(webContents) {
  if (!webContents || webContents.isDestroyed()) return

  const css = settings.faceitTheme ? loadSiteThemeCss() : ''
  const previous = insertedThemeKeys.get(webContents)

  try {
    if (previous) {
      insertedThemeKeys.delete(webContents)
      await webContents.removeInsertedCSS(previous)
    }
    if (css) insertedThemeKeys.set(webContents, await webContents.insertCSS(css))
  } catch (error) {
    // A page can be replaced while the CSS is being applied; the next load
    // re-applies the theme anyway.
  }
}

const queueModes = [
  { value: '6v6', label: '6v6' },
  { value: '9v9', label: '9v9' },
  { value: 'ultiduo', label: 'Ultiduo' },
  { value: '4v4', label: '4v4' },
  { value: '3v3', label: 'Ultitrio (3v3)' },
]

// Mirrors the table in settings.js: total slots per class in each queue.
const queueClasses = {
  '6v6': { scout: 4, soldier: 4, demoman: 2, medic: 2 },
  '9v9': {
    scout: 2,
    soldier: 2,
    pyro: 2,
    demoman: 2,
    heavy: 2,
    engineer: 2,
    medic: 2,
    sniper: 2,
    spy: 2,
  },
  ultiduo: { soldier: 2, medic: 2 },
  '4v4': { scout: 2, soldier: 2, demoman: 2, medic: 2 },
  '3v3': { scout: 2, soldier: 2, medic: 2 },
}

const classLabels = {
  scout: 'Скаут',
  soldier: 'Солдат',
  pyro: 'Пироман',
  demoman: 'Подрывник',
  heavy: 'Тяжёлый',
  engineer: 'Инженер',
  medic: 'Медик',
  sniper: 'Снайпер',
  spy: 'Шпион',
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
const iconFile = name =>
  app.isPackaged ? path.join(process.resourcesPath, 'icons', name) : path.join(__dirname, 'icons', name)

const steamAuthHosts = new Set([
  'steamcommunity.com',
  'www.steamcommunity.com',
  'steampowered.com',
  'www.steampowered.com',
])

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    settings = { ...defaultSettings, ...saved }
  } catch {
    settings = { ...defaultSettings }
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to save settings:', error)
  }
}

function broadcastSettings() {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window.webContents) {
      window.webContents.send('settings:changed', { ...settings })
    }
  }
}

function applyStartupSetting() {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.launchOnStartup })
  }
}

function isSameSite(url) {
  try {
    return new URL(url).host === new URL(settings.siteUrl).host
  } catch {
    return false
  }
}

function parseSteamConnect(url) {
  const match = /^steam:\/\/connect\/([^/?#]+)(?:\/([^?#]+))?/i.exec(url)
  if (!match) return undefined

  const rawHost = decodeURIComponent(match[1])
  const separator = rawHost.lastIndexOf(':')
  const address = separator > -1 ? rawHost.slice(0, separator) : rawHost
  const port = separator > -1 ? rawHost.slice(separator + 1) : undefined
  const password = match[2] ? decodeURIComponent(match[2]) : undefined

  return {
    address,
    port,
    password,
    endpoint: port ? `${address}:${port}` : address,
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: iconFile('app.ico') }).show()
      return
    }
  } catch (error) {
    console.error('Notification failed:', error)
  }

  tray?.displayBalloon({ title, content: body, icon: nativeImageForTray() })
}

function nativeImageForTray() {
  const { nativeImage } = require('electron')
  return nativeImage.createFromPath(iconFile('tray.ico'))
}

function findSteamExecutable() {
  const configured = settings.steamExePath?.trim()
  if (configured && fs.existsSync(configured)) return configured

  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { encoding: 'utf8' },
    )
    const match = /REG_SZ\s+(.+)/.exec(output)
    if (match?.[1]) {
      const candidate = path.join(match[1].trim(), 'steam.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {
    // Registry key is optional; fall back to the standard installation paths.
  }

  const candidates = [
    'C:\\Program Files (x86)\\Steam\\steam.exe',
    'C:\\Program Files\\Steam\\steam.exe',
  ]
  return candidates.find(candidate => fs.existsSync(candidate))
}

async function launchTeamFortress(connectUrl, server) {
  if (settings.launchMode === 'steam-exe') {
    const steamExe = findSteamExecutable()
    if (!steamExe) {
      throw new Error(
        'Steam.exe не найден. Укажите путь к Steam в настройках или используйте режим "Steam URI".',
      )
    }

    const args = ['-applaunch', '440']
    const launchOptions = settings.launchOptions.trim()
    if (launchOptions) args.push(...launchOptions.split(/\s+/))
    args.push('+connect', server.endpoint)
    if (server.password) args.push('+password', server.password)

    const child = spawn(steamExe, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', error => console.error('Failed to start Steam:', error))
    child.unref()
    return
  }

  await shell.openExternal(connectUrl)
}

async function requestConnect(connectUrl, skipConfirmation = false) {
  const server = parseSteamConnect(connectUrl)
  if (!server) return

  if (!skipConfirmation && !settings.autoConnect) {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const result = await dialog.showMessageBox(parent, {
      type: 'question',
      title: 'Подключение к игре',
      message: `Запустить Team Fortress 2 и подключиться к ${server.endpoint}?`,
      detail: server.password ? 'Сервер защищён паролем, он будет передан автоматически.' : undefined,
      buttons: ['Подключиться', 'Отмена', 'Всегда подключать'],
      defaultId: 0,
      cancelId: 1,
    })

    if (result.response === 1) return
    if (result.response === 2) {
      settings.autoConnect = true
      saveSettings()
    }
  }

  try {
    await launchTeamFortress(connectUrl, server)
    notify('TF2Pickup', `Запускаем TF2, подключаемся к ${server.endpoint}`)
    if (settings.minimizeOnJoin) mainWindow?.minimize()
  } catch (error) {
    dialog.showErrorBox('Не удалось запустить TF2', String(error?.message ?? error))
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function handleNavigation(event, url) {
  if (/^steam:\/\/connect\//i.test(url)) {
    event.preventDefault()
    requestConnect(url)
    return
  }

  if (/^steam:\/\//i.test(url)) {
    event.preventDefault()
    shell.openExternal(url)
    return
  }

  if (!/^https?:\/\//i.test(url)) return

  const host = hostOf(url)
  // Steam OpenID must complete inside the app window so the session cookie is set here.
  if (isSameSite(url) || steamAuthHosts.has(host)) return

  event.preventDefault()
  shell.openExternal(url)
}

// The site is a desktop layout. Instead of enlarging it, scale the whole page
// so the design fits the window with as little scrolling as possible: first
// fit the design width (never above 100%), then shrink further while the page
// is still taller than the viewport. The reference width matches the default
// window, so 1366 px wide -> 100%.
const ZOOM_REFERENCE_WIDTH = 1366
const ZOOM_MIN = 0.5
const ZOOM_MAX = 1
// Shrinking the whole page to fit its full height quickly makes text unreadable
// on long pages, so the height-driven shrink stops at a readable scale. The
// width-driven scale may go lower, because that is required to fit narrow
// windows without horizontal scrolling.
const ZOOM_HEIGHT_FLOOR = 0.7

let autoZoomTimer = null
let autoZoomSeq = 0
let transitionDisableKey = null

function readPageMetrics(webContents) {
  const read = webContents
    .executeJavaScript(
      `(() => {
        const doc = document.documentElement
        const body = document.body
        return {
          scrollHeight: Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0),
          innerHeight: window.innerHeight,
        }
      })()`,
      true,
    )
    .catch(() => null)
  // Never let a measurement block the next fit attempt.
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), 1200))
  return Promise.race([read, timeout])
}

function disableTransitionsTemporarily(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  if (transitionDisableKey) return
  try {
    transitionDisableKey = webContents.insertCSS(
      '* { transition: none !important; animation: none !important; }',
    )
    setTimeout(() => {
      if (transitionDisableKey) {
        try {
          webContents.removeInsertedCSS(transitionDisableKey)
        } catch {
          // Ignore.
        }
        transitionDisableKey = null
      }
    }, 600)
  } catch {
    // Ignore.
  }
}

function applyWidthZoom(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [width] = mainWindow.getContentSize()
  if (!width) return
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, width / ZOOM_REFERENCE_WIDTH))
  try {
    if (Math.abs(webContents.getZoomFactor() - zoom) > 0.001) webContents.setZoomFactor(zoom)
  } catch (error) {
    // Ignore.
  }
}

async function applyAutoZoom(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [width] = mainWindow.getContentSize()
  if (!width) return

  const seq = ++autoZoomSeq
  const widthZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, width / ZOOM_REFERENCE_WIDTH))
  const heightFloor = Math.min(widthZoom, ZOOM_HEIGHT_FLOOR)
  let zoom = widthZoom

  try {
    if (Math.abs(webContents.getZoomFactor() - zoom) > 0.001) webContents.setZoomFactor(zoom)
    // One correction pass: if the page is still taller than the viewport,
    // shrink (but no lower than the readable floor). Re-measure once more
    // afterwards because the responsive layout follows the new zoom.
    const metrics = await readPageMetrics(webContents)
    if (seq !== autoZoomSeq) return
    if (metrics && metrics.innerHeight) {
      const ratio = metrics.innerHeight / Math.max(1, metrics.scrollHeight)
      if (ratio < 0.995) {
        const next = Math.max(heightFloor, zoom * ratio)
        if (next < zoom - 0.002) {
          zoom = next
          webContents.setZoomFactor(zoom)
          const second = await readPageMetrics(webContents)
          if (seq !== autoZoomSeq) return
          if (second && second.innerHeight) {
            const ratio2 = second.innerHeight / Math.max(1, second.scrollHeight)
            if (ratio2 < 0.995) {
              const next2 = Math.max(heightFloor, zoom * ratio2)
              if (next2 < zoom - 0.002) {
                zoom = next2
                webContents.setZoomFactor(zoom)
              }
            }
          }
        }
      }
    }
  } catch (error) {
    // Ignore: the page can be replaced while the zoom is applied.
  }
}

function scheduleAutoZoom(webContents) {
  if (autoZoomTimer) clearTimeout(autoZoomTimer)
  autoZoomTimer = setTimeout(() => {
    autoZoomTimer = null
    void applyAutoZoom(webContents)
  }, 50)
}

function attachZoom(webContents) {
  if (!webContents || webContents.isDestroyed()) return
  try {
    webContents.setVisualZoomLevelLimits(ZOOM_MIN, 3)
  } catch (error) {
    // Older Electron builds may not support this; ignore.
  }
  webContents.on('before-input-event', (event, input) => {
    if (!(input.control || input.meta)) return
    const key = input.key
    if (key === '=' || key === '+') {
      webContents.setZoomLevel(webContents.getZoomLevel() + 0.5)
      event.preventDefault()
    } else if (key === '-') {
      webContents.setZoomLevel(webContents.getZoomLevel() - 0.5)
      event.preventDefault()
    } else if (key === '0') {
      webContents.setZoomLevel(0)
      event.preventDefault()
    }
  })
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide()
    return
  }

  mainWindow = new BrowserWindow({
    width: 1366,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'TF2Pickup',
    icon: iconFile('app.ico'),
    backgroundColor: settings.faceitTheme ? '#0a0b0e' : '#1b1b1b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.setMenu(null)
  // Apply the width-based zoom before the first paint so the site is never
  // shown unscaled, even for a moment.
  applyWidthZoom(mainWindow.webContents)
  mainWindow.loadURL(settings.siteUrl)
  attachZoom(mainWindow.webContents)
  mainWindow.webContents.on('dom-ready', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    applySiteTheme(mainWindow?.webContents)
    applyWidthZoom(mainWindow?.webContents)
    applyAutoZoom(mainWindow?.webContents)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    refit()
  })
  const refit = () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    // Apply the width zoom synchronously first to avoid a flash of the
    // un-scaled page, then refine for height asynchronously.
    applyWidthZoom(mainWindow?.webContents)
    scheduleAutoZoom(mainWindow?.webContents)
  }
  mainWindow.on('resize', refit)
  mainWindow.on('maximize', refit)
  mainWindow.on('unmaximize', refit)
  mainWindow.on('enter-full-screen', refit)
  mainWindow.on('leave-full-screen', refit)
  mainWindow.on('restore', refit)
  mainWindow.webContents.on('will-navigate', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    applyWidthZoom(mainWindow?.webContents)
  })
  mainWindow.webContents.on('did-start-navigation', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    applyWidthZoom(mainWindow?.webContents)
  })
  mainWindow.webContents.on('did-start-loading', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    applyWidthZoom(mainWindow?.webContents)
  })
  mainWindow.webContents.on('did-navigate', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    refit()
  })
  mainWindow.webContents.on('did-navigate-in-page', () => {
    disableTransitionsTemporarily(mainWindow?.webContents)
    refit()
  })
  applyAutoZoom(mainWindow.webContents)

  mainWindow.on('close', event => {
    if (isQuitting || !settings.closeToTray) return
    event.preventDefault()
    mainWindow.hide()
    notify('TF2Pickup', 'Приложение свернуто в трей. Нажмите на иконку, чтобы открыть.')
  })

  mainWindow.on('closed', () => {
    mainWindow = undefined
  })
}

function ensureWindowVisible(window) {
  try {
    const bounds = window.getBounds()
    const visible = screen.getAllDisplays().some(display => {
      const area = display.workArea
      return (
        bounds.x < area.x + area.width - 40 &&
        bounds.x + bounds.width > area.x + 40 &&
        bounds.y < area.y + area.height - 40 &&
        bounds.y + bounds.height > area.y + 40
      )
    })
    if (!visible) window.center()
  } catch {
    // Screen information can be unavailable while displays are being reconfigured.
  }
}

function focusSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) return false

  if (settingsWindow.isMinimized()) settingsWindow.restore()
  settingsWindow.show()
  settingsWindow.focus()
  settingsWindow.moveTop()
  return true
}

function createSettingsWindow() {
  if (focusSettingsWindow()) return
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide()

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 820,
    minWidth: 460,
    minHeight: 620,
    maxWidth: 900,
    maxHeight: 1200,
    resizable: true,
    // No `parent`: a child of the main window is not shown by Windows while the
    // main window is hidden in the tray, which made the settings window look
    // like it never opened.
    title: 'Настройки TF2Pickup',
    icon: iconFile('app.ico'),
    backgroundColor: '#17181c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  settingsWindow.setMenu(null)
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'))

  const reveal = () => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return
    ensureWindowVisible(settingsWindow)
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    settingsWindow.moveTop()
  }

  // Show explicitly instead of relying on a single "ready-to-show": a failed
  // paint must not leave the window invisible forever.
  reveal()
  setTimeout(reveal, 150)

  settingsWindow.on('closed', () => {
    settingsWindow = undefined
  })
}

function truncate(text, limit) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value
}

function escapeMenuLabel(text) {
  return String(text ?? '').replace(/&/g, '&&')
}

function openChat() {
  createMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return

  mainWindow.show()
  mainWindow.focus()

  const send = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:open')
  }
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

function chatPopupPosition(size) {
  const margin = 8
  const trayBounds = tray ? tray.getBounds() : { x: 0, y: 0, width: 0, height: 0 }
  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x || 0,
    y: trayBounds.y || 0,
  })
  const area = display.workArea
  let x
  let y

  if (trayBounds.width && trayBounds.height) {
    x = Math.round(trayBounds.x + trayBounds.width / 2 - size.width / 2)
    const below = trayBounds.y < area.y + area.height / 2
    y = below ? trayBounds.y + trayBounds.height + margin : trayBounds.y - size.height - margin
  } else {
    x = area.x + area.width - size.width - margin
    y = area.y + area.height - size.height - margin
  }

  x = Math.min(Math.max(area.x + margin, x), area.x + area.width - size.width - margin)
  y = Math.min(Math.max(area.y + margin, y), area.y + area.height - size.height - margin)
  return { x: Math.round(x), y: Math.round(y) }
}

function sendPopupState() {
  if (!chatPopup || chatPopup.isDestroyed()) return
  if (chatPopup.webContents.isLoading()) return
  chatPopup.webContents.send('chat:popup-messages', chatMessages)
}

function createChatPopup() {
  chatPopup = new BrowserWindow({
    width: 380,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: true,
    title: 'Чат TF2Pickup',
    icon: iconFile('app.ico'),
    backgroundColor: '#14151a',
    webPreferences: {
      preload: path.join(__dirname, 'chat-popup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  chatPopup.setMenu(null)
  chatPopup.loadFile(path.join(__dirname, 'chat-popup.html'))
  chatPopup.webContents.on('will-navigate', event => event.preventDefault())
  chatPopup.webContents.on('did-finish-load', sendPopupState)
  chatPopup.on('blur', () => {
    if (!chatPopup || chatPopup.isDestroyed()) return
    chatPopup.hide()
    popupHiddenAt = Date.now()
  })
  chatPopup.on('closed', () => {
    chatPopup = undefined
  })
}

function showChatPopup() {
  if (!chatPopup || chatPopup.isDestroyed()) createChatPopup()
  if (!chatPopup) return

  const [width, height] = chatPopup.getSize()
  const { x, y } = chatPopupPosition({ width, height })
  chatPopup.setPosition(x, y)
  chatPopup.show()
  chatPopup.focus()
  popupShownAt = Date.now()
  sendPopupState()
}

function toggleChatPopup() {
  if (chatPopup && !chatPopup.isDestroyed() && chatPopup.isVisible()) {
    // Ignore the second click of a double click: otherwise the popup would
    // open and immediately close again.
    if (Date.now() - popupShownAt < 400) return
    chatPopup.hide()
    popupHiddenAt = Date.now()
    return
  }
  // The popup hides itself on blur, so a click on the tray icon right after the
  // blur must not immediately reopen it.
  if (Date.now() - popupHiddenAt < 300) return
  showChatPopup()
}

function modeLabel(value) {
  return queueModes.find(mode => mode.value === value)?.label || value
}

function effectiveQueueConfig() {
  const mode = queueClasses[settings.requeueQueue] ? settings.requeueQueue : '6v6'
  const classes = queueClasses[mode]
  const gameClass = classes[settings.requeueClass] ? settings.requeueClass : Object.keys(classes)[0]
  const maxSlot = classes[gameClass] || 1
  const slot = Math.min(Math.max(1, Number(settings.requeueSlot) || 1), maxSlot)
  return { mode, gameClass, maxSlot, slot }
}

function requeueSettingsPatch(patch) {
  const mode = queueClasses[patch.requeueQueue] ? patch.requeueQueue : effectiveQueueConfig().mode
  const classes = queueClasses[mode]
  const requestedClass = patch.requeueClass || settings.requeueClass
  const gameClass = classes[requestedClass] ? requestedClass : Object.keys(classes)[0]
  const maxSlot = classes[gameClass] || 1
  const slot = Math.min(
    Math.max(1, Number(patch.requeueSlot || settings.requeueSlot) || 1),
    maxSlot,
  )
  return { requeueQueue: mode, requeueClass: gameClass, requeueSlot: slot }
}

function applySettings(next) {
  const previousTheme = settings.faceitTheme
  settings = { ...settings, ...next }
  saveSettings()
  applyStartupSetting()
  broadcastSettings()
  updateTray()

  if (Boolean(previousTheme) !== Boolean(settings.faceitTheme) && mainWindow && !mainWindow.isDestroyed()) {
    applySiteTheme(mainWindow.webContents)
  }

  return { ...settings }
}

function queueConfigMenu() {
  const { mode, gameClass, maxSlot, slot } = effectiveQueueConfig()
  const classes = queueClasses[mode]

  return [
    {
      label: 'Занять слот после лобби',
      type: 'checkbox',
      checked: Boolean(settings.autoRequeue),
      click: item => applySettings({ autoRequeue: Boolean(item.checked) }),
    },
    {
      label: `Режим: ${modeLabel(mode)}`,
      submenu: queueModes.map(item => ({
        label: item.label,
        type: 'radio',
        checked: item.value === mode,
        click: () => applySettings(requeueSettingsPatch({ requeueQueue: item.value })),
      })),
    },
    {
      label: `Класс: ${classLabels[gameClass] || gameClass}`,
      submenu: Object.keys(classes).map(name => ({
        label: classLabels[name] || name,
        type: 'radio',
        checked: name === gameClass,
        click: () => applySettings(requeueSettingsPatch({ requeueClass: name })),
      })),
    },
    {
      label: `Слот: ${slot}`,
      submenu: Array.from({ length: maxSlot }, (_, index) => ({
        label: `Слот ${index + 1}`,
        type: 'radio',
        checked: index + 1 === slot,
        click: () => applySettings({ requeueSlot: index + 1 }),
      })),
    },
  ]
}

function slotOccupancyMenu() {
  if (!queueState || !queueState.isQueuePage || queueState.slots.length === 0) {
    return [{ label: 'Нет данных — откройте страницу очереди', enabled: false }]
  }

  const perClass = new Map()
  for (const slot of queueState.slots) {
    const gameClass = slot.id.replace(/-\d+$/, '')
    const entry = perClass.get(gameClass) || { occupied: 0, total: 0 }
    entry.total += 1
    if (slot.occupied) entry.occupied += 1
    perClass.set(gameClass, entry)
  }

  const queueName = queueState.label || queueState.slug || 'очередь'
  const counts =
    queueState.current !== null && queueState.required !== null
      ? ` — ${queueState.current}/${queueState.required}`
      : ''
  const membership = queueState.inCurrentQueue
    ? ' — вы в очереди'
    : queueState.inAnyQueue
      ? ' — вы в другой очереди'
      : ''
  const items = [{ label: truncate(`${queueName}${counts}${membership}`, 80), enabled: false }]

  for (const [gameClass, entry] of perClass) {
    items.push({
      label: `${classLabels[gameClass] || gameClass}: ${entry.occupied}/${entry.total}`,
      enabled: false,
    })
  }

  const { gameClass } = effectiveQueueConfig()
  const ownSlots = queueState.slots.filter(slot => slot.id.startsWith(`${gameClass}-`))
  if (ownSlots.length > 0) {
    items.push({ type: 'separator' })
    for (const slot of ownSlots) {
      const number = slot.id.slice(gameClass.length + 1)
      const player = slot.name || (slot.occupied ? 'занят' : 'свободен')
      items.push({ label: truncate(`Слот ${number}: ${player}`, 60), enabled: false })
    }
  }

  return items
}

function queueMenu() {
  const { mode, gameClass, slot } = effectiveQueueConfig()
  const summary = settings.autoRequeue
    ? `Автозаход: ${modeLabel(mode)} / ${classLabels[gameClass] || gameClass} / слот ${slot}`
    : 'Автозаход после лобби: выкл'

  return {
    label: truncate(summary, 72),
    submenu: [
      ...queueConfigMenu(),
      { type: 'separator' },
      { label: 'Занятость слотов', submenu: slotOccupancyMenu() },
    ],
  }
}

function chatMenuItems() {
  if (!settings.trayChat) return []

  const items = [{ label: 'Чат в трее', click: showChatPopup }]
  if (chatMessages.length === 0) {
    items.push({ label: 'Пока сообщений нет', enabled: false })
  } else {
    for (const message of chatMessages.slice(-6)) {
      const prefix = message.at ? `${message.at} ` : ''
      items.push({
        label: escapeMenuLabel(truncate(`${prefix}${message.author || '???'}: ${message.body}`, 70)),
        click: showChatPopup,
      })
    }
  }

  items.push(
    { type: 'separator' },
    { label: 'Открыть чат в приложении', click: openChat },
  )

  return [...items, { type: 'separator' }]
}

function trayTemplate() {
  return [
    {
      label: 'Открыть TF2Pickup',
      click: createMainWindow,
    },
    { type: 'separator' },
    ...chatMenuItems(),
    queueMenu(),
    { type: 'separator' },
    {
      label: 'Настройки',
      click: createSettingsWindow,
    },
    {
      label: 'Открыть сайт в браузере',
      click: () => shell.openExternal(settings.siteUrl),
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]
}

function updateTray() {
  if (!tray || tray.isDestroyed()) return

  const last = settings.trayChat ? chatMessages[chatMessages.length - 1] : null
  tray.setToolTip(
    last ? truncate(`TF2Pickup — ${last.author || '???'}: ${last.body}`, 120) : 'TF2Pickup',
  )
}

function scheduleTrayUpdate() {
  if (trayUpdateTimer) return
  trayUpdateTimer = setTimeout(() => {
    trayUpdateTimer = null
    updateTray()
  }, 700)
}

function createTray() {
  tray = new Tray(iconFile('tray.ico'))
  tray.setToolTip('TF2Pickup')
  updateTray()

  // The menu is built on demand: rebuilding it on every chat/queue update used
  // to close it right under the cursor, so clicks (e.g. on "Настройки") were
  // sometimes lost.
  tray.on('right-click', () => {
    if (!tray || tray.isDestroyed()) return
    try {
      tray.popUpContextMenu(Menu.buildFromTemplate(trayTemplate()))
    } catch (error) {
      console.error('Tray menu failed:', error)
      tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()))
    }
  })

  tray.on('click', () => {
    if (settings.trayChat) toggleChatPopup()
    else createMainWindow()
  })
}

ipcMain.handle('settings:get', () => ({ ...settings }))
ipcMain.handle('settings:save', (_event, next) => applySettings(next))
ipcMain.handle('app:version', () => app.getVersion())

ipcMain.on('notify-ready-up', () => {
  if (settings.notifyReadyUp) {
    notify('Игра начинается!', 'Нажмите «I’m ready», если готовы играть.')
  }
})

ipcMain.on('notify-server-ready', () => {
  if (settings.notifyServerReady) {
    notify('Сервер готов', 'Игра запущена — можно подключаться к серверу.')
  }
})

ipcMain.on('steam-connect', (_event, url) => {
  if (typeof url === 'string') requestConnect(url)
})

ipcMain.on('auto-connect', (_event, url) => {
  if (settings.autoJoin && typeof url === 'string') requestConnect(url, true)
})

ipcMain.handle('auto-pre-ready:check', () => settings.autoPreReady)
ipcMain.handle('auto-ready:check', () => settings.autoReady)
ipcMain.handle('auto-requeue:config', () => ({
  enabled: Boolean(settings.autoRequeue),
  queue: settings.requeueQueue,
  gameClass: settings.requeueClass,
  slot: Number(settings.requeueSlot) || 1,
}))

ipcMain.on('auto-action-done', (_event, message) => {
  if (settings.notifyAutoActions && typeof message === 'string') {
    notify('TF2Pickup', message)
  }
})

ipcMain.on('chat:messages', (_event, messages) => {
  if (!Array.isArray(messages)) return

  chatMessages = messages
    .filter(message => message && typeof message === 'object')
    .map(message => ({
      id: typeof message.id === 'string' ? message.id : '',
      at: typeof message.at === 'string' ? truncate(message.at, 10) : '',
      author: truncate(message.author, 40),
      body: truncate(message.body, 300),
    }))
    .filter(message => message.body)
    .slice(-50)

  sendPopupState()
  scheduleTrayUpdate()
})

ipcMain.on('chat:popup-close', () => {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide()
})

ipcMain.on('chat:popup-open-app', () => {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide()
  createMainWindow()
})

ipcMain.handle('chat:send', async (_event, text) => {
  const message = truncate(text, 300)
  if (!message) return { ok: false, error: 'Пустое сообщение' }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    if (mainWindow && mainWindow.webContents.isLoading()) {
      await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve))
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: 'Окно приложения недоступно' }
  }

  const id = String(++chatSendSeq)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chatSendPending.delete(id)
      resolve({ ok: false, error: 'Сайт не ответил, попробуйте ещё раз' })
    }, 6000)

    chatSendPending.set(id, { resolve, timer })
    mainWindow.webContents.send('chat:send', { id, text: message })
  })
})

ipcMain.on('chat:send-result', (_event, payload) => {
  const id = payload && typeof payload === 'object' ? String(payload.id) : ''
  const pending = chatSendPending.get(id)
  if (!pending) return

  chatSendPending.delete(id)
  clearTimeout(pending.timer)
  pending.resolve(
    payload.ok
      ? { ok: true }
      : { ok: false, error: truncate(payload.error, 160) || 'Не удалось отправить' },
  )
})

ipcMain.on('chat:popup-settings', () => {
  if (chatPopup && !chatPopup.isDestroyed()) chatPopup.hide()
  createSettingsWindow()
})

ipcMain.on('page:size-changed', event => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (event.sender !== mainWindow.webContents) return
  scheduleAutoZoom(mainWindow.webContents)
})

ipcMain.on('queue:state', (_event, state) => {
  if (!state || typeof state !== 'object') return

  const slots = Array.isArray(state.slots)
    ? state.slots
        .filter(slot => slot && typeof slot.id === 'string' && /^[a-z]+-\d+$/.test(slot.id))
        .slice(0, 64)
        .map(slot => ({
          id: slot.id,
          occupied: Boolean(slot.occupied),
          name: truncate(slot.name, 24),
        }))
    : []

  queueState = {
    slug: typeof state.slug === 'string' ? truncate(state.slug, 40) : '',
    label: truncate(state.label, 24),
    isQueuePage: Boolean(state.isQueuePage),
    inAnyQueue: Boolean(state.inAnyQueue),
    inCurrentQueue: Boolean(state.inCurrentQueue),
    current: Number.isFinite(state.current) ? state.current : null,
    required: Number.isFinite(state.required) ? state.required : null,
    slots,
  }

  scheduleTrayUpdate()
})

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'window') return

  contents.on('will-navigate', handleNavigation)
  contents.setWindowOpenHandler(details => {
    if (isSameSite(details.url) || steamAuthHosts.has(hostOf(details.url))) {
      return { action: 'allow' }
    }
    handleNavigation({ preventDefault() {} }, details.url)
    return { action: 'deny' }
  })
})

app.setAppUserModelId('org.tf2pickup.desktop')

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', createMainWindow)

  app.whenReady().then(() => {
    loadSettings()
    applyStartupSetting()
    createTray()
    createMainWindow()
  })

  app.on('before-quit', () => {
    isQuitting = true
  })

  app.on('window-all-closed', event => {
    event.preventDefault()
  })

  app.on('activate', createMainWindow)
}
