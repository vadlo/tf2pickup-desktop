const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApi', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: values => ipcRenderer.invoke('settings:save', values),
  getVersion: () => ipcRenderer.invoke('app:version'),
})

const REQUEUE_PENDING_KEY = 'tf2pickup-desktop:requeue-pending'
const MY_GAME_KEY = 'tf2pickup-desktop:my-game'
const QUEUE_URL_CACHE_PREFIX = 'tf2pickup-desktop:queue-url:'
const CHAT_LIMIT = 50

// Slugs used by https://tf2pick-up.ru/ (v5). Settings keep the friendly names.
const QUEUE_SLUGS = {
  '6v6': 'auto-6v6',
  '9v9': 'auto-9v9',
  '4v4': 'auto-4v4',
  ultiduo: 'auto-ultiduo',
  '3v3': 'auto-ultitrio',
}

let requeueConfig = { enabled: false, queue: '6v6', gameClass: 'soldier', slot: 1 }
let requeueConfigLoaded = false
let requeueConfigChanged = false
let requeueWake = null

// Returns true when an already loaded config actually changed, so the page can
// immediately move the player to the newly selected slot.
function applyRequeueConfig(value) {
  if (!value) return false
  const next = {
    enabled: Boolean(value.enabled),
    queue: typeof value.queue === 'string' && value.queue ? value.queue : '6v6',
    gameClass:
      typeof value.gameClass === 'string' && value.gameClass ? value.gameClass : 'soldier',
    slot: Number(value.slot) || 1,
  }
  const changed =
    requeueConfigLoaded &&
    (next.enabled !== requeueConfig.enabled ||
      next.queue !== requeueConfig.queue ||
      next.gameClass !== requeueConfig.gameClass ||
      next.slot !== requeueConfig.slot)
  requeueConfigLoaded = true
  requeueConfig = next
  return changed
}

ipcRenderer.on('settings:changed', (_event, values) => {
  if (!values) return
  const changed = applyRequeueConfig({
    enabled: values.autoRequeue,
    queue: values.requeueQueue,
    gameClass: values.requeueClass,
    slot: values.requeueSlot,
  })
  if (changed) {
    // A new target must override a join that was already in flight for the
    // previous target and must be applied without restarting the app.
    requeueConfigChanged = true
    clearStored(REQUEUE_PENDING_KEY)
  }
  if (requeueWake) requeueWake()
})

ipcRenderer.on('chat:open', () => {
  const chatTab = document.querySelector('[data-tabs-select="tab-chat"]')
  if (chatTab && typeof chatTab.click === 'function') {
    chatTab.click()
    return
  }

  const chatPanel = document.getElementById('tab-chat')
  if (chatPanel && chatPanel.style) chatPanel.style.display = ''
})

// Messages typed in the tray popup are submitted through the site itself: the
// session, CSRF protection and rate limits stay in the page that owns them.
ipcRenderer.on('chat:send', (_event, payload) => {
  const id = payload && typeof payload === 'object' ? payload.id : undefined
  const text = payload && typeof payload.text === 'string' ? payload.text : ''

  const reply = (ok, error) =>
    ipcRenderer.send('chat:send-result', { id, ok, error: error || '' })

  const form = document.getElementById('chat-prompt')
  const field = form?.querySelector('input[name="message"]')
  if (!form || !field) {
    reply(false, 'Чат доступен только на странице очереди — откройте её в приложении')
    return
  }
  if (field.disabled) {
    reply(false, 'Отправка недоступна: чат заглушён или офлайн')
    return
  }

  try {
    field.value = text
    const view = field.ownerDocument?.defaultView
    const EventCtor = view?.Event || Event
    field.dispatchEvent(new EventCtor('input', { bubbles: true }))
    if (typeof form.requestSubmit === 'function') form.requestSubmit()
    else form.dispatchEvent(new EventCtor('submit', { bubbles: true, cancelable: true }))
  } catch (error) {
    reply(false, String(error?.message ?? error))
    return
  }

  reply(true)
})

