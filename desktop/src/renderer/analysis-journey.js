const NO_CONTEXT = '请先在聊天档案中选择会话，点击「分析此会话」，再切换到聊天旅程。';
const LOADING = '正在统计此会话的全部已归档消息…';
const ZERO = '此会话暂无已归档消息。';
const FAILURE = '统计加载失败，请重试。';
const SCOPE = '统计范围：此会话当前已归档的全部消息；日期按上海时区。已归档不代表平台完整历史。';
const SPINE = '日级归档脊，不是逐条事件追溯';
const NO_DAYS = '没有可按上海时区归日的消息。';
const EVENTS = '逐条事件追溯尚未授权。本页不定位 messagePk，不跳转引用，也不提供火花提醒。';

function isJourneySnapshot(snapshot) {
  return snapshot?.activeModule === 'analysis' && snapshot?.activeAnalysisTab === 'journey';
}

function samePair(left, right) {
  return !!left && !!right && left.accountId === right.accountId && left.conversationId === right.conversationId;
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isValidJourneyDto(dto, pair) {
  if (!dto || typeof dto !== 'object' || dto.scope !== 'archived-conversation' || dto.timeZone !== 'Asia/Shanghai') return false;
  if (!samePair(dto, pair) || !dto.stats || typeof dto.stats !== 'object') return false;
  const stats = dto.stats;
  if (!isNonNegativeInteger(stats.totalMessages)) return false;
  if (!isNonNegativeInteger(stats.unknownTimestampCount)) return false;
  if (!isNonNegativeInteger(stats.invalidTimestampCount)) return false;
  if (!stats.dailyCounts || typeof stats.dailyCounts !== 'object' || Array.isArray(stats.dailyCounts)) return false;
  return Object.entries(stats.dailyCounts).every(([day, count]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && isNonNegativeInteger(count));
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function createAnalysisJourneyController({ api, documentRef = document, getShellSnapshot }) {
  const empty = documentRef.getElementById('analysis-tab-empty');
  const content = documentRef.getElementById('analysis-journey-content');
  const scope = documentRef.getElementById('analysis-journey-scope');
  const pairLabel = documentRef.getElementById('analysis-journey-pair');
  const spineNote = documentRef.getElementById('analysis-journey-spine-note');
  const total = documentRef.getElementById('analysis-journey-total');
  const unknownTime = documentRef.getElementById('analysis-journey-unknown-time');
  const invalidTime = documentRef.getElementById('analysis-journey-invalid-time');
  const days = documentRef.getElementById('analysis-journey-days');
  const eventsCopy = documentRef.getElementById('analysis-journey-events-copy');
  const retry = documentRef.getElementById('analysis-journey-retry');

  if (!empty || !content || !scope || !pairLabel || !spineNote || !total || !unknownTime || !invalidTime || !days || !eventsCopy || !retry) {
    throw new Error('analysis-journey-markup-contract-invalid');
  }

  spineNote.textContent = SPINE;
  eventsCopy.textContent = EVENTS;

  let requestGeneration = 0;
  let activePair = null;
  let loading = false;

  function showPairMeta(pair) {
    scope.textContent = SCOPE;
    pairLabel.textContent = `账号 ${pair.accountId} · 会话 ${pair.conversationId}`;
  }

  function fillNotes(stats) {
    total.textContent = String(stats.totalMessages);
    unknownTime.textContent = String(stats.unknownTimestampCount);
    invalidTime.textContent = String(stats.invalidTimestampCount);
  }

  function renderDays(dailyCounts) {
    clearChildren(days);
    const entries = Object.entries(dailyCounts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (entries.length === 0) {
      const item = documentRef.createElement('li');
      item.textContent = NO_DAYS;
      days.append(item);
      return;
    }
    for (const [day, count] of entries) {
      const item = documentRef.createElement('li');
      item.textContent = `${day} · ${count}`;
      days.append(item);
    }
  }

  function showEmptyOnly(text) {
    content.hidden = true;
    retry.hidden = true;
    empty.hidden = false;
    empty.textContent = text;
  }

  function showFailure(pair) {
    empty.hidden = false;
    empty.textContent = FAILURE;
    content.hidden = false;
    retry.hidden = false;
    showPairMeta(pair);
    fillNotes({
      totalMessages: '—',
      unknownTimestampCount: '—',
      invalidTimestampCount: '—'
    });
    clearChildren(days);
  }

  function invalidate() {
    requestGeneration += 1;
    activePair = null;
    loading = false;
  }

  async function loadForPair(pair) {
    const generation = ++requestGeneration;
    activePair = { accountId: pair.accountId, conversationId: pair.conversationId };
    loading = true;
    showEmptyOnly(LOADING);
    try {
      const dto = await api.getConversationStats({
        accountId: pair.accountId,
        conversationId: pair.conversationId
      });
      if (generation !== requestGeneration) return;
      const snapshot = getShellSnapshot();
      if (!isJourneySnapshot(snapshot) || !samePair(snapshot.analysisContext, activePair)) return;
      if (!isValidJourneyDto(dto, activePair)) {
        loading = false;
        showFailure(activePair);
        return;
      }
      loading = false;
      showPairMeta(dto);
      fillNotes(dto.stats);
      renderDays(dto.stats.dailyCounts);
      content.hidden = false;
      retry.hidden = true;
      const dayCount = Object.keys(dto.stats.dailyCounts).length;
      if (dto.stats.totalMessages === 0) {
        empty.hidden = false;
        empty.textContent = ZERO;
        return;
      }
      if (dayCount === 0) {
        empty.hidden = false;
        empty.textContent = NO_DAYS;
        return;
      }
      empty.hidden = true;
    } catch {
      if (generation !== requestGeneration) return;
      const snapshot = getShellSnapshot();
      if (!isJourneySnapshot(snapshot) || !samePair(snapshot.analysisContext, activePair)) return;
      loading = false;
      showFailure(activePair);
    }
  }

  function handleSnapshot(snapshot) {
    if (!isJourneySnapshot(snapshot)) {
      invalidate();
      content.hidden = true;
      retry.hidden = true;
      return;
    }
    const pair = snapshot.analysisContext;
    if (!pair) {
      invalidate();
      showEmptyOnly(NO_CONTEXT);
      return;
    }
    if (samePair(pair, activePair) && loading) return;
    void loadForPair(pair);
  }

  retry.addEventListener('click', () => {
    const snapshot = getShellSnapshot();
    if (!isJourneySnapshot(snapshot) || !snapshot.analysisContext) {
      showEmptyOnly(NO_CONTEXT);
      return;
    }
    void loadForPair(snapshot.analysisContext);
  });

  return {
    handleSnapshot,
    invalidate
  };
}
