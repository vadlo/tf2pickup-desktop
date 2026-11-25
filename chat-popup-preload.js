const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chatPopup', {
  onMessages: callback =>
    ipcRenderer.on('chat:popup-messages', (_event, messages) => {
      callback(Array.isArray(messages) ? messages : [])
    }),
  send: text => ipcRenderer.invoke('chat:send', String(text ?? '')),
  openApp: () => ipcRenderer.send('chat:popup-open-app'),
  openSettings: () => ipcRenderer.send('chat:popup-settings'),
  close: () => ipcRenderer.send('chat:popup-close'),
})
