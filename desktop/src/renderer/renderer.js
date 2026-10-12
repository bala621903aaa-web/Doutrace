import { createChatArchiveController } from './chat-archive.js';
import { chatArchiveMarkup } from './chat-archive-view.js';
import { isStableAnalysisContext, mountAppShell, navigateAppShell } from './shell/app-shell.js';
import { createAnalysisAiController } from './analysis-ai.js';
import { createAnalysisInteractionController } from './analysis-interaction.js';
import { createAnalysisJourneyController } from './analysis-journey.js';
import { createAnalysisStatsController } from './analysis-stats.js';

const api = window.desktopArchive;
const state = {
  app: null,
  context: {
    account: null,
    conversations: [],
    archivedConversations: [],
    collector: { state: 'idle' },
    repair: { running: false, lastResult: null },
    exporting: false
  },
  selectedId: null,
  selectedAccountId: null,
  offset: 0,
  loadedOffset: 0,
  loadedQuery: '',
  busy: false,
  loadGeneration: 0,
  mediaSources: new Map(),
  loadedMessages: [],
  loadedAttachments: [],
  filterKind: '',
  filterContentStatus: ''
};

const $ = id => document.getElementById(id);
$('chat-archive-page').innerHTML = chatArchiveMarkup;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const isRunning = () => ['collecting'].includes(state.context.collector.state);
const stateLabels = {
  idle: '空闲', ready: '就绪', collecting: '正在保存', complete: '历史消息已保存', partial: '部分保存',
  stopped: '已停止', interrupted: '上次中断', error: '采集失败', 'auth-required': '需要登录',
  'conversation-changed': '浏览器会话已切换'
};
const reasonLabels = {
  history_end: '已读到历史终点', page_limit: '已达本次页数上限', user_stop: '用户停止',
  missing_has_more: '未能确认历史终点', stalled: '分页停止推进', conversation_changed: '会话已切换'
};

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').style.color = error ? '#ad2020' : '#52606d';
}

function renderCollector() {
  const collector = state.context.collector || {};
  const repair = state.context.repair || { running: false, lastResult: null };
  $('captureStatus').textContent = `${stateLabels[collector.state] || '空闲'} · ${collector.pages || 0} 页 · ${collector.messages || 0} 条${collector.reason ? ` · ${reasonLabels[collector.reason] || '采集出现错误'}` : ''}`;
  $('progress').hidden = !isRunning();
  $('start').disabled = state.busy || state.context.exporting || repair.running || isRunning() ||
    !state.app?.acquisitionEnabled || !state.app?.connected ||
    state.selectedAccountId !== state.context.account?.accountId ||
    !state.context.conversations.some(item => item.conversationId === state.selectedId);
  $('stop').disabled = !isRunning();
  $('connect').disabled = state.busy || state.context.exporting || repair.running || isRunning() || !state.app?.acquisitionEnabled;
  $('refresh').disabled = state.busy || state.context.exporting || repair.running || isRunning() || !state.app?.connected;
  $('export').disabled = state.busy || state.context.exporting || repair.running || isRunning() || !state.selectedId;
  const archiveExists = (state.context.archivedConversations || []).some(item =>
    item.accountId === state.selectedAccountId && item.conversationId === state.selectedId && item.messageCount > 0);
  const matchingCurrent = state.selectedAccountId === state.context.account?.accountId &&
    state.context.conversations.some(item => item.conversationId === state.selectedId);
  $('repair').disabled = state.busy || state.context.exporting || repair.running || isRunning() ||
    !state.app?.acquisitionEnabled || !state.app?.connected || !archiveExists || !matchingCurrent;
  $('cancelRepair').disabled = !repair.running;
  const last = repair.lastResult;
  const repairReasons = {
    complete: '目标已回读完', 'history-end': '已到服务端当前历史终点', 'page-limit': '达到 6 页上限',
    cancelled: '已取消，可继续', stalled: '分页游标停止推进', 'identity-changed': '账号或会话已切换'
  };
  $('repairStatus').textContent = repair.running
    ? '正在按既有消息 ID 回读；本次最多 6 页。'
    : last
      ? `上次结果：改善 ${last.repaired} 项，找到 ${last.matched} 项，${last.remaining} 项尚未回读；仍不完整 ${last.stillIncomplete} 条。消息数 ${last.beforeMessageCount} → ${last.messageCount}；检查点${last.checkpointUnchanged ? '未变' : '有变化'}，采集运行记录${last.runsUnchanged ? '未变' : '有变化'}；${repairReasons[last.stopReason] || last.stopReason}。`
      : '选择当前账号下的档案，并在独立浏览器选中同一私聊后使用。';
}

function syncAnalyzeConversationAction() {
  const snapshot = chatArchive.getSnapshot();
  $('analyzeConversation').disabled = !isStableAnalysisContext({
    accountId: snapshot.accountId,
    conversationId: snapshot.conversationId
  });
}

