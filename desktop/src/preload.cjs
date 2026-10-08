const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('app-state'),
  getContext: () => ipcRenderer.invoke('archive-get-context'),
  connect: () => ipcRenderer.invoke('archive-connect'),
  refreshContext: () => ipcRenderer.invoke('archive-refresh-context'),
  startCapture: input => ipcRenderer.invoke('archive-start-capture', input),
  stopCapture: () => ipcRenderer.invoke('archive-stop-capture'),
  getCollector: () => ipcRenderer.invoke('archive-get-collector'),
  repairConversation: input => ipcRenderer.invoke('archive-repair-conversation', input),
  cancelRepair: () => ipcRenderer.invoke('archive-cancel-repair'),
  retryAttachment: input => ipcRenderer.invoke('archive-retry-attachment', input),
  getMessages: input => ipcRenderer.invoke('archive-get-messages', input),
  getAttachments: input => ipcRenderer.invoke('archive-get-attachments', input),
  getMediaUrl: input => ipcRenderer.invoke('archive-get-media-url', input),
  recordMediaEvidence: input => ipcRenderer.invoke('archive-record-media-evidence', input),
  exportConversation: input => ipcRenderer.invoke('archive-export', input),
  onEvent: listener => {
    const handler = (_event, context) => listener(context);
    ipcRenderer.on('archive-event', handler);
    return () => ipcRenderer.removeListener('archive-event', handler);
  }
};

contextBridge.exposeInMainWorld('desktopArchive', api);
