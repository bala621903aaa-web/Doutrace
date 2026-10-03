import { randomUUID } from 'node:crypto';
import type { Frame, Page } from 'playwright-core';
import { updateHistoryRequest, type DecodedHistoryMessage } from '../im/protocol.js';
import {
  codeVersionHash,
  checkpointStoreContext,
  loadControlBaseline,
  loadSuiteVerificationCheckpoint,
  saveControlBaseline,
  saveVerificationCheckpoint,
  type HistoryControlBaseline,
  type HistoryVerificationCheckpoint
} from './checkpoint.js';
import { HistoryNetworkObserver, type CapturedHistoryExchange, type CapturedHistoryRequest } from './history-transport.js';
import { buildLiveVerificationReport, saveLiveVerificationReport, type EndpointFact, type LivePageFact, type LiveRunFacts, type ResumeFact, type TimeEvidence } from './live-report.js';
import { readPageState, type PageState } from './page-state.js';
import { compareMessagesToRows } from './time-evidence.js';
import { runVisibleTimeVerification } from './time-verifier.js';
import type { BrowserProbeSession } from './session.js';
import { openVerificationSuiteRun, TASK_REQUIREMENTS, type VerificationTask, type VerificationSuiteRun } from './verification-suite.js';

const REQUEST_TIMEOUT_MS = 30_000;
const USER_WAIT_MS = 1_500;

export interface HistoryVerificationOptions {
  session: BrowserProbeSession;
  observer: HistoryNetworkObserver;
  task?: VerificationTask;
  suiteId?: string;
  checkpointId?: string;
  prepare?: boolean;
  pages: number;
  maxPages?: number;
  timeSnapshots?: number;
  uiMessageInfo?: boolean;
  /** Same-process normal page exchange, used only by the bounded main sequence. */
  initialExchange?: CapturedHistoryExchange;
  resume: boolean;
  workspaceRoot: string;
  signal: AbortSignal;
  onMessage?: (message: string) => void;
}

function announce(options: HistoryVerificationOptions, message: string) {
  options.onMessage?.(message);
  if (!options.onMessage) console.log(message);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel/i.test(message)) return 'verification-cancelled';
  if (/timeout/i.test(message)) return 'history-response-timeout';
  if (/observer-closed/i.test(message)) return 'history-observer-closed';
  if (/protocol|wire|decode|response-body|body-too-large/i.test(message)) return 'response-protocol-error';
  if (/fetch/i.test(message)) return 'browser-fetch-error';
  return 'history-request-error';
}

function ids(messages: DecodedHistoryMessage[]) {
  return messages.map(message => message.platformMessageId).filter((value): value is string => value !== null);
}

function indexes(messages: DecodedHistoryMessage[]) {
  return messages.map(message => message.indexInConversation).filter((value): value is bigint => value !== null);
}

function indexRange(values: bigint[]) {
  if (!values.length) return null;
  return { min: values.reduce((left, right) => left < right ? left : right), max: values.reduce((left, right) => left > right ? left : right) };
}

function indexRelation(previous: DecodedHistoryMessage[], current: DecodedHistoryMessage[]): LivePageFact['indexRelationToPrevious'] {
  const previousRange = indexRange(indexes(previous));
  const currentRange = indexRange(indexes(current));
  if (!previousRange || !currentRange) return 'unknown';
  if (currentRange.max < previousRange.min) return 'older';
  if (currentRange.min > previousRange.max) return 'newer';
  return 'overlap';
}

export { compareMessagesToRows, parsePageTimeLabel } from './time-evidence.js';

function pageLocation(page: Page | Frame) {
  try {
    const url = new URL(page.url());
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return { origin: '', pathname: '' };
  }
}

function safeBigInt(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  try { return BigInt(value); } catch { return null; }
}

function selectedConversationStable(states: PageState[]) {
  if (states.length < 2) return null;
  const first = states[0].selectedConversationIds;
  return states.slice(1).every(state => first.length > 0 && state.selectedConversationIds.some(value => first.includes(value)));
}

function buildCheckpoint(run: VerificationSuiteRun, accountId: string, checkpointId: string, page: LivePageFact): HistoryVerificationCheckpoint | null {
  if (page.nextCursor === null) return null;
  return {
    version: 2,
    kind: 'p1-history-checkpoint',
    suiteId: run.metadata.suiteId,
    checkpointId,
    runId: run.metadata.runId,
    savedAt: new Date().toISOString(),
    accountId,
    conversationId: page.conversationId,
    conversationShortId: page.shortId.toString(),
    nextCursor: page.nextCursor.toString(),
    lastPageMessageIds: ids(page.messages),
    lastPageIndexes: indexes(page.messages).map(value => value.toString()),
    lastPageHasMore: page.hasMore,
    codeVersionHash: codeVersionHash(run.metadata),
    protocolMappingVersion: run.metadata.protocolMappingVersion,
    timeMappingVersion: run.metadata.timeMappingVersion
  };
}