async function loadRequeueConfig() {
  try {
    applyRequeueConfig(await ipcRenderer.invoke('auto-requeue:config'))
  } catch (error) {
    console.error('TF2Pickup requeue config failed:', error)
  }
}

function readStored(key) {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function readRaw(key) {
  try {
    return sessionStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStored(key, value) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage is optional; automation simply won't survive a reload.
  }
}

function writeRaw(key, value) {
  try {
    sessionStorage.setItem(key, String(value))
  } catch {
    // Ignore.
  }
}

function clearStored(key) {
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Ignore.
  }
}

function rememberMyGame(number) {
  writeRaw(MY_GAME_KEY, number)
}

function readMyGame() {
  return readRaw(MY_GAME_KEY)
}

function normalizedPath() {
  return location.pathname.replace(/\/+$/, '') || '/'
}

function isQueuePagePath(path) {
  return path === '/' || /^\/q\/[^/]+$/.test(path)
}

function slugOf(path) {
  const match = /\/q\/([^/?#]+)/.exec(String(path || ''))
  return match ? match[1] : ''
}

function currentQueueSlug() {
  const link = document.querySelector('#queue-switcher a[aria-current="page"]')
  const slug = link?.getAttribute('data-umami-event-queue')
  if (slug) return slug

  return slugOf(normalizedPath())
}

// Slug of the queue the player is actually in (may differ from the page being
// viewed). The queue switcher marks that link with `data-joined`.
function joinedQueueSlug() {
  const link = document.querySelector('#queue-switcher a[data-joined]')
  return link?.getAttribute('data-umami-event-queue') || ''
}

function hiddenInputValue(id) {
  const element = document.getElementById(id)
  if (!element) return ''
  const value = element.value ?? element.getAttribute('value') ?? ''
  return String(value)
}

function isInAnyQueue() {
  return hiddenInputValue('isInAnyQueue') === 'true'
}

function isInCurrentQueue() {
  return hiddenInputValue('isInCurrentQueue') === 'true'
}

function ownQueueSlot(gameClass, slot) {
  if (!gameClass || slot === undefined || slot === null) return null
  return document.getElementById(`queue-slot-${gameClass}-${slot}`)
}

// True only when the player occupies the exact configured class/slot. The
// site marks the own slot with the `queue-slot-own` class and a leave button.
function isOnConfiguredSlot(gameClass, slot) {
  const element = ownQueueSlot(gameClass, slot)
  if (!element) return false
  if (element.classList.contains('queue-slot-own')) return true
  return Boolean(element.querySelector('.leave-queue-button'))
}

function isGameActive() {
  const snackbar = document.getElementById('running-game-snackbar')
  return Boolean(
    snackbar && /You are involved in a currently running game/i.test(snackbar.textContent || ''),
  )
}

function readyDialogVisible() {
  const dialog = document.getElementById('ready-up-dialog')
  return Boolean(dialog && (dialog.open || dialog.hasAttribute('open')))
}

function isOnQueueSlug(slug) {
  if (!slug) return false
  const current = currentQueueSlug()
  if (current) return current === slug
  return normalizedPath() === `/q/${slug}`
}

function queueUrlCandidates(queue) {
  const list = []
  if (QUEUE_SLUGS[queue]) list.push(QUEUE_SLUGS[queue])
  if (/^auto-/.test(queue)) list.push(queue)
  list.push(`auto-${queue}`, queue)
  return Array.from(new Set(list.filter(Boolean)))
}

function switcherQueueSlug(queue) {
  const candidates = new Set(queueUrlCandidates(queue).map(slug => slug.toLowerCase()))
  const name = queue.toLowerCase()

  for (const link of document.querySelectorAll('#queue-switcher a[data-umami-event-queue]')) {
    const slug = (link.getAttribute('data-umami-event-queue') || '').trim()
    if (!slug) continue
    if (candidates.has(slug.toLowerCase())) return slug

    const label = (link.querySelector('.queue-switcher-label span')?.textContent || '')
      .trim()
      .toLowerCase()
    if (label && label === name) return slug
  }

  return ''
}

function cachedQueueUrl(queue) {
  const path = readRaw(QUEUE_URL_CACHE_PREFIX + queue)
  return path.startsWith('/q/') ? path : ''
}

function rememberQueueUrl(queue, path) {
  writeRaw(QUEUE_URL_CACHE_PREFIX + queue, path)
}

function probeQueueUrl(slug) {
  return new Promise(resolve => {
    if (typeof fetch !== 'function') {
      resolve(false)
      return
    }

    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let controller = null
    try {
      if (typeof AbortController === 'function') controller = new AbortController()
    } catch {
      controller = null
    }

    const timer = setTimeout(() => {
      controller?.abort()
      finish(false)
    }, 2500)

    let target = `/q/${slug}`
    try {
      target = new URL(`/q/${slug}`, location.href).toString()
    } catch {
      // Keep the relative URL.
    }

    fetch(target, {
      method: 'HEAD',
      credentials: 'include',
      signal: controller?.signal,
    })
      .then(response => {
        clearTimeout(timer)
        finish(Boolean(response && response.ok))
      })
      .catch(() => {
        clearTimeout(timer)
        finish(false)
      })
  })
}

// The queue switcher on the site is the source of truth for queue URLs: the
// upstream project already renamed a few slugs in the past (3v3 -> ultitrio).
async function resolveQueueUrl(queue) {
  const fromSwitcher = switcherQueueSlug(queue)
  if (fromSwitcher) {
    const path = `/q/${fromSwitcher}`
    rememberQueueUrl(queue, path)
    return path
  }

  const cached = cachedQueueUrl(queue)
  if (cached) return cached

  for (const slug of queueUrlCandidates(queue)) {
    if (await probeQueueUrl(slug)) {
      const path = `/q/${slug}`
      rememberQueueUrl(queue, path)
      return path
    }
  }

  return `/q/${QUEUE_SLUGS[queue] || queue}`
}

function hasQueueUi() {
  return Boolean(document.querySelector('.join-queue-button, .leave-queue-button'))
}

let handledConnectHref = ''

function interceptSteamLinks() {
  document.addEventListener(
    'click',
    event => {
      const link = event.target?.closest?.('a[href^="steam://connect/"]')
      if (!link) return

      event.preventDefault()
      event.stopImmediatePropagation()
      handledConnectHref = link.href
      ipcRenderer.send('steam-connect', link.href)
    },
    true,
  )
}

function observeGameEvents() {
  let readyUpVisible = false
  let scheduled = false
  let preReadyFalseSince = 0
  let preReadyLastPress = 0
  let preReadyPressing = false

  let readyPending = false
  const lastClicks = { ready: 0 }

  const clickIfEnabled = (channel, button, message, lastClickKey) => {
    if (readyPending) return
    readyPending = true

    ipcRenderer
      .invoke(channel)
      .then(enabled => {
        if (!enabled) return
        if (!document.contains(button) || button.disabled) return
        if (Date.now() - lastClicks[lastClickKey] < 10000) return

        lastClicks[lastClickKey] = Date.now()
        button.click()
        ipcRenderer.send('auto-action-done', message)
      })
      .catch(error => console.error('TF2Pickup auto action failed:', error))
      .finally(() => {
        readyPending = false
      })
  }

  const pressPreReady = button => {
    if (preReadyPressing) return
    preReadyPressing = true

    ipcRenderer
      .invoke('auto-pre-ready:check')
      .then(enabled => {
        if (!enabled) return
        if (!document.contains(button) || button.disabled) return
        // The site arms pre-ready itself (on join/ready-up) and cancels it after
        // a timeout. Blind clicks would toggle an armed state back off, so only
        // press when the current state is a confirmed "off".
        if (button.getAttribute('aria-pressed') === 'true') return
        if (!isInAnyQueue()) return

        button.click()
      })
      .catch(error => console.error('TF2Pickup auto action failed:', error))
      .finally(() => {
        preReadyPressing = false
      })
  }

  const check = () => {
    scheduled = false

    const dialog = document.getElementById('ready-up-dialog')
    const dialogVisible = readyDialogVisible()
    if (dialogVisible && !readyUpVisible) {
      ipcRenderer.send('notify-ready-up')
    }
    readyUpVisible = dialogVisible

    if (dialogVisible && dialog) {
      const readyButton = dialog.querySelector('button[name="ready"]')
      if (readyButton && !readyButton.disabled) {
        clickIfEnabled('auto-ready:check', readyButton, 'Авто-реди: нажал «I’m ready»', 'ready')
      }
    }

    const gameActive = isGameActive()
    const queued = isInAnyQueue()
    const preButton = document.getElementById('pre-ready-up-button')
    const preActive = preButton?.getAttribute('aria-pressed') === 'true'

    // Only touch pre-ready while actually queued, outside the ready-up flow and
    // without an active game, and only after the "off" state proved stable.
    const canPressPreReady = Boolean(
      preButton && !preButton.disabled && queued && !gameActive && !dialogVisible && !preActive,
    )

    if (!canPressPreReady) {
      preReadyFalseSince = 0
    } else {
      const now = Date.now()
      if (!preReadyFalseSince) preReadyFalseSince = now
      if (now - preReadyFalseSince >= 1000 && now - preReadyLastPress >= 30000) {
        preReadyLastPress = now
        preReadyFalseSince = 0
        pressPreReady(preButton)
      }
    }

    const joinLink = document.querySelector('a.join-game-button[href^="steam://connect/"]')
    const href = joinLink?.getAttribute('href') ?? ''
    if (href && href !== handledConnectHref) {
      handledConnectHref = href
      ipcRenderer.send('notify-server-ready')

      // Only auto-join the player's own game, never a STV spectator link.
      if (/join (game|in)/i.test(joinLink.textContent ?? '')) {
        ipcRenderer.send('auto-connect', href)
      }
    }
    if (!href) handledConnectHref = ''
  }

  const scheduleCheck = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(check, 250)
  }

  const observer = new MutationObserver(scheduleCheck)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'open',
      'href',
      'class',
      'style',
      'aria-selected',
      'aria-pressed',
      'aria-current',
      'disabled',
      'value',
      'data-player',
    ],
  })
  // Mutations alone are not enough: the pre-ready state must be re-checked even
  // when the page is visually idle (e.g. after a timed pre-ready cancel).
  setInterval(scheduleCheck, 500)
  scheduleCheck()
}

