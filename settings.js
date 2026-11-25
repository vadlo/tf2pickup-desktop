const form = document.getElementById('settings-form')
const status = document.getElementById('status')
const checkboxNames = [
  'autoConnect',
  'autoJoin',
  'autoPreReady',
  'autoReady',
  'autoRequeue',
  'notifyAutoActions',
  'minimizeOnJoin',
  'closeToTray',
  'notifyReadyUp',
  'notifyServerReady',
  'trayChat',
  'launchOnStartup',
  'faceitTheme',
]

// Class counts are per team; the site creates two teams for every queue.
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

function fillSlotOptions(gameClass, queue, selectedSlot) {
  const max = queueClasses[queue]?.[gameClass] ?? 1
  const select = document.getElementById('requeueSlot')
  select.innerHTML = ''
  for (let i = 1; i <= max; i++) {
    const option = document.createElement('option')
    option.value = String(i)
    option.textContent = `Слот ${i}`
    select.append(option)
  }
  const value = Number(selectedSlot)
  select.value = String(Number.isInteger(value) && value >= 1 && value <= max ? value : 1)
}

function fillClassOptions(queue, selectedClass, selectedSlot) {
  const classes = queueClasses[queue] ?? queueClasses['6v6']
  const select = document.getElementById('requeueClass')
  select.innerHTML = ''
  for (const name of Object.keys(classes)) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = classLabels[name] ?? name
    select.append(option)
  }
  const gameClass = classes[selectedClass] ? selectedClass : Object.keys(classes)[0]
  select.value = gameClass
  fillSlotOptions(gameClass, queue, selectedSlot)
}

function fillForm(values) {
  for (const name of checkboxNames) {
    document.getElementById(name).checked = Boolean(values[name])
  }
  for (const name of ['siteUrl', 'launchMode', 'steamExePath', 'launchOptions']) {
    document.getElementById(name).value = values[name] ?? ''
  }
  const queue = queueClasses[values.requeueQueue] ? values.requeueQueue : '6v6'
  document.getElementById('requeueQueue').value = queue
  fillClassOptions(queue, values.requeueClass, values.requeueSlot)
}

function readForm() {
  const values = {}
  for (const name of checkboxNames) {
    values[name] = document.getElementById(name).checked
  }
  for (const name of [
    'siteUrl',
    'launchMode',
    'steamExePath',
    'launchOptions',
    'requeueQueue',
    'requeueClass',
  ]) {
    values[name] = document.getElementById(name).value.trim()
  }
  values.requeueSlot = Number(document.getElementById('requeueSlot').value) || 1

  if (!values.siteUrl) values.siteUrl = 'https://tf2pick-up.ru/'
  if (!queueClasses[values.requeueQueue]) values.requeueQueue = '6v6'
  const classes = queueClasses[values.requeueQueue]
  if (!classes[values.requeueClass]) values.requeueClass = Object.keys(classes)[0]
  values.requeueSlot = Math.min(Math.max(1, values.requeueSlot), classes[values.requeueClass])
  return values
}

document.getElementById('requeueQueue').addEventListener('change', event => {
  fillClassOptions(
    event.target.value,
    document.getElementById('requeueClass').value,
    document.getElementById('requeueSlot').value,
  )
})

document.getElementById('requeueClass').addEventListener('change', event => {
  fillSlotOptions(
    event.target.value,
    document.getElementById('requeueQueue').value,
  )
})

async function init() {
  try {
    const settings = await window.desktopApi.getSettings()
    fillForm(settings)
    document.getElementById('version').textContent = `TF2Pickup Desktop v${await window.desktopApi.getVersion()}`
  } catch (error) {
    status.classList.add('error')
    status.textContent = `Не удалось загрузить настройки: ${error.message}`
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  status.classList.remove('error')
  status.textContent = ''
  try {
    await window.desktopApi.saveSettings(readForm())
    status.textContent = 'Настройки сохранены.'
  } catch (error) {
    status.classList.add('error')
    status.textContent = `Ошибка сохранения: ${error.message}`
  }
})

document.getElementById('cancel').addEventListener('click', () => window.close())

document.getElementById('reset').addEventListener('click', () => {
  fillForm({
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
  })
  status.textContent = 'Значения по умолчанию восстановлены — нажмите «Сохранить».'
})

init()