function buildControlBaseline(run: VerificationSuiteRun, accountId: string, checkpointId: string, fact: LivePageFact): HistoryControlBaseline {
  return {
    version: 1,
    kind: 'p1-history-control-baseline',
    suiteId: run.metadata.suiteId,
    checkpointId,
    runId: run.metadata.runId,
    capturedAt: new Date().toISOString(),
    accountId,
    conversationId: fact.conversationId,
    conversationShortId: fact.shortId.toString(),
    inputCursor: fact.inputCursor?.toString() ?? null,
    responseMessageIds: ids(fact.messages),
    responseIndexes: indexes(fact.messages).map(value => value.toString()),
    nextCursor: fact.nextCursor?.toString() ?? null,
    hasMore: fact.hasMore,
    httpStatus: fact.httpStatus,
    businessStatus: fact.businessStatus?.toString() ?? null,
    codeVersionHash: codeVersionHash(run.metadata),
    protocolMappingVersion: run.metadata.protocolMappingVersion,
    timeMappingVersion: run.metadata.timeMappingVersion
  };
}

function controlMatchesFact(baseline: HistoryControlBaseline, fact: LivePageFact) {
  const messageIds = ids(fact.messages);
  const indexValues = indexes(fact.messages).map(value => value.toString());
  return fact.inputCursor?.toString() === baseline.inputCursor && fact.conversationId === baseline.conversationId && fact.shortId.toString() === baseline.conversationShortId && fact.httpStatus >= 200 && fact.httpStatus < 300 && fact.businessStatus === 0n && JSON.stringify(messageIds) === JSON.stringify(baseline.responseMessageIds) && JSON.stringify(indexValues) === JSON.stringify(baseline.responseIndexes) && fact.nextCursor?.toString() === baseline.nextCursor && fact.hasMore === baseline.hasMore && fact.httpStatus === baseline.httpStatus && fact.businessStatus?.toString() === baseline.businessStatus;
}

function pageFactFromExchange(input: {
  pageNumber: number;
  source: 'initial' | 'active';
  exchange: CapturedHistoryExchange;
  beforeState: PageState;
  afterState: PageState;
  previous: LivePageFact | null;
  expectedCursor: bigint | null;
}): LivePageFact | null {
  const decoded = input.exchange.decoded;
  if (!decoded || decoded.state !== 'decoded') return null;
  const messages = decoded.messages;
  const previousMessages = input.previous?.messages ?? [];
  const previousIds = new Set(ids(previousMessages));
  const currentIds = ids(messages);
  const overlap = input.previous ? currentIds.filter(id => previousIds.has(id)).length : 0;
  const newPlatformIds = input.previous ? currentIds.filter(id => !previousIds.has(id)).length : new Set(currentIds).size;
  const comparison = compareMessagesToRows(messages, input.afterState.rows, input.afterState.capturedAt);
  const request = input.exchange.request.decoded;
  const cursorLinkedFromPrevious = input.expectedCursor === null ? request.cursor === null : request.cursor === input.expectedCursor;
  const cursorProgressed = decoded.hasMore === false || (decoded.nextCursor !== null && request.cursor !== decoded.nextCursor);
  return {
    pageNumber: input.pageNumber,
    source: input.source,
    inputCursor: request.cursor,
    nextCursor: decoded.nextCursor,
    conversationId: request.conversationId,
    shortId: request.conversationShortId,
    sequenceId: request.sequenceId,
    httpStatus: input.exchange.httpStatus,
    browserFetchStatus: null,
    businessStatus: decoded.statusCode,
    hasMore: decoded.hasMore,
    messages,
    beforeState: input.beforeState,
    afterState: input.afterState,
    cursorLinkedFromPrevious,
    cursorProgressed,
    newPlatformIds,
    crossPagePlatformIdIntersection: overlap,
    indexRelationToPrevious: input.previous ? indexRelation(input.previous.messages, messages) : 'not-applicable',
    timeCrossChecks: comparison.matched,
    field10PageLabelCrossChecks: comparison.field10Matches,
    extensionPageLabelCrossChecks: comparison.extensionMatches,
    bodyOrderChecks: comparison.orderChecks,
    timeUnitEvidence: comparison.selectedUnit,
    timeEvidence: comparison
  };
}

