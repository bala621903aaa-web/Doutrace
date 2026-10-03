import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DecodedHistoryMessage } from '../im/protocol.js';
import { extensionTimeCandidates } from '../im/protocol.js';
import { appDataRoot } from './browser.js';
import type { PageState } from './page-state.js';
import {
  P1_REQUIREMENTS,
  TASK_REQUIREMENTS,
  recordVerificationSuiteRun,
  sha256Path,
  type P1RequirementKey,
  type SuiteRedactor,
  type SuiteRunMetadata,
  type VerificationTask
} from './verification-suite.js';
import { TIME_MAPPING_VERSION } from './verification-suite.js';
import { CLIENT_TIME_MAPPING_SOURCE, type ClientTimeSourceEvidence } from './time-mapping-source.js';
import type { MessageInfoDiagnostics } from './message-info-time.js';

export type LiveVerdict = 'pass' | 'fail' | 'inconclusive';
export type RequirementStatus = LiveVerdict | 'not-run';

export interface TimeEvidence {
  matched: number;
  uniqueMatchedMessageIds: number;
  ambiguous: number;
  noTime: number;
  minuteOnly: number;
  outOfWindow: number;
  field10Matches: number;
  extensionMatches: number;
  field10SecondsMatches: number;
  extensionSecondsMatches: number;
  selectedField: 'field10' | 'server-extension' | 'unknown';
  selectedUnit: 'millisecond' | 'second' | 'unknown';
  unresolvedConflicts: number;
  orderChecks: number;
  duplicateMessageIds: number;
  timezone: 'Asia/Shanghai';
  precision: 'minute' | 'unknown';
  rowTextCount?: number;
  rowKeyCount?: number;
  rowTimeCount?: number;
  messageTextCount?: number;
  keyMatches?: number;
  textMatches?: number;
  /** Internal only; omitted from redacted reports. */
  matchedMessageIds?: string[];
  field10CandidateMatches?: number;
  extensionCandidateMatches?: number;
  sameMinuteCandidateMatches?: number;
}

export interface LivePageFact {
  pageNumber: number;
  source: 'initial' | 'active';
  inputCursor: bigint | null;
  nextCursor: bigint | null;
  conversationId: string;
  shortId: bigint;
  sequenceId: bigint | null;
  httpStatus: number;
  browserFetchStatus: number | null;
  businessStatus: bigint | null;
  hasMore: boolean | null;
  messages: DecodedHistoryMessage[];
  beforeState: PageState;
  afterState: PageState;
  cursorLinkedFromPrevious: boolean | null;
  cursorProgressed: boolean | null;
  newPlatformIds: number;
  crossPagePlatformIdIntersection: number;
  indexRelationToPrevious: 'older' | 'newer' | 'overlap' | 'unknown' | 'not-applicable';
  timeCrossChecks: number;
  field10PageLabelCrossChecks: number;
  extensionPageLabelCrossChecks: number;
  bodyOrderChecks: number;
  timeUnitEvidence: 'millisecond' | 'second' | 'unknown';
  timeEvidence?: TimeEvidence;
}

export interface LiveTimeSnapshotFact {
  accountId: string | null;
  conversationId: string | null;
  messages: DecodedHistoryMessage[];
  beforeState: PageState;
  afterState: PageState;
  sessionMatches: boolean;
  mappingSourceVerified: boolean;
  mappingSources: ClientTimeSourceEvidence[];
  messageInfo?: MessageInfoDiagnostics;
  initializationExchanges: number;
  historyExchanges: number;
  duplicateSourceMessages: number;
  conflictingMessageIds: number;
  sourceDecodeErrors: number;
  evidence: TimeEvidence;
}

export interface EndpointFact {
  pageNumber: number | null;
  reached: boolean;
  confirmed: boolean;
  confirmationHasMore: boolean | null;
  reason: 'explicit-end' | 'missing-flag' | 'page-limit' | 'empty-page' | 'request-error' | 'business-error' | 'decode-error' | 'not-attempted';
  recheckMatches?: boolean;
  recheckMessageCount?: number;
  recheckOrderMatches?: boolean;
  sessionMatches?: boolean | null;
}

export interface ResumeFact {
  requested: boolean;
  checkpointFound: boolean;
  accountMatches: boolean | null;
  conversationMatches: boolean | null;
  shortIdMatches: boolean | null;
  cursorMatches: boolean | null;
  boundaryCompared: boolean;
  boundaryRelation: 'adjacent' | 'overlap' | 'disjoint' | 'matched-control' | 'mismatch' | 'unknown';
  previousRunDifferent: boolean;
  checkpointSaved: boolean;
  failure: string | null;
  controlCompared?: boolean;
  controlMatches?: boolean | null;
  recoveryResponseCursorMatches?: boolean | null;
  nextPageVerified?: boolean;
  implementationMatches?: boolean | null;
}

