export const APP_MODULES = Object.freeze(['archive', 'analysis', 'media', 'reminders', 'settings']);
export const ANALYSIS_TABS = Object.freeze(['overview', 'interaction', 'journey', 'ai']);

const analysisTabLabels = Object.freeze({
  overview: '总览',
  interaction: '互动分析',
  journey: '聊天旅程',
  ai: 'AI 洞察'
});

const analysisTabStatus = Object.freeze({
  overview: '总览尚未接入真实归档统计。',
  interaction: '互动分析尚未接入真实归档统计。',
  journey: '聊天旅程尚未提供可追溯的归档事件。',
  ai: 'AI 洞察尚未提供真实分析服务，不会显示示例回答。'
});

function readStableAnalysisContext(context) {
  if (!context || typeof context !== 'object') return null;
  const accountId = context.accountId;
  const conversationId = context.conversationId;
  if (typeof accountId !== 'string' || accountId.trim() === '') return null;
  if (typeof conversationId !== 'string' || conversationId.trim() === '') return null;
  return { accountId, conversationId };
}

/** True when a snapshot can pin an analysis session. Nicknames are not IDs. */
export function isStableAnalysisContext(context) {
  return readStableAnalysisContext(context) !== null;
}

let mountedShell;

export function createAppShell({ documentRef = document, onBeforeLeave = () => {}, onAfterEnter = () => {} } = {}) {
  const navigationItems = [...documentRef.querySelectorAll('[data-route]')];
  const modules = [...documentRef.querySelectorAll('[data-module]')];
  const analysisTabs = [...documentRef.querySelectorAll('[data-analysis-tab]')];
  const analysisPanel = documentRef.getElementById('analysis-tab-panel');
  const analysisTitle = documentRef.getElementById('analysis-tab-title');
  const analysisStatus = documentRef.getElementById('analysis-tab-empty');

  if (navigationItems.length !== APP_MODULES.length ||
      APP_MODULES.some(module => !navigationItems.some(item => item.dataset.route === module)) ||
      modules.length !== APP_MODULES.length ||
      APP_MODULES.some(module => !modules.some(page => page.dataset.module === module)) ||
      analysisTabs.length !== ANALYSIS_TABS.length ||
      ANALYSIS_TABS.some(tab => !analysisTabs.some(item => item.dataset.analysisTab === tab)) ||
      !analysisPanel || !analysisTitle || !analysisStatus) {
    throw new Error('app-shell-markup-contract-invalid');
  }

  const analysisModule = modules.find(page => page.dataset.module === 'analysis');
  let activeModule = navigationItems.find(item => item.getAttribute('aria-current') === 'page')?.dataset.route ?? 'archive';
  let activeAnalysisTab = analysisTabs.find(item => item.getAttribute('aria-selected') === 'true')?.dataset.analysisTab ?? 'overview';
  let pinnedAnalysisContext = null;

  function publishAnalysisContext() {
    if (!analysisModule) return;
    if (!pinnedAnalysisContext) {
      delete analysisModule.dataset.analysisAccount;
      delete analysisModule.dataset.analysisConversation;
      return;
    }
    analysisModule.dataset.analysisAccount = pinnedAnalysisContext.accountId;
    analysisModule.dataset.analysisConversation = pinnedAnalysisContext.conversationId;
  }

  function pinAnalysisContext(context) {
    const stable = readStableAnalysisContext(context);
    if (!stable) return false;
    pinnedAnalysisContext = stable;
    publishAnalysisContext();
    return true;
  }

  function selectAnalysisTab(tab, moveFocus = false) {
    if (!ANALYSIS_TABS.includes(tab)) return false;
    activeAnalysisTab = tab;
    const label = analysisTabLabels[tab];
    for (const item of analysisTabs) {
      const selected = item.dataset.analysisTab === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      if (selected && moveFocus) item.focus();
    }
    analysisPanel.setAttribute('aria-labelledby', ['analysis-tab-', tab].join(''));
    analysisTitle.textContent = label;
    analysisStatus.textContent = analysisTabStatus[tab];
    return true;
  }

  function navigate(module) {
    if (!APP_MODULES.includes(module)) return false;
    if (module === activeModule) return true;

    const previousModule = activeModule;
    onBeforeLeave({ from: previousModule, to: module });
    activeModule = module;
    for (const page of modules) page.hidden = page.dataset.module !== module;
    for (const item of navigationItems) {
      if (item.dataset.route === module) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
    onAfterEnter({ from: previousModule, to: module });
    return true;
  }

  for (const item of navigationItems) {
    item.addEventListener('click', () => { navigate(item.dataset.route); });
  }
  for (const item of analysisTabs) {
    item.addEventListener('click', () => { selectAnalysisTab(item.dataset.analysisTab); });
    item.addEventListener('keydown', event => {
      const currentIndex = ANALYSIS_TABS.indexOf(item.dataset.analysisTab);
      const nextIndex = event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (currentIndex + 1) % ANALYSIS_TABS.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (currentIndex + ANALYSIS_TABS.length - 1) % ANALYSIS_TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? ANALYSIS_TABS.length - 1
              : -1;
      if (nextIndex < 0) return;
      event.preventDefault();
      selectAnalysisTab(ANALYSIS_TABS[nextIndex], true);
    });
  }

  selectAnalysisTab(activeAnalysisTab);
  return {
    navigate,
    selectAnalysisTab,
    pinAnalysisContext,
    getSnapshot() {
      return {
        activeModule,
        activeAnalysisTab,
        analysisContext: pinnedAnalysisContext
          ? { accountId: pinnedAnalysisContext.accountId, conversationId: pinnedAnalysisContext.conversationId }
          : null
      };
    }
  };
}

export function mountAppShell(options) {
  if (mountedShell) throw new Error('app-shell-already-mounted');
  mountedShell = createAppShell(options);
  return mountedShell;
}

/**
 * Stable navigation entry, including Archive to AI insights.
 * A provided analysisContext is copied only when it has stable accountId and
 * conversationId values. Omitting it keeps the previous module navigation.
 */
export function navigateAppShell(module, analysisTab, analysisContext) {
  if (!mountedShell) return false;
  const stableContext = analysisContext === undefined ? null : readStableAnalysisContext(analysisContext);
  if (analysisContext !== undefined && !stableContext) return false;
  if (analysisTab && !ANALYSIS_TABS.includes(analysisTab)) return false;
  if (!APP_MODULES.includes(module)) return false;
  if (stableContext) mountedShell.pinAnalysisContext(stableContext);
  if (analysisTab) mountedShell.selectAnalysisTab(analysisTab);
  return mountedShell.navigate(module);
}