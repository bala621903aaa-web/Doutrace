import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let windowInstance: BrowserWindow | undefined;

function createWindow() {
  windowInstance = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    title: '抖音私聊档案',
    webPreferences: {
      preload: join(currentDirectory, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  void windowInstance.loadFile(join(currentDirectory, 'renderer', 'index.html'));
  windowInstance.on('closed', () => { windowInstance = undefined; });
}

ipcMain.handle('app-state', () => ({
  version: app.getVersion(),
  validationGate: 'p1-required',
  message: '真实数据通道尚未完成无滚动分页验证，正式采集功能保持关闭。'
}));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