export interface LiveRunFacts {
  runId: string;
  task?: VerificationTask;
  suite?: SuiteRunMetadata | null;
  redactor?: SuiteRedactor;
  mode: 'normal' | 'resume';
  requestedPages: number;
  endpointPageLimit: number;
  startedAt: string;
  finishedAt: string;
  browserKind: string;
  browserExecutable: string;
  targetOrigin: string;
  targetPathname: string;
  selfAccountIds: string[];
  selectedConversationIds: string[];
  selectedTitle: string;
  selectedConversationStable: boolean | null;
  pages: LivePageFact[];
  timeSnapshots?: LiveTimeSnapshotFact[];
  timeStopReason?: 'samples-collected' | 'window-not-covered' | 'samples-insufficient' | 'identity-unverified' | 'cancelled';
  endpoint: EndpointFact;
  resume: ResumeFact;
  freshTemplateCaptured: boolean;
  freshTemplateDecoded: boolean;
  freshTemplateResponseStatus: number | null;
  noScrollViolation: boolean;
  errors: Array<{ code: string; phase: string }>;
}

interface Requirement {
  key: P1RequirementKey;
  label: string;
  status: RequirementStatus;
  evidence: Record<string, unknown>;
  gaps: string[];
}

export interface LiveVerificationReport {
  reportVersion: 2;
  kind: 'p1-live-verification';
  generatedAt: string;
  runId: string;
  task: VerificationTask;
  suite: SuiteRunMetadata | null;
  applicableRequirements: P1RequirementKey[];
  evidenceComplete: boolean;
  mode: 'normal' | 'resume';
  verdict: LiveVerdict;
  // A task report can pass its own requirement but never opens formal
  // collection. Only P1-ACCEPTANCE-SUMMARY can open the aggregate gate.
  formalCollection: 'open' | 'closed';
  p2GateOpen: boolean;
  browser: { kind: string; executablePath: string };
  accountFingerprints: string[];
  target: { origin: string; pathname: string };
  requestedPages: number;
  completedPages: number;
  endpoint: EndpointFact;
  resume: ResumeFact;
  pages: ReturnType<typeof redactedPage>[];
  timeSnapshots?: ReturnType<typeof redactedTimeSnapshot>[];
  timeStopReason?: LiveRunFacts['timeStopReason'];
  requirements: Requirement[];
  errors: Array<{ code: string; phase: string }>;
  privacy: { note: string; omitted: string[] };
}

function createFallbackRedactor(): SuiteRedactor {
  const key = randomBytes(32);
  return {
    fingerprint(kind, value) {
      if (value === null) return null;
      return createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex').slice(0, 16);
    }
  };
}

function digitCounts(values: Array<bigint | null>) {
  return [...new Set(values.filter((value): value is bigint => value !== null).map(value => value.toString().length))].sort((a, b) => a - b);
}

function countBy(items: string[]) {
  const result: Record<string, number> = {};
  for (const item of items) result[item] = (result[item] ?? 0) + 1;
  return result;
}

function publicTimeEvidence(evidence: TimeEvidence | null) {
  if (!evidence) return null;
  const { matchedMessageIds: _matchedMessageIds, ...publicEvidence } = evidence;
  return publicEvidence;
}

function redactedTimeSnapshot(snapshot: LiveTimeSnapshotFact, redactor: SuiteRedactor) {
  const before = snapshot.beforeState.messageList;
  const after = snapshot.afterState.messageList;
  return {
    capturedAt: snapshot.afterState.capturedAt,
    accountFingerprint: redactor.fingerprint('account', snapshot.accountId),
    conversationFingerprint: redactor.fingerprint('conversation', snapshot.conversationId),
    sessionMatches: snapshot.sessionMatches,
    mappingSourceVerified: snapshot.mappingSourceVerified,
    mappingSources: snapshot.mappingSources,
    messageInfo: snapshot.messageInfo,
    verifiedMapping: snapshot.mappingSourceVerified ? CLIENT_TIME_MAPPING_SOURCE : null,
    initializationExchanges: snapshot.initializationExchanges,
    historyExchanges: snapshot.historyExchanges,
    candidateMessages: snapshot.messages.length,
    duplicateSourceMessages: snapshot.duplicateSourceMessages,
    conflictingMessageIds: snapshot.conflictingMessageIds,
    sourceDecodeErrors: snapshot.sourceDecodeErrors,
    messageList: { before, after, positionUnchanged: before.found && after.found && before.scrollTop === after.scrollTop },
    ui: snapshot.afterState.ui,
    evidence: publicTimeEvidence(snapshot.evidence),
    matchedMessageFingerprints: (snapshot.evidence.matchedMessageIds ?? []).map(id => redactor.fingerprint('message', id))
  };
}

