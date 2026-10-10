import { createMessageView } from './message-view.js';

/**
 * Coordinates archive selection, message requests, search, filters, and paging.
 * The public methods are also the intended seam for a future renderer shell.
 */
export function createChatArchiveController({ api, state, $, esc, setStatus, render }) {
  let controller;
  const messageView = createMessageView({
    api,
    state,
    $,
    esc,
    setStatus,
    onReference: target => controller.jumpToReference(target),
    onRetry: attachmentId => retryAttachment(attachmentId)
  });

  function cancelPending() {
    clearTimeout(window.__searchTimer);
    return ++state.loadGeneration;
  }

  function selectConversation(accountId, conversationId) {
    cancelPending();
    state.selectedAccountId = accountId;
    state.selectedId = conversationId;
    state.offset = 0;
    state.loadedOffset = 0;
    state.loadedQuery = '';
    state.loadedMessages = [];
    state.loadedAttachments = [];
    $('filterCount').textContent = '当前已加载消息：0 条';
    messageView.pausePlayingMedia($('messages'));
    $('messages').innerHTML = '<div class="empty">正在加载当前会话消息…</div>';
    $('search').value = '';
    render();
    void loadMessages();
  }

  function renderConversations() {
    const items = state.context.conversations || [];
    $('conversations').innerHTML = items.length
      ? items.map(item => `<button class="conversation ${state.selectedId === item.conversationId && state.selectedAccountId === state.context.account?.accountId ? 'selected' : ''}" data-conversation="${esc(item.conversationId)}"><strong>${esc(item.title || '当前私聊')}</strong><small>浏览器中选定的私聊</small></button>`).join('')
      : '<div class="empty">在独立浏览器打开一个私聊后刷新。</div>';
    document.querySelectorAll('[data-conversation]').forEach(button => {
      button.addEventListener('click', () => selectConversation(state.context.account?.accountId, button.dataset.conversation));
    });
    const selected = items.find(item => item.conversationId === state.selectedId);
    $('selected').textContent = selected ? `已选：${selected.title || '当前私聊'}` : '请先选择当前浏览器中的会话';
  }

  function renderArchives() {
    const items = (state.context.archivedConversations || []).filter(item => item.messageCount > 0);
    if (!state.selectedId && items[0]) {
      state.selectedId = items[0].conversationId;
      state.selectedAccountId = items[0].accountId;
    }
    $('archives').innerHTML = items.length
      ? items.map(item => `<button class="conversation ${state.selectedId === item.conversationId && state.selectedAccountId === item.accountId ? 'selected' : ''}" data-archive="${esc(item.conversationId)}" data-account="${esc(item.accountId)}"><strong>${esc(item.title || '私聊档案')}</strong><small>${item.messageCount} 条消息</small></button>`).join('')
      : '<div class="empty">尚无本机档案。</div>';
    document.querySelectorAll('[data-archive]').forEach(button => {
      button.addEventListener('click', () => selectConversation(button.dataset.account, button.dataset.archive));
    });
    $('archiveTitle').textContent = items.length ? `离线档案（${items.length} 个会话）` : '离线档案';
  }

  function renderLists() {
    renderArchives();
    renderConversations();
  }

  function setFilters(filters = {}) {
    if (Object.hasOwn(filters, 'kind')) {
      state.filterKind = filters.kind || '';
      $('kindFilter').value = state.filterKind;
    }
    if (Object.hasOwn(filters, 'contentStatus')) {
      state.filterContentStatus = filters.contentStatus || '';
      $('contentStatusFilter').value = state.filterContentStatus;
    }
    messageView.applyFilters();
  }

  async function jumpToReference(target) {
    if (!target) return;
    let navigationGeneration = cancelPending();
    let message = state.loadedMessages.find(item => item.platformMessageId === target);
    if (!message) {
      $('search').value = target;
      state.offset = 0;
      const pending = loadMessages();
      navigationGeneration = state.loadGeneration;
      const loaded = await pending;
      if (navigationGeneration !== state.loadGeneration) return;
      if (!loaded) {
        if (loaded === false) setStatus('引用消息读取失败，请稍后重试。', true);
        return;
      }
      message = state.loadedMessages.find(item => item.platformMessageId === target);
    } else {
      $('search').value = state.loadedQuery;
      state.offset = state.loadedOffset;
    }
    if (!message) {
      setStatus('未找到引用消息，可能尚未保存。', true);
      return;
    }
    let changed = false;
    if (state.filterKind && state.filterKind !== message.kind) {
      state.filterKind = '';
      $('kindFilter').value = '';
      changed = true;
    }
    if (state.filterContentStatus && state.filterContentStatus !== message.contentStatus) {
      state.filterContentStatus = '';
      $('contentStatusFilter').value = '';
      changed = true;
    }
    if (changed) messageView.applyFilters();
    const row = [...$('messages').querySelectorAll('[data-message-pk]')]
      .find(item => item.dataset.messagePk === message.messagePk);
    if (!row || row.hidden) {
      setStatus('引用消息暂时无法显示，请重试。', true);
      return;
    }
    row.scrollIntoView?.({ block: 'center' });
    row.classList.add('target-message');
  }

  async function loadMessages() {
    const generation = ++state.loadGeneration;
    const accountId = state.selectedAccountId;
    if (!accountId || !state.selectedId) {
      state.loadedMessages = [];
      state.loadedAttachments = [];
      $('filterCount').textContent = '当前已加载消息：0 条';
      messageView.pausePlayingMedia($('messages'));
      $('messages').innerHTML = '<div class="empty">选择会话后查看消息。</div>';
      return false;
    }
    const query = $('search').value;
    const offset = state.offset;
    try {
      const [rows, allAttachments] = await Promise.all([
        api.getMessages({ accountId, conversationId: state.selectedId, query, limit: 500, offset }),
        api.getAttachments({ accountId, conversationId: state.selectedId })
      ]);
      const attachments = allAttachments.filter(item => item.assetState !== 'superseded');
      const visible = new Set(rows.map(row => row.messagePk));
      await Promise.all(attachments.filter(item => visible.has(item.messagePk)).map(async item => {
        if (item.status === 'saved') {
          const source = await api.getMediaUrl({ attachmentId: item.id });
          if (source) state.mediaSources.set(item.id, source);
          else state.mediaSources.delete(item.id);
        } else {
          state.mediaSources.delete(item.id);
        }
      }));
      if (generation !== state.loadGeneration) return null;
      state.loadedMessages = rows;
      state.loadedAttachments = attachments;
      state.loadedQuery = query;
      state.loadedOffset = offset;
      const saved = attachments.filter(item => item.status === 'saved').length;
      const pending = attachments.filter(item => item.status === 'pending').length;
      const failed = attachments.filter(item => item.status === 'failed' || item.status === 'unavailable').length;
      $('mediaStatus').textContent = attachments.length
        ? `附件：${saved}/${attachments.length} 已保存 · ${pending} 项处理中 · ${failed} 项失败或缺失；格式歧义会单独标明。`
        : '当前档案没有可保存附件。';
      messageView.renderMessages();
      $('previous').disabled = offset === 0;
      $('next').disabled = rows.length < 500;
      $('pageInfo').textContent = rows.length ? `显示第 ${offset + 1}～${offset + rows.length} 条` : '';
      return true;
    } catch (error) {
      if (generation !== state.loadGeneration) return null;
      state.loadedMessages = [];
      state.loadedAttachments = [];
      $('filterCount').textContent = '当前已加载消息：0 条';
      messageView.pausePlayingMedia($('messages'));
      $('messages').innerHTML = `<div class="empty">读取档案失败：${esc(error.message || error)}</div>`;
      return false;
    }
  }

  async function refreshConversations() {
    const generation = cancelPending();
    try {
      const context = await api.refreshContext();
      const app = await api.getState();
      if (generation !== state.loadGeneration) return;
      state.context = context;
      state.app = app;
      const current = context.conversations[0];
      if (current) {
        state.selectedId = current.conversationId;
        state.selectedAccountId = context.account.accountId;
        state.offset = 0;
      }
      render();
      await loadMessages();
    } catch (error) {
      if (generation === state.loadGeneration) setStatus(error.message || String(error), true);
    }
  }

  function searchMessages(query) {
    if (query !== undefined) $('search').value = query;
    state.offset = 0;
    const generation = cancelPending();
    window.__searchTimer = setTimeout(() => {
      if (generation === state.loadGeneration) void loadMessages();
    }, 220);
  }

  function retryAttachment(attachmentId) {
    state.busy = true;
    render();
    (async () => {
      try {
        if (!attachmentId) return;
        state.mediaSources.delete(attachmentId);
        await api.retryAttachment({ attachmentId });
        await loadMessages();
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        state.busy = false;
        render();
      }
    })();
  }

  async function handleContextEvent(context) {
    const generation = cancelPending();
    const app = await api.getState();
    if (generation !== state.loadGeneration) return;
    state.context = context;
    state.app = app;
    render();
    if (state.selectedId) void loadMessages();
  }

  function initialize() {
    const initialGeneration = state.loadGeneration;
    Promise.all([api.getState(), api.getContext()])
      .then(([appState, context]) => {
        if (initialGeneration !== state.loadGeneration) return;
        state.app = appState;
        state.context = context;
        render();
        void loadMessages();
      })
      .catch(error => {
        if (initialGeneration === state.loadGeneration) setStatus(error.message || String(error), true);
      });
  }

  $('kindFilter').addEventListener('change', event => setFilters({ kind: event.target.value }));
  $('contentStatusFilter').addEventListener('change', event => setFilters({ contentStatus: event.target.value }));
  $('clearFilters').addEventListener('click', () => setFilters({ kind: '', contentStatus: '' }));
  $('search').addEventListener('input', () => searchMessages());
  $('previous').addEventListener('click', () => {
    cancelPending();
    state.offset = Math.max(0, state.offset - 500);
    void loadMessages();
  });
  $('next').addEventListener('click', () => {
    cancelPending();
    state.offset += 500;
    void loadMessages();
  });

  controller = {
    selectConversation,
    refreshConversations,
    loadMessages,
    setFilters,
    searchMessages,
    cancelPending,
    jumpToReference,
    pausePlayingMedia: messageView.pausePlayingMedia,
    cleanupMedia: messageView.cleanupMedia,
    renderLists,
    initialize,
    handleContextEvent,
    getSnapshot() {
      return {
        accountId: state.selectedAccountId,
        conversationId: state.selectedId,
        query: state.loadedQuery,
        offset: state.loadedOffset,
        messages: [...state.loadedMessages],
        attachments: [...state.loadedAttachments],
        filters: { kind: state.filterKind, contentStatus: state.filterContentStatus }
      };
    }
  };
  return controller;
}
