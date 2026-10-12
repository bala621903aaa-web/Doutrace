const NO_CONTEXT = '请先在聊天档案中选择会话，点击「分析此会话」，再切换到互动分析。';
const LOADING = '正在统计此会话的全部已归档消息…';
const ZERO = '此会话暂无已归档消息。';
const FAILURE = '统计加载失败，请重试。';
const SCOPE = '统计范围：此会话当前已归档的全部消息；日期按上海时区。已归档不代表平台完整历史。';
const BUCKET_NOTE = '发送者数字是统计桶，不是双方身份。有 senderId 时按 senderId 分桶；缺少 senderId 时才回退到 senderName。该回退不能用来判断气泡左右或跨联系人。';
const GAP = '主动发起、回复间隔和中位数的口径尚未确定，本刀不做，不会展示示例数字。';
const NO_DAYS = '没有可按上海时区归日的消息。';
const NO_SENDERS = '没有发送者统计桶。';

const KIND_LABELS = Object.freeze([
  ['text', '文本'],
  ['image', '图片'],
  ['voice', '语音'],
  ['video-file', '视频文件'],
  ['video-share', '视频分享'],
  ['emoji', '表情'],
  ['system', '系统'],
  ['unknown', '未知']
]);

function isInteractionSnapshot(snapshot) {
  return snapshot?.activeModule === 'analysis' && snapshot?.activeAnalysisTab === 'interaction';
}

function samePair(left, right) {
  return !!left && !!right && left.accountId === right.accountId && left.conversationId === right.conversationId;
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isValidInteractionDto(dto, pair) {
  if (!dto || typeof dto !== 'object' || dto.scope !== 'archived-conversation' || dto.timeZone !== 'Asia/Shanghai') return false;
  if (!samePair(dto, pair) || !dto.stats || typeof dto.stats !== 'object') return false;
  const stats = dto.stats;
  if (!isNonNegativeInteger(stats.totalMessages)) return false;
  if (!stats.kindCounts || typeof stats.kindCounts !== 'object' || Array.isArray(stats.kindCounts)) return false;
  if (!KIND_LABELS.every(([kind]) => isNonNegativeInteger(stats.kindCounts[kind]))) return false;
  if (!stats.dailyCounts || typeof stats.dailyCounts !== 'object' || Array.isArray(stats.dailyCounts)) return false;
  if (!Object.entries(stats.dailyCounts).every(([day, count]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && isNonNegativeInteger(count))) return false;
  if (!Array.isArray(stats.senderCounts)) return false;
  return stats.senderCounts.every(bucket => bucket
    && typeof bucket === 'object'
    && isNullableString(bucket.senderId)
    && isNullableString(bucket.senderName)
    && isNonNegativeInteger(bucket.count));
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function createAnalysisInteractionController({ api, documentRef = document, getShellSnapshot }) {
  const empty = documentRef.getElementById('analysis-tab-empty');
  const content = documentRef.getElementById('analysis-interaction-content');
  const scope = documentRef.getElementById('analysis-interaction-scope');
  const pairLabel = documentRef.getElementById('analysis-interaction-pair');
  const bucketNote = documentRef.getElementById('analysis-interaction-bucket-note');
  const kinds = documentRef.getElementById('analysis-interaction-kinds');
  const days = documentRef.getElementById('analysis-interaction-days');
  const senders = documentRef.getElementById('analysis-interaction-senders');
  const gapCopy = documentRef.getElementById('analysis-interaction-gap-copy');
  const retry = documentRef.getElementById('analysis-interaction-retry');

  if (!empty || !content || !scope || !pairLabel || !bucketNote || !kinds || !days || !senders || !gapCopy || !retry) {
    throw new Error('analysis-interaction-markup-contract-invalid');
  }

  bucketNote.textContent = BUCKET_NOTE;
  gapCopy.textContent = GAP;

  let requestGeneration = 0;
  let activePair = null;
  let loading = false;

  function showPairMeta(pair) {
    scope.textContent = SCOPE;
    pairLabel.textContent = `账号 ${pair.accountId} · 会话 ${pair.conversationId}`;
  }

  function renderKinds(kindCounts) {
    clearChildren(kinds);
    for (const [kind, label] of KIND_LABELS) {
      const row = documentRef.createElement('div');
      const term = documentRef.createElement('dt');
      const value = documentRef.createElement('dd');
      term.textContent = label;
      value.dataset.kind = kind;
      value.textContent = String(kindCounts[kind]);
      row.append(term, value);
      kinds.append(row);
    }
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

  function renderSenders(senderCounts) {
    clearChildren(senders);
    if (senderCounts.length === 0) {
      const item = documentRef.createElement('li');
      item.textContent = NO_SENDERS;
      senders.append(item);
      return;
    }
    for (const bucket of senderCounts) {
      const senderId = typeof bucket.senderId === 'string' && bucket.senderId.trim() !== '' ? bucket.senderId : null;
      const senderName = typeof bucket.senderName === 'string' && bucket.senderName.trim() !== '' ? bucket.senderName : null;
      const basis = senderId !== null
        ? '分桶依据：senderId'
        : senderName !== null
          ? '分桶依据：senderName 回退（不是身份）'
          : '分桶依据：未知发送者';
      const item = documentRef.createElement('li');
      item.textContent = `统计桶 · senderId ${senderId ?? '无'} · 展示名 ${senderName ?? '无'} · ${bucket.count} 条 · ${basis}`;
      senders.append(item);
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
    clearChildren(kinds);
    clearChildren(days);
    clearChildren(senders);
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
      if (!isInteractionSnapshot(snapshot) || !samePair(snapshot.analysisContext, activePair)) return;
      if (!isValidInteractionDto(dto, activePair)) {
        loading = false;
        showFailure(activePair);
        return;
      }
      loading = false;
      showPairMeta(dto);
      renderKinds(dto.stats.kindCounts);
      renderDays(dto.stats.dailyCounts);
      renderSenders(dto.stats.senderCounts);
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
      if (!isInteractionSnapshot(snapshot) || !samePair(snapshot.analysisContext, activePair)) return;
      loading = false;
      showFailure(activePair);
    }
  }

  function handleSnapshot(snapshot) {
    if (!isInteractionSnapshot(snapshot)) {
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
    if (!isInteractionSnapshot(snapshot) || !snapshot.analysisContext) {
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