function setupAutoRequeue() {
  let scheduled = false
  let triggered = false
  let myGameActive = false
  let myGameWasLive = false
  let joinInFlight = false
  let lastJoinAttempt = 0
  let notified = false
  let startupChecked = false
  let retryTimer = null
  let resolving = false
  let leaveInFlight = false
  let lastLeaveAttempt = 0
  let requeueEpoch = 0

  const stopRetry = () => {
    if (retryTimer) {
      clearInterval(retryTimer)
      retryTimer = null
    }
  }

  // Leave whatever queue/slot currently holds the player so the pending join
  // can put them on the configured one. Throttled so a slow htmx swap cannot
  // turn the retry loop into a click storm. Returns true when the leave was
  // issued or is still cooling down, false when there is no button to press.
  const leaveCurrentQueue = () => {
    if (leaveInFlight || Date.now() - lastLeaveAttempt < 2000) return true
    const button =
      document.querySelector('.queue-slot-own .leave-queue-button') ||
      document.querySelector('.leave-queue-button')
    if (!button || button.disabled) return false
    leaveInFlight = true
    lastLeaveAttempt = Date.now()
    try {
      button.click()
    } catch {
      // Ignore: the slot may be swapped out mid-click.
    }
    setTimeout(() => {
      leaveInFlight = false
    }, 1200)
    return true
  }

  const tryJoin = () => {
    const pending = readStored(REQUEUE_PENDING_KEY)
    if (!pending) {
      stopRetry()
      notified = false
      return
    }
    const epoch = requeueEpoch
    // Never drop a pending join because the settings round-trip is still in
    // flight: the config loads asynchronously right after the page starts.
    if (!requeueConfigLoaded) return
    if (!requeueConfig.enabled) {
      clearStored(REQUEUE_PENDING_KEY)
      stopRetry()
      notified = false
      return
    }
    if (Date.now() - (Number(pending.at) || 0) > 10 * 60 * 1000) {
      clearStored(REQUEUE_PENDING_KEY)
      stopRetry()
      notified = false
      return
    }

    const slug = pending.slug || slugOf(pending.path) || QUEUE_SLUGS[pending.queue] || pending.queue

    // Already exactly on the configured class/slot: the pending join is done.
    // The queue page must match too: slot ids are only unique inside a queue.
    if (isOnQueueSlug(slug) && isOnConfiguredSlot(pending.gameClass, pending.slot)) {
      clearStored(REQUEUE_PENDING_KEY)
      stopRetry()
      notified = false
      startupChecked = true
      return
    }

    // The player is queued on another mode or another slot: leave it first,
    // then keep retrying so the join below fires right after the leave.
    if (isInAnyQueue()) {
      // If a join we just triggered landed, we are already in the queue —
      // possibly on a fallback slot when the configured one was taken. Leaving
      // now would only loop, so treat it as success.
      if (joinInFlight || Date.now() - lastJoinAttempt < 5000) {
        clearStored(REQUEUE_PENDING_KEY)
        stopRetry()
        notified = false
        startupChecked = true
        return
      }

      if (!retryTimer) retryTimer = setInterval(tryJoin, 400)
      if (leaveCurrentQueue()) return

      // No leave button on this page: the player sits in a queue of another
      // mode. The queue switcher marks that queue with `data-joined`, so go
      // there, leave it, and the retry loop will bring us back to join.
      const joinedSlug = joinedQueueSlug()
      if (joinedSlug && !isOnQueueSlug(joinedSlug)) {
        location.assign(`/q/${joinedSlug}`)
      }
      return
    }

    if (!isOnQueueSlug(slug)) {
      location.assign(pending.path || `/q/${slug}`)
      return
    }

    if (!retryTimer) retryTimer = setInterval(tryJoin, 400)
    if (joinInFlight || Date.now() - lastJoinAttempt < 2000) return

    const slotPrefix = `queue-slot-${pending.gameClass}-`
    const buttons = Array.from(
      document.querySelectorAll(`[id^="${slotPrefix}"] button.join-queue-button:not([disabled])`),
    )
    if (buttons.length === 0) return

    const preferredId = `${slotPrefix}${pending.slot}`
    const button =
      buttons.find(item => item.closest('.queue-slot')?.id === preferredId) ?? buttons[0]
    const slotId = button.value || button.closest('.queue-slot')?.id.slice('queue-slot-'.length)

    lastJoinAttempt = Date.now()
    joinInFlight = true
    button.click()
    if (!notified) {
      notified = true
      ipcRenderer.send(
        'auto-action-done',
        `Автозаход: занимаю слот ${slotId} в ${pending.queue}`,
      )
    }

    setTimeout(() => {
      if (epoch !== requeueEpoch) return
      const slot = slotId ? document.getElementById(`queue-slot-${slotId}`) : null
      const joined =
        isInAnyQueue() ||
        isOnConfiguredSlot(pending.gameClass, pending.slot) ||
        Boolean(slot?.hasAttribute('data-player'))
      if (joined) {
        clearStored(REQUEUE_PENDING_KEY)
        stopRetry()
        notified = false
        startupChecked = true
      }
      joinInFlight = false
    }, 700)
  }

  const startRetry = () => {
    tryJoin()
  }

  const beginRequeue = async reason => {
    if (resolving) return
    resolving = true

    let path = ''
    try {
      path = await resolveQueueUrl(requeueConfig.queue)
    } catch {
      path = `/q/${QUEUE_SLUGS[requeueConfig.queue] || requeueConfig.queue}`
    } finally {
      resolving = false
    }

    if (reason === 'game') clearStored(MY_GAME_KEY)

    const slug = slugOf(path) || QUEUE_SLUGS[requeueConfig.queue] || requeueConfig.queue
    notified = false
    writeStored(REQUEUE_PENDING_KEY, {
      queue: requeueConfig.queue,
      gameClass: requeueConfig.gameClass,
      slot: requeueConfig.slot,
      slug,
      path,
      at: Date.now(),
    })

    if (isOnQueueSlug(slug)) startRetry()
    else location.assign(path)
  }

  const triggerRequeue = () => {
    if (triggered || !requeueConfig.enabled) return
    triggered = true
    void beginRequeue('game')
  }

  const check = () => {
    scheduled = false

    // A changed auto-requeue target (tray menu or settings window) must be
    // applied immediately, not only after restarting the app.
    if (requeueConfigChanged) {
      requeueConfigChanged = false
      startupChecked = false
      requeueEpoch += 1
      lastJoinAttempt = 0
      joinInFlight = false
    }

    if (readStored(REQUEUE_PENDING_KEY)) tryJoin()

    const path = normalizedPath()
    const gameMatch = /^\/games\/(\d+)$/.exec(path)

    if (gameMatch) {
      const number = gameMatch[1]
      const state = document.getElementById(`game-${number}-state`)
      const live = Boolean(state && /live/i.test(state.textContent || ''))
      const joinButton =
        document.querySelector(`#game-${number}-join-game-button a.join-game-button`) ??
        document.querySelector('a.join-game-button')
      const isPlayerButton = /join game|join in/i.test(joinButton?.textContent || '')
      const knownMine = readMyGame() === number

      if (live && (isPlayerButton || knownMine)) {
        myGameWasLive = true
        triggered = false
        rememberMyGame(number)
      }

      const eventList = document.getElementById(`game-${number}-event-list`)
      const ended = Boolean(
        eventList && /Game ended|Game interrupted/i.test(eventList.textContent || ''),
      )
      // Require the state element to be present: during an htmx swap it can be
      // briefly missing, which must not look like "game ended".
      const endedByState = Boolean(state) && myGameWasLive

      if ((myGameWasLive || knownMine) && !live && (ended || endedByState)) {
        triggerRequeue()
      }
      return
    }

    myGameWasLive = false

    const snackbar = document.getElementById('running-game-snackbar')
    const active = isGameActive()
    const gameNumber =
      snackbar
        ?.querySelector('a[href^="/games/"]')
        ?.getAttribute('href')
        ?.match(/\/games\/(\d+)/)?.[1] ?? ''

    if (active && gameNumber) {
      myGameActive = true
      rememberMyGame(gameNumber)
      triggered = false
    } else if (myGameActive && !active) {
      myGameActive = false
      triggerRequeue()
    }

    // Opening the app must occupy the configured slot right away, not only
    // after a finished match. Runs once per page load so a manual leave is not
    // overridden later in the same session.
    if (startupChecked || !requeueConfig.enabled) return
    if (!isQueuePagePath(path)) return
    if (!hasQueueUi()) return
    if (readStored(REQUEUE_PENDING_KEY)) return

    // Only the exact configured class/slot is respected. Any other state —
    // another queue, another mode, or another slot of the same queue — is
    // overridden and the player is moved to the configured slot.
    const configuredSlug = QUEUE_SLUGS[requeueConfig.queue] || requeueConfig.queue
    if (
      isOnQueueSlug(configuredSlug) &&
      isOnConfiguredSlot(requeueConfig.gameClass, requeueConfig.slot)
    ) {
      startupChecked = true
      return
    }
    if (active || readyDialogVisible()) return

    startupChecked = true
    void beginRequeue('startup')
  }

  const scheduleCheck = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(check, 150)
  }

  const observer = new MutationObserver(scheduleCheck)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [
      'open',
      'href',
      'class',
      'style',
      'disabled',
      'value',
      'id',
      'data-player',
      'aria-pressed',
      'aria-current',
    ],
  })
  window.addEventListener('popstate', () => {
    triggered = false
    startupChecked = false
    scheduleCheck()
  })

  // Safety net: queue state also changes without local DOM mutations (htmx
  // optimistic swaps, websocket pushes handled elsewhere).
  setInterval(scheduleCheck, 1500)

  requeueWake = scheduleCheck
  scheduleCheck()
}