function render() {
  chatArchive.renderLists();
  renderCollector();
  syncAnalyzeConversationAction();
  const account = state.context.account;
  const appStatus = state.app?.browserStatus || '尚未连接独立浏览器';
  if (state.app?.message) {
    $('notice').textContent = state.app.message;
    $('notice').style.background = state.app.acquisitionEnabled ? '#fff7e6' : '#fff0f0';
    $('notice').style.color = state.app.acquisitionEnabled ? '#7a4b00' : '#8a2020';
  }
  setStatus(`${appStatus}${account ? ' · 已识别登录账号' : ''}`);
}

const chatArchive = createChatArchiveController({ api, state, $, esc, setStatus, render });

let analysisStats = null;
let analysisInteraction = null;
let analysisJourney = null;
let analysisAi = null;
const shell = mountAppShell({
  documentRef: document,
  onBeforeLeave: ({ from }) => {
    if (from !== 'archive') return;
    chatArchive.cancelPending();
    chatArchive.cleanupMedia();
  },
  onAfterEnter: ({ to }) => {
    if (to !== 'archive') return;
    if (state.app) void chatArchive.loadMessages();
    else chatArchive.initialize();
  },
  onAnalysisStateChange: snapshot => {
    analysisStats?.handleSnapshot(snapshot);
    analysisInteraction?.handleSnapshot(snapshot);
    analysisJourney?.handleSnapshot(snapshot);
    analysisAi?.handleSnapshot(snapshot);
  }
});
analysisStats = createAnalysisStatsController({
  api,
  documentRef: document,
  getShellSnapshot: () => shell.getSnapshot()
});
analysisInteraction = createAnalysisInteractionController({
  api,
  documentRef: document,
  getShellSnapshot: () => shell.getSnapshot()
});
analysisJourney = createAnalysisJourneyController({
  api,
  documentRef: document,
  getShellSnapshot: () => shell.getSnapshot()
});
analysisAi = createAnalysisAiController({
  documentRef: document
});
analysisStats.handleSnapshot(shell.getSnapshot());
analysisInteraction.handleSnapshot(shell.getSnapshot());
analysisJourney.handleSnapshot(shell.getSnapshot());
analysisAi.handleSnapshot(shell.getSnapshot());

$('connect').addEventListener('click', async () => {
  state.busy = true;
  render();
  try {
    state.app = await api.connect();
    state.context = await api.getContext();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    state.busy = false;
    render();
  }
});
$('refresh').addEventListener('click', () => { void chatArchive.refreshConversations(); });
$('start').addEventListener('click', async () => {
  const stopAfterPages = $('stopAfterNextPage').checked ? 1 : undefined;
  $('stopAfterNextPage').checked = false;
  try {
    state.context.collector = await api.startCapture({
      conversationId: state.selectedId,
      resume: $('resume').checked,
      maxPages: Number($('maxPages').value) || 200,
      stopAfterPages
    });
    render();
  } catch (error) {
    if (stopAfterPages) $('stopAfterNextPage').checked = true;
    setStatus(error.message || String(error), true);
  }
});
$('stop').addEventListener('click', async () => {
  try {
    state.context.collector = await api.stopCapture();
    render();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});
$('repair').addEventListener('click', async () => {
  const accountId = state.selectedAccountId;
  const conversationId = state.selectedId;
  if (!accountId || !conversationId) return;
  state.busy = true;
  render();
  try {
    const result = await api.repairConversation({ accountId, conversationId, maxPages: 6 });
    state.context.repair = { running: false, lastResult: result };
    setStatus(`补修结束：找到 ${result.matched} 项，改善 ${result.repaired} 项，仍有 ${result.remaining} 项未回读。`);
    await chatArchive.loadMessages();
  } catch (error) {
    setStatus(error.message || String(error), true);
  } finally {
    state.busy = false;
    render();
  }
});
$('cancelRepair').addEventListener('click', async () => {
  try {
    await api.cancelRepair();
  } catch (error) {
    setStatus(error.message || String(error), true);
  }
});
$('export').addEventListener('click', async () => {
  const accountId = state.selectedAccountId;
  if (!accountId || !state.selectedId) return setStatus('请先选择已有档案。', true);
  state.busy = true;
  render();
  try {
    const result = await api.exportConversation({ accountId, conversationId: state.selectedId });
    state.busy = false;
    render();
    if (result.cancelled) return;
    setStatus(`导出完成：${result.outputPath}（${result.report.messageCount} 条消息，必要媒体缺失 ${result.report.requiredAssetMissingCount} 项；${result.historyComplete ? '历史范围到达已验证终点' : '部分历史范围'}；${result.complete ? '内容与必要媒体完整' : '部分档案，详见导出报告'}）`);
  } catch (error) {
    state.busy = false;
    render();
    setStatus(error.message || String(error), true);
  }
});

$('analyzeConversation').addEventListener('click', () => {
  const snapshot = chatArchive.getSnapshot();
  const analysisContext = {
    accountId: snapshot.accountId,
    conversationId: snapshot.conversationId
  };
  if (!isStableAnalysisContext(analysisContext)) {
    syncAnalyzeConversationAction();
    return;
  }
  navigateAppShell('analysis', 'ai', analysisContext);
});

api.onEvent(context => { void chatArchive.handleContextEvent(context); });
chatArchive.initialize();
