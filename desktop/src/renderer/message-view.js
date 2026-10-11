/**
 * Message DOM and local media behavior for the archive renderer.
 *
 * This module deliberately receives the existing renderer state and DOM helpers:
 * it owns message presentation without introducing a second state store.
 */
export function createMessageView({ api, state, $, esc, setStatus, onReference, onRetry }) {
  const kindLabels = {
    text: '文字', image: '图片', voice: '语音', 'video-file': '视频', 'video-share': '视频分享',
    emoji: '表情', system: '系统消息', unknown: '未识别消息'
  };
  const contentLabels = {
    parsed: '内容已解析', partial: '部分解析', unknown: '内容未解析', 'legacy-missing': '旧记录待补修'
  };
  const attachmentErrors = {
    'media-authentication-failed': '解密认证失败', 'media-key-invalid': '解密密钥格式不正确',
    'media-format-unrecognized': '无法识别文件格式', 'media-role-mismatch': '实际格式与消息类别不符',
    'attachment-http-403': '资源拒绝访问或链接已过期', 'attachment-http-404': '平台资源已不存在',
    'attachment-download-failed': '下载失败，可重试', 'attachment-cancelled': '本次下载已取消',
    'resource-source-missing': '未取得可用资源地址', 'local-file-unavailable': '本机媒体文件缺失或损坏',
    'saved-media-missing': '本机媒体文件缺失', 'saved-media-unreadable': '本机媒体文件无法读取',
    'downloader-unavailable': '连接浏览器后可继续保存'
  };

  function mediaEvidenceLabel(source) {
    const evidence = source?.evidence || {};
    if (source?.family === 'image') {
      return evidence.imageDecoded
        ? `浏览器已解码 ${evidence.imageDecoded.naturalWidth}×${evidence.imageDecoded.naturalHeight}`
        : evidence.imageError
          ? `浏览器解码失败（${evidence.imageError.errorCode}）`
          : '签名已校验；浏览器图片解码待验';
    }
    if (source?.family === 'audio') {
      return evidence.audioEnded
        ? '播放已结束'
        : evidence.audioPlayback
          ? `播放已推进 ${evidence.audioPlayback.advancedSeconds.toFixed(2)} 秒`
          : evidence.audioMetadata
            ? `元数据已载入（${evidence.audioMetadata.durationSeconds.toFixed(2)} 秒）；播放待验`
            : evidence.audioError
              ? `浏览器音频错误（${evidence.audioError.errorCode}）`
              : '签名已校验；播放待验';
    }
    if (source?.family === 'ambiguous-container') return 'MP4 容器角色待确认；此结果不算语音播放验证';
    return `${source?.actualFormat || source?.mime || '媒体'}；浏览器播放待验`;
  }

  async function recordMediaEvidence(attachmentId, fileVersion, event) {
    const source = state.mediaSources.get(attachmentId);
    if (!source || source.fileVersion !== fileVersion) return null;
    try {
      const result = await api.recordMediaEvidence({ attachmentId, fileVersion, event });
      if (state.mediaSources.get(attachmentId)?.fileVersion !== fileVersion) return null;
      source.evidence = result.evidence;
      const label = document.querySelector(`[data-media-status="${CSS.escape(attachmentId)}"]`);
      if (label) label.textContent = mediaEvidenceLabel(source);
      return result;
    } catch (error) {
      if (error?.message === 'media-file-version-changed') return null;
      const label = document.querySelector(`[data-media-status="${CSS.escape(attachmentId)}"]`);
      if (label) label.textContent = `验收记录未写入：${error?.message || '本机文件状态已变化'}`;
      return null;
    }
  }

  function pausePlayingMedia(root = $('messages')) {
    root?.querySelectorAll('audio, video').forEach(media => {
      if (!media.paused) media.pause();
    });
  }

  function renderMessages() {
    const accountId = state.selectedAccountId;
    const attachments = state.loadedAttachments;
    const rows = state.loadedMessages;
    pausePlayingMedia($('messages'));
    $('messages').innerHTML = rows.length ? rows.map(message => {
      const relation = message.kind === 'system' || !accountId || !message.senderId
        ? 'neutral' : message.senderId === accountId ? 'outgoing' : 'incoming';
      const sender = relation === 'outgoing' ? '我' : message.senderName ||
        (relation === 'incoming' ? '对方' : '发送者未确认');
      const sentDate = new Date(message.sentAtMs);
      const timestamp = Number.isFinite(message.sentAtMs) && Number.isFinite(sentDate.getTime())
        ? sentDate.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '时间未知';
      const media = attachments.filter(item => item.messagePk === message.messagePk).map(item => {
        const source = state.mediaSources.get(item.id);
        const url = source?.url;
        const error = attachmentErrors[item.error] || '附件处理未完成';
        const retry = item.canRetry && state.app?.acquisitionEnabled
          ? `<button data-retry="${esc(item.id)}">重试附件</button>`
          : '';
        if (item.status !== 'saved' || !url) {
          return `<div class="attachment-row"><small>${item.status === 'pending' ? '附件正在保存' : item.status === 'unavailable' ? '附件不可用' : item.status === 'saved' ? '本机文件无法读取或校验' : '附件未保存'}${item.error ? `：${error}` : ''}</small>${retry}</div>`;
        }
        const label = esc(mediaEvidenceLabel(source));
        if (source.mime === 'image/heic') {
          return '<div class="attachment-row"><small>HEIC 原文件已保存；请导出 ZIP 后用支持 HEIC 的程序打开。</small></div>';
        }
        if (source.mime?.startsWith('image/')) {
          return `<div class="attachment-row"><img data-media-image="${esc(item.id)}" data-file-version="${esc(source.fileVersion)}" loading="lazy" src="${esc(url)}" alt="聊天图片"><small data-media-status="${esc(item.id)}">${label}</small></div>`;
        }
        if (source.mime?.startsWith('audio/')) {
          return `<div class="attachment-row"><audio data-media-audio="${esc(item.id)}" data-file-version="${esc(source.fileVersion)}" controls preload="none" src="${esc(url)}"></audio><small data-media-status="${esc(item.id)}">${label}</small></div>`;
        }
        return `<div class="attachment-row"><video controls preload="none" src="${esc(url)}"></video><small data-media-status="${esc(item.id)}">${label}</small></div>`;
      }).join('');
      const reference = message.replySnapshot
        ? `<button class="reference" ${message.replySnapshot.status === 'available' ? `data-reference="${esc(message.replyToPlatformMessageId)}"` : 'disabled'}><span class="reference__label">引用消息</span><span class="reference__text">${esc(message.replySnapshot.text || '目标消息尚未采集')}</span></button>`
        : '';
      return `<article class="message message--${relation}" data-sender-relation="${relation}" data-message-pk="${esc(message.messagePk)}" data-platform-id="${esc(message.platformMessageId)}"><span class="message-avatar" aria-hidden="true">${esc(Array.from(sender)[0] || '?')}</span><div class="message-content"><div class="message-head"><b>${esc(sender)}</b><time>${esc(timestamp)}</time></div><div class="message-bubble">${reference}<div class="message-body">${esc(message.text || `[${kindLabels[message.kind] || '消息'}]`)}</div><div class="media">${media}</div><small class="message-badge">${esc(kindLabels[message.kind] || '消息')} · ${esc(contentLabels[message.contentStatus] || '内容状态未知')}</small></div></div></article>`;
    }).join('') + '<div class="empty" id="filterEmpty" hidden>当前已加载消息中没有符合筛选条件的结果，请调整或清除筛选。</div>'
      : '<div class="empty">当前页没有消息。</div>';

    document.querySelectorAll('[data-media-image]').forEach(image => {
      const attachmentId = image.dataset.mediaImage;
      const fileVersion = image.dataset.fileVersion;
      const submitLoaded = () => {
        if (!image.isConnected || image.naturalWidth < 1 || image.naturalHeight < 1 ||
          image.dataset.submittedLoadVersion === fileVersion ||
          state.mediaSources.get(attachmentId)?.fileVersion !== fileVersion) return;
        image.dataset.submittedLoadVersion = fileVersion;
        void recordMediaEvidence(attachmentId, fileVersion, {
          type: 'image-decoded', naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight
        });
      };
      image.addEventListener('load', submitLoaded, { once: true });
      image.addEventListener('error', () => {
        if (image.isConnected && image.dataset.submittedErrorVersion !== fileVersion &&
          state.mediaSources.get(attachmentId)?.fileVersion === fileVersion) {
          image.dataset.submittedErrorVersion = fileVersion;
          void recordMediaEvidence(attachmentId, fileVersion, { type: 'image-error', errorCode: 4 });
        }
      }, { once: true });
      if (image.complete) queueMicrotask(submitLoaded);
    });

    document.querySelectorAll('[data-media-audio]').forEach(audio => {
      const attachmentId = audio.dataset.mediaAudio;
      const fileVersion = audio.dataset.fileVersion;
      let playStartedAt = null;
      let playbackWrite = null;
      let metadataWritten = false;
      let errorWritten = false;
      audio.addEventListener('loadedmetadata', () => {
        if (metadataWritten || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
        metadataWritten = true;
        void recordMediaEvidence(attachmentId, fileVersion, { type: 'audio-metadata', durationSeconds: audio.duration });
      }, { once: true });
      audio.addEventListener('play', () => { playStartedAt = audio.currentTime; });
      audio.addEventListener('timeupdate', () => {
        if (playbackWrite || playStartedAt === null) return;
        const advancedSeconds = audio.currentTime - playStartedAt;
        if (advancedSeconds >= 0.25) {
          playbackWrite = recordMediaEvidence(attachmentId, fileVersion, { type: 'audio-playback', advancedSeconds });
        }
      });
      audio.addEventListener('ended', async () => {
        if (playbackWrite) await playbackWrite;
        if (state.mediaSources.get(attachmentId)?.evidence?.audioPlayback) {
          await recordMediaEvidence(attachmentId, fileVersion, { type: 'audio-ended' });
        }
      });
      audio.addEventListener('error', () => {
        const errorCode = audio.error?.code;
        if (!errorWritten && Number.isSafeInteger(errorCode) && errorCode >= 1 && errorCode <= 4) {
          errorWritten = true;
          void recordMediaEvidence(attachmentId, fileVersion, { type: 'audio-error', errorCode });
        }
      }, { once: true });
    });

    document.querySelectorAll('[data-reference]').forEach(button => {
      button.addEventListener('click', () => { void onReference(button.dataset.reference); });
    });
    document.querySelectorAll('[data-retry]').forEach(button => {
      button.addEventListener('click', () => { void onRetry(button.dataset.retry); });
    });
    applyFilters();
  }

  function applyFilters() {
    const visible = new Set(state.loadedMessages
      .filter(message => (!state.filterKind || message.kind === state.filterKind) &&
        (!state.filterContentStatus || message.contentStatus === state.filterContentStatus))
      .map(message => message.messagePk));
    $('messages').querySelectorAll('.message').forEach(row => {
      const hide = !visible.has(row.dataset.messagePk);
      if (hide && !row.hidden) pausePlayingMedia(row);
      row.hidden = hide;
    });
    const empty = $('filterEmpty');
    if (empty) empty.hidden = visible.size !== 0;
    $('filterCount').textContent = `当前已加载消息：筛选显示 ${visible.size} / ${state.loadedMessages.length} 条`;
  }

  function cleanupMedia() {
    const root = $('messages');
    pausePlayingMedia(root);
    root?.querySelectorAll('audio, video, img[data-media-image]').forEach(media => media.removeAttribute('src'));
    state.mediaSources.clear();
  }

  return { renderMessages, applyFilters, pausePlayingMedia, cleanupMedia };
}