function pageMessageEvidence(page: LivePageFact, redactor: SuiteRedactor, previousIds: Set<string> | null) {
  const ids = page.messages.map(message => message.platformMessageId).filter((value): value is string => value !== null);
  const uniqueIds = new Set(ids);
  const previousIntersection = previousIds ? ids.filter(id => previousIds.has(id)) : [];
  const indexValues = page.messages.map(message => message.indexInConversation);
  const timeValues = page.messages.map(message => message.timeField10);
  const extensionTimes = page.messages.flatMap(extensionTimeCandidates);
  const timeFieldStrings = new Set(timeValues.filter((value): value is bigint => value !== null).map(value => value.toString()));
  const contentKeys = page.messages.flatMap(message => message.content.keys);
  const contentSignals = page.messages.flatMap(message => message.content.signals);
  const references = page.messages.map(message => message.reference);
  return {
    count: page.messages.length,
    conversationMatches: page.messages.filter(message => message.conversationId === page.conversationId).length,
    shortIdMatches: page.messages.filter(message => message.conversationShortId === page.shortId).length,
    platformIdCount: ids.length,
    uniquePlatformIdCount: uniqueIds.size,
    platformIdFingerprints: ids.map(id => redactor.fingerprint('message', id)!),
    newPlatformIds: page.newPlatformIds,
    crossPagePlatformIdIntersection: page.crossPagePlatformIdIntersection || previousIntersection.length,
    index: {
      count: indexValues.filter(value => value !== null).length,
      digitCounts: digitCounts(indexValues),
      firstFingerprint: page.messages[0]?.indexInConversation === null || page.messages[0]?.indexInConversation === undefined ? null : redactor.fingerprint('index', page.messages[0].indexInConversation.toString()),
      lastFingerprint: page.messages.at(-1)?.indexInConversation === null || page.messages.at(-1)?.indexInConversation === undefined ? null : redactor.fingerprint('index', page.messages.at(-1)!.indexInConversation!.toString()),
      relationToPrevious: page.indexRelationToPrevious
    },
    senderIdCount: page.messages.filter(message => message.senderUid !== null).length,
    time: {
      field10Count: timeValues.filter(value => value !== null).length,
      field10DigitCounts: digitCounts(timeValues),
      extensionServerTimeCount: extensionTimes.length,
      extensionDigitCounts: [...new Set(extensionTimes.map(value => value.length))].sort((a, b) => a - b),
      equalToField10: extensionTimes.filter(value => timeFieldStrings.has(value)).length,
      pageLabelCrossChecks: page.timeCrossChecks,
      field10PageLabelCrossChecks: page.field10PageLabelCrossChecks,
      extensionPageLabelCrossChecks: page.extensionPageLabelCrossChecks,
      sampledMessageOrderChecks: page.bodyOrderChecks,
      unitEvidence: page.timeUnitEvidence,
      evidence: publicTimeEvidence(page.timeEvidence ?? null)
    },
    content: {
      validJsonObjectCount: page.messages.filter(message => message.content.validJsonObject).length,
      recognizedKeyCounts: countBy(contentKeys),
      signalCounts: countBy(contentSignals)
    },
    references: {
      field18Count: references.filter(reference => reference.present).length,
      targetIdCount: references.filter(reference => reference.targetMessageId !== null).length,
      malformedCount: references.filter(reference => reference.malformed).length,
      targetIdFingerprints: references.filter(reference => reference.targetMessageId !== null).map(reference => redactor.fingerprint('reference-target', reference.targetMessageId)!),
      targetStatus: references.map(reference => reference.targetMessageId === null ? (reference.present ? 'unresolved' : 'none') : 'observed')
    }
  };
}

function redactedPage(page: LivePageFact, redactor: SuiteRedactor, previousIds: Set<string> | null) {
  const listBefore = page.beforeState.messageList;
  const listAfter = page.afterState.messageList;
  return {
    pageNumber: page.pageNumber,
    source: page.source,
    httpStatus: page.httpStatus,
    browserFetchStatus: page.browserFetchStatus,
    businessStatus: page.businessStatus?.toString() ?? null,
    request: {
      conversationFingerprint: redactor.fingerprint('conversation', page.conversationId),
      shortIdFingerprint: redactor.fingerprint('short-id', page.shortId.toString()),
      cursorFingerprint: page.inputCursor === null ? null : redactor.fingerprint('cursor', page.inputCursor.toString()),
      cursorDigits: page.inputCursor?.toString().length ?? null,
      sequenceIdDigits: page.sequenceId?.toString().length ?? null
    },
    response: {
      nextCursorFingerprint: page.nextCursor === null ? null : redactor.fingerprint('cursor', page.nextCursor.toString()),
      nextCursorDigits: page.nextCursor?.toString().length ?? null,
      hasMore: page.hasMore,
      cursorLinkedFromPrevious: page.cursorLinkedFromPrevious,
      cursorProgressed: page.cursorProgressed
    },
    messages: pageMessageEvidence(page, redactor, previousIds),
    messageList: {
      before: { found: listBefore.found, scrollTop: listBefore.scrollTop, scrollHeight: listBefore.scrollHeight, clientHeight: listBefore.clientHeight, rowCount: listBefore.rowCount },
      after: { found: listAfter.found, scrollTop: listAfter.scrollTop, scrollHeight: listAfter.scrollHeight, clientHeight: listAfter.clientHeight, rowCount: listAfter.rowCount },
      positionUnchanged: listBefore.found && listAfter.found && listBefore.scrollTop === listAfter.scrollTop
    },
    ui: {
      before: page.beforeState.ui,
      after: page.afterState.ui
    }
  };
}

