import type { Frame, Page } from 'playwright-core';

export interface PageRowState {
  text: string;
  timeLabel: string;
  timeLabels?: string[];
  timeAssociation?: 'row' | 'sibling' | 'none' | 'ambiguous';
  messageKey?: string | null;
  markers: string[];
  fromMe: boolean;
  sideKnown?: boolean;
}

export interface MessageListState {
  found: boolean;
  scrollTop: number | null;
  scrollHeight: number | null;
  clientHeight: number | null;
  rowCount: number;
}

export interface PageState {
  capturedAt: string;
  origin: string;
  pathname: string;
  selectedConversationIds: string[];
  selectedTitle: string;
  selfUidCandidates: string[];
  messageList: MessageListState;
  rows: PageRowState[];
  ui: {
    frameOrigin: string;
    framePathname: string;
    bodyElementCount: number;
    bodyTextLength: number;
    selectedCandidateCount: number;
    messageRowCandidateCount: number;
    textRowCount: number;
    timeLabelCount: number;
    timeLabelShapeCounts: Record<string, number>;
    listCandidateCount: number;
    scrollCandidateCount: number;
    conversationStorePresent: boolean;
    headerPresent: boolean;
  };
}

export const PAGE_STATE_EVALUATOR = String.raw`(() => {
  const asString = value => {
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return null;
  };
  const ids = new Set();
  const addId = value => {
    const string = asString(value);
    if (string && string.length <= 256) ids.add(string);
  };
  const store = (() => {
    try { return window.conversationStore; }
    catch { return undefined; }
  })();
  const addObjectCandidates = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (/^(conversation_?id|conversationId|conv_?id|id)$/i.test(key)) addId(child);
    }
  };
  if (store) {
    try {
      for (const key of ['curConversationId', 'currentConversationId', 'conversationId']) addId(store[key]);
      const currentId = asString(store.curConversationId) || asString(store.currentConversationId);
      const map = store.conversationMap;
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        if (currentId) addObjectCandidates(map[currentId]);
        if (currentId && map[currentId] && typeof map[currentId] === 'object') addId(map[currentId].id);
      }
      addObjectCandidates(store.currentConversation);
    } catch {}
  }
  try {
    const query = new URLSearchParams(location.search);
    for (const [key, value] of query) if (/conversation|conv/i.test(key)) addId(value);
  } catch {}
  const selectedCandidates = [...document.querySelectorAll('[data-e2e*="conversation" i], [class*="conversation" i]')]
    .filter(element => {
      const className = typeof element.className === 'string' ? element.className : '';
      return element.getAttribute('aria-selected') === 'true' || /(?:cur|active|selected)/i.test(className);
    }).slice(0, 20);
  for (const selected of selectedCandidates) {
    for (const name of ['data-conversation-id', 'data-conv-id', 'data-conversation', 'data-id']) addId(selected.getAttribute(name));
  }
  const header = document.querySelector('.RightPanelHeaderinfoContainer, [class*="RightPanelHeader" i], [data-e2e="chat-header"]');
  const title = header?.textContent?.trim() || '';
  const observedRows = [...document.querySelectorAll('.messageMessageBoxmessageBox')];
  const rawRowElements = [...new Set(observedRows.length ? observedRows : [...document.querySelectorAll('[data-e2e="message"], [data-e2e*="message-item" i], [data-testid="message"], [data-testid*="message-item" i]')])];
  // Several observed selectors match both a message container and nested
  // content wrappers. Keep only the outermost candidate for each message.
  const rowElements = rawRowElements.filter(row => !rawRowElements.some(other => other !== row && other.contains(row))).slice(0, 120);
  const listCandidates = [
    document.querySelector('.messageMessageListlist'),
    document.querySelector('[data-e2e="message-list"]'),
    document.querySelector('[class*="messageMessageList" i]'),
    document.querySelector('[data-testid*="message-list" i]')
  ].filter(Boolean);
  let list = listCandidates[0];
  const scrollCandidates = [...document.querySelectorAll('*')].filter(element => {
    if (element === document.body || element === document.documentElement) return false;
    const className = typeof element.className === 'string' ? element.className : '';
    const style = getComputedStyle(element);
    return element.scrollHeight > element.clientHeight + 20 && /auto|scroll|overlay/i.test(style.overflowY) && /message|chat|conversation|list|scroll|panel/i.test(className);
  });
  if (!list) list = scrollCandidates.find(candidate => rowElements.some(row => candidate.contains(row))) || scrollCandidates[0];
  if (!list && rowElements[0]) {
    let parent = rowElements[0].parentElement;
    while (parent) {
      if (parent.scrollHeight > parent.clientHeight + 20 && /(message|list|conversation)/i.test(String(parent.className))) { list = parent; break; }
      parent = parent.parentElement;
    }
  }
  const rows = rowElements.map(row => {
    const text = row.querySelector('.TextMessageTextpureText, [class*="TextMessageText" i], [data-e2e*="message-text" i], [data-testid*="message-text" i]')?.textContent?.trim() || '';
    const timeLike = value => /(?:[0-9]{1,2}\s*[:：]\s*[0-9]{2}|[0-9]{1,4}\s*[年/月日-]\s*[0-9]{1,2}|刚刚|昨天|前天|今天|周[一二三四五六日天])/.test(value);
    const timeCandidates = [];
    const timeElements = [row, ...row.querySelectorAll('time, [datetime], [data-time], [data-timestamp], .MessageBoxTimetimeLayout, [class*="Time" i]')];
    for (const element of timeElements) {
      // A chat body/card's title may itself contain a date. Only read title
      // and aria-label on an actual time element, not every descendant.
      const isTimeElement = element !== row && (element.tagName === 'TIME' || /time/i.test(String(element.className)) || element.hasAttribute('datetime'));
      for (const name of isTimeElement ? ['datetime', 'title', 'aria-label', 'data-time', 'data-timestamp'] : ['datetime', 'data-time', 'data-timestamp']) {
        const value = element.getAttribute?.(name)?.trim();
        if (value && timeLike(value)) timeCandidates.push(value);
      }
      const className = typeof element.className === 'string' ? element.className : '';
      if (/time/i.test(className)) {
        const value = element.textContent?.trim();
        if (value && timeLike(value)) timeCandidates.push(value);
      }
    }
    const timeLabels = [...new Set(timeCandidates)];
    const timeAssociation = timeLabels.length === 1 ? 'row' : timeLabels.length > 1 ? 'ambiguous' : 'none';
    const timeLabel = timeLabels.length === 1 ? timeLabels[0] : '';
    const className = typeof row.className === 'string' ? row.className : '';
    const markers = [];
    if (row.querySelector('img, [class*="Image"], [class*="image"]')) markers.push('image');
    if (row.querySelector('audio, [class*="Voice"], [class*="voice"], [data-e2e*="voice"]')) markers.push('voice');
    if (row.querySelector('video, [class*="Video"], [class*="video"]')) markers.push('video');
    if (row.querySelector('[class*="Emoji"], [class*="emoji"], [class*="Sticker"], [class*="sticker"]')) markers.push('emoji');
    const messageKey = ['data-message-id', 'data-msg-id', 'data-messageid']
      .map(name => row.getAttribute(name)?.trim() || '')
      .find(value => value) || null;
    const content = row.querySelector('.messageMessageBoxcontentBox');
    return { text, timeLabel, timeLabels, timeAssociation, messageKey, markers: [...new Set(markers)], fromMe: /isFromMe/i.test(className) || Boolean(content?.classList.contains('messageMessageBoxisFromMe')), sideKnown: Boolean(content) || /isFromMe/i.test(className) };
  });
  const timeLabelShapeCounts = {};
  for (const label of rows.map(row => row.timeLabel).filter(Boolean)) {
    const shape = [
      'len:' + Math.min(label.length, 32),
      'digits:' + Math.min((label.match(/[0-9]/g) || []).length, 8),
      'clock:' + /[0-9]{1,2}:[0-9]{2}/.test(label),
      'calendar:' + /年|月|日|[0-9]{1,2}[-/][0-9]{1,2}/.test(label),
      'relative:' + /刚刚|昨天|前天|今天|周[一二三四五六日天]/.test(label)
    ].join(',');
    timeLabelShapeCounts[shape] = (timeLabelShapeCounts[shape] || 0) + 1;
  }
  return {
    capturedAt: new Date().toISOString(),
    origin: location.origin,
    pathname: location.pathname,
    selectedConversationIds: [...ids],
    selectedTitle: title,
    messageList: { found: Boolean(list), scrollTop: list?.scrollTop ?? null, scrollHeight: list?.scrollHeight ?? null, clientHeight: list?.clientHeight ?? null, rowCount: rows.length },
    rows,
    ui: {
      frameOrigin: location.origin,
      framePathname: location.pathname,
      bodyElementCount: document.body?.querySelectorAll('*').length ?? 0,
      bodyTextLength: document.body?.innerText?.length ?? 0,
        selectedCandidateCount: selectedCandidates.length,
        messageRowCandidateCount: rowElements.length,
        textRowCount: rows.filter(row => row.text).length,
        timeLabelCount: rows.filter(row => row.timeAssociation === 'row').length,
        timeLabelShapeCounts,
        listCandidateCount: listCandidates.length,
      scrollCandidateCount: scrollCandidates.length,
      conversationStorePresent: Boolean(store),
      headerPresent: Boolean(header)
    }
  };
})()`;