async function waitForInitialExchange(observer: HistoryNetworkObserver, options: HistoryVerificationOptions, selected: PageState): Promise<CapturedHistoryExchange | null> {
  if (options.initialExchange) {
    const baseline = options.initialExchange;
    const sourcePage = baseline.request.sourcePage ?? options.session.page;
    const current = await readPageState(sourcePage);
    if (!observer.listHistoryExchanges().includes(baseline) || sourcePage.isClosed() || current.selectedConversationIds.length !== 1 ||
        current.selectedConversationIds[0] !== baseline.request.decoded.conversationId) throw new Error('sequence-initial-session-mismatch');
    return baseline;
  }
  const suitable = async () => {
    const current = await readPageState(options.session.page).catch(() => selected);
    const selectedIds = current.selectedConversationIds.length ? current.selectedConversationIds : selected.selectedConversationIds;
    return observer.listHistoryExchanges()
      .filter(exchange => exchange.request.decoded.conversationId && exchange.decoded?.state === 'decoded')
      .filter(exchange => selectedIds.length === 0 || selectedIds.includes(exchange.request.decoded.conversationId))
      .at(-1) ?? null;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    await options.session.page.waitForTimeout(USER_WAIT_MS).catch(() => undefined);
    const exchange = await suitable();
    if (exchange) return exchange;
    if (attempt === 0) {
      announce(options, '本轮尚未捕获新鲜历史请求。请保持消息列表不滚动、不发送内容，重新进入或点击当前单人私聊；完成后按 Enter 继续。');
      const { waitForEnter } = await import('./session.js');
      if (!await waitForEnter('当前会话已稳定显示后按 Enter。', options.signal)) return null;
    } else if (attempt === 1) {
      announce(options, '仍未捕获新鲜历史请求；验证器将执行一次有界的只读页面重载，再重新观察当前会话。');
      await options.session.page.reload({ waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS }).catch(() => undefined);
    }
  }
  return suitable();
}

function noEndpointFact(): EndpointFact {
  return { pageNumber: null, reached: false, confirmed: false, confirmationHasMore: null, reason: 'not-attempted' };
}

function noResumeFact(requested: boolean): ResumeFact {
  return { requested, checkpointFound: false, accountMatches: null, conversationMatches: null, shortIdMatches: null, cursorMatches: null, boundaryCompared: false, boundaryRelation: 'unknown', previousRunDifferent: false, checkpointSaved: false, failure: null, controlCompared: false, controlMatches: null, recoveryResponseCursorMatches: null, nextPageVerified: false, implementationMatches: null };
}

function defaultState(): PageState {
  return { capturedAt: new Date().toISOString(), origin: '', pathname: '', selectedConversationIds: [], selectedTitle: '', selfUidCandidates: [], messageList: { found: false, scrollTop: null, scrollHeight: null, clientHeight: null, rowCount: 0 }, rows: [], ui: { frameOrigin: '', framePathname: '', bodyElementCount: 0, bodyTextLength: 0, selectedCandidateCount: 0, messageRowCandidateCount: 0, textRowCount: 0, timeLabelCount: 0, timeLabelShapeCounts: {}, listCandidateCount: 0, scrollCandidateCount: 0, conversationStorePresent: false, headerPresent: false } };
}

function selectedSessionMatches(state: PageState, conversationId: string): boolean | null {
  return state.selectedConversationIds.length ? state.selectedConversationIds.includes(conversationId) : null;
}

function mergeSessionMatches(current: boolean | null | undefined, next: boolean | null): boolean | null {
  if (current === false || next === false) return false;
  if (current === null || current === undefined || next === null) return null;
  return true;
}

async function buildAndSave(facts: LiveRunFacts, options: HistoryVerificationOptions) {
  const report = buildLiveVerificationReport(facts);
  const paths = await saveLiveVerificationReport(report, options.workspaceRoot);
  announce(options, `P1 ${report.task} 分项验证判定：${report.verdict}；正式采集保持关闭。`);
  announce(options, `脱敏 JSON：${paths.jsonPath}`);
  announce(options, `报告：${paths.markdownPath}`);
  return { report, paths };
}

