import type { Page } from 'playwright-core';
import type { HistoryVerificationOptions } from './history-verifier.js';
import { readPageState, type PageState } from './page-state.js';
import type { LiveRunFacts, LiveTimeSnapshotFact } from './live-report.js';
import { waitForEnter } from './session.js';
import { compareMessagesToRows, emptyTimeEvidence } from './time-evidence.js';
import { collectVisibleMessageWindow } from './time-window.js';
import type { VerificationSuiteRun } from './verification-suite.js';
import { CLIENT_TIME_MAPPING_SOURCE, CLIENT_MESSAGE_COPY_SOURCE } from './time-mapping-source.js';
import { collectMessageInfoTimes, type MessageInfoDiagnostics } from './message-info-time.js';

async function renderedPage(options: HistoryVerificationOptions): Promise<{ page: Page; state: PageState }> {
  const candidates = [...new Set([options.session.page,
    ...options.observer.listInitExchanges().map(exchange => exchange.sourcePage),
    ...options.observer.listHistoryExchanges().map(exchange => exchange.request.sourcePage)
  ])].filter((page): page is Page => Boolean(page && !page.isClosed()));
  const states = await Promise.all(candidates.map(async page => ({ page, state: await readPageState(page).catch(() => null) })));
  const readable = states.filter((item): item is { page: Page; state: PageState } => item.state !== null);
  if (!readable.length) throw new Error('time-page-state-unreadable');
  const score = (state: PageState) => (state.messageList.found ? 1_000_000 : 0) + state.rows.length;
  return readable.reduce((best, item) => score(item.state) > score(best.state) ? item : best);
}

