const NO_CONTEXT = '请先在聊天档案中选择会话，点击「分析此会话」。检索、模型和持久化尚未授权，当前不会分析，也不会展示示例回答。';
const PINNED_EMPTY = '此会话已固定，但没有可用的 AI 服务。检索、模型和持久化尚未授权，当前不会分析，也不会展示示例回答。';
const CONTRACT = '检索、模型和持久化尚未授权。当前不会分析，也不会展示示例回答，也不会把归档正文或统计送出本机。';
const NO_PAIR_STATE = '尚未固定会话。请在聊天档案中点击「分析此会话」。';
const LIMITS = Object.freeze([
  '检索尚未授权，不会检索归档正文。',
  '模型尚未授权，不会调用模型，也不会展示示例回答。',
  '持久化尚未授权，不会保存分析历史或来源快照。'
]);

function isAiSnapshot(snapshot) {
  return snapshot?.activeModule === 'analysis' && snapshot?.activeAnalysisTab === 'ai';
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function createAnalysisAiController({ documentRef = document }) {
  const empty = documentRef.getElementById('analysis-tab-empty');
  const content = documentRef.getElementById('analysis-ai-content');
  const contract = documentRef.getElementById('analysis-ai-contract');
  const state = documentRef.getElementById('analysis-ai-state');
  const limits = documentRef.getElementById('analysis-ai-limits');

  if (!empty || !content || !contract || !state || !limits) {
    throw new Error('analysis-ai-markup-contract-invalid');
  }

  contract.textContent = CONTRACT;
  clearChildren(limits);
  for (const line of LIMITS) {
    const item = documentRef.createElement('li');
    item.textContent = line;
    limits.append(item);
  }

  function showHonestShell(snapshot) {
    const pair = snapshot.analysisContext;
    content.hidden = false;
    empty.hidden = false;
    if (!pair) {
      empty.textContent = NO_CONTEXT;
      state.textContent = NO_PAIR_STATE;
      return;
    }
    empty.textContent = PINNED_EMPTY;
    state.textContent = `已固定账号 ${pair.accountId} · 会话 ${pair.conversationId}。没有可用的 AI 服务，所以这里仍然是空状态。`;
  }

  function handleSnapshot(snapshot) {
    if (!isAiSnapshot(snapshot)) {
      content.hidden = true;
      return;
    }
    showHonestShell(snapshot);
  }

  return { handleSnapshot };
}
