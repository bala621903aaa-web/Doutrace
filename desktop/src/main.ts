import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { appDataRoot } from './probe/browser.js';
import { DouyinHistoryAdapter } from './adapters/douyin-history-adapter.js';
import { ArchiveDatabase, type BrowserMediaEvidenceEvent } from './core/archive-db.js';
import { AttachmentService } from './core/attachment-service.js';
import { ArchiveRepair, type RepairConversationResult } from './core/archive-repair.js';
import { ArchiveCollector, type CollectorSnapshot } from './core/collector.js';
import { CollectorCursorEvidence, loadOrCreateCollectorEvidenceKey } from './core/collector-evidence.js';
import { assertTrustedArchiveSender } from './core/renderer-trust.js';
import { validateReleaseValidation, type ReleaseValidationState } from './core/release-validation.js';
import { P1_REQUIREMENTS, PROTOCOL_MAPPING_VERSION, TIME_MAPPING_VERSION } from './probe/verification-suite.js';
import type { AccountInfo, ConversationInfo } from './core/contracts.js';
import type { DesktopAppState, DesktopContext } from './core/desktop-api.js';
import { exportConversation } from './core/archive-export.js';
import { loadConversationStats } from './core/conversation-stats-service.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const developmentMode = existsSync(join(currentDirectory, 'development-mode.json'));
const dataRoot = developmentMode ? join(dirname(currentDirectory), '.desktop-data', 'mock-dev') : appDataRoot();
const rendererEntryUrl = pathToFileURL(join(currentDirectory, 'renderer', 'index.html')).href;
let windowInstance: BrowserWindow | undefined;
let database: ArchiveDatabase | undefined;
let adapter: DouyinHistoryAdapter | undefined;
let collector: ArchiveCollector | undefined;
let attachmentService: AttachmentService | undefined;
let archiveRepair: ArchiveRepair | undefined;
let collectorCursorEvidence: CollectorCursorEvidence | undefined;
let activeAccount: AccountInfo | null = null;
let activeConversations: ConversationInfo[] = [];
let browserStatus = developmentMode ? '本地模拟模式：浏览器连接和联网自动化已禁用' : '尚未连接独立浏览器';
let shuttingDown = false;
let repairRunning = false;
let lastRepairResult: RepairConversationResult | null = null;
let exporting = false;
let exportDialogOpen = false;
let activeExport: Promise<unknown> | null = null;
let releaseValidation: ReleaseValidationState = { valid: false, acquisitionEnabled: false, offlineEnabled: true, reason: 'release-validation-not-loaded' };

const emptyCollector: CollectorSnapshot = {
  state: 'idle', runId: null, account: null, conversation: null, pages: 0, messages: 0,
  nextCursor: null, hasMore: null, reason: null, error: null, startedAt: null, finishedAt: null
};

function currentContext(): DesktopContext {
  return {
    account: activeAccount,
    conversations: activeConversations,
    archivedConversations: database?.listConversations(activeAccount?.accountId) ?? [],
    collector: collector?.snapshot() ?? emptyCollector,
    repair: { running: repairRunning, lastResult: lastRepairResult },
    exporting
  };
}

function sendContext() {
  if (!windowInstance || windowInstance.isDestroyed()) return;
  windowInstance.webContents.send('archive-event', currentContext());
}

function appState(): DesktopAppState {
  return {
    version: app.getVersion(),
    validationGate: releaseValidation.valid ? 'p1-open' : 'p1-required',
    acquisitionEnabled: releaseValidation.acquisitionEnabled,
    message: developmentMode
      ? '本地模拟开发版：仅使用隔离的模拟数据目录；真实账号连接、采集、补修和联网自动化已禁用。'
      : releaseValidation.valid
      ? 'P1 八项证据与当前构建匹配；这不表示 P2～P5 的真实产品验收已全部完成。'
      : `构建验收资料校验失败（${releaseValidation.reason}）；离线阅读和导出可用，联网采集、补修与附件重试已禁用。`,
    connected: Boolean(adapter && !adapter.page.isClosed()),
    account: activeAccount,
    browserStatus
  };
}