function requirement(key: P1RequirementKey, label: string, status: RequirementStatus, evidence: Record<string, unknown>, gaps: string[] = []): Requirement {
  return { key, label, status, evidence, gaps };
}

function notRun(key: P1RequirementKey, task: VerificationTask): Requirement {
  return requirement(key, key, 'not-run', { taskApplicable: false, task }, ['本分项任务不适用；由对应真实任务报告提供证据。']);
}

function allTransportPages(facts: LiveRunFacts) {
  return facts.pages.filter(page => page.source === 'initial' || page.source === 'active');
}

function countUniqueMessages(facts: LiveRunFacts) {
  const ids = [...allTransportPages(facts), ...(facts.timeSnapshots ?? [])].flatMap(page => page.messages.map(message => message.platformMessageId).filter((id): id is string => id !== null));
  return new Set(ids).size;
}

function mergeTimeEvidence(facts: LiveRunFacts): TimeEvidence {
  const evidence = [...allTransportPages(facts).map(page => page.timeEvidence), ...(facts.timeSnapshots ?? []).map(snapshot => snapshot.evidence)].filter((value): value is TimeEvidence => Boolean(value));
  if (!evidence.length) {
    const matched = allTransportPages(facts).reduce((sum, page) => sum + page.timeCrossChecks, 0);
    return {
      matched,
      uniqueMatchedMessageIds: matched,
      ambiguous: 0,
      noTime: 0,
      minuteOnly: 0,
      outOfWindow: 0,
      field10Matches: allTransportPages(facts).reduce((sum, page) => sum + page.field10PageLabelCrossChecks, 0),
      extensionMatches: allTransportPages(facts).reduce((sum, page) => sum + page.extensionPageLabelCrossChecks, 0),
      field10SecondsMatches: 0,
      extensionSecondsMatches: 0,
      selectedField: 'unknown',
      selectedUnit: allTransportPages(facts).map(page => page.timeUnitEvidence).find(value => value !== 'unknown') === 'millisecond' ? 'millisecond' : 'unknown',
      unresolvedConflicts: 1,
      orderChecks: allTransportPages(facts).reduce((sum, page) => sum + page.bodyOrderChecks, 0),
      duplicateMessageIds: 0,
      timezone: 'Asia/Shanghai',
      precision: 'unknown',
      rowTextCount: 0,
      rowKeyCount: 0,
      rowTimeCount: 0,
      messageTextCount: 0,
      keyMatches: 0,
      textMatches: 0
    };
  }
  const selectedFields = new Set(evidence.map(item => item.selectedField).filter(value => value !== 'unknown'));
  const selectedUnits = new Set(evidence.map(item => item.selectedUnit).filter(value => value !== 'unknown'));
  return {
    matched: evidence.reduce((sum, item) => sum + item.matched, 0),
    uniqueMatchedMessageIds: new Set(evidence.flatMap(item => item.matchedMessageIds ?? [])).size || evidence.reduce((sum, item) => sum + item.uniqueMatchedMessageIds, 0),
    ambiguous: evidence.reduce((sum, item) => sum + item.ambiguous, 0),
    noTime: evidence.reduce((sum, item) => sum + item.noTime, 0),
    minuteOnly: evidence.reduce((sum, item) => sum + item.minuteOnly, 0),
    outOfWindow: evidence.reduce((sum, item) => sum + item.outOfWindow, 0),
    field10Matches: evidence.reduce((sum, item) => sum + item.field10Matches, 0),
    extensionMatches: evidence.reduce((sum, item) => sum + item.extensionMatches, 0),
    field10SecondsMatches: evidence.reduce((sum, item) => sum + item.field10SecondsMatches, 0),
    extensionSecondsMatches: evidence.reduce((sum, item) => sum + item.extensionSecondsMatches, 0),
    selectedField: selectedFields.size === 1 ? [...selectedFields][0] : 'unknown',
    selectedUnit: selectedUnits.size === 1 ? [...selectedUnits][0] : 'unknown',
    unresolvedConflicts: evidence.reduce((sum, item) => sum + item.unresolvedConflicts, 0) + (selectedFields.size > 1 || selectedUnits.size > 1 ? 1 : 0),
    orderChecks: evidence.reduce((sum, item) => sum + item.orderChecks, 0),
    duplicateMessageIds: evidence.reduce((sum, item) => sum + item.duplicateMessageIds, 0),
    timezone: 'Asia/Shanghai',
    precision: evidence.some(item => item.matched > 0) && evidence.filter(item => item.matched > 0).every(item => item.precision === 'minute') ? 'minute' : 'unknown',
    rowTextCount: evidence.reduce((sum, item) => sum + (item.rowTextCount ?? 0), 0),
    rowKeyCount: evidence.reduce((sum, item) => sum + (item.rowKeyCount ?? 0), 0),
    rowTimeCount: evidence.reduce((sum, item) => sum + (item.rowTimeCount ?? 0), 0),
    messageTextCount: evidence.reduce((sum, item) => sum + (item.messageTextCount ?? 0), 0),
    keyMatches: evidence.reduce((sum, item) => sum + (item.keyMatches ?? 0), 0),
    textMatches: evidence.reduce((sum, item) => sum + (item.textMatches ?? 0), 0),
    field10CandidateMatches: evidence.reduce((sum, item) => sum + (item.field10CandidateMatches ?? 0), 0),
    extensionCandidateMatches: evidence.reduce((sum, item) => sum + (item.extensionCandidateMatches ?? 0), 0),
    sameMinuteCandidateMatches: evidence.reduce((sum, item) => sum + (item.sameMinuteCandidateMatches ?? 0), 0)
  };
}

