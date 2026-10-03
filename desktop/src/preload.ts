import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopArchive', {
  getState: () => ipcRenderer.invoke('app-state') as Promise<{ version: string; validationGate: string; message: string }>
});