function parseBrowserMediaEvidenceEvent(value: unknown): BrowserMediaEvidenceEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const exactKeys = (expected: string[]) => Object.keys(event).length === expected.length && expected.every(key => Object.hasOwn(event, key));
  switch (event.type) {
    case 'image-decoded':
      return exactKeys(['type', 'naturalWidth', 'naturalHeight']) && Number.isSafeInteger(event.naturalWidth) && Number.isSafeInteger(event.naturalHeight)
        ? { type: 'image-decoded', naturalWidth: Number(event.naturalWidth), naturalHeight: Number(event.naturalHeight) } : null;
    case 'image-error':
    case 'audio-error':
      return exactKeys(['type', 'errorCode']) && Number.isSafeInteger(event.errorCode)
        ? { type: event.type, errorCode: Number(event.errorCode) } : null;
    case 'audio-metadata':
      return exactKeys(['type', 'durationSeconds']) && typeof event.durationSeconds === 'number' && Number.isFinite(event.durationSeconds)
        ? { type: 'audio-metadata', durationSeconds: event.durationSeconds } : null;
    case 'audio-playback':
      return exactKeys(['type', 'advancedSeconds']) && typeof event.advancedSeconds === 'number' && Number.isFinite(event.advancedSeconds)
        ? { type: 'audio-playback', advancedSeconds: event.advancedSeconds } : null;
    case 'audio-ended':
      return exactKeys(['type']) ? { type: 'audio-ended' } : null;
    default: return null;
  }
}

function createWindow() {
  windowInstance = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 980,
    minHeight: 650,
    title: '抖忆 · DouTrace',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#faf9f6',
      symbolColor: '#5f554a',
      height: 38
    },
    webPreferences: {
      preload: join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  windowInstance.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowInstance.webContents.on('will-navigate', event => event.preventDefault());
  void windowInstance.loadFile(join(currentDirectory, 'renderer', 'index.html'));
  windowInstance.on('closed', () => { windowInstance = undefined; });
}

function handleArchive<T extends unknown[], R>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: T) => R) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedArchiveSender(event, windowInstance, rendererEntryUrl);
    return handler(event, ...(args as T));
  });
}

async function ensureDatabase() {
  if (database) return database;
  database = await ArchiveDatabase.open(join(dataRoot, 'archive', 'archive.sqlite3'));
  database.recoverInterruptedRuns();
  attachmentService = new AttachmentService(database, join(dataRoot, 'archive', 'media'));
  return database;
}

async function connectBrowser() {
  if (!releaseValidation.acquisitionEnabled || developmentMode) throw new Error(appState().message);
  if (exporting) throw new Error('导出期间暂不能重连浏览器。');
  await collector?.stopAndWait();
  await archiveRepair?.cancelAndWait();
  await attachmentService?.cancelAndWait();
  if (adapter) await adapter.close().catch(() => undefined);
  adapter = undefined;
  collector = undefined;
  archiveRepair = undefined;
  activeAccount = null;
  activeConversations = [];
  browserStatus = '正在启动独立浏览器…';
  sendContext();
  adapter = await DouyinHistoryAdapter.open({
    onStatus: message => { browserStatus = message; sendContext(); },
    onContextInvalidated: async () => {
      activeAccount = null;
      activeConversations = [];
      browserStatus = '浏览器页面已变化，请返回抖音聊天页并重新刷新会话。';
      sendContext();
      await collector?.stopAndWait();
      await archiveRepair?.cancelAndWait();
    }
  });
  browserStatus = '浏览器已打开：请登录并选择既有单人私聊，然后刷新会话列表。';
  attachmentService = new AttachmentService(database!, join(dataRoot, 'archive', 'media'), adapter);
  archiveRepair = new ArchiveRepair(database!, adapter, join(dataRoot, 'archive', 'repair-progress'));
  collectorCursorEvidence ??= new CollectorCursorEvidence(await loadOrCreateCollectorEvidenceKey(
    join(dataRoot, 'archive', 'acceptance', 'collector-cursor-evidence.key')
  ));
  collector = new ArchiveCollector(adapter, database!, {
    onSnapshot: () => sendContext(),
    onPage: page => {
      if (!attachmentService || !releaseValidation.acquisitionEnabled) return;
      void attachmentService.wake(page.accountId, page.conversationId).then(() => sendContext()).catch(() => {
        browserStatus = '附件队列处理遇到错误；可重新连接后继续。';
        sendContext();
      });
    }
  }, collectorCursorEvidence);
  sendContext();
  return appState();
}