function evaluateRequirements(facts: LiveRunFacts): Requirement[] {
  const task = facts.task ?? 'chain';
  const applicable = new Set(TASK_REQUIREMENTS[task]);
  const requirements = P1_REQUIREMENTS.map(key => notRun(key, task));
  const put = (item: Requirement) => {
    const index = requirements.findIndex(candidate => candidate.key === item.key);
    if (index >= 0) requirements[index] = item;
  };
  const pages = allTransportPages(facts);
  const activeContinuationCount = pages.filter(page => page.source === 'active').length;
  const pageSuccess = pages.length > 0 && pages.every(page => page.httpStatus >= 200 && page.httpStatus < 300 && page.businessStatus === 0n && (page.browserFetchStatus === null || (page.browserFetchStatus >= 200 && page.browserFetchStatus < 300)));
  const hasProtocolError = facts.errors.some(error => /protocol|status|response|request/i.test(error.code));

  if (applicable.has('real-channel')) {
    const needed = Math.max(0, facts.requestedPages - 1);
    const status: LiveVerdict = !pages.length ? 'inconclusive' : hasProtocolError ? 'fail' : pageSuccess && activeContinuationCount >= needed ? 'pass' : 'inconclusive';
    put(requirement('real-channel', '正常登录的真实通道', status, { task, freshTemplateCaptured: facts.freshTemplateCaptured, freshTemplateDecoded: facts.freshTemplateDecoded, freshTemplateResponseStatus: facts.freshTemplateResponseStatus, successfulPages: pages.filter(page => page.httpStatus >= 200 && page.httpStatus < 300 && page.businessStatus === 0n).length, requiredPages: facts.requestedPages }, !pages.length ? ['本轮没有捕获可解码的真实历史交换。'] : []));
  }

  if (applicable.has('identity')) {
    const identityMismatch = pages.some(page => page.messages.some(message => (message.conversationId !== null && message.conversationId !== page.conversationId) || (message.conversationShortId !== null && message.conversationShortId !== page.shortId)));
    const selectionKnown = facts.selectedConversationIds.length > 0;
    const selectionMatches = selectionKnown && facts.selectedConversationIds.includes(pages[0]?.conversationId ?? '');
    const status: LiveVerdict = identityMismatch ? 'fail' : !facts.selfAccountIds.length || !selectionKnown || facts.selectedConversationStable !== true || !selectionMatches || !pages.length ? 'inconclusive' : 'pass';
    put(requirement('identity', '账号/会话身份', status, { selfAccountIdCount: facts.selfAccountIds.length, selectedConversationIdCount: facts.selectedConversationIds.length, selectedConversationMatchesRequest: selectionMatches, stableAcrossRequests: facts.selectedConversationStable === true, messageConversationMismatches: identityMismatch ? 1 : 0 }, identityMismatch ? ['消息归属与请求会话不一致。'] : status === 'inconclusive' ? ['需要真实自身 UID、当前选中会话和稳定的跨请求对照。'] : []));
  }

  if (applicable.has('platform-message-id')) {
    const idMissing = pages.some(page => page.messages.some(message => message.platformMessageId === null));
    const idDuplicate = pages.some(page => {
      const ids = page.messages.map(message => message.platformMessageId).filter((id): id is string => id !== null);
      return new Set(ids).size !== ids.length;
    });
    const status: LiveVerdict = !pages.length ? 'inconclusive' : idMissing || idDuplicate ? 'fail' : pages.length >= facts.requestedPages && pages.every(page => page.messages.length > 0) ? 'pass' : 'inconclusive';
    put(requirement('platform-message-id', '平台消息 ID', status, { pages: pages.length, missingCount: pages.reduce((sum, page) => sum + page.messages.filter(message => message.platformMessageId === null).length, 0), duplicatePageCount: pages.filter(page => { const ids = page.messages.map(message => message.platformMessageId).filter((id): id is string => id !== null); return new Set(ids).size !== ids.length; }).length }, idMissing || idDuplicate ? ['存在缺失或同页重复的平台消息 ID。'] : status === 'inconclusive' ? ['需要目标数量的非空真实页。'] : []));
  }

  if (applicable.has('three-pages-no-scroll')) {
    const chain = pages.slice(0, facts.requestedPages);
    const shortPage = chain.length < facts.requestedPages || chain.some(page => page.messages.length === 0);
    const cursorBroken = chain.some((page, index) => index > 0 && (page.cursorLinkedFromPrevious !== true || page.cursorProgressed !== true));
    const pageListBroken = chain.some(page => !page.beforeState.messageList.found || !page.afterState.messageList.found || page.beforeState.messageList.scrollTop !== page.afterState.messageList.scrollTop);
    const transitionChanged = chain.slice(1).some((page, index) => {
      const previous = chain[index].afterState.messageList;
      const current = page.beforeState.messageList;
      return previous.found && current.found && previous.scrollTop !== current.scrollTop;
    });
    const noNewMessages = chain.some((page, index) => index > 0 && page.newPlatformIds <= 0);
    const indexRelationBroken = chain.some((page, index) => index > 0 && page.indexRelationToPrevious === 'newer');
    const indexUnknown = chain.some((page, index) => index > 0 && page.indexRelationToPrevious === 'unknown');
    const status: LiveVerdict = pageListBroken || transitionChanged || cursorBroken || noNewMessages || indexRelationBroken || facts.noScrollViolation ? 'fail' : shortPage || indexUnknown ? 'inconclusive' : 'pass';
    put(requirement('three-pages-no-scroll', '无滚动连续三页', status, { requestedPages: facts.requestedPages, completedPages: chain.length, activeContinuationCount, cursorBroken, noNewMessages, indexRelationBroken, indexRelationUnknown: indexUnknown, listPositionChecks: chain.filter(page => page.beforeState.messageList.found && page.afterState.messageList.found).length, listPositionTransitionChanged: transitionChanged, noScrollViolation: facts.noScrollViolation }, status === 'fail' ? [pageListBroken ? '未取得目标消息列表的前后位置证据。' : transitionChanged ? '相邻真实页之间的消息列表位置发生变化。' : cursorBroken ? '真实续传游标未形成连续关联。' : noNewMessages ? '连续页没有新增平台消息 ID。' : indexRelationBroken ? '跨页索引方向出现反向推进。' : '无滚动连续页存在真实矛盾。'] : shortPage ? [`需要同一会话至少 ${facts.requestedPages} 个非空真实页，并完成真实续传。`] : []));
  }

  if (applicable.has('sent-time')) {
    const evidence = mergeTimeEvidence(facts);
    const snapshots = facts.timeSnapshots ?? [];
    const sessionsVerified = snapshots.length > 0 && facts.selfAccountIds.length === 1 && snapshots.every(snapshot => snapshot.sessionMatches && snapshot.accountId === facts.selfAccountIds[0]);
    const sourceConflicts = snapshots.reduce((sum, snapshot) => sum + snapshot.conflictingMessageIds, 0);
    const mappingSourceVerified = snapshots.length > 0 && snapshots.every(snapshot => snapshot.mappingSourceVerified === true && (!snapshot.messageInfo?.accepted || snapshot.messageInfo.copyHelperVerified === true));
    const copyContradictions = snapshots.reduce((sum, snapshot) => sum + Object.entries(snapshot.messageInfo?.rejected ?? {}).filter(([code]) => ['copy-identity-mismatch', 'copy-message-mismatch', 'copy-row-mismatch', 'copy-calendar-mismatch', 'copy-wire-time-mismatch', 'copy-window-changed', 'copy-duplicate-message'].includes(code)).reduce((count, [, value]) => count + value, 0), 0);
    const status: LiveVerdict = !sessionsVerified || !mappingSourceVerified || facts.noScrollViolation || copyContradictions > 0 || evidence.unresolvedConflicts > 0 || sourceConflicts > 0 || evidence.duplicateMessageIds > 0 || evidence.outOfWindow > 0 ? 'inconclusive' : evidence.uniqueMatchedMessageIds < 10 || evidence.matched < 10 || evidence.orderChecks < 10 || evidence.selectedField === 'unknown' || evidence.selectedUnit === 'unknown' || evidence.precision !== 'minute' ? 'inconclusive' : 'pass';
    put(requirement('sent-time', '发送时间', status, { sampledMessages: countUniqueMessages(facts), ...publicTimeEvidence(evidence), sessionsVerified, mappingSourceVerified, verifiedMapping: mappingSourceVerified ? CLIENT_TIME_MAPPING_SOURCE : null, sourceConflicts, copyContradictions, uiMessageInfoSamples: snapshots.reduce((sum, snapshot) => sum + (snapshot.messageInfo?.accepted ?? 0), 0), snapshotCount: snapshots.length, stopReason: facts.timeStopReason ?? null, indexTreatedAsTime: false, mappingVersion: TIME_MAPPING_VERSION }, status === 'inconclusive' ? ['需要至少十条唯一真实消息的严格归属、完整日期、单位、时区、顺序和字段映射证据，以及实际加载的官方显示脚本散列；当前不能将未决冲突算作通过。'] : []));
  }

  if (applicable.has('history-end')) {
    const endpoint = facts.endpoint;
    const status: LiveVerdict = endpoint.sessionMatches === false || endpoint.reason === 'request-error' || endpoint.reason === 'business-error' || endpoint.reason === 'decode-error' ? 'fail' : endpoint.reached && endpoint.confirmed && endpoint.recheckMatches === true && endpoint.recheckOrderMatches === true && endpoint.sessionMatches === true ? 'pass' : 'inconclusive';
    put(requirement('history-end', '历史终点', status, { reached: endpoint.reached, confirmed: endpoint.confirmed, reason: endpoint.reason, confirmationHasMore: endpoint.confirmationHasMore, recheckMatches: endpoint.recheckMatches ?? null, recheckMessageCount: endpoint.recheckMessageCount ?? null, recheckOrderMatches: endpoint.recheckOrderMatches ?? null, sessionMatches: endpoint.sessionMatches ?? null }, status === 'inconclusive' ? ['需要成功完整响应中的明确 has_more=false、同一输入游标的消息顺序重读，以及每次请求前后的选中会话一致。'] : endpoint.sessionMatches === false ? ['请求前后选中会话与短会话目标不一致，已停止。'] : []));
  }

  if (applicable.has('cursor-recovery')) {
    const resume = facts.resume;
    const status: LiveVerdict = resume.failure ? 'fail' : resume.requested && resume.checkpointFound && resume.accountMatches === true && resume.conversationMatches === true && resume.shortIdMatches === true && resume.cursorMatches === true && resume.controlCompared === true && resume.controlMatches === true && resume.recoveryResponseCursorMatches === true && resume.nextPageVerified === true && resume.previousRunDifferent && resume.checkpointSaved && resume.implementationMatches !== false ? 'pass' : 'inconclusive';
    put(requirement('cursor-recovery', '游标恢复', status, { requested: resume.requested, checkpointFound: resume.checkpointFound, accountMatches: resume.accountMatches, conversationMatches: resume.conversationMatches, shortIdMatches: resume.shortIdMatches, cursorMatches: resume.cursorMatches, controlCompared: resume.controlCompared ?? false, controlMatches: resume.controlMatches ?? null, recoveryResponseCursorMatches: resume.recoveryResponseCursorMatches ?? null, nextPageVerified: resume.nextPageVerified ?? false, boundaryCompared: resume.boundaryCompared, boundaryRelation: resume.boundaryRelation, previousRunDifferent: resume.previousRunDifferent, checkpointSaved: resume.checkpointSaved, implementationMatches: resume.implementationMatches ?? null }, status === 'inconclusive' ? ['必须用同游标控制页完成 ID 顺序、输出游标和 has_more 对账，再用恢复输出游标完成下一次真实续传；仅游标可解析或 disjoint 不足以通过。'] : []));
  }

  if (applicable.has('message-semantics')) {
    const signals = new Set(pages.flatMap(page => page.messages.flatMap(message => message.content.signals)));
    const hasReference = pages.some(page => page.messages.some(message => message.reference.present && message.reference.targetMessageId !== null));
    const referenceMalformed = pages.some(page => page.messages.some(message => message.reference.malformed));
    const requiredSignals = ['text', 'image', 'emoji', 'video-share', 'video-file', 'voice'];
    const missingSignals = requiredSignals.filter(signal => !signals.has(signal));
    const status: LiveVerdict = referenceMalformed ? 'fail' : missingSignals.length || !hasReference ? 'inconclusive' : 'pass';
    put(requirement('message-semantics', '本版消息语义', status, { observedSignals: [...signals].sort(), missingSignals, explicitReferenceObserved: hasReference, malformedReferenceCount: pages.reduce((sum, page) => sum + page.messages.filter(message => message.reference.malformed).length, 0), messageCount: countUniqueMessages(facts) }, status === 'inconclusive' ? ['需要本版全部消息类型和可解析显式引用目标；缺少的类型保持未验证。'] : []));
  }
  return requirements;
}

