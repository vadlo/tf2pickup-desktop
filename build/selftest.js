const Module = require('module')
const fs = require('fs')
const path = require('path')
const { JSDOM, VirtualConsole } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const PRELOAD = path.join(ROOT, 'preload.js')
const SETTINGS_HTML = path.join(ROOT, 'settings.html')
const SETTINGS_JS = path.join(ROOT, 'settings.js')
const PENDING_KEY = 'tf2pickup-desktop:requeue-pending'
const MY_GAME_KEY = 'tf2pickup-desktop:my-game'
const QUEUE_URL_CACHE_PREFIX = 'tf2pickup-desktop:queue-url:'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let currentIpc = null
const originalLoad = Module._load
Module._load = function (request) {
  if (request === 'electron') {
    return {
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: currentIpc,
    }
  }
  return originalLoad.apply(this, arguments)
}

function makeIpc(handlers = {}) {
  const sent = []
  const listeners = {}
  return {
    sent,
    invoke: (channel, ...args) => {
      if (!(channel in handlers)) return Promise.reject(new Error(`no handler: ${channel}`))
      const value = handlers[channel]
      return Promise.resolve(typeof value === 'function' ? value(...args) : value)
    },
    send: (channel, ...args) => sent.push({ channel, args }),
    on: (channel, callback) => {
      ;(listeners[channel] = listeners[channel] || []).push(callback)
    },
    emit: (channel, payload) => (listeners[channel] || []).forEach(callback => callback({}, payload)),
    has: channel => sent.some(item => item.channel === channel),
    all: channel => sent.filter(item => item.channel === channel),
  }
}

function createPage(html, url) {
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {})
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, virtualConsole })
  const assigned = []
  const real = dom.window.location
  // jsdom forbids patching Location.assign, so preload gets a thin stand-in.
  const location = {
    get pathname() {
      return real.pathname
    },
    get protocol() {
      return real.protocol
    },
    get href() {
      return real.href
    },
    assign(target) {
      assigned.push(target)
    },
    replace(target) {
      assigned.push(target)
    },
  }
  return { dom, assigned, location }
}

let activeIntervals = []
const realSetInterval = setInterval

function resetIntervals() {
  for (const id of activeIntervals) clearInterval(id)
  activeIntervals = []
}

function bindWindow(window, location, { fetchOk } = {}) {
  global.window = window
  global.document = window.document
  global.location = location || window.location
  global.sessionStorage = window.sessionStorage
  global.MutationObserver = window.MutationObserver
  global.setInterval = (callback, ms) => {
    const id = realSetInterval(callback, ms)
    activeIntervals.push(id)
    return id
  }

  const fetchCalls = []
  global.fetch = async (url, init = {}) => {
    const target = String(url)
    fetchCalls.push({ url: target, method: init.method || 'GET' })
    const ok = fetchOk ? Boolean(await fetchOk(target, init)) : true
    return { ok, status: ok ? 200 : 404 }
  }

  return fetchCalls
}

function loadPreload(ipc) {
  currentIpc = ipc
  delete require.cache[require.resolve(PRELOAD)]
  require(PRELOAD)
}

function trackJoinClicks(window) {
  const clicks = []
  for (const button of window.document.querySelectorAll('button.join-queue-button')) {
    button.addEventListener('click', () => clicks.push(button.value))
  }
  return clicks
}

function switcher(currentSlug, joinedSlug = '') {
  const queues = [
    ['auto-6v6', '6v6'],
    ['auto-9v9', '9v9'],
    ['auto-bball', 'BBall'],
    ['auto-ultiduo', 'Ultiduo'],
    ['auto-4v4', '4v4'],
    ['auto-ultitrio', 'Ultitrio'],
  ]
  return `<nav id="queue-switcher">${queues
    .map(
      ([slug, label]) =>
        `<a href="/q/${slug}" data-umami-event-queue="${slug}"${
          slug === currentSlug ? ' aria-current="page"' : ''
        }${slug === joinedSlug ? ' data-joined=""' : ''}><span class="queue-switcher-label"><span>${label}</span></span></a>`,
    )
    .join('')}</nav>`
}

function slotMarkup(id, state) {
  if (state === 'occupied') {
    return `<div class="queue-slot" id="queue-slot-${id}" data-player="76561198000000001"><div class="player-info"><span class="player-name-text">Boris</span></div></div>`
  }
  if (state === 'own') {
    return `<div class="queue-slot queue-slot-own" id="queue-slot-${id}" data-player="76561198000000000"><div class="player-info"><span class="player-name-text">Me</span><button class="leave-queue-button" name="leave" value="">Leave queue</button></div></div>`
  }
  return `<div class="queue-slot" id="queue-slot-${id}"><button class="join-queue-button" name="join" value="${id}"${
    state === 'disabled' ? ' disabled' : ''
  }><span class="sr-only">Join queue on slot ${id}</span></button></div>`
}

const queuePage = ({
  slug = 'auto-6v6',
  joined = '',
  inQueue = false,
  inCurrent = false,
  preReady = false,
  preReadyDisabled,
  snackbar = '',
  slots = [
    ['soldier-1', 'free'],
    ['soldier-2', 'occupied'],
    ['soldier-3', 'free'],
  ],
} = {}) =>
  `<!doctype html><html><body>
    <div id="queue-content">
      <div class="queue-toolbar" id="queue-toolbar">
        <input type="hidden" id="isInCurrentQueue" value="${inCurrent}" />
        <input type="hidden" id="isInAnyQueue" value="${inQueue}" />
        ${switcher(slug, joined)}
        <span id="queue-current-player-count">5</span>/<span id="queue-required-player-count">12</span>
        <button id="pre-ready-up-button" name="prereadytoggle" aria-pressed="${preReady}"${
          (preReadyDisabled ?? !inQueue) ? ' disabled' : ''
        }>Pre-ready up</button>
      </div>
      <div class="queue-slots">${slots.map(([id, state]) => slotMarkup(id, state)).join('')}</div>
    </div>
    <div id="running-game-snackbar">${snackbar}</div>
  </body></html>`