async function refreshContext() {
  if (!releaseValidation.acquisitionEnabled || developmentMode) throw new Error(appState().message);
  if (exporting) throw new Error('导出期间暂不能刷新浏览器会话。');
  if (!adapter) throw new Error('请先连接独立浏览器。');
  activeAccount = await adapter.getAccount();
  activeConversations = await adapter.listConversationDirectory();
  database?.upsertAccount(activeAccount);
  for (const conversation of activeConversations) database?.upsertConversation(activeAccount.accountId, conversation);
  if (releaseValidation.acquisitionEnabled) {
    void attachmentService?.wake(activeAccount.accountId).then(() => sendContext()).catch(() => {
      browserStatus = '附件队列处理遇到错误；可重新连接后继续。';
      sendContext();
    });
  }
  browserStatus = activeConversations.length ? `已读取 ${activeConversations.length} 个会话；请在列表中选择要采集的联系人。` : '尚未观察到会话列表；请在浏览器打开一个既有私聊后重试。';
  sendContext();
  return {
    account: activeAccount,
    conversations: activeConversations,
    archivedConversations: database?.listConversations(activeAccount.accountId) ?? [],
    collector: collector?.snapshot() ?? emptyCollector,
    repair: { running: repairRunning, lastResult: lastRepairResult },
    exporting
  } satisfies DesktopContext;
}