function setupChatBridge() {
  let lastSignature = ''
  let scheduled = false

  const collect = () => {
    const list = document.getElementById('chat-message-list')
    if (!list) return []

    const messages = []
    for (const node of list.querySelectorAll('.chat-message')) {
      const body = (node.querySelector('.body')?.textContent || '').replace(/\s+/g, ' ').trim()
      if (!body) continue

      const id = (node.id || '').replace(/^msg-/, '')
      const author = (node.querySelector('.author')?.textContent || '').replace(/\s+/g, ' ').trim()
      const at = (node.querySelector('.at')?.textContent || '').trim()
      // MongoDB ObjectId starts with the unix timestamp (8 hex chars).
      const unix = /^[0-9a-f]{8}$/i.test(id) ? parseInt(id.slice(0, 8), 16) : 0

      messages.push({ id, at, author, body, unix })
    }

    messages.sort((left, right) => left.unix - right.unix)
    return messages.slice(-CHAT_LIMIT)
  }

  const flush = () => {
    scheduled = false

    const messages = collect()
    const signature = messages
      .map(message => message.id || `${message.at}|${message.author}|${message.body}`)
      .join('\u0001')
    if (signature === lastSignature) return

    lastSignature = signature
    ipcRenderer.send(
      'chat:messages',
      messages.map(({ id, at, author, body }) => ({ id, at, author, body })),
    )
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(flush, 400)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  schedule()
}

function watchPageSize() {
  if (typeof ResizeObserver === 'undefined') return

  let lastHeight = 0
  let timer = null

  const measure = () =>
    Math.max(
      document.documentElement ? document.documentElement.scrollHeight : 0,
      document.body ? document.body.scrollHeight : 0,
    )

  const report = () => {
    const height = measure()
    if (Math.abs(height - lastHeight) < 24) return
    lastHeight = height
    clearTimeout(timer)
    timer = setTimeout(() => ipcRenderer.send('page:size-changed'), 250)
  }

  const observer = new ResizeObserver(report)
  if (document.documentElement) observer.observe(document.documentElement)
  if (document.body) observer.observe(document.body)
  report()
}

function setupQueueStateBridge() {
  let lastSignature = ''
  let scheduled = false

  const collect = () => {
    const slots = []
    for (const element of document.querySelectorAll('.queue-slot[id^="queue-slot-"]')) {
      const id = (element.id || '').slice('queue-slot-'.length)
      if (!/^[a-z]+-\d+$/.test(id)) continue

      const name = (element.querySelector('.player-name-text')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
      slots.push({ id, occupied: element.hasAttribute('data-player'), name })
    }

    const activeLink = document.querySelector('#queue-switcher a[aria-current="page"]')
    const label = (activeLink?.querySelector('.queue-switcher-label span')?.textContent || '').trim()
    const currentText = (document.getElementById('queue-current-player-count')?.textContent || '').trim()
    const requiredText = (document.getElementById('queue-required-player-count')?.textContent || '').trim()

    return {
      slug: currentQueueSlug(),
      label,
      isQueuePage: isQueuePagePath(normalizedPath()),
      inAnyQueue: isInAnyQueue(),
      inCurrentQueue: isInCurrentQueue(),
      current: /^\d+$/.test(currentText) ? Number(currentText) : null,
      required: /^\d+$/.test(requiredText) ? Number(requiredText) : null,
      slots,
    }
  }

  const flush = () => {
    scheduled = false

    const state = collect()
    const signature = JSON.stringify([
      state.slug,
      state.label,
      state.isQueuePage,
      state.inAnyQueue,
      state.inCurrentQueue,
      state.current,
      state.required,
      state.slots.map(slot => `${slot.id}:${slot.occupied ? 1 : 0}:${slot.name}`),
    ])
    if (signature === lastSignature) return

    lastSignature = signature
    ipcRenderer.send('queue:state', state)
  }

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(flush, 350)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-player', 'id', 'value', 'aria-current', 'class'],
  })
  setInterval(schedule, 2000)
  schedule()
}

