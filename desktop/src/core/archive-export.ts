import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { ArchiveDatabase, type ArchiveAttachmentRow, type ArchiveExportBundle, type ArchiveMessageRow } from './archive-db.js';
import type { InternalMediaRole } from './contracts.js';
import { assessMediaRole, decodeMediaBytes, MediaDecodeError } from './media-decoder.js';

interface ProcessedAttachment {
  zipPath: string | null;
  mime: string | null;
  extension: string | null;
  actualFormat: string | null;
  size: number | null;
  status: string;
  validationStatus: string;
  error: string | null;
  role: InternalMediaRole | 'legacy' | null;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const localId = (value: string) => `local-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;

function safeError(error: string | null) {
  if (!error) return null;
  return /^[a-z0-9-]{1,80}$/i.test(error) ? error : 'attachment-processing-failed';
}

function safeStopReason(reason: string | null) {
  const allowed = new Set(['history_end', 'page_limit', 'user_stop', 'missing_has_more', 'stalled', 'conversation_changed', 'interrupted', 'collector_error', 'capture_error']);
  return reason && allowed.has(reason) ? reason : reason ? 'other' : null;
}

function mapSegments(bundle: ArchiveExportBundle) {
  const segments = new Map<string, Array<ArchiveExportBundle['segments'][number]>>();
  for (const segment of bundle.segments) segments.set(segment.messagePk, [...(segments.get(segment.messagePk) ?? []), segment]);
  return segments;
}

function safeSnapshot(message: ArchiveMessageRow) {
  if (!message.replySnapshot) return null;
  return {
    status: message.replySnapshot.status,
    text: message.replySnapshot.text ?? null,
    kind: message.replySnapshot.kind ?? null,
    senderId: message.replySnapshot.senderId ?? null,
    senderName: message.replySnapshot.senderName ?? null
  };
}

function messageJson(bundle: ArchiveExportBundle, processed: Map<string, ProcessedAttachment>) {
  const segments = mapSegments(bundle);
  const references = new Map(bundle.references.map(reference => [reference.messagePk, reference]));
  const attachmentsByMessage = new Map<string, ArchiveAttachmentRow[]>();
  for (const attachment of bundle.attachments) attachmentsByMessage.set(attachment.messagePk, [...(attachmentsByMessage.get(attachment.messagePk) ?? []), attachment]);
  return bundle.messages.map(message => ({
    id: localId(message.messagePk),
    platformMessageId: message.platformMessageId ?? null,
    senderId: message.senderId ?? null,
    senderName: message.senderName ?? null,
    sentAtMs: message.sentAtMs,
    sentAtRaw: message.sentAtRaw ?? null,
    sentAtPrecision: message.sentAtPrecision,
    sequence: message.sequence ?? null,
    kind: message.kind,
    contentStatus: message.contentStatus ?? 'legacy-missing',
    contentStatusReason: message.contentStatusReason ?? null,
    text: message.text,
    segments: (segments.get(message.messagePk) ?? []).map(segment => ({ kind: segment.kind, text: segment.text, label: segment.label })),
    reference: references.has(message.messagePk) ? {
      targetMessageId: references.get(message.messagePk)?.targetMessageId ?? null,
      status: references.get(message.messagePk)?.status ?? 'unresolved',
      snapshot: safeSnapshot(message)
    } : null,
    attachments: (attachmentsByMessage.get(message.messagePk) ?? []).map(attachment => {
      const result = processed.get(attachment.id);
      return {
        id: localId(attachment.id),
        kind: attachment.kind,
        quality: attachment.quality,
        status: result?.status ?? attachment.status,
        attempts: attachment.attempts,
        mime: result?.mime ?? null,
        extension: result?.extension ?? null,
        actualFormat: result?.actualFormat ?? null,
        validationStatus: result?.validationStatus ?? attachment.validationStatus,
        assetState: attachment.assetState,
        size: result?.size ?? null,
        error: result?.error ?? safeError(attachment.error),
        path: result?.zipPath ?? null
      };
    })
  }));
}

function inferredLegacyRole(message: ArchiveMessageRow): InternalMediaRole | null {
  if (message.kind === 'image') return 'image';
  if (message.kind === 'voice') return 'audio';
  if (message.kind === 'video-file') return 'video';
  if (message.kind === 'emoji') return 'emoji';
  if (message.kind === 'video-share') return 'poster';
  return null;
}

function requiredRoles(message: ArchiveMessageRow): InternalMediaRole[] {
  if (message.kind === 'image') return ['image'];
  if (message.kind === 'voice') return ['audio'];
  if (message.kind === 'video-file') return ['video'];
  if (message.kind === 'emoji') return ['emoji'];
  return [];
}

function isOptionalRole(message: ArchiveMessageRow, role: InternalMediaRole | 'legacy' | null) {
  return role === 'poster' && (message.kind === 'video-share' || message.kind === 'video-file') ||
    role === 'legacy' && message.kind === 'video-share';
}

function offlineHtml(bundle: ArchiveExportBundle, processed: Map<string, ProcessedAttachment>, historyComplete: boolean, requiredMissingCount: number) {
  const targetById = new Map(bundle.messages.map(message => [message.platformMessageId, message]));
  const referenceByMessage = new Map(bundle.references.map(item => [item.messagePk, item]));
  const attachmentsByMessage = new Map<string, ArchiveAttachmentRow[]>();
  for (const attachment of bundle.attachments) {
    if (attachment.assetState === 'superseded') continue;
    attachmentsByMessage.set(attachment.messagePk, [...(attachmentsByMessage.get(attachment.messagePk) ?? []), attachment]);
  }
  const rows = bundle.messages.map(message => {
    const media = (attachmentsByMessage.get(message.messagePk) ?? []).map(attachment => {
      const result = processed.get(attachment.id);
      const path = result?.zipPath;
      if (!path) return `<span class="missing">附件${escapeHtml(result?.status === 'invalid' ? '校验失败' : '未保存')}：${escapeHtml(attachment.kind)}${result?.error ? `（${escapeHtml(result.error)}）` : ''}</span>`;
      if (result.mime === 'image/heic') return `<span class="missing">HEIC 图片原文件已保存；此页面不提供预览。<a href="${escapeHtml(path)}" download>下载原文件</a></span>`;
      if (result.mime?.startsWith('image/')) return `<img loading="lazy" src="${escapeHtml(path)}" alt="聊天图片">`;
      if (result.mime?.startsWith('audio/')) return `<audio controls preload="none" src="${escapeHtml(path)}"></audio><a href="${escapeHtml(path)}" download>下载语音</a>`;
      if (result.mime?.startsWith('video/')) return `<video controls preload="none" src="${escapeHtml(path)}"></video><a href="${escapeHtml(path)}" download>下载视频</a>`;
      return `<a href="${escapeHtml(path)}" download>下载附件（${escapeHtml(result.actualFormat ?? '已校验')}）</a>`;
    }).join('');
    const reference = referenceByMessage.get(message.messagePk);
    const target = reference?.targetMessageId ? targetById.get(reference.targetMessageId) : undefined;
    let ref = '';
    if (reference && target) ref = `<a class="reference" href="#${localId(target.messagePk)}">引用：${escapeHtml(target.text || '[非文本消息]')}</a>`;
    else if (reference) {
      const snapshot = safeSnapshot(message);
      ref = `<aside class="reference">引用目标未保存在此档案中${snapshot?.text ? `：${escapeHtml(snapshot.text)}` : ''}</aside>`;
    }
    const timestamp = message.sentAtMs === null ? '时间未知' : new Date(message.sentAtMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const kindLabels: Record<string, string> = { image: '图片', voice: '语音', 'video-file': '视频文件', 'video-share': '视频分享卡片', emoji: '表情', system: '系统消息', unknown: '未识别消息' };
    const body = message.text || `[${kindLabels[message.kind] ?? '消息'}]`;
    const sender = message.senderName ?? (message.senderId === bundle.account?.accountId ? '我' : '对方');
    return `<article id="${localId(message.messagePk)}" data-search="${escapeHtml(`${sender} ${body} ${message.platformMessageId ?? ''}`.toLocaleLowerCase())}"><header><b>${escapeHtml(sender)}</b><time>${escapeHtml(timestamp)}</time></header><div class="message-meta">${escapeHtml(kindLabels[message.kind] ?? '消息')} · ${escapeHtml(message.contentStatus ?? 'legacy-missing')}</div><p>${escapeHtml(body)}</p><div class="media">${media}</div>${ref}</article>`;
  }).join('\n');
  const saved = bundle.attachments.filter(attachment => attachment.assetState !== 'superseded' && processed.get(attachment.id)?.zipPath).length;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(bundle.conversation?.title ?? '抖音私聊档案')}</title><style>
body{margin:0;background:#f5f6f8;color:#20242a;font-family:system-ui,"Microsoft YaHei",sans-serif}main{max-width:960px;margin:0 auto;padding:24px}header.top{position:sticky;top:0;padding:16px 0;background:#f5f6f8ee;backdrop-filter:blur(8px);z-index:2}h1{margin:0 0 6px;font-size:22px}.meta{color:#68717c;font-size:13px}.warning{color:#8a5700}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d8dde4;border-radius:8px;margin-top:14px}article{background:#fff;border:1px solid #e1e5ea;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 4px 16px #20242a0d;scroll-margin-top:140px}article:target{outline:2px solid #155eef}article header{display:flex;justify-content:space-between;gap:16px;color:#59636f;font-size:13px}.message-meta{font-size:12px;color:#76808b;margin-top:8px}article p{white-space:pre-wrap;line-height:1.7;margin:10px 0}.media{display:flex;flex-wrap:wrap;gap:10px}.media img,.media video{max-width:360px;max-height:320px;border-radius:8px}.media audio{max-width:360px}.missing,.reference{display:block;color:#9b5b00;background:#fff7e6;border-radius:6px;padding:6px 8px;font-size:13px;margin-top:8px}.reference{color:#4d5c76;background:#eef4ff}</style></head><body><main><header class="top"><h1>${escapeHtml(bundle.conversation?.title ?? '抖音私聊档案')}</h1><div class="meta">${bundle.messages.length} 条消息；${historyComplete ? '已读到历史终点' : '部分历史'}；已保存媒体 ${saved} 个；必要媒体缺失 ${requiredMissingCount} 个</div><input id="search" placeholder="搜索发送者、正文或平台消息 ID"></header><section id="messages">${rows}</section></main><script>const input=document.querySelector('#search');const rows=[...document.querySelectorAll('article')];input.addEventListener('input',()=>{const q=input.value.trim().toLocaleLowerCase();for(const row of rows)row.hidden=Boolean(q&&!row.dataset.search.includes(q));});document.querySelectorAll('a.reference').forEach(link=>link.addEventListener('click',()=>{input.value='';for(const row of rows)row.hidden=false;}));</script></body></html>`;
}