handleArchive('app-state', () => appState());
handleArchive('archive-get-context', () => currentContext());
handleArchive('archive-connect', () => connectBrowser());
handleArchive('archive-refresh-context', () => refreshContext());
handleArchive('archive-select-conversation', async (_event, input: { conversationId: string }) => {
  if (!adapter) throw new Error('请先连接独立浏览器。');
  if (!releaseValidation.acquisitionEnabled || developmentMode) throw new Error(appState().message);
  if (typeof input?.conversationId !== 'string' || !input.conversationId.trim()) throw new Error('conversationId 无效。');
  if (exporting) throw new Error('导出期间暂不能切换会话。');
  await collector?.stopAndWait();
  await archiveRepair?.cancelAndWait();
  browserStatus = `正在切换浏览器会话到：${input.conversationId}…`;
  sendContext();
  await adapter.selectConversationInBrowser(input.conversationId);
  // 切换成功后，调用 listPrivateConversations() 获取带流量验证的完整会话信息
  const conversations = await adapter.listPrivateConversations();
  activeAccount = await adapter.getAccount();
  activeConversations = conversations;
  database?.upsertAccount(activeAccount);
  for (const conv of conversations) {
    database?.upsertConversation(activeAccount.accountId, conv);
  }
  browserStatus = `已切换至：${conversations[0]?.title || input.conversationId}，可开始采集。`;
  sendContext();
  return currentContext();
});
handleArchive('archive-get-collector', () => collector?.snapshot() ?? emptyCollector);
handleArchive('archive-start-capture', async (_event, input: { conversationId: string; resume?: boolean; maxPages?: number; stopAfterPages?: number }) => {
  if (!collector || !activeAccount) throw new Error('请先连接浏览器并刷新会话。');
  if (!releaseValidation.acquisitionEnabled) throw new Error(appState().message);
  if (exporting) throw new Error('导出期间暂不能开始采集。');
  if (repairRunning) throw new Error('旧档案补修正在进行，请等待完成或取消。');
  if (collector.running) throw new Error('采集正在进行，请先停止。');
  if (input.stopAfterPages !== undefined && input.stopAfterPages !== 1) throw new Error('单次自动停止仅支持提交下一页后停止。');
  const conversation = activeConversations.find(item => item.conversationId === input.conversationId);
  if (!conversation) throw new Error('请选择一个当前可见的会话。');
  void collector.start({ conversation, resume: input.resume !== false, maxPages: input.maxPages, stopAfterPages: input.stopAfterPages }).catch(() => undefined);
  sendContext();
  return collector.snapshot();
});
handleArchive('archive-stop-capture', () => {
  collector?.stop();
  sendContext();
  return collector?.snapshot() ?? emptyCollector;
});
handleArchive('archive-repair-conversation', async (_event, input: { accountId: string; conversationId: string; maxPages?: number }) => {
  if (!database || !archiveRepair || !activeAccount) throw new Error('请先连接浏览器并刷新会话。');
  if (!releaseValidation.acquisitionEnabled) throw new Error(appState().message);
  if (exporting) throw new Error('导出期间暂不能开始补修。');
  if (repairRunning) throw new Error('旧档案补修正在进行。');
  if (input.accountId !== activeAccount.accountId) throw new Error('补修账号与当前登录账号不一致。');
  if (!activeConversations.some(item => item.conversationId === input.conversationId)) throw new Error('请先在独立浏览器选择目标私聊并刷新会话列表。');
  repairRunning = true;
  browserStatus = '正在补修已有消息；不会更改正式采集检查点。';
  sendContext();
  try {
    await collector?.stopAndWait();
    const result = await archiveRepair.repairConversation(input);
    lastRepairResult = result;
    void attachmentService?.wake(input.accountId, input.conversationId).then(() => sendContext()).catch(() => {
      browserStatus = '补修已结束，附件队列将在下次连接时继续。';
      sendContext();
    });
    browserStatus = `补修结束：找到 ${result.matched} 项，改善 ${result.repaired} 项，仍待回读 ${result.remaining} 项。`;
    return result;
  } finally {
    repairRunning = false;
    sendContext();
  }
});
handleArchive('archive-cancel-repair', async () => {
  await archiveRepair?.cancelAndWait();
});
handleArchive('archive-retry-attachment', async (_event, input: { attachmentId: string }) => {
  if (exporting) throw new Error('导出期间暂不能重试附件。');
  if (!releaseValidation.acquisitionEnabled) throw new Error(appState().message);
  if (!attachmentService) return false;
  const retried = await attachmentService.retry(input.attachmentId);
  sendContext();
  return retried;
});
handleArchive('archive-get-messages', (_event, input: { accountId: string; conversationId: string; query?: string; limit?: number; offset?: number }) => {
  if (!database) throw new Error('数据库尚未初始化。');
  return database.listMessages(input.accountId, input.conversationId, input.query ?? '', Math.min(input.limit ?? 500, 2_000), input.offset ?? 0);
});
handleArchive('archive-get-conversation-stats', (_event, input: unknown) => {
  if (!database) throw new Error('数据库尚未初始化。');
  return loadConversationStats(database, input);
});
handleArchive('archive-get-attachments', (_event, input: { accountId: string; conversationId: string }) => {
  if (!database) throw new Error('数据库尚未初始化。');
  return database.listAttachments(input.accountId, input.conversationId).map(({ localPath: _localPath, ...attachment }) => attachment);
});
handleArchive('archive-get-media-url', async (_event, input: { attachmentId: string }) => {
  if (!database || !attachmentService || typeof input?.attachmentId !== 'string' || input.attachmentId.length > 128) return null;
  try {
    const source = await attachmentService.resolveBrowserMediaSource(input.attachmentId);
    return { url: pathToFileURL(source.path).href, fileVersion: source.fileVersion, mime: source.mime,
      actualFormat: source.actualFormat, family: source.family, evidence: source.evidence };
  } catch { return null; }
});
handleArchive('archive-record-media-evidence', async (event, input: { attachmentId: string; fileVersion: string; event: unknown }) => {
  if (!database || !attachmentService || !windowInstance || event.sender !== windowInstance.webContents) throw new Error('media-evidence-sender-invalid');
  if (typeof input?.attachmentId !== 'string' || input.attachmentId.length < 1 || input.attachmentId.length > 128 ||
      typeof input.fileVersion !== 'string' || !/^[\da-f]{64}$/.test(input.fileVersion)) throw new Error('media-evidence-input-invalid');
  const evidenceEvent = parseBrowserMediaEvidenceEvent(input.event);
  if (!evidenceEvent) throw new Error('media-evidence-event-invalid');
  const result = await attachmentService.recordBrowserMediaEvent({ attachmentId: input.attachmentId, fileVersion: input.fileVersion, event: evidenceEvent });
  if (result.recorded) {
    const root = join(dataRoot, 'archive', 'acceptance');
    await mkdir(root, { recursive: true });
    const record = JSON.stringify({ recordedAt: new Date().toISOString(), attachmentId: input.attachmentId,
      fileSha256: input.fileVersion, event: evidenceEvent });
    await appendFile(join(root, 'media-evidence.jsonl'), `${record}\n`, { encoding: 'utf8', flag: 'a' });
  }
  return result;
});
handleArchive('archive-export', async (_event, input: { accountId: string; conversationId: string }) => {
  if (!database || !windowInstance) throw new Error('数据库尚未初始化。');
  if (exporting || exportDialogOpen) throw new Error('已有导出正在进行。');
  const title = database.listConversations(input.accountId).find(item => item.conversationId === input.conversationId)?.title ?? 'douyin-archive';
  const defaultPath = join(dataRoot, 'archive', 'exports', `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60) || 'douyin-archive'}-${new Date().toISOString().slice(0, 10)}.zip`);
  exportDialogOpen = true;
  let selected;
  try {
    selected = await dialog.showSaveDialog(windowInstance, { title: '导出离线档案', defaultPath, filters: [{ name: 'ZIP 档案', extensions: ['zip'] }] });
  } finally { exportDialogOpen = false; }
  if (selected.canceled || !selected.filePath) return { cancelled: true as const };
  exporting = true;
  sendContext();
  const task = (async () => {
    await collector?.stopAndWait();
    await archiveRepair?.whenIdle();
    if (releaseValidation.acquisitionEnabled) await attachmentService?.wake(input.accountId, input.conversationId);
    await attachmentService?.whenIdle();
    const result = await exportConversation(database!, input.accountId, input.conversationId, selected.filePath!);
    return { cancelled: false as const, outputPath: result.outputPath, complete: result.report.complete,
      historyComplete: result.report.historyComplete, fileCount: result.fileCount, mediaCount: result.mediaCount, report: result.report };
  })();
  activeExport = task;
  try { return await task; }
  finally { activeExport = null; exporting = false; sendContext(); }
});

app.whenReady().then(async () => {
  await ensureDatabase();
  releaseValidation = await validateReleaseValidation(currentDirectory, {
    productVersion: app.getVersion(), suiteId: 'p1-sol-final-20261004', requirementKeys: P1_REQUIREMENTS,
    protocolMappingVersion: PROTOCOL_MAPPING_VERSION, timeMappingVersion: TIME_MAPPING_VERSION
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(error => {
  console.error(error);
  app.quit();
});

app.on('before-quit', event => {
  if (shuttingDown) return;
  shuttingDown = true;
  event.preventDefault();
  void (async () => {
    await activeExport?.catch(() => undefined);
    await collector?.stopAndWait();
    await archiveRepair?.cancelAndWait();
    await attachmentService?.cancelAndWait();
    await adapter?.close();
  })().catch(() => undefined).finally(() => {
    database?.close();
    app.exit(0);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