function setupVoicePanel() {
  const ensure = () => {
    if (!document.body) return
    if (document.getElementById('tf2pickup-voice')) return
    const panel = document.createElement('div')
    panel.id = 'tf2pickup-voice'
    panel.setAttribute('role', 'group')
    panel.setAttribute('aria-label', 'Голосовые каналы Discord')

    const caption = document.createElement('div')
    caption.className = 'tf2pickup-voice-caption'
    caption.textContent = 'Голос Discord'
    panel.appendChild(caption)

    const teams = [
      { team: 'red', label: 'RED', sub: 'Красные' },
      { team: 'blue', label: 'BLU', sub: 'Синие' },
    ]
    for (const item of teams) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `tf2pickup-voice-button tf2pickup-voice-${item.team}`
      button.dataset.voiceTeam = item.team
      button.title = `Войти в голосовой канал ${item.sub.toLowerCase()} (Discord)`

      const dot = document.createElement('span')
      dot.className = 'tf2pickup-voice-dot'
      button.appendChild(dot)

      const label = document.createElement('span')
      label.className = 'tf2pickup-voice-label'
      label.textContent = item.label
      const small = document.createElement('small')
      small.textContent = item.sub
      label.appendChild(small)
      button.appendChild(label)

      button.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        ipcRenderer.send('voice:open', item.team)
      })
      button.addEventListener('mousedown', event => {
        event.preventDefault()
        event.stopPropagation()
      })

      panel.appendChild(button)
    }

    document.body.appendChild(panel)
  }

  if (document.body) ensure()
  else document.addEventListener('DOMContentLoaded', ensure, { once: true })

  const readd = () => setTimeout(ensure, 0)
  if (document.body) {
    for (const eventName of ['htmx:afterSwap', 'htmx:afterSettle', 'htmx:historyRestore']) {
      document.body.addEventListener(eventName, readd)
    }
    const observer = new MutationObserver(() => {
      if (!document.getElementById('tf2pickup-voice')) ensure()
    })
    observer.observe(document.body, { childList: true })
    observer.observe(document.documentElement, { childList: true })
  }
}

function whenReady(callback) {
  if (document.documentElement) {
    callback()
  } else {
    document.addEventListener('DOMContentLoaded', callback, { once: true })
  }
}

if (location.protocol !== 'file:') {
  try {
    loadRequeueConfig()
    whenReady(() => {
      interceptSteamLinks()
      observeGameEvents()
      setupAutoRequeue()
      setupChatBridge()
      setupQueueStateBridge()
      setupVoicePanel()
      watchPageSize()
    })
  } catch (error) {
    console.error('TF2Pickup preload integration failed:', error)
  }
}