export async function writeZipAtomically(outputPath: string, archiveBytes: Uint8Array, replace: (temporary: string, destination: string) => Promise<void> = rename) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = join(dirname(outputPath), `.${localId(outputPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, archiveBytes, { flag: 'wx' });
    const written = await stat(temporary);
    if (!written.isFile() || written.size !== archiveBytes.byteLength || written.size === 0) throw new Error('export-write-verification-failed');
    await replace(temporary, outputPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function exportConversation(database: ArchiveDatabase, accountId: string, conversationId: string, outputPath: string) {
  const bundle = database.getExportBundle(accountId, conversationId);
  if (!bundle.conversation) throw new Error('conversation-not-found');
  const files: Record<string, Uint8Array> = { 'media/': new Uint8Array() };
  const processed = new Map<string, ProcessedAttachment>();
  const messageByPk = new Map(bundle.messages.map(message => [message.messagePk, message]));
  const attachmentsByMessage = new Map<string, ArchiveAttachmentRow[]>();
  for (const attachment of bundle.attachments) attachmentsByMessage.set(attachment.messagePk, [...(attachmentsByMessage.get(attachment.messagePk) ?? []), attachment]);

  for (const attachment of bundle.attachments) {
    const message = messageByPk.get(attachment.messagePk);
    const declaredRole = bundle.attachmentRoles[attachment.id] ?? 'legacy';
    const role = declaredRole === 'legacy' && message ? inferredLegacyRole(message) ?? 'legacy' : declaredRole;
    const base: ProcessedAttachment = { zipPath: null, mime: null, extension: null, actualFormat: null, size: null,
      status: attachment.status, validationStatus: attachment.validationStatus, error: safeError(attachment.error), role };
    if (attachment.status !== 'saved' || !attachment.localPath) {
      base.status = attachment.status === 'saved' ? 'unavailable' : attachment.status;
      if (attachment.status === 'saved') base.error = 'local-file-unavailable';
      processed.set(attachment.id, base);
      continue;
    }
    try {
      const info = await stat(attachment.localPath);
      if (!info.isFile() || info.size <= 0 || info.size > 64 * 1024 * 1024) throw new Error('local-file-invalid');
      const bytes = new Uint8Array(await readFile(attachment.localPath));
      if (!bytes.length || bytes.byteLength !== info.size || (attachment.size !== null && attachment.size !== bytes.byteLength)) throw new Error('attachment-size-mismatch');
      const decoded = decodeMediaBytes(bytes);
      const assessment = role === 'legacy' ? 'compatible' : assessMediaRole(role, decoded.format);
      if (assessment === 'mismatch') throw new Error('media-role-mismatch');
      const fileVersion = createHash('sha256').update(bytes).digest('hex');
      const evidence = database.getBrowserMediaEvidence(attachment.id, fileVersion);
      const evidenceRole = role === 'legacy' ? decoded.format.family : role;
      const browserVerified = assessment === 'compatible' && (
        ['image', 'poster', 'emoji'].includes(evidenceRole) ? Boolean(evidence.imageDecoded)
          : evidenceRole === 'audio' ? Boolean(evidence.audioPlayback || evidence.audioEnded) : false
      );
      const exportPath = `media/${localId(attachment.id).slice(6)}.${decoded.format.extension}`;
      files[exportPath] = bytes;
      Object.assign(base, { zipPath: exportPath, mime: decoded.format.mime, extension: decoded.format.extension,
        actualFormat: decoded.format.format, size: bytes.byteLength,
        validationStatus: assessment === 'ambiguous' ? 'role-ambiguous' : browserVerified ? 'browser-verified' : 'signature-valid',
        error: null, status: 'saved' });
    } catch (error) {
      const roleMismatch = error instanceof Error && error.message === 'media-role-mismatch';
      const decodeInvalid = error instanceof MediaDecodeError;
      base.status = roleMismatch || decodeInvalid ? 'invalid' : 'unavailable';
      base.validationStatus = roleMismatch ? 'role-mismatch' : 'invalid';
      const code = (error as NodeJS.ErrnoException)?.code;
      base.error = error instanceof MediaDecodeError ? error.code
        : code === 'ENOENT' || error instanceof Error && ['local-file-invalid', 'attachment-size-mismatch'].includes(error.message) ? 'local-file-unavailable'
          : error instanceof Error && /^[a-z0-9-]{1,80}$/i.test(error.message) ? error.message : 'local-file-unavailable';
    }
    processed.set(attachment.id, base);
  }

  const requiredMissing: Array<{ messageId: string; role: string; status: string }> = [];
  const requiredAttachmentIds = new Set<string>();
  for (const message of bundle.messages) {
    const attached = attachmentsByMessage.get(message.messagePk) ?? [];
    for (const role of requiredRoles(message)) {
      const matches = attached.filter(attachment => attachment.assetState !== 'superseded' && (bundle.attachmentRoles[attachment.id] ?? 'legacy') === role ||
        attachment.assetState === 'legacy' && inferredLegacyRole(message) === role);
      if (!matches.length) requiredMissing.push({ messageId: localId(message.messagePk), role, status: 'asset-not-registered' });
      for (const attachment of matches) requiredAttachmentIds.add(attachment.id);
    }
    for (const attachment of attached) {
      if (attachment.assetState === 'superseded') continue;
      const role = bundle.attachmentRoles[attachment.id] ?? 'legacy';
      if (isOptionalRole(message, role)) continue;
      requiredAttachmentIds.add(attachment.id);
    }
  }
  for (const attachmentId of requiredAttachmentIds) {
    const result = processed.get(attachmentId);
    if (!result?.zipPath || result.validationStatus === 'invalid' || result.validationStatus === 'role-mismatch' || result.validationStatus === 'role-ambiguous') {
      const attachment = bundle.attachments.find(item => item.id === attachmentId)!;
      const message = messageByPk.get(attachment.messagePk)!;
      const role = result?.role && result.role !== 'legacy' ? result.role : inferredLegacyRole(message);
      requiredMissing.push({ messageId: localId(message.messagePk), role: role ?? 'unspecified', status: result?.error ?? result?.status ?? 'attachment-missing' });
    }
  }

  const contentStatusCounts = { parsed: 0, partial: 0, unknown: 0, 'legacy-missing': 0 };
  for (const message of bundle.messages) contentStatusCounts[message.contentStatus ?? 'legacy-missing']++;
  const checkpointRun = bundle.runs.find(run => run.runId === bundle.checkpoint?.runId);
  const historyComplete = bundle.checkpoint?.state === 'complete' && bundle.checkpoint.hasMore === false && checkpointRun?.state === 'complete' && checkpointRun.reason === 'history_end';
  const unknownMessageCount = bundle.messages.filter(message => message.kind === 'unknown').length;
  const incompleteContentCount = contentStatusCounts.partial + contentStatusCounts.unknown + contentStatusCounts['legacy-missing'];
  const activeAttachments = bundle.attachments.filter(attachment => attachment.assetState !== 'superseded');
  const supersededAttachments = bundle.attachments.filter(attachment => attachment.assetState === 'superseded');
  const heicWithoutInlinePreviewCount = activeAttachments.filter(attachment => processed.get(attachment.id)?.zipPath && processed.get(attachment.id)?.mime === 'image/heic').length;
  const missingAttachments = activeAttachments.filter(attachment => !processed.get(attachment.id)?.zipPath).map(attachment => {
    const result = processed.get(attachment.id);
    return { id: localId(attachment.id), kind: attachment.kind, status: result?.error === 'local-file-unavailable' ? 'local-file-unavailable' : result?.status ?? attachment.status,
      validationStatus: result?.validationStatus ?? attachment.validationStatus, quality: attachment.quality, error: result?.error ?? safeError(attachment.error) };
  });
  const attachmentStatusCounts: Record<string, number> = {};
  const supersededAttachmentStatusCounts: Record<string, number> = {};
  const validationCounts: Record<string, number> = {};
  const qualityCounts: Record<string, number> = {};
  for (const attachment of activeAttachments) {
    const result = processed.get(attachment.id)!;
    attachmentStatusCounts[result.status] = (attachmentStatusCounts[result.status] ?? 0) + 1;
    validationCounts[result.validationStatus] = (validationCounts[result.validationStatus] ?? 0) + 1;
    qualityCounts[attachment.quality] = (qualityCounts[attachment.quality] ?? 0) + 1;
  }
  for (const attachment of supersededAttachments) {
    const status = processed.get(attachment.id)!.status;
    supersededAttachmentStatusCounts[status] = (supersededAttachmentStatusCounts[status] ?? 0) + 1;
  }
  const report = {
    version: 3,
    exportedAt: new Date().toISOString(),
    account: { accountId, displayName: bundle.account?.displayName ?? null },
    conversation: { conversationId, title: bundle.conversation.title, participantIds: bundle.conversation.participantIds },
    messageCount: bundle.messages.length,
    runCount: bundle.runs.length,
    historyComplete,
    complete: historyComplete && incompleteContentCount === 0 && unknownMessageCount === 0 && requiredMissing.length === 0,
    scope: historyComplete ? '已验证本机采集检查点到达服务端历史终点；不代表平台已删除消息可恢复或未来消息持续同步。' : '本机档案为部分历史范围或尚未验证到服务端历史终点。',
    contentStatusCounts,
    unsupportedMessageCount: bundle.messages.filter(message => (message.contentStatus ?? 'legacy-missing') !== 'parsed' || message.kind === 'unknown').length,
    unknownKindCount: unknownMessageCount,
    attachmentCount: activeAttachments.length,
    savedMediaCount: activeAttachments.filter(attachment => processed.get(attachment.id)?.zipPath).length,
    heicWithoutInlinePreviewCount,
    attachmentStatusCounts,
    validationCounts,
    qualityCounts,
    supersededAttachmentCount: supersededAttachments.length,
    supersededSavedMediaCount: supersededAttachments.filter(attachment => processed.get(attachment.id)?.zipPath).length,
    supersededAttachmentStatusCounts,
    exportedMediaFileCount: [...processed.values()].filter(item => item.zipPath).length,
    requiredAssetMissingCount: requiredMissing.length,
    requiredAssetMissing: requiredMissing,
    checkpointState: bundle.checkpoint?.state ?? 'not-started',
    stopReasons: [...new Set(bundle.runs.map(run => safeStopReason(run.reason)).filter((reason): reason is string => Boolean(reason)))],
    missingAttachments,
    limitations: [
      ...(incompleteContentCount || unknownMessageCount ? ['部分消息类型或内容尚未完整解释。'] : []),
      ...(requiredMissing.length ? ['必要图片、语音或视频文件缺失、格式不符或容器角色无法确认。'] : []),
      ...(heicWithoutInlinePreviewCount ? ['HEIC 原文件已保存，但离线 HTML 不提供内嵌预览；需使用支持 HEIC 的程序打开。'] : []),
      '视频分享保留卡片与可取得的封面，不要求下载分享的视频整段。',
      'historyComplete 只描述当前本机档案的已验证采集范围，不代表平台历史永久完整。'
    ]
  };
  const exportMessages = messageJson(bundle, processed);
  files['messages.json'] = strToU8(JSON.stringify({
    account: report.account,
    conversation: report.conversation,
    messages: exportMessages
  }, null, 2));
  files['export-report.json'] = strToU8(JSON.stringify(report, null, 2));
  files['index.html'] = strToU8(offlineHtml(bundle, processed, historyComplete, requiredMissing.length));

  const archiveBytes = zipSync(files, { level: 6 });
  await writeZipAtomically(outputPath, archiveBytes);
  return { outputPath, report, fileCount: Object.keys(files).length, mediaCount: [...processed.values()].filter(item => item.zipPath).length };
}
