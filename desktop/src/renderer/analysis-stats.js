const NO_CONTEXT = '请先在聊天档案中选择会话，点击「分析此会话」，再切换到总览。';
const LOADING = '正在统计此会话的全部已归档消息…';
const ZERO = '此会话暂无已归档消息。';
const FAILURE = '统计加载失败，请重试。';
const SCOPE = '统计范围：此会话当前已归档的全部消息；日期按上海时区。已归档不代表平台完整历史。';

function isOverviewSnapshot(snapshot) {
  return snapshot?.activeModule === 'analysis' && snapshot?.activeAnalysisTab === 'overview';
}

function samePair(left, right) {
  return !!left && !!right && left.accountId === right.accountId && left.conversationId === right.conversationId;
}

function isValidStatsDto(dto, pair) {
  return !!dto
    && typeof dto === 'object'
    && dto.scope === 'archived-conversation'
    && dto.timeZone === 'Asia/Shanghai'
    && samePair(dto, pair)
    && dto.stats
    && typeof dto.stats === 'object'
    && typeof dto.stats.totalMessages === 'number'
    && typeof dto.stats.distinctSenderCount === 'number'
    && typeof dto.stats.unknownTimestampCount === 'number'
    && typeof dto.stats.invalidTimestampCount === 'number'
    && typeof dto.stats.unknownSenderMessageCount === 'number';
}

export function createAnalysisStatsController({ api, documentRef = document, getShellSnapshot }) {
  const empty = documentRef.getElementById('analysis-tab-empty');
  const content = documentRef.getElementById('analysis-stats-content');
  const total = documentRef.getElementById('analysis-stats-total');
  const senders = documentRef.getElementById('analysis-stats-senders');
  const unknownTime = documentRef.getElementById('analysis-stats-unknown-time');
  const invalidTime = documentRef.getElementById('analysis-stats-invalid-time');
  const unknownSender = documentRef.getElementById('analysis-stats-unknown-sender');
  const scope = documentRef.getElementById('analysis-stats-scope');
  const pairLabel = documentRef.getElementById('analysis-stats-pair');
  const retry = documentRef.getElementById('analysis-stats-retry');

  if (!empty || !content || !total || !senders || !unknownTime || !invalidTime || !unknownSender || !scope || !pairLabel || !retry) {
    throw new Error('analysis-stats-markup-contract-invalid');
  }

  let requestGeneration = 0;
  let activePair = null;
  let loading = false;

  function fillMetrics(stats) {
    total.textContent = String(stats.totalMessages);
    senders.textContent = String(stats.distinctSenderCount);
    unknownTime.textContent = String(stats.unknownTimestampCount);
    invalidTime.textContent = String(stats.invalidTimestampCount);
    unknownSender.textContent = String(stats.unknownSenderMessageCount);
  }

  function showPairMeta(pair) {
    scope.textContent = SCOPE;
    pairLabel.textContent = `账号 ${pair.accountId} · 会话 ${pair.conversationId}`;
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
    fillMetrics({
      totalMessages: '—',
      distinctSenderCount: '—',
      unknownTimestampCount: '—',
      invalidTimestampCount: '—',
      unknownSenderMessageCount: '—'
    });
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
      if (!isOverviewSnapshot(snapshot) || !samePair(snapshot.analysisContext, activePair)) return;
      if (!isValidStatsDto(dto, activePair)) {
        loading = false;
        showFailure(activePair);
        return;
      }
      loading = false;
      showPairMeta(dto);
      fillMetrics(dto.stats);
      content.hidden = false;
      retry.hidden = true;
      if (dto.stats.totalMessages === 0) {
        empty.hidden = false;
        empty.textContent = ZERO;
        return;
      }
      empty.hidden = true;
    } catch {
      if (generation !== requestGeneration) return;
      const snapshot = getShellSnapshot();
      if (!isOverviewSnapshot(snapshot) || !samePair(snapshot.analysisContext, activePair)) return;
      loading = false;
      showFailure(activePair);
    }
  }

  function handleSnapshot(snapshot) {
    if (!isOverviewSnapshot(snapshot)) {
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
    if (!isOverviewSnapshot(snapshot) || !snapshot.analysisContext) {
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