const gamePage = ({ number = 42, live = true, joinLabel = 'join game' } = {}) =>
  `<!doctype html><html><body>
    <div id="game-${number}-state" class="game-state" aria-label="Game status">${
      live ? '<span class="uppercase">live</span>' : ''
    }</div>
    <div class="contents" id="game-${number}-join-game-button">
      <a href="steam://connect/1.2.3.4:27015/secret" class="button join-game-button"><span>${joinLabel}</span></a>
    </div>
    <div class="game-event-list" id="game-${number}-event-list" aria-label="Game events">
      <div class="game-event">Game started</div>
    </div>
  </body></html>`

function setPending(window, values) {
  window.sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ at: Date.now(), queue: '6v6', gameClass: 'soldier', slot: 1, ...values }),
  )
}

function readPending(window) {
  try {
    return JSON.parse(window.sessionStorage.getItem(PENDING_KEY))
  } catch {
    return null
  }
}

const requeueConfig = { enabled: true, queue: '6v6', gameClass: 'soldier', slot: 1 }

const nowSeconds = () => Math.floor(Date.now() / 1000)
const objectId = seconds => `${Math.max(0, seconds).toString(16).padStart(8, '0')}c0ffee1234567890`

const chatPage = messages =>
  `<!doctype html><html><body>
    <button class="tab-link" data-tabs-select="tab-chat"><span>Chat</span></button>
    <div class="tab-content" id="tab-chat">
      <div class="chat" id="chat">
        <div class="message-list" id="chat-message-list">
          <div class="chat-day" id="chat-day-today">
            <div class="chat-date-separator"><span>Today</span></div>
            <div class="chat-day-messages">${messages
              .map(
                ({ at, author, body, seconds }) => `<p class="chat-message" id="msg-${objectId(seconds)}">
                  <span class="message-text"><span class="at">${at}</span> <a href="/players/76561198000000000" class="author">${author}</a>: <span class="body">${body}</span></span>
                  <button class="delete-btn">x</button>
                </p>`,
              )
              .join('')}</div>
          </div>
        </div>
        <div class="chat-prompt-container" id="chat-prompt-container">
          <form class="m-2 flex flex-row gap-2" id="chat-prompt" hx-post="/chat" hx-swap="none">
            <input type="text" class="flex-1" placeholder="Send message..." name="message" autocomplete="off" />
            <button type="submit">Send</button>
          </form>
        </div>
      </div>
    </div>
  </body></html>`

