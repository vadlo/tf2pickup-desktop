const messagesElement = document.getElementById('messages')
const form = document.getElementById('send-form')
const input = document.getElementById('message')
const sendButton = document.getElementById('send')
const statusElement = document.getElementById('status')

let lastSignature = ''
let statusTimer = null

function setStatus(text, isError = false) {
  statusElement.textContent = text || ''
  statusElement.style.color = isError ? '#ff9494' : '#8c929e'

  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  if (text) {
    statusTimer = setTimeout(() => {
      statusElement.textContent = ''
    }, 5000)
  }
}

function scrollToBottom() {
  messagesElement.scrollTop = messagesElement.scrollHeight
}

function render(messages) {
  const signature = messages
    .map(message => `${message.id}|${message.at}|${message.author}|${message.body}`)
    .join('\u0001')
  if (signature === lastSignature) return

  const wasNearBottom =
    messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 48
  lastSignature = signature

  messagesElement.textContent = ''
  if (messages.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = 'Сообщений пока нет'
    messagesElement.append(empty)
    return
  }

  for (const message of messages) {
    const row = document.createElement('div')
    row.className = 'msg'

    const meta = document.createElement('div')
    meta.className = 'meta'

    if (message.at) {
      const time = document.createElement('span')
      time.className = 'time'
      time.textContent = `${message.at} `
      meta.append(time)
    }

    const author = document.createElement('span')
    author.className = 'author'
    author.textContent = message.author || '???'
    meta.append(author)

    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = message.body

    row.append(meta, body)
    messagesElement.append(row)
  }

  if (wasNearBottom || messages.length === 1) scrollToBottom()
}

window.chatPopup.onMessages(render)

form.addEventListener('submit', async event => {
  event.preventDefault()

  const text = input.value.trim()
  if (!text) return

  sendButton.disabled = true
  try {
    const result = await window.chatPopup.send(text)
    if (result && result.ok) {
      input.value = ''
      setStatus('Отправлено')
    } else {
      setStatus((result && result.error) || 'Не удалось отправить', true)
    }
  } catch (error) {
    setStatus(String(error?.message ?? error), true)
  } finally {
    sendButton.disabled = false
    input.focus()
  }
})

document.getElementById('close').addEventListener('click', () => window.chatPopup.close())

document.getElementById('open-app').addEventListener('click', () => {
  if (typeof window.chatPopup.openApp === 'function') window.chatPopup.openApp()
})

document.getElementById('open-settings').addEventListener('click', () => {
  if (typeof window.chatPopup.openSettings === 'function') window.chatPopup.openSettings()
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.chatPopup.close()
})

input.focus()