export async function runHistoryVerification(options: HistoryVerificationOptions) {
  const task = options.task ?? 'chain';
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  let suite: VerificationSuiteRun | null = null;
  try {
    suite = await openVerificationSuiteRun({ suiteId: options.suiteId ?? 'p1-closeout', runId, task, mode: options.resume ? 'resume' : 'normal', checkpointId: options.checkpointId ?? null, startedAt, workspaceRoot: options.workspaceRoot });
  } catch {
    // The report remains useful for diagnosis but cannot be accepted by the
    // aggregate gate without suite metadata and file hashes.
  }
  if (task === 'time') {
    if (options.resume) throw new Error('resume-requires-recovery-task');
    const facts = await runVisibleTimeVerification(options, { runId, startedAt, suite });
    return buildAndSave(facts, options);
  }
  const errors: Array<{ code: string; phase: string }> = [];
  const pages: LivePageFact[] = [];
  let endpoint: EndpointFact = noEndpointFact();
  let resume: ResumeFact = noResumeFact(options.resume);
  let checkpoint: HistoryVerificationCheckpoint | null = null;
  let controlBaseline: HistoryControlBaseline | null = null;
  if (options.resume && options.suiteId && options.checkpointId) {
    checkpoint = await loadSuiteVerificationCheckpoint({ suiteId: options.suiteId, checkpointId: options.checkpointId });
    controlBaseline = await loadControlBaseline({ suiteId: options.suiteId, checkpointId: options.checkpointId });
  }
  const selectedStates: PageState[] = [];
  let freshExchange: CapturedHistoryExchange | null = null;
  let template: CapturedHistoryRequest | null = null;
  let verificationPage: Page = options.session.page;
  let verificationFrame: Frame | undefined;
  let accountIds: string[] = [];
  let selected: PageState = await readPageState(options.session.page).catch(() => defaultState());
  selectedStates.push(selected);
  try {
    freshExchange = await waitForInitialExchange(options.observer, options, selected);
    if (freshExchange) {
      template = freshExchange.request;
      verificationPage = template.sourcePage ?? verificationPage;
      verificationFrame = template.sourceFrame;
      if (verificationPage !== options.session.page) selectedStates.length = 0;
      selected = await readPageState(verificationPage).catch(() => selected);
      selectedStates.push(selected);
      accountIds = options.observer.selfAccountIdsInMemory();
    } else {
      errors.push({ code: 'fresh-history-not-captured', phase: 'initial' });
    }

    const location = pageLocation(verificationPage);
    const commonFacts = (finishedAt: string): LiveRunFacts => ({ runId, task, suite: suite?.metadata ?? null, redactor: suite?.redactor, mode: options.resume ? 'resume' : 'normal', requestedPages: task === 'endpoint' ? 1 : task === 'recovery' ? 2 : options.pages, endpointPageLimit: options.maxPages ?? (task === 'chain' ? options.pages : task === 'endpoint' ? 5 : 20), startedAt, finishedAt, browserKind: options.session.executable.kind, browserExecutable: options.session.executable.path, targetOrigin: selected.origin || location.origin, targetPathname: selected.pathname || location.pathname, selfAccountIds: accountIds, selectedConversationIds: selected.selectedConversationIds, selectedTitle: selected.selectedTitle, selectedConversationStable: selectedConversationStable(selectedStates), pages, endpoint, resume, freshTemplateCaptured: Boolean(template), freshTemplateDecoded: Boolean(freshExchange?.decoded?.state === 'decoded'), freshTemplateResponseStatus: freshExchange?.httpStatus ?? null, noScrollViolation: false, errors });
    if (!template || !freshExchange?.decoded || freshExchange.decoded.state !== 'decoded') {
      if (freshExchange?.decoded?.state === 'server-error') errors.push({ code: 'history-response-status-error', phase: 'initial' });
      else if (freshExchange?.decodeError) errors.push({ code: 'response-protocol-error', phase: 'initial' });
      return buildAndSave(commonFacts(new Date().toISOString()), options);
    }

    const initialBefore = selected;
    const initialAfter = await readPageState(verificationPage).catch(() => initialBefore);
    const initialFact = pageFactFromExchange({ pageNumber: 1, source: 'initial', exchange: freshExchange, beforeState: initialBefore, afterState: initialAfter, previous: null, expectedCursor: template.decoded.cursor });
    if (!initialFact) {
      errors.push({ code: freshExchange.decoded.state === 'decoded' ? 'response-protocol-error' : 'history-response-status-error', phase: 'initial' });
      return buildAndSave(commonFacts(new Date().toISOString()), options);
    }
    initialFact.browserFetchStatus = freshExchange.httpStatus;
    pages.push(initialFact);

    if (options.resume && task !== 'recovery') errors.push({ code: 'resume-requires-recovery-task', phase: 'arguments' });
    if (options.resume && task === 'recovery') {
      if (!checkpoint) {
        resume = { ...resume, failure: 'checkpoint-not-found' };
        errors.push({ code: 'checkpoint-not-found', phase: 'resume' });
      } else if (!controlBaseline) {
        resume = { ...resume, checkpointFound: true, failure: 'control-baseline-not-found' };
        errors.push({ code: 'control-baseline-not-found', phase: 'resume' });
      } else {
        const currentVersionHash = suite ? codeVersionHash(suite.metadata) : '';
        const implementationMatches = Boolean(suite && checkpoint.codeVersionHash === currentVersionHash && controlBaseline.codeVersionHash === currentVersionHash && checkpoint.protocolMappingVersion === suite.metadata.protocolMappingVersion && checkpoint.timeMappingVersion === suite.metadata.timeMappingVersion && controlBaseline.protocolMappingVersion === suite.metadata.protocolMappingVersion && controlBaseline.timeMappingVersion === suite.metadata.timeMappingVersion);
        const expectedCursor = safeBigInt(checkpoint.nextCursor);
        const accountMatches = accountIds.includes(checkpoint.accountId);
        const conversationMatches = checkpoint.conversationId === template.decoded.conversationId;
        const shortIdMatches = checkpoint.conversationShortId === template.decoded.conversationShortId.toString();
        resume = { ...resume, checkpointFound: true, accountMatches, conversationMatches, shortIdMatches, cursorMatches: false, previousRunDifferent: checkpoint.runId !== runId, implementationMatches };
        if (!implementationMatches || !accountMatches || !conversationMatches || !shortIdMatches || expectedCursor === null) {
          const failure = !implementationMatches ? 'checkpoint-code-version-mismatch' : 'checkpoint-identity-mismatch';
          resume = { ...resume, failure };
          errors.push({ code: failure, phase: 'resume' });
        } else {
          const requestBody = updateHistoryRequest(template.body, { cursor: expectedCursor, sequenceId: template.decoded.sequenceId === null ? undefined : template.decoded.sequenceId + 1n });
          try {
            const requestContext = verificationFrame && !verificationFrame.isDetached() ? verificationFrame : verificationPage;
            const result = await options.observer.sendPage(requestContext, template, requestBody, options.signal, REQUEST_TIMEOUT_MS);
            const before = await readPageState(verificationPage).catch(() => initialAfter);
            const after = await readPageState(verificationPage).catch(() => before);
            const recovered = pageFactFromExchange({ pageNumber: 2, source: 'active', exchange: result.exchange, beforeState: before, afterState: after, previous: null, expectedCursor });
            if (!recovered) {
              resume = { ...resume, failure: result.exchange.decoded?.state === 'server-error' ? 'recovery-business-error' : 'recovery-decode-error' };
              errors.push({ code: result.exchange.decoded?.state === 'server-error' ? 'history-response-status-error' : 'response-protocol-error', phase: 'resume-control' });
            } else {
              recovered.browserFetchStatus = result.browserFetchStatus;
              pages.push(recovered);
              const cursorMatches = recovered.inputCursor === expectedCursor;
              const control = controlMatchesFact(controlBaseline, recovered);
              resume = { ...resume, cursorMatches, controlCompared: true, controlMatches: control, boundaryCompared: true, boundaryRelation: control ? 'matched-control' : 'mismatch', recoveryResponseCursorMatches: control && recovered.inputCursor === safeBigInt(controlBaseline.inputCursor) ? true : false };
              if (!cursorMatches || !control) {
                const failure = !cursorMatches ? 'recovery-request-cursor-mismatch' : 'recovery-control-mismatch';
                resume = { ...resume, failure };
                errors.push({ code: failure, phase: 'resume-control' });
              } else if (recovered.hasMore !== true || recovered.nextCursor === null || recovered.nextCursor === recovered.inputCursor) {
                resume = { ...resume, failure: 'recovery-output-cursor-not-progressing' };
                errors.push({ code: 'history-cursor-no-progress', phase: 'resume-control' });
              } else {
                const nextBody = updateHistoryRequest(template.body, { cursor: recovered.nextCursor, sequenceId: recovered.sequenceId === null ? undefined : recovered.sequenceId + 1n });
                const nextResult = await options.observer.sendPage(requestContext, template, nextBody, options.signal, REQUEST_TIMEOUT_MS);
                const nextBefore = await readPageState(verificationPage).catch(() => after);
                const nextAfter = await readPageState(verificationPage).catch(() => nextBefore);
                const nextFact = pageFactFromExchange({ pageNumber: 3, source: 'active', exchange: nextResult.exchange, beforeState: nextBefore, afterState: nextAfter, previous: recovered, expectedCursor: recovered.nextCursor });
                if (!nextFact) {
                  resume = { ...resume, failure: 'recovery-next-page-decode-error' };
                  errors.push({ code: 'response-protocol-error', phase: 'resume-next-page' });
                } else {
                  nextFact.browserFetchStatus = nextResult.browserFetchStatus;
                  pages.push(nextFact);
                  const nextVerified = nextFact.httpStatus >= 200 && nextFact.httpStatus < 300 && nextFact.businessStatus === 0n && nextFact.cursorLinkedFromPrevious === true && nextFact.cursorProgressed === true && nextFact.conversationId === checkpoint.conversationId && nextFact.shortId.toString() === checkpoint.conversationShortId && nextFact.newPlatformIds > 0;
                  resume = { ...resume, nextPageVerified: nextVerified };
                  if (!nextVerified) errors.push({ code: 'recovery-next-page-mismatch', phase: 'resume-next-page' });
                  const accountId = accountIds[0];
                  const checkpointToSave = accountId && nextVerified && suite && options.checkpointId ? buildCheckpoint(suite, accountId, options.checkpointId, nextFact) : null;
                  if (checkpointToSave && suite) {
                    await saveVerificationCheckpoint(checkpointToSave, checkpointStoreContext(checkpointToSave, suite.redactor));
                    resume = { ...resume, checkpointSaved: true };
                  }
                }
              }
            }
          } catch (error) {
            resume = { ...resume, failure: errorCode(error) };
            errors.push({ code: errorCode(error), phase: 'resume-control' });
          }
        }
      }
    } else {
      const targetPages = task === 'chain' ? options.pages : task === 'recovery' ? 2 : 1;
      const maxPages = options.maxPages ?? (task === 'chain' ? options.pages : task === 'endpoint' ? 5 : 20);
      let nextCursor = initialFact.nextCursor;
      let expectedPrevious: LivePageFact | null = initialFact;
      let sequenceId = template.decoded.sequenceId;
      let pageNumber = 2;
      let endpointReached = initialFact.hasMore === false;
      if (task === 'endpoint') {
        const initialSelection = mergeSessionMatches(selectedSessionMatches(initialBefore, initialFact.conversationId), selectedSessionMatches(initialAfter, initialFact.conversationId));
        endpoint = { ...endpoint, sessionMatches: initialSelection };
        if (initialSelection === false) {
          errors.push({ code: 'endpoint-session-mismatch', phase: 'initial' });
          endpointReached = true;
        } else if (endpointReached) {
          endpoint = { pageNumber: 1, reached: true, confirmed: false, confirmationHasMore: null, reason: 'explicit-end', sessionMatches: initialSelection };
        }
      }
      while (!options.signal.aborted && template && !endpointReached && pages.length < maxPages && nextCursor !== null) {
        if ((task === 'chain' || task === 'recovery') && pages.length >= targetPages) break;
        const before = await readPageState(verificationPage).catch(() => selected);
        selectedStates.push(before);
        const activeCursor = nextCursor;
        const requestBody = updateHistoryRequest(template.body, { cursor: activeCursor, sequenceId: sequenceId === null ? undefined : sequenceId + 1n });
        let result: { exchange: CapturedHistoryExchange; browserFetchStatus: number | null };
        try {
          const requestContext = verificationFrame && !verificationFrame.isDetached() ? verificationFrame : verificationPage;
          result = await options.observer.sendPage(requestContext, template, requestBody, options.signal, REQUEST_TIMEOUT_MS);
        } catch (error) {
          errors.push({ code: errorCode(error), phase: `page-${pageNumber}` });
          if (task === 'endpoint') endpoint = { pageNumber: pages.length, reached: false, confirmed: false, confirmationHasMore: null, reason: 'request-error' };
          break;
        }
        const after = await readPageState(verificationPage).catch(() => before);
        selectedStates.push(after);
        if (task === 'endpoint') {
          const requestSelection = mergeSessionMatches(selectedSessionMatches(before, result.exchange.request.decoded.conversationId), selectedSessionMatches(after, result.exchange.request.decoded.conversationId));
          endpoint = { ...endpoint, sessionMatches: mergeSessionMatches(endpoint.sessionMatches, requestSelection) };
          if (endpoint.sessionMatches === false) {
            errors.push({ code: 'endpoint-session-mismatch', phase: `page-${pageNumber}` });
            endpointReached = true;
            break;
          }
        }
        const fact = pageFactFromExchange({ pageNumber, source: 'active', exchange: result.exchange, beforeState: before, afterState: after, previous: expectedPrevious, expectedCursor: activeCursor });
        if (!fact) {
          const reason: EndpointFact['reason'] = result.exchange.decoded?.state === 'server-error' ? 'business-error' : 'decode-error';
          errors.push({ code: result.exchange.decoded?.state === 'server-error' ? 'history-response-status-error' : result.exchange.decodeError || 'response-protocol-error', phase: `page-${pageNumber}` });
          if (task === 'endpoint') endpoint = { pageNumber: pages.length, reached: false, confirmed: false, confirmationHasMore: null, reason };
          break;
        }
        fact.browserFetchStatus = result.browserFetchStatus;
        pages.push(fact);
        if (fact.beforeState.messageList.found && fact.afterState.messageList.found && fact.beforeState.messageList.scrollTop !== fact.afterState.messageList.scrollTop) errors.push({ code: 'message-list-scroll-position-changed', phase: `page-${pageNumber}` });
        if (fact.businessStatus !== 0n || fact.httpStatus < 200 || fact.httpStatus >= 300) {
          errors.push({ code: 'history-response-status-error', phase: `page-${pageNumber}` });
          if (task === 'endpoint') endpoint = { pageNumber, reached: false, confirmed: false, confirmationHasMore: null, reason: 'business-error' };
          break;
        }
        if (fact.hasMore === false) {
          endpointReached = true;
          if (task === 'endpoint') endpoint = { ...endpoint, pageNumber, reached: true, confirmed: false, confirmationHasMore: null, reason: 'explicit-end' };
          break;
        }
        if (fact.hasMore === null) {
          errors.push({ code: 'missing-history-end-flag', phase: `page-${pageNumber}` });
          if (task === 'endpoint') endpoint = { pageNumber, reached: false, confirmed: false, confirmationHasMore: null, reason: 'missing-flag' };
          break;
        }
        if (fact.nextCursor === null || fact.nextCursor === fact.inputCursor || fact.newPlatformIds <= 0) {
          errors.push({ code: 'history-cursor-no-progress', phase: `page-${pageNumber}` });
          if (task === 'endpoint') endpoint = { pageNumber, reached: false, confirmed: false, confirmationHasMore: null, reason: 'empty-page' };
          break;
        }
        expectedPrevious = fact;
        nextCursor = fact.nextCursor;
        sequenceId = fact.sequenceId;
        pageNumber++;
        const semanticSignals = new Set(pages.flatMap(page => page.messages.flatMap(message => message.content.signals)));
        const semanticReference = pages.some(page => page.messages.some(message => message.reference.present && message.reference.targetMessageId !== null));
        if (task === 'semantics' && ['text', 'image', 'emoji', 'video-share', 'video-file', 'voice'].every(signal => semanticSignals.has(signal)) && semanticReference) break;
      }
      if (task === 'recovery' && !options.signal.aborted && suite && options.checkpointId && pages.length >= 2 && accountIds[0]) {
        const prepared = buildCheckpoint(suite, accountIds[0], options.checkpointId, pages[1]);
        if (prepared) {
          const context = checkpointStoreContext(prepared, suite.redactor);
          await saveVerificationCheckpoint(prepared, context);
          const controlCursor = safeBigInt(prepared.nextCursor);
          if (controlCursor !== null) {
            const controlBody = updateHistoryRequest(template.body, { cursor: controlCursor, sequenceId: pages[1].sequenceId === null ? undefined : pages[1].sequenceId + 1n });
            try {
              const requestContext = verificationFrame && !verificationFrame.isDetached() ? verificationFrame : verificationPage;
              const controlResult = await options.observer.sendPage(requestContext, template, controlBody, options.signal, REQUEST_TIMEOUT_MS);
              const controlBefore = await readPageState(verificationPage).catch(() => pages[1].afterState);
              const controlAfter = await readPageState(verificationPage).catch(() => controlBefore);
              const controlFact = pageFactFromExchange({ pageNumber: 3, source: 'active', exchange: controlResult.exchange, beforeState: controlBefore, afterState: controlAfter, previous: null, expectedCursor: controlCursor });
              if (controlFact) {
                const baseline = buildControlBaseline(suite, accountIds[0], options.checkpointId, controlFact);
                await saveControlBaseline(baseline, context);
                resume = { ...resume, checkpointFound: true, checkpointSaved: true, controlCompared: true, controlMatches: true, boundaryCompared: true, boundaryRelation: 'matched-control', implementationMatches: true };
              } else {
                errors.push({ code: 'control-page-decode-error', phase: 'recovery-prepare' });
              }
            } catch (error) {
              errors.push({ code: errorCode(error), phase: 'recovery-prepare-control' });
            }
          }
        }
      }
      if (task === 'endpoint' && !endpoint.reached && endpoint.reason === 'not-attempted' && pages.length >= maxPages) endpoint = { ...endpoint, reason: 'page-limit', pageNumber: pages.length };
      if (task === 'endpoint' && endpoint.reached && pages.at(-1) && template && !options.signal.aborted) {
        const last = pages.at(-1)!;
        const confirmationBody = updateHistoryRequest(template.body, { cursor: last.inputCursor, sequenceId: last.sequenceId === null ? undefined : last.sequenceId + 1n });
        try {
          const requestContext = verificationFrame && !verificationFrame.isDetached() ? verificationFrame : verificationPage;
          const confirmationBefore = await readPageState(verificationPage).catch(() => pages.at(-1)!.beforeState);
          const confirmation = await options.observer.sendPage(requestContext, template, confirmationBody, options.signal, REQUEST_TIMEOUT_MS);
          const confirmationAfter = await readPageState(verificationPage).catch(() => confirmationBefore);
          const confirmationSelection = mergeSessionMatches(selectedSessionMatches(confirmationBefore, last.conversationId), selectedSessionMatches(confirmationAfter, last.conversationId));
          const decoded = confirmation.exchange.decoded;
          const confirmationIds = decoded?.state === 'decoded' ? ids(decoded.messages) : [];
          const lastIds = ids(last.messages);
          const confirmationIndexes = decoded?.state === 'decoded' ? indexes(decoded.messages).map(value => value.toString()) : [];
          const lastIndexes = indexes(last.messages).map(value => value.toString());
          const confirmedWithStatus = confirmation.exchange.httpStatus >= 200 && confirmation.exchange.httpStatus < 300 && decoded?.state === 'decoded' && decoded.statusCode === 0n && decoded.hasMore === false;
          const recheckMatches = confirmedWithStatus && JSON.stringify(confirmationIds) === JSON.stringify(lastIds);
          const recheckOrderMatches = recheckMatches && JSON.stringify(confirmationIndexes) === JSON.stringify(lastIndexes);
          endpoint = { ...endpoint, confirmed: confirmedWithStatus, confirmationHasMore: decoded?.state === 'decoded' ? decoded.hasMore : null, recheckMatches, recheckMessageCount: confirmationIds.length, recheckOrderMatches, sessionMatches: mergeSessionMatches(endpoint.sessionMatches, confirmationSelection) };
          if (!confirmedWithStatus || !recheckMatches || !recheckOrderMatches) errors.push({ code: 'history-end-recheck-mismatch', phase: 'endpoint-confirmation' });
        } catch (error) {
          endpoint = { ...endpoint, reason: 'request-error' };
          errors.push({ code: errorCode(error), phase: 'endpoint-confirmation' });
        }
      }
    }
  } catch (error) {
    errors.push({ code: errorCode(error), phase: 'verification' });
  }

  const finalState = await readPageState(verificationPage).catch(() => selected);
  selectedStates.push(finalState);
  const withinPageScrollChanged = pages.some(page => page.beforeState.messageList.found && page.afterState.messageList.found && page.beforeState.messageList.scrollTop !== page.afterState.messageList.scrollTop);
  const acrossPageScrollChanged = pages.slice(1).some((page, index) => {
    const previous = pages[index].afterState.messageList;
    const current = page.beforeState.messageList;
    return previous.found && current.found && previous.scrollTop !== current.scrollTop;
  });
  const facts: LiveRunFacts = {
    runId,
    task,
    suite: suite?.metadata ?? null,
    redactor: suite?.redactor,
    mode: options.resume ? 'resume' : 'normal',
    requestedPages: task === 'endpoint' ? 1 : task === 'recovery' ? 2 : options.pages,
    endpointPageLimit: options.maxPages ?? (task === 'chain' ? options.pages : task === 'endpoint' ? 5 : 20),
    startedAt,
    finishedAt: new Date().toISOString(),
    browserKind: options.session.executable.kind,
    browserExecutable: options.session.executable.path,
    targetOrigin: finalState.origin || selected.origin || pageLocation(verificationPage).origin,
    targetPathname: finalState.pathname || selected.pathname || pageLocation(verificationPage).pathname,
    selfAccountIds: accountIds,
    selectedConversationIds: finalState.selectedConversationIds.length ? finalState.selectedConversationIds : selected.selectedConversationIds,
    selectedTitle: finalState.selectedTitle || selected.selectedTitle,
    selectedConversationStable: selectedConversationStable(selectedStates),
    pages,
    endpoint,
    resume,
    freshTemplateCaptured: Boolean(template),
    freshTemplateDecoded: Boolean(freshExchange?.decoded?.state === 'decoded'),
    freshTemplateResponseStatus: freshExchange?.httpStatus ?? null,
    noScrollViolation: withinPageScrollChanged || acrossPageScrollChanged,
    errors
  };
  return buildAndSave(facts, options);
}