async function testStartupJoin() {
  resetIntervals()
  const { dom, assigned, location } = createPage(queuePage(), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  const pending = readPending(dom.window)
  record(
    'Запуск: сразу занят выбранный слот',
    clicks.length === 1 && clicks[0] === 'soldier-1',
    `clicks=${JSON.stringify(clicks)}`,
  )
  record(
    'Запуск: сохранены режим/класс/слот и адрес очереди',
    pending?.queue === '6v6' &&
      pending?.gameClass === 'soldier' &&
      pending?.slot === 1 &&
      pending?.path === '/q/auto-6v6',
    JSON.stringify(pending),
  )
  record('Запуск: перехода не было, уже на нужной очереди', assigned.length === 0, `${assigned}`)

  dom.window.document.getElementById('isInAnyQueue').setAttribute('value', 'true')
  dom.window.document.getElementById('queue-slot-soldier-1').setAttribute('data-player', 'me')
  dom.window.document.getElementById('queue-slot-soldier-1').innerHTML =
    '<div class="player-info">me</div>'
  await sleep(1200)

  record('Запуск: после захода повторных кликов нет', clicks.length === 1, `clicks=${JSON.stringify(clicks)}`)
  record('Запуск: флаг автозахода очищен', readPending(dom.window) === null)
}

async function testStartupSkipWhenQueued() {
  resetIntervals()
  const html = queuePage({
    inQueue: true,
    inCurrent: true,
    preReady: true,
    slots: [
      ['soldier-1', 'own'],
      ['soldier-2', 'occupied'],
      ['soldier-3', 'free'],
    ],
  })
  const { dom, assigned, location } = createPage(html, 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Запуск: уже в очереди — слот не занимается',
    clicks.length === 0 && readPending(dom.window) === null && assigned.length === 0,
    `clicks=${JSON.stringify(clicks)} assigned=${JSON.stringify(assigned)}`,
  )
}

function trackLeaveClicks(window) {
  const clicks = []
  for (const button of window.document.querySelectorAll('.leave-queue-button')) {
    button.addEventListener('click', () =>
      clicks.push(button.closest('.queue-slot')?.id || 'unknown'),
    )
  }
  return clicks
}

async function testStartupOverridesOtherSlot() {
  resetIntervals()
  const html = queuePage({
    inQueue: true,
    inCurrent: true,
    preReady: true,
    slots: [
      ['scout-1', 'own'],
      ['soldier-1', 'free'],
      ['soldier-2', 'occupied'],
    ],
  })
  const { dom, location } = createPage(html, 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  const leaveClicks = trackLeaveClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Старт: чужой слот — сначала выход из очереди',
    leaveClicks.length === 1 && clicks.length === 0,
    `leave=${JSON.stringify(leaveClicks)} clicks=${JSON.stringify(clicks)}`,
  )

  // The server confirmed the leave: the hidden flags flipped and the old slot
  // turned back into a free join button.
  dom.window.document.getElementById('isInAnyQueue').setAttribute('value', 'false')
  dom.window.document.getElementById('isInCurrentQueue').setAttribute('value', 'false')
  const own = dom.window.document.getElementById('queue-slot-scout-1')
  own.setAttribute('class', 'queue-slot')
  own.removeAttribute('data-player')
  own.innerHTML = '<div class="player-info">free</div>'
  await sleep(1200)

  record(
    'Старт: чужой слот — затем занят настроенный слот',
    clicks.length === 1 && clicks[0] === 'soldier-1',
    `clicks=${JSON.stringify(clicks)}`,
  )

  dom.window.document.getElementById('isInAnyQueue').setAttribute('value', 'true')
  const target = dom.window.document.getElementById('queue-slot-soldier-1')
  target.setAttribute('class', 'queue-slot queue-slot-own')
  target.setAttribute('data-player', '76561198000000000')
  target.innerHTML = '<div class="player-info">me</div>'
  await sleep(900)

  record(
    'Старт: чужой слот — флаг автозахода очищен',
    readPending(dom.window) === null,
    JSON.stringify(readPending(dom.window)),
  )
}

async function testStartupLeavesOtherMode() {
  resetIntervals()
  const html = queuePage({
    slug: 'auto-6v6',
    joined: 'auto-9v9',
    inQueue: true,
    inCurrent: false,
    slots: [
      ['soldier-1', 'free'],
      ['soldier-2', 'occupied'],
      ['soldier-3', 'free'],
    ],
  })
  const { dom, assigned, location } = createPage(html, 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(700)

  record(
    'Старт: другой режим — переход в очередь, где стоит игрок',
    assigned[0] === '/q/auto-9v9' && clicks.length === 0,
    `assigned=${JSON.stringify(assigned)} clicks=${JSON.stringify(clicks)}`,
  )
}

async function testRequeueLeavesJoinedQueueAndReturns() {
  resetIntervals()
  const html = queuePage({
    slug: 'auto-9v9',
    joined: 'auto-9v9',
    inQueue: true,
    inCurrent: true,
    slots: [
      ['soldier-1', 'own'],
      ['soldier-2', 'free'],
      ['soldier-3', 'occupied'],
    ],
  })
  const { dom, assigned, location } = createPage(html, 'https://tf2-pick-up.ru/q/auto-9v9')
  bindWindow(dom.window, location)
  setPending(dom.window, { slug: 'auto-6v6', path: '/q/auto-6v6' })
  const clicks = trackJoinClicks(dom.window)
  const leaveClicks = trackLeaveClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Другая очередь: сначала выход, без захода на чужой слот',
    leaveClicks.length === 1 && clicks.length === 0 && assigned.length === 0,
    `leave=${JSON.stringify(leaveClicks)} clicks=${JSON.stringify(clicks)} assigned=${JSON.stringify(assigned)}`,
  )

  dom.window.document.getElementById('isInAnyQueue').setAttribute('value', 'false')
  dom.window.document.getElementById('isInCurrentQueue').setAttribute('value', 'false')
  dom.window.document.querySelector('#queue-switcher a[data-joined]').removeAttribute('data-joined')
  const own = dom.window.document.getElementById('queue-slot-soldier-1')
  own.setAttribute('class', 'queue-slot')
  own.removeAttribute('data-player')
  own.innerHTML = '<div class="player-info">free</div>'
  await sleep(1200)

  record(
    'Другая очередь: после выхода — переход к настроенной очереди',
    assigned.includes('/q/auto-6v6'),
    `assigned=${JSON.stringify(assigned)}`,
  )
  record(
    'Другая очередь: флаг автозахода сохранён до захода',
    readPending(dom.window) !== null,
    JSON.stringify(readPending(dom.window)),
  )
}

async function testStartupSkipsOtherPages() {
  resetIntervals()
  const html = `<!doctype html><html><body>
    <div id="queue-slot-soldier-1"><button class="join-queue-button" name="join" value="soldier-1">+</button></div>
  </body></html>`
  const { dom, assigned, location } = createPage(html, 'https://tf2-pick-up.ru/players/76561198000000000')
  bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Запуск: на страницах вне очередей ничего не происходит',
    clicks.length === 0 && assigned.length === 0 && readPending(dom.window) === null,
  )
}

async function testGameEndRequeue() {
  resetIntervals()
  const { dom, assigned, location } = createPage(gamePage(), 'https://tf2-pick-up.ru/games/42')
  bindWindow(dom.window, location)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(500)

  record('Матч live: автозаход ещё не срабатывает', assigned.length === 0 && readPending(dom.window) === null)

  dom.window.document.getElementById('game-42-state').textContent = ''
  dom.window.document.getElementById('game-42-event-list').innerHTML =
    '<div class="game-event">Game ended</div>'
  await sleep(500)

  const pending = readPending(dom.window)
  record(
    'Матч окончен: переход на /q/auto-6v6 (v5)',
    assigned[0] === '/q/auto-6v6',
    `assigned=${JSON.stringify(assigned)}`,
  )
  record(
    'Матч окончен: сохранены режим/класс/слот',
    pending?.queue === '6v6' && pending?.gameClass === 'soldier' && pending?.slot === 1,
    JSON.stringify(pending),
  )

  dom.window.document.getElementById('game-42-state').textContent = ''
  await sleep(400)
  record('Повторное срабатывание исключено', assigned.length === 1, `assigned=${JSON.stringify(assigned)}`)
}

async function testUltitrioResolution() {
  resetIntervals()
  const { dom, assigned, location } = createPage(gamePage({ number: 7 }), 'https://tf2-pick-up.ru/games/7')
  const fetchCalls = bindWindow(dom.window, location, {
    fetchOk: url => url.includes('/q/auto-ultitrio'),
  })
  loadPreload(
    makeIpc({
      'auto-requeue:config': { enabled: true, queue: '3v3', gameClass: 'soldier', slot: 1 },
    }),
  )
  await sleep(500)

  dom.window.document.getElementById('game-7-state').textContent = ''
  dom.window.document.getElementById('game-7-event-list').innerHTML = '<div>Game ended</div>'
  await sleep(1500)

  const pending = readPending(dom.window)
  record(
    'Режим 3v3: переход на /q/auto-ultitrio',
    assigned[0] === '/q/auto-ultitrio',
    `assigned=${JSON.stringify(assigned)}`,
  )
  record(
    'Режим 3v3: адрес проверен HEAD-запросом',
    fetchCalls.length === 1 &&
      fetchCalls[0].method === 'HEAD' &&
      fetchCalls[0].url.includes('/q/auto-ultitrio'),
    JSON.stringify(fetchCalls),
  )
  record('Режим 3v3: в ожидании записан slug', pending?.slug === 'auto-ultitrio', JSON.stringify(pending))
}