export function buildLiveVerificationReport(facts: LiveRunFacts): LiveVerificationReport {
  const task = facts.task ?? 'chain';
  const redactor = facts.redactor ?? createFallbackRedactor();
  const requirements = evaluateRequirements(facts);
  const applicableRequirements = [...TASK_REQUIREMENTS[task]];
  const applicableResults = requirements.filter(item => applicableRequirements.includes(item.key));
  const verdict: LiveVerdict = applicableResults.some(item => item.status === 'fail') ? 'fail' : applicableResults.some(item => item.status !== 'pass') ? 'inconclusive' : 'pass';
  const pages = allTransportPages(facts);
  const redactedPages = pages.map((page, index) => redactedPage(page, redactor, index === 0 ? null : new Set(pages[index - 1].messages.map(message => message.platformMessageId).filter((id): id is string => id !== null))));
  const suite = facts.suite ? { ...facts.suite, finishedAt: facts.finishedAt } : null;
  return {
    reportVersion: 2,
    kind: 'p1-live-verification',
    generatedAt: facts.finishedAt,
    runId: facts.runId,
    task,
    suite,
    applicableRequirements,
    evidenceComplete: Boolean(suite) && requirements.every(item => item.status !== 'not-run' ? item.evidence !== undefined : true),
    mode: facts.mode,
    verdict,
    formalCollection: 'closed',
    p2GateOpen: false,
    browser: { kind: facts.browserKind, executablePath: facts.browserExecutable },
    accountFingerprints: facts.selfAccountIds.map(id => redactor.fingerprint('account', id)!),
    target: { origin: facts.targetOrigin, pathname: facts.targetPathname },
    requestedPages: facts.requestedPages,
    completedPages: pages.length,
    endpoint: facts.endpoint,
    resume: facts.resume,
    pages: redactedPages,
    timeSnapshots: (facts.timeSnapshots ?? []).map(snapshot => redactedTimeSnapshot(snapshot, redactor)),
    timeStopReason: facts.timeStopReason,
    requirements,
    errors: facts.errors,
    privacy: {
      note: '本报告只保存本 suite 内可关联的私有 HMAC 指纹、字段名、结构、计数和位置证据。单项通过不会开放正式采集。',
      omitted: ['认证头、Cookie、Token、请求签名', '原始 Protobuf/JSON 包', '聊天正文和媒体链接', '原始账号、会话、消息 ID', '附件内容', 'suite 私有 HMAC 密钥']
    }
  };
}