async function readFrameState(frame: Frame): Promise<PageState> {
  const state = await frame.evaluate(PAGE_STATE_EVALUATOR) as Omit<PageState, 'selfUidCandidates'>;
  return { ...state, selfUidCandidates: [] };
}

function stateScore(state: PageState) {
  return (state.messageList.found ? 1_000_000 : 0) + state.rows.length * 100 + state.selectedConversationIds.length * 10 + (state.selectedTitle ? 1 : 0);
}

export async function readPageState(context: Page | Frame): Promise<PageState> {
  const frames = typeof (context as Page).frames === 'function' ? (context as Page).frames() : [context as Frame];
  const results = await Promise.all(frames.map(async frame => {
    try { return { state: await readFrameState(frame), error: null as string | null }; }
    catch (error) { return { state: null, error: error instanceof Error ? error.message : String(error) }; }
  }));
  const states = results.map(result => result.state).filter((state): state is PageState => state !== null);
  if (!states.length) {
    const summary = results.map(result => result.error).filter((error): error is string => Boolean(error)).slice(0, 3).join('|');
    throw new Error(`page-state-unreadable${summary ? `:${summary}` : ''}`);
  }
  return states.reduce((best, state) => stateScore(state) > stateScore(best) ? state : best);
}

export function sameMessageListPosition(left: PageState, right: PageState): boolean {
  return left.messageList.found && right.messageList.found &&
    left.messageList.scrollTop === right.messageList.scrollTop;
}