async function testSwitcherResolution() {
  resetIntervals()
  const { dom, assigned, location } = createPage(queuePage(), 'https://tf2-pick-up.ru/q/auto-6v6')
  const fetchCalls = bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  loadPreload(
    makeIpc({
      'auto-requeue:config': { enabled: true, queue: 'bball', gameClass: 'soldier', slot: 1 },
    }),
  )
  await sleep(700)

  record(
    'Неизвестный режим: адрес взят из переключателя очередей',
    assigned[0] === '/q/auto-bball',
    `assigned=${JSON.stringify(assigned)}`,
  )
  record('Неизвестный режим: сеть не потребовалась', fetchCalls.length === 0, JSON.stringify(fetchCalls))
  record('Неизвестный режим: слот пока не занимается', clicks.length === 0, `clicks=${JSON.stringify(clicks)}`)
}

async function testQueueJoinPreferredSlot() {
  resetIntervals()
  const { dom, location } = createPage(queuePage(), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  setPending(dom.window, { slug: 'auto-6v6', path: '/q/auto-6v6' })
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Очередь: занят предпочтительный слот',
    clicks.length === 1 && clicks[0] === 'soldier-1',
    `clicks=${JSON.stringify(clicks)}`,
  )

  dom.window.document.getElementById('isInAnyQueue').setAttribute('value', 'true')
  const own = dom.window.document.getElementById('queue-slot-soldier-1')
  own.setAttribute('data-player', '76561198000000000')
  own.innerHTML = '<div class="player-info">me</div>'
  await sleep(1200)

  record('Очередь: после захода повторных кликов нет', clicks.length === 1, `clicks=${JSON.stringify(clicks)}`)
  record('Очередь: флаг автозахода очищен', readPending(dom.window) === null)
}

async function testQueueFallbackSlot() {
  resetIntervals()
  const { dom, location } = createPage(queuePage(), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  setPending(dom.window, { slug: 'auto-6v6', path: '/q/auto-6v6' })
  dom.window.document.getElementById('queue-slot-soldier-1').innerHTML =
    '<div class="player-info">other</div>'
  dom.window.document.getElementById('queue-slot-soldier-1').setAttribute('data-player', 'other')
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Занят выбранный слот: взят первый свободный слот класса',
    clicks.length === 1 && clicks[0] === 'soldier-3',
    `clicks=${JSON.stringify(clicks)}`,
  )
}