/** Reads only normal page traffic and DOM snapshots; never fetches older pages. */
export async function runVisibleTimeVerification(options: HistoryVerificationOptions, context: {
  runId: string; startedAt: string; suite: VerificationSuiteRun | null;
}): Promise<LiveRunFacts> {
  const say = (message: string) => options.onMessage ? options.onMessage(message) : console.log(message);
  const snapshots: LiveTimeSnapshotFact[] = [];
  const errors: LiveRunFacts['errors'] = [];
  let expectedAccount: string | null = null;
  let latestState: PageState | null = null;
  let stopReason: LiveRunFacts['timeStopReason'] = 'samples-insufficient';
  const limit = options.timeSnapshots ?? 3;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('time-snapshots-out-of-range');
  for (let index = 0; index < limit && !options.signal.aborted; index++) {
    if (index > 0 && !await waitForEnter('请在同账号选择另一条已有单人私聊，待页面稳定后按 Enter 追加当前窗口的时间样本（不滚动、不发送消息）；Ctrl+C 停止。', options.signal)) break;
    await options.observer.drainPendingResponses();
    let current: { page: Page; state: PageState };
    try { current = await renderedPage(options); }
    catch { errors.push({ code: 'time-page-state-unreadable', phase: 'time-snapshot' }); stopReason = 'identity-unverified'; break; }
    const before = current.state;
    const accounts = options.observer.selfAccountIdsInMemory();
    const account = accounts.length === 1 ? accounts[0] : null;
    const conversation = before.selectedConversationIds.length === 1 ? before.selectedConversationIds[0] : null;
    if (expectedAccount === null && account) expectedAccount = account;
    const window = collectVisibleMessageWindow({
      conversationId: conversation ?? '',
      initialization: options.observer.listInitExchanges().filter(exchange => exchange.sourcePage === current.page),
      history: options.observer.listHistoryExchanges().filter(exchange => exchange.request.sourcePage === current.page)
    });
    let mappingSources = options.observer.listClientTimeSources().filter(source => source.sourcePage === current.page)
      .map(({ sourcePage: _sourcePage, ...evidence }) => evidence);
    const mappingSourceVerified = mappingSources.some(source => source.url === CLIENT_TIME_MAPPING_SOURCE.url && source.verified);
    let rows = before.rows;
    let messageInfo: MessageInfoDiagnostics | undefined;
    if (options.uiMessageInfo && mappingSourceVerified && account && conversation) {
      const result = await collectMessageInfoTimes({ page: current.page, state: before, messages: window.messages, account, conversation, signal: options.signal });
      rows = result.rows;
      messageInfo = result.diagnostics;
      await options.observer.drainPendingResponses();
      mappingSources = options.observer.listClientTimeSources().filter(source => source.sourcePage === current.page)
        .map(({ sourcePage: _sourcePage, ...evidence }) => evidence);
      messageInfo.copyHelperVerified = mappingSources.some(source => source.url === CLIENT_MESSAGE_COPY_SOURCE.url && source.verified);
      say(`页面复制信息：尝试 ${messageInfo.attempted}，严格 ID/内容/完整时间关联 ${messageInfo.accepted}；诊断 ${JSON.stringify(messageInfo.rejected)}；原剪贴板文本${messageInfo.clipboardRestored ? '已恢复' : '未恢复或未改动'}。`);
    }
    const after = await readPageState(current.page).catch(() => before);
    latestState = after;
    const sessionMatches = account !== null && account === expectedAccount && conversation !== null &&
      after.selectedConversationIds.length === 1 && after.selectedConversationIds[0] === conversation && before.messageList.found && after.messageList.found;
    const evidence = sessionMatches ? compareMessagesToRows(window.messages, messageInfo ? rows : after.rows, after.capturedAt, account!, mappingSourceVerified ? CLIENT_TIME_MAPPING_SOURCE.field : undefined) : emptyTimeEvidence();
    snapshots.push({ accountId: account, conversationId: conversation, beforeState: before, afterState: after, sessionMatches, mappingSourceVerified, mappingSources, messageInfo, ...window, evidence });
    const unique = new Set(snapshots.flatMap(snapshot => snapshot.evidence.matchedMessageIds ?? [])).size;
    const associations = (evidence.keyMatches ?? 0) + (evidence.textMatches ?? 0);
    say(`时间窗口 ${index + 1}：初始化来源 ${window.initializationExchanges}，历史来源 ${window.historyExchanges}，候选消息 ${window.messages.length}；可靠行关联 ${associations}，本窗口时间对照 ${evidence.matched}，累计唯一消息 ${unique}；官方显示脚本散列 ${mappingSourceVerified ? '一致' : '尚未核对'}。`);
    if (!sessionMatches) { stopReason = 'identity-unverified'; break; }
    if (!associations) {
      stopReason = 'window-not-covered';
      say('当前正常响应未覆盖渲染消息，时间任务已停止；不会继续翻旧历史凑样本。请正常重新进入聊天页并选定已有会话后重跑，检查初始化解码诊断。');
      break;
    }
    if (unique >= 10) { stopReason = 'samples-collected'; break; }
    if (window.conflictingMessageIds || evidence.unresolvedConflicts || evidence.outOfWindow) {
      say('当前窗口的身份版本或日期/候选字段仍有未解释差异，保留未验证报告。');
      break;
    }
  }
  if (options.signal.aborted) stopReason = 'cancelled';
  const withinSnapshotScrollChanged = snapshots.some(snapshot => snapshot.beforeState.messageList.scrollTop !== snapshot.afterState.messageList.scrollTop);
  return {
    runId: context.runId, task: 'time', suite: context.suite?.metadata ?? null, redactor: context.suite?.redactor,
    mode: 'normal', requestedPages: 0, endpointPageLimit: 0, startedAt: context.startedAt, finishedAt: new Date().toISOString(),
    browserKind: options.session.executable.kind, browserExecutable: options.session.executable.path,
    targetOrigin: latestState?.origin ?? '', targetPathname: latestState?.pathname ?? '',
    selfAccountIds: expectedAccount ? [expectedAccount] : [], selectedConversationIds: latestState?.selectedConversationIds ?? [], selectedTitle: latestState?.selectedTitle ?? '',
    selectedConversationStable: snapshots.length > 0 && snapshots.every(snapshot => snapshot.sessionMatches),
    pages: [], timeSnapshots: snapshots, timeStopReason: stopReason,
    endpoint: { pageNumber: null, reached: false, confirmed: false, confirmationHasMore: null, reason: 'not-attempted' },
    resume: { requested: false, checkpointFound: false, accountMatches: null, conversationMatches: null, shortIdMatches: null, cursorMatches: null, boundaryCompared: false, boundaryRelation: 'unknown', previousRunDifferent: false, checkpointSaved: false, failure: null },
    freshTemplateCaptured: snapshots.some(snapshot => snapshot.initializationExchanges + snapshot.historyExchanges > 0),
    freshTemplateDecoded: snapshots.some(snapshot => snapshot.messages.length > 0), freshTemplateResponseStatus: null,
    noScrollViolation: withinSnapshotScrollChanged, errors
  };
}