function markdown(report: LiveVerificationReport) {
  const lines = [
    '# P1 分项真实验证报告',
    '',
    `生成时间：${report.generatedAt}（Asia/Shanghai）`,
    `suite：\`${report.suite?.suiteId ?? '未关联'}\`；任务：\`${report.task}\`；运行：\`${report.runId}\`；判定：**${report.verdict}**`,
    '',
    '正式采集门：关闭。只有 `P1-ACCEPTANCE-SUMMARY` 的八项真实证据全部为 pass 且版本与当前实现匹配时，才允许进入 P2。',
    '',
    '## 本任务适用项',
    '',
    '| 必验项 | 判定 | 证据摘要 |',
    '|---|---|---|',
    ...report.requirements.filter(item => report.applicableRequirements.includes(item.key)).map(item => `| ${item.label} | ${item.status} | ${item.gaps.length ? item.gaps.join(' ') : '本任务证据满足该项'} |`),
    '',
    '## 其他项',
    '',
    ...report.requirements.filter(item => !report.applicableRequirements.includes(item.key)).map(item => `- ${item.key}：not-run（由对应分项任务验证）。`),
    '',
    '## 运行概览',
    '',
    `- 请求页数：${report.requestedPages}；捕获页数：${report.completedPages}。`,
    `- 历史终点字段：${report.endpoint.reason}；终点重读：${report.endpoint.confirmed ? '请求完成' : '未完成'}。`,
    `- 恢复任务：${report.resume.requested ? '是' : '否'}；控制页对账：${report.resume.controlMatches === true ? '通过' : '未通过/未执行'}。`,
    '',
    '## 隐私边界',
    '',
    ...report.privacy.omitted.map(item => `- 未保存：${item}。`),
    ''
  ];
  return lines.join('\n');
}

export async function saveLiveVerificationReport(report: LiveVerificationReport, workspaceRoot: string): Promise<{ jsonPath: string; markdownPath: string; manifestPath: string | null }> {
  const reportDirectory = join(appDataRoot(), 'probe-reports');
  await mkdir(reportDirectory, { recursive: true });
  const suitePart = report.suite?.suiteId ?? 'unscoped';
  const jsonPath = join(reportDirectory, `p1-${suitePart}-${report.task}-${report.runId}.json`);
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  const markdownDirectory = join(workspaceRoot, 'P1-REPORTS', suitePart);
  await mkdir(markdownDirectory, { recursive: true });
  const markdownPath = join(markdownDirectory, `${report.task}-${report.runId}.md`);
  await writeFile(markdownPath, markdown(report), 'utf8');
  let manifestPath: string | null = null;
  if (report.suite) {
    manifestPath = await recordVerificationSuiteRun({
      ...report.suite,
      reportJsonPath: jsonPath,
      reportJsonSha256: await sha256Path(jsonPath),
      reportMarkdownPath: markdownPath,
      reportMarkdownSha256: await sha256Path(markdownPath)
    });
  }
  return { jsonPath, markdownPath, manifestPath };
}