async function testQueueCooldown() {
  resetIntervals()
  const html = queuePage({
    slots: [
      ['soldier-1', 'disabled'],
      ['soldier-2', 'occupied'],
      ['soldier-3', 'disabled'],
    ],
  })
  const { dom, location } = createPage(html, 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  setPending(dom.window, { slug: 'auto-6v6', path: '/q/auto-6v6' })
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(700)

  const noClickYet = clicks.length === 0 && readPending(dom.window) !== null

  dom.window.document
    .getElementById('queue-slot-soldier-1')
    .querySelector('button')
    .removeAttribute('disabled')
  await sleep(1500)

  record(
    'Кулдаун: клик только после разблокировки кнопки',
    noClickYet && clicks.length === 1 && clicks[0] === 'soldier-1',
    `noClickYet=${noClickYet} clicks=${JSON.stringify(clicks)}`,
  )
}

async function testSnackbarOnQueuePage() {
  resetIntervals()
  const snackbar = `<div class="snackbar">
      <span>You are involved in a currently running game</span>
      <a href="/games/42" class="button">Go back to the game</a>
    </div>`
  const { dom, assigned, location } = createPage(queuePage({ snackbar }), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const clicks = trackJoinClicks(dom.window)
  loadPreload(makeIpc({ 'auto-requeue:config': requeueConfig }))
  await sleep(600)

  record(
    'Баннер активной игры: слот не занимается',
    clicks.length === 0 && readPending(dom.window) === null,
  )

  dom.window.document.getElementById('running-game-snackbar').innerHTML = ''
  await sleep(900)

  record(
    'Баннер исчез: клик по свободному слоту',
    clicks.length === 1 && clicks[0] === 'soldier-1',
    `clicks=${JSON.stringify(clicks)}`,
  )
  record('Баннер исчез: переход не нужен', assigned.length === 0, `assigned=${JSON.stringify(assigned)}`)
}

async function testDisabledConfig() {
  resetIntervals()
  const { dom, assigned, location } = createPage(gamePage({ number: 7 }), 'https://tf2-pick-up.ru/games/7')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': { ...requeueConfig, enabled: false } })
  loadPreload(ipc)
  await sleep(500)

  dom.window.document.getElementById('game-7-state').textContent = ''
  dom.window.document.getElementById('game-7-event-list').innerHTML = '<div>Game ended</div>'
  await sleep(500)
  record('Автозаход выключен: ничего не происходит', assigned.length === 0 && readPending(dom.window) === null)

  ipc.emit('settings:changed', {
    autoRequeue: true,
    requeueQueue: '6v6',
    requeueClass: 'soldier',
    requeueSlot: 1,
  })
  dom.window.document.getElementById('game-7-state').textContent = '   '
  await sleep(800)
  record(
    'Смена настройки на лету: автозаход включился без перезапуска',
    assigned[0] === '/q/auto-6v6',
    `assigned=${JSON.stringify(assigned)}`,
  )
}

async function testPreReady() {
  resetIntervals()
  const { dom, location } = createPage(
    queuePage({ inQueue: true, inCurrent: true, preReady: false, slots: [['soldier-1', 'own']] }),
    'https://tf2-pick-up.ru/q/auto-6v6',
  )
  bindWindow(dom.window, location)
  const clicks = []
  dom.window.document.getElementById('pre-ready-up-button').addEventListener('click', () => clicks.push(1))
  const ipc = makeIpc({
    'auto-pre-ready:check': true,
    'auto-ready:check': false,
    'auto-requeue:config': requeueConfig,
  })
  loadPreload(ipc)
  await sleep(2200)

  record('Pre-ready: кнопка нажата, когда игрок в очереди', clicks.length === 1, `clicks=${clicks.length}`)
  record('Pre-ready: без спама уведомлений об автодействии', !ipc.has('auto-action-done'), JSON.stringify(ipc.sent.map(item => item.channel)))

  await sleep(1500)
  record('Pre-ready: повторное нажатие не раньше 30 секунд', clicks.length === 1, `clicks=${clicks.length}`)

  resetIntervals()
  const idle = createPage(
    queuePage({ inQueue: false, preReady: false, preReadyDisabled: false }),
    'https://tf2-pick-up.ru/q/auto-6v6',
  )
  bindWindow(idle.dom.window, idle.location)
  const idleClicks = []
  idle.dom.window.document
    .getElementById('pre-ready-up-button')
    .addEventListener('click', () => idleClicks.push(1))
  loadPreload(makeIpc({ 'auto-pre-ready:check': true, 'auto-requeue:config': requeueConfig }))
  await sleep(1600)
  record('Pre-ready: не нажимается вне очереди', idleClicks.length === 0, `clicks=${idleClicks.length}`)

  resetIntervals()
  const armed = createPage(
    queuePage({ inQueue: true, inCurrent: true, preReady: true, slots: [['soldier-1', 'own']] }),
    'https://tf2-pick-up.ru/q/auto-6v6',
  )
  bindWindow(armed.dom.window, armed.location)
  const armedClicks = []
  armed.dom.window.document
    .getElementById('pre-ready-up-button')
    .addEventListener('click', () => armedClicks.push(1))
  loadPreload(makeIpc({ 'auto-pre-ready:check': true, 'auto-requeue:config': requeueConfig }))
  await sleep(1600)
  record('Pre-ready: уже включённый режим не отключается', armedClicks.length === 0, `clicks=${armedClicks.length}`)
}

async function testReadyDialog() {
  resetIntervals()
  const html = `<!doctype html><html><body>
    <dialog id="ready-up-dialog" open>
      <form><button name="ready" value="ready">I'm ready</button><button name="leave" value="leave">Leave</button></form>
    </dialog>
  </body></html>`

  const { dom, location } = createPage(html, 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const clicks = []
  dom.window.document.querySelector('button[name="ready"]').addEventListener('click', () => clicks.push(1))
  const ipc = makeIpc({
    'auto-pre-ready:check': false,
    'auto-ready:check': true,
    'auto-requeue:config': requeueConfig,
  })
  loadPreload(ipc)
  await sleep(700)

  record('Ready-up: показано уведомление', ipc.has('notify-ready-up'), JSON.stringify(ipc.sent.map(item => item.channel)))
  record('Ready-up: «I’m ready» нажата (опция включена)', clicks.length === 1, `clicks=${clicks.length}`)

  resetIntervals()
  const off = createPage(html, 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(off.dom.window, off.location)
  const offClicks = []
  off.dom.window.document.querySelector('button[name="ready"]').addEventListener('click', () => offClicks.push(1))
  const offIpc = makeIpc({
    'auto-pre-ready:check': false,
    'auto-ready:check': false,
    'auto-requeue:config': requeueConfig,
  })
  loadPreload(offIpc)
  await sleep(700)
  record('Ready-up: без опции клика нет, уведомление есть', offClicks.length === 0 && offIpc.has('notify-ready-up'))
}

async function testSteamLinks() {
  resetIntervals()
  const { dom, location } = createPage(gamePage(), 'https://tf2-pick-up.ru/games/42')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(ipc)
  await sleep(500)

  const link = dom.window.document.querySelector('a.join-game-button')
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  link.dispatchEvent(event)
  const sentConnect = ipc.sent.find(item => item.channel === 'steam-connect')
  record(
    'Steam-ссылка: клик перехвачен и отправлен в main',
    Boolean(sentConnect) && sentConnect.args[0].includes('steam://connect/1.2.3.4:27015/secret'),
  )
  record('Steam-ссылка: переход по умолчанию отменён', event.defaultPrevented)
  record('Steam-ссылка: уведомление о готовности сервера', ipc.has('notify-server-ready'))

  resetIntervals()
  const stv = createPage(gamePage({ number: 43, joinLabel: 'watch stv' }), 'https://tf2-pick-up.ru/games/43')
  bindWindow(stv.dom.window, stv.location)
  const stvIpc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(stvIpc)
  await sleep(500)
  record('STV: автоподключение не срабатывает', !stvIpc.has('auto-connect'), JSON.stringify(stvIpc.sent.map(item => item.channel)))

  resetIntervals()
  const countdown = createPage(gamePage({ number: 44, joinLabel: 'join in 0:15' }), 'https://tf2-pick-up.ru/games/44')
  bindWindow(countdown.dom.window, countdown.location)
  const countdownIpc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(countdownIpc)
  await sleep(500)
  record(
    'Отсчёт «join in»: автоподключение срабатывает',
    countdownIpc.has('auto-connect'),
    JSON.stringify(countdownIpc.sent.map(item => item.channel)),
  )
}

async function testChatBridge() {
  resetIntervals()
  const base = nowSeconds() - 300
  const messages = [
    { at: '21:00', author: 'dev.inq', body: 'gg', seconds: base },
    { at: '21:01', author: 'player2', body: 'wp', seconds: base + 60 },
    { at: '21:02', author: 'player3', body: 'gl hf <3', seconds: base + 120 },
  ]
  const { dom, location } = createPage(chatPage(messages), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(ipc)
  await sleep(900)

  const payloads = ipc.all('chat:messages')
  const last = payloads.at(-1)?.args?.[0] || []
  record('Чат: сообщения отправлены в main', payloads.length === 1, `payloads=${payloads.length}`)
  record(
    'Чат: автор/время/текст распознаны',
    last[0]?.author === 'dev.inq' && last[0]?.at === '21:00' && last[0]?.body === 'gg',
    JSON.stringify(last[0]),
  )
  record('Чат: порядок от старых к новым', last.at(-1)?.body === 'gl hf <3', JSON.stringify(last.map(item => item.body)))

  const list = dom.window.document.querySelector('.chat-day-messages')
  const fresh = dom.window.document.createElement('p')
  fresh.className = 'chat-message'
  fresh.id = `msg-${objectId(nowSeconds())}`
  fresh.innerHTML =
    '<span class="message-text"><span class="at">21:05</span> <a class="author" href="/players/1">newbie</a>: <span class="body">hi all</span></span>'
  list.append(fresh)
  await sleep(900)

  const updated = ipc.all('chat:messages').at(-1)?.args?.[0] || []
  record(
    'Чат: новое сообщение появляется в трее',
    updated.length === 4 && updated.at(-1)?.body === 'hi all',
    JSON.stringify(updated.map(item => item.body)),
  )

  resetIntervals()
  const empty = createPage(chatPage([]), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(empty.dom.window, empty.location)
  const emptyIpc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(emptyIpc)
  await sleep(700)
  record('Чат: пустой чат не отправляет данные', emptyIpc.all('chat:messages').length === 0)
}

async function testQueueStateBridge() {
  resetIntervals()
  const { dom, location } = createPage(queuePage(), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(ipc)
  await sleep(700)

  const state = ipc.all('queue:state').at(-1)?.args?.[0]
  record(
    'Трей: состояние очереди отправлено в main',
    state?.slug === 'auto-6v6' && state?.label === '6v6' && state?.isQueuePage === true,
    JSON.stringify({ slug: state?.slug, label: state?.label }),
  )
  record(
    'Трей: занятые слоты и ники определены',
    state?.slots?.length === 3 &&
      state.slots.find(slot => slot.id === 'soldier-2')?.occupied === true &&
      state.slots.find(slot => slot.id === 'soldier-2')?.name === 'Boris' &&
      state.slots.find(slot => slot.id === 'soldier-1')?.occupied === false,
    JSON.stringify(state?.slots),
  )
  record(
    'Трей: счётчик игроков определён',
    state?.current === 5 && state?.required === 12,
    `${state?.current}/${state?.required}`,
  )

  dom.window.document.getElementById('queue-slot-soldier-1').setAttribute('data-player', '76561198000000009')
  dom.window.document.getElementById('queue-slot-soldier-1').innerHTML =
    '<div class="player-info"><span class="player-name-text">New Guy</span></div>'
  await sleep(900)

  const updated = ipc.all('queue:state').at(-1)?.args?.[0]
  record(
    'Трей: изменения занятости обновляются',
    updated?.slots?.find(slot => slot.id === 'soldier-1')?.occupied === true &&
      updated?.slots?.find(slot => slot.id === 'soldier-1')?.name === 'New Guy',
    JSON.stringify(updated?.slots?.find(slot => slot.id === 'soldier-1')),
  )

  resetIntervals()
  const game = createPage(gamePage({ number: 3 }), 'https://tf2-pick-up.ru/games/3')
  bindWindow(game.dom.window, game.location)
  const gameIpc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(gameIpc)
  await sleep(700)
  const gameState = gameIpc.all('queue:state').at(-1)?.args?.[0]
  record(
    'Трей: на странице игры слотов нет',
    gameState?.isQueuePage === false && gameState?.slots?.length === 0,
    JSON.stringify({ isQueuePage: gameState?.isQueuePage, slots: gameState?.slots?.length }),
  )
}

async function testChatOpen() {
  resetIntervals()
  const { dom, location } = createPage(chatPage([]), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': requeueConfig })
  let tabClicks = 0
  dom.window.document
    .querySelector('[data-tabs-select="tab-chat"]')
    .addEventListener('click', () => tabClicks++)
  loadPreload(ipc)
  await sleep(300)

  ipc.emit('chat:open')
  record('Трей: пункт «Открыть чат» переключает вкладку чата', tabClicks === 1, `clicks=${tabClicks}`)
}

async function testChatSend() {
  resetIntervals()
  const { dom, location } = createPage(chatPage([]), 'https://tf2-pick-up.ru/q/auto-6v6')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': requeueConfig })
  const form = dom.window.document.getElementById('chat-prompt')
  const field = form.querySelector('input[name="message"]')
  let submits = 0
  form.addEventListener('submit', event => {
    event.preventDefault()
    submits += 1
  })
  loadPreload(ipc)
  await sleep(400)

  ipc.emit('chat:send', { id: '42', text: 'привет всем' })
  await sleep(250)

  const result = ipc.all('chat:send-result')[0]?.args?.[0]
  record('Чат в трее: текст подставлен в форму сайта', field.value === 'привет всем', `value=${field.value}`)
  record('Чат в трее: форма сайта отправлена', submits === 1, `submits=${submits}`)
  record('Чат в трее: отправка подтверждена', result?.ok === true, JSON.stringify(result))
}

async function testChatSendUnavailable() {
  resetIntervals()
  const html = '<!doctype html><html><body><div id="chat-message-list"></div></body></html>'
  const { dom, location } = createPage(html, 'https://tf2-pick-up.ru/players/76561198000000000')
  bindWindow(dom.window, location)
  const ipc = makeIpc({ 'auto-requeue:config': requeueConfig })
  loadPreload(ipc)
  await sleep(300)

  ipc.emit('chat:send', { id: '7', text: 'test' })
  await sleep(200)

  const result = ipc.all('chat:send-result')[0]?.args?.[0]
  record(
    'Чат в трее: вне страницы очереди показывается ошибка',
    result?.ok === false && typeof result?.error === 'string' && result.error.length > 0,
    JSON.stringify(result),
  )
}

async function testChatPopupUi() {
  const html = fs.readFileSync(path.join(ROOT, 'chat-popup.html'), 'utf8')
  const script = fs.readFileSync(path.join(ROOT, 'chat-popup.js'), 'utf8')
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {})
  const dom = new JSDOM(html, {
    url: 'https://tf2-pick-up.ru/chat-popup.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  })

  let deliver = null
  let sent = null
  dom.window.chatPopup = {
    onMessages: callback => {
      deliver = callback
    },
    send: async text => {
      sent = text
      return { ok: true }
    },
    close: () => {},
  }

  dom.window.eval(script)
  deliver([
    { id: '1', at: '21:00', author: 'dev.inq', body: 'gg' },
    { id: '2', at: '21:01', author: '<img src=x onerror=alert(1)>', body: '<b>hi</b>' },
  ])
  await sleep(120)

  const doc = dom.window.document
  record('Окно чата в трее: сообщения отображаются', doc.querySelectorAll('.msg').length === 2, `count=${doc.querySelectorAll('.msg').length}`)
  record(
    'Окно чата в трее: текст экранируется',
    doc.querySelector('.msg:nth-child(2) .body').textContent === '<b>hi</b>' &&
      doc.querySelectorAll('.msg img').length === 0,
  )

  const field = doc.getElementById('message')
  field.value = 'hello'
  doc.getElementById('send-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await sleep(150)
  record('Окно чата в трее: отправка очищает поле', sent === 'hello' && field.value === '' && doc.getElementById('status').textContent === 'Отправлено')

  dom.window.chatPopup.send = async () => ({ ok: false, error: 'нет доступа' })
  field.value = 'again'
  doc.getElementById('send-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await sleep(150)
  record(
    'Окно чата в трее: ошибка отправки показывается',
    doc.getElementById('status').textContent === 'нет доступа' && field.value === 'again',
    doc.getElementById('status').textContent,
  )

  let opened = false
  dom.window.chatPopup.openApp = () => {
    opened = true
  }
  doc.getElementById('open-app').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  record('Окно чата в трее: есть кнопка открытия приложения', opened === true)

  let settingsOpened = false
  dom.window.chatPopup.openSettings = () => {
    settingsOpened = true
  }
  doc
    .getElementById('open-settings')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  record('Окно чата в трее: есть кнопка настроек', settingsOpened === true)
}

async function testThemeAssets() {
  const readTheme = name => fs.readFileSync(path.join(ROOT, 'theme', name), 'utf8')
  const fonts = readTheme('fonts.css')
  const faceit = readTheme('faceit.css')
  const app = readTheme('app.css')
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  const settingsHtml = fs.readFileSync(SETTINGS_HTML, 'utf8')
  const popupHtml = fs.readFileSync(path.join(ROOT, 'chat-popup.html'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

  record(
    'Тема: шрифт встроен в CSS',
    fonts.includes('@font-face') &&
      fonts.includes('data:font/woff2;base64,') &&
      fonts.includes('Roboto Condensed'),
    `${Math.round(fonts.length / 1024)} KB`,
  )
  record(
    'Тема: палитра FACEIT и ключевые компоненты',
    [
      '--face-orange: #ff5500',
      '--color-zinc-950',
      '.nav-steam-button',
      '.queue-slot',
      "#pre-ready-up-button[aria-pressed='true']",
    ].every(needle => faceit.includes(needle)),
    `${Math.round(faceit.length / 1024)} KB`,
  )
  const balanced = css =>
    (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length
  record('Тема: CSS без незакрытых блоков', balanced(faceit) && balanced(app) && balanced(fonts))
  record(
    'Тема: main применяет тему после каждой загрузки страницы',
    mainJs.includes('function applySiteTheme') &&
      mainJs.includes("webContents.on('dom-ready'") &&
      mainJs.includes('faceitTheme: true'),
  )
  record(
    'Тема: окна приложения используют общий стиль',
    settingsHtml.includes('theme/app.css') &&
      settingsHtml.includes('theme/fonts.css') &&
      popupHtml.includes('theme/fonts.css'),
  )
  record(
    'Тема: файлы темы попадают в сборку',
    Array.isArray(pkg.build?.files) && pkg.build.files.includes('theme/**/*'),
  )
}

async function testSettingsUi() {
  const html = fs.readFileSync(SETTINGS_HTML, 'utf8')
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', () => {})
  const dom = new JSDOM(html, {
    url: 'https://tf2-pick-up.ru/settings.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  })
  const stored = {
    siteUrl: 'https://tf2-pick-up.ru/',
    autoConnect: false,
    autoJoin: false,
    autoPreReady: true,
    autoReady: false,
    autoRequeue: true,
    requeueQueue: '9v9',
    requeueClass: 'medic',
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
  let saved = null
  dom.window.desktopApi = {
    getSettings: async () => stored,
    saveSettings: async values => {
      saved = values
      Object.assign(stored, values)
      return stored
    },
    getVersion: async () => '1.0.0',
  }
  dom.window.eval(fs.readFileSync(SETTINGS_JS, 'utf8'))
  await sleep(200)

  const doc = dom.window.document
  const classes = doc.getElementById('requeueClass')
  const slots = doc.getElementById('requeueSlot')
  record(
    'Настройки: классы соответствуют выбранному режиму',
    classes.options.length === 9 && classes.value === 'medic',
    `options=${classes.options.length} value=${classes.value}`,
  )
  record('Настройки: слоты соответствуют классу', slots.options.length === 2 && slots.value === '1', `options=${slots.options.length}`)
  record('Настройки: переключатель чата в трее включён', doc.getElementById('trayChat').checked === true)
  record(
    'Настройки: тема FACEIT включена по умолчанию',
    doc.getElementById('faceitTheme').checked === true,
  )

  const queueSelect = doc.getElementById('requeueQueue')
  queueSelect.value = 'ultiduo'
  queueSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  record(
    'Смена режима: список классов перестроился, допустимый класс сохранён',
    classes.options.length === 2 && classes.value === 'medic',
    `options=${classes.options.length} value=${classes.value}`,
  )

  queueSelect.value = '3v3'
  queueSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  record(
    'Смена режима: недопустимый класс заменён',
    classes.options.length === 3 && ['scout', 'soldier', 'medic'].includes(classes.value),
    `value=${classes.value}`,
  )

  const overflow = doc.createElement('option')
  overflow.value = '99'
  overflow.textContent = 'Слот 99'
  slots.append(overflow)
  slots.value = '99'
  const values = dom.window.readForm()
  record(
    'Валидация: номер слота ограничен конфигом режима',
    values.requeueSlot <= 2 && values.requeueQueue === '3v3',
    JSON.stringify({ queue: values.requeueQueue, gameClass: values.requeueClass, slot: values.requeueSlot }),
  )

  doc.getElementById('requeueQueue').value = '6v6'
  doc.getElementById('requeueClass').value = 'soldier'
  doc.getElementById('requeueSlot').value = '1'
  doc.getElementById('autoRequeue').checked = false
  doc.getElementById('trayChat').checked = false
  doc.getElementById('faceitTheme').checked = false
  doc.getElementById('settings-form').dispatchEvent(
    new dom.window.Event('submit', { bubbles: true, cancelable: true }),
  )
  await sleep(150)
  record(
    'Сохранение: новые параметры уходят в main',
    Boolean(saved) &&
      saved.autoRequeue === false &&
      saved.trayChat === false &&
      saved.faceitTheme === false &&
      saved.requeueQueue === '6v6' &&
      saved.requeueClass === 'soldier',
    JSON.stringify(saved && { autoRequeue: saved.autoRequeue, trayChat: saved.trayChat, faceitTheme: saved.faceitTheme, queue: saved.requeueQueue, cls: saved.requeueClass }),
  )
}

async function testQueueUrlCache() {
  resetIntervals()
  const { dom, assigned, location } = createPage(gamePage({ number: 9 }), 'https://tf2-pick-up.ru/games/9')
  const fetchCalls = bindWindow(dom.window, location, { fetchOk: () => false })
  dom.window.sessionStorage.setItem(`${QUEUE_URL_CACHE_PREFIX}4v4`, '/q/auto-4v4')
  loadPreload(
    makeIpc({
      'auto-requeue:config': { enabled: true, queue: '4v4', gameClass: 'medic', slot: 2 },
    }),
  )
  await sleep(500)

  dom.window.document.getElementById('game-9-state').textContent = ''
  dom.window.document.getElementById('game-9-event-list').innerHTML = '<div>Game ended</div>'
  await sleep(900)

  record(
    'Кэш адреса очереди: переход без сети',
    assigned[0] === '/q/auto-4v4' && fetchCalls.length === 0,
    `assigned=${JSON.stringify(assigned)} fetch=${JSON.stringify(fetchCalls)}`,
  )
  record(
    'Кэш адреса очереди: класс и слот сохранены',
    readPending(dom.window)?.gameClass === 'medic' && readPending(dom.window)?.slot === 2,
    JSON.stringify(readPending(dom.window)),
  )
}

async function testInstalledBuild() {
  const { execFileSync } = require('child_process')
  const node = process.execPath
  const script = `
    const asar = require('@electron/asar');
    const fs = require('fs');
    const src = asar.extractFile('dist/win-unpacked/resources/app.asar', 'preload.js').toString();
    const inst = process.env.LOCALAPPDATA + '\\\\Programs\\\\TF2Pickup\\\\resources\\\\app.asar';
    if (!fs.existsSync(inst)) { console.log('MISSING'); process.exit(0) }
    const dst = asar.extractFile(inst, 'preload.js').toString();
    console.log(src === dst ? 'SAME' : 'DIFF');
  `
  let out = ''
  try {
    out = execFileSync(node, ['-e', script], { cwd: ROOT, encoding: 'utf8' }).trim()
  } catch (error) {
    out = `ERROR ${error.message}`
  }
  record('Установленная версия идентична собранной', out === 'SAME', out)
}

async function main() {
  await testStartupJoin()
  await testStartupSkipWhenQueued()
  await testStartupOverridesOtherSlot()
  await testStartupLeavesOtherMode()
  await testRequeueLeavesJoinedQueueAndReturns()
  await testStartupSkipsOtherPages()
  await testGameEndRequeue()
  await testUltitrioResolution()
  await testSwitcherResolution()
  await testQueueJoinPreferredSlot()
  await testQueueFallbackSlot()
  await testQueueCooldown()
  await testSnackbarOnQueuePage()
  await testDisabledConfig()
  await testPreReady()
  await testReadyDialog()
  await testSteamLinks()
  await testChatBridge()
  await testQueueStateBridge()
  await testChatOpen()
  await testChatSend()
  await testChatSendUnavailable()
  await testChatPopupUi()
  await testThemeAssets()
  await testSettingsUi()
  await testQueueUrlCache()
  await testInstalledBuild()

  const failed = results.filter(item => !item.ok)
  console.log(`\nИтого: ${results.length - failed.length}/${results.length} проверок пройдено`)
  if (failed.length > 0) {
    console.log('Провалены:')
    for (const item of failed) console.log(` - ${item.name}`)
    process.exitCode = 1
  }
  resetIntervals()
}

main().catch(error => {
  console.error('Harness crashed:', error)
  process.exitCode = 1
})
