import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InternalMediaAssetDescription, InternalMediaCandidate, InternalMediaRole } from './contracts.js';
import { ArchiveDatabase, type BrowserMediaEvidence, type BrowserMediaEvidenceEvent, type InternalAttachmentRecord } from './archive-db.js';
import { assessMediaRole, decodeMediaBytes, MediaDecodeError } from './media-decoder.js';
import { isAllowedDouyinMediaUrl } from './media-url.js';

export interface AttachmentFetcher {
  downloadAttachment(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string }>;
}

export interface ResolvedBrowserMediaSource {
  path: string;
  fileVersion: string;
  mime: string;
  actualFormat: string;
  family: string;
  evidence: BrowserMediaEvidence;
}

const MAX_ATTEMPTS = 3;
const QUALITY_RANK: Record<InternalMediaCandidate['quality'], number> = { original: 0, large: 1, preview: 2, unknown: 3 };

function readAsset(row: InternalAttachmentRecord): InternalMediaAssetDescription | null {
  try {
    const value = JSON.parse(row.resourceJson) as Partial<InternalMediaAssetDescription>;
    if (value.resourceKey !== row.resourceKey || !['image', 'audio', 'video', 'poster', 'emoji'].includes(value.role ?? '') ||
        (value.skey !== null && value.skey !== undefined && typeof value.skey !== 'string') || !Array.isArray(value.candidates)) return null;
    const candidates = value.candidates.filter((item): item is InternalMediaCandidate => {
      if (!item || typeof item.url !== 'string' || typeof item.sourcePath !== 'string' ||
          !['original', 'large', 'preview', 'unknown'].includes(item.quality)) return false;
      return isAllowedDouyinMediaUrl(item.url);
    });
    return { resourceKey: value.resourceKey, role: value.role as InternalMediaRole, skey: value.skey ?? null, candidates };
  } catch { return null; }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof MediaDecodeError) return error.code;
  if (error instanceof Error) {
    const message = error.message;
    if (message === 'attachment-cancelled') return message;
    const http = message.match(/^attachment-http-(\d{3})$/);
    if (http) return `attachment-http-${http[1]}`;
    if (['attachment-url-not-allowed', 'adapter-closed'].includes(message)) return message;
  }
  return 'attachment-download-failed';
}

function roleFor(asset: InternalMediaAssetDescription) {
  return asset.role;
}

export class AttachmentService {
  private pending: Promise<void> = Promise.resolve();
  private readonly controller = new AbortController();

  constructor(private readonly database: ArchiveDatabase, private readonly mediaRoot: string, private readonly fetcher?: AttachmentFetcher) {}

  /** Queue already-committed media descriptors; restart recovery reads the same queue from SQLite. */
  wake(accountId?: string, conversationId?: string): Promise<void> {
    const next = this.pending.catch(() => undefined).then(async () => {
      if (this.controller.signal.aborted) return;
      await this.verifySaved(accountId, conversationId);
      const records = this.database.listRetryableAttachments(accountId, conversationId);
      for (const row of records) {
        if (this.controller.signal.aborted) return;
        await this.saveOne(row);
      }
    });
    this.pending = next;
    return next;
  }

  async retry(attachmentId: string) {
    if (!this.database.retryAttachment(attachmentId)) return false;
    await this.wake();
    return true;
  }

  whenIdle() { return this.pending; }

  async cancelAndWait() {
    this.controller.abort();
    await this.pending.catch(() => undefined);
  }

  async resolveBrowserMediaSource(attachmentId: string): Promise<ResolvedBrowserMediaSource> {
    const context = this.database.getAttachmentMediaContext(attachmentId);
    if (!context) throw new Error('saved-media-unavailable');
    let bytes: Uint8Array;
    try {
      const info = await stat(context.localPath);
      if (!info.isFile() || info.size <= 0 || info.size > 64 * 1024 * 1024) throw new Error('saved-media-missing');
      bytes = new Uint8Array(await readFile(context.localPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error('saved-media-missing');
      throw error;
    }
    if (!bytes.byteLength || (context.size !== null && context.size !== bytes.byteLength)) throw new Error('attachment-size-mismatch');
    const decoded = decodeMediaBytes(bytes);
    const assessment = context.expectedRole === 'legacy' ? 'compatible' : assessMediaRole(context.expectedRole, decoded.format);
    if (assessment === 'mismatch') throw new Error('media-role-mismatch');
    const fileVersion = createHash('sha256').update(bytes).digest('hex');
    return {
      path: context.localPath, fileVersion, mime: decoded.format.mime, actualFormat: decoded.format.format,
      family: decoded.format.family,
      evidence: this.database.getBrowserMediaEvidence(attachmentId, fileVersion)
    };
  }

  async recordBrowserMediaEvent(input: { attachmentId: string; fileVersion: string; event: BrowserMediaEvidenceEvent }) {
    if (!/^[\da-f]{64}$/.test(input.fileVersion)) throw new Error('media-file-version-invalid');
    const source = await this.resolveBrowserMediaSource(input.attachmentId);
    if (source.fileVersion !== input.fileVersion) throw new Error('media-file-version-changed');
    if (input.event.type.startsWith('image-') && source.family !== 'image') throw new Error('media-event-role-mismatch');
    if (input.event.type.startsWith('audio-') && source.family !== 'audio') throw new Error('media-event-role-mismatch');
    return this.database.recordBrowserMediaEvidence(input.attachmentId, input.fileVersion, input.event);
  }

  private async verifySaved(accountId?: string, conversationId?: string) {
    for (const row of this.database.listSavedAttachments(accountId, conversationId)) {
      if (this.controller.signal.aborted) return;
      const asset = readAsset(row);
      if (!asset || !row.localPath) continue;
      let bytes: Uint8Array;
      try {
        const info = await stat(row.localPath);
        if (!info.isFile() || info.size <= 0 || info.size > 64 * 1024 * 1024) throw new Error('saved-media-missing');
        bytes = new Uint8Array(await readFile(row.localPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error instanceof Error && error.message === 'saved-media-missing')) {
          this.database.updateAttachment({ attachmentId: row.id, status: 'pending', attempts: 0, error: 'saved-media-missing', localPath: null, size: null, mime: null, extension: null, validationStatus: 'unverified', actualFormat: null });
        } else {
          this.database.updateAttachment({ attachmentId: row.id, status: 'failed', attempts: row.attempts, error: 'saved-media-unreadable', validationStatus: 'invalid' });
        }
        continue;
      }

      try {
        let decoded;
        try { decoded = decodeMediaBytes(bytes); }
        catch (firstError) {
          if (!asset.skey) throw firstError;
          decoded = decodeMediaBytes(bytes, asset.skey);
        }
        const assessment = assessMediaRole(roleFor(asset), decoded.format);
        if (assessment === 'mismatch') {
          this.database.updateAttachment({ attachmentId: row.id, status: 'pending', attempts: 0, error: 'saved-media-role-mismatch', localPath: null, size: null, mime: null, extension: null, validationStatus: 'role-mismatch', actualFormat: decoded.format.format });
        } else {
          const fileVersion = createHash('sha256').update(bytes).digest('hex');
          const evidence = this.database.getBrowserMediaEvidence(row.id, fileVersion);
          const browserVerified = assessment === 'compatible' && (
            roleFor(asset) === 'image' || roleFor(asset) === 'poster' || roleFor(asset) === 'emoji'
              ? Boolean(evidence.imageDecoded)
              : roleFor(asset) === 'audio' ? Boolean(evidence.audioPlayback || evidence.audioEnded) : false
          );
          this.database.updateAttachment({ attachmentId: row.id, status: 'saved', attempts: row.attempts, error: null,
            localPath: row.localPath, size: bytes.byteLength, mime: decoded.format.mime, extension: decoded.format.extension,
            validationStatus: assessment === 'ambiguous' ? 'role-ambiguous' : browserVerified ? 'browser-verified' : 'signature-valid', actualFormat: decoded.format.format });
        }
      } catch (error) {
        this.database.updateAttachment({ attachmentId: row.id, status: 'pending', attempts: 0, error: safeErrorCode(error), localPath: null, size: null, mime: null, extension: null, validationStatus: 'invalid', actualFormat: null });
      }
    }
  }

  private async saveOne(row: InternalAttachmentRecord) {
    const asset = readAsset(row);
    if (!asset || asset.candidates.length === 0) {
      this.database.updateAttachment({ attachmentId: row.id, status: 'unavailable', attempts: row.attempts, error: 'resource-source-invalid', validationStatus: 'invalid' });
      return;
    }
    if (!this.fetcher) {
      this.database.updateAttachment({ attachmentId: row.id, status: 'pending', attempts: row.attempts, error: 'downloader-unavailable' });
      return;
    }

    const candidates = [...asset.candidates].sort((left, right) => QUALITY_RANK[left.quality] - QUALITY_RANK[right.quality]);
    let attempts = row.attempts;
    let lastCode = 'attachment-download-failed';
    let lastValidation: 'unverified' | 'invalid' | 'role-mismatch' = 'unverified';
    let lastFormat: string | null = null;
    for (const candidate of candidates) {
      if (attempts >= MAX_ATTEMPTS || this.controller.signal.aborted) break;
      try {
        const result = await this.fetcher.downloadAttachment(candidate.url, this.controller.signal);
        if (this.controller.signal.aborted) return;
        const decoded = decodeMediaBytes(result.bytes, asset.skey);
        const assessment = assessMediaRole(roleFor(asset), decoded.format);
        if (assessment === 'mismatch') {
          attempts++;
          lastCode = 'media-role-mismatch';
          lastValidation = 'role-mismatch';
          lastFormat = decoded.format.format;
          this.database.updateAttachment({ attachmentId: row.id, status: 'failed', attempts, quality: candidate.quality, error: lastCode,
            mime: decoded.format.mime, extension: decoded.format.extension, size: decoded.bytes.byteLength,
            validationStatus: lastValidation, actualFormat: lastFormat });
          continue;
        }
        const localPath = await this.writeVerified(row.id, decoded.bytes, decoded.format.extension, asset.skey);
        attempts++;
        this.database.updateAttachment({ attachmentId: row.id, status: 'saved', attempts, quality: candidate.quality, mime: decoded.format.mime,
          extension: decoded.format.extension, localPath, size: decoded.bytes.byteLength, error: null,
          validationStatus: assessment === 'ambiguous' ? 'role-ambiguous' : 'signature-valid', actualFormat: decoded.format.format });
        return;
      } catch (error) {
        if (this.controller.signal.aborted || safeErrorCode(error) === 'attachment-cancelled') return;
        attempts++;
        lastCode = error instanceof Error && error.message === 'media-write-failed' ? error.message : safeErrorCode(error);
        lastValidation = error instanceof MediaDecodeError ? 'invalid' : 'unverified';
        lastFormat = null;
        this.database.updateAttachment({ attachmentId: row.id, status: 'failed', attempts, quality: candidate.quality, error: lastCode,
          validationStatus: lastValidation, actualFormat: lastFormat });
      }
    }
    if (attempts >= MAX_ATTEMPTS || candidates.length > 0) {
      this.database.updateAttachment({ attachmentId: row.id, status: 'failed', attempts, error: lastCode,
        validationStatus: lastValidation, actualFormat: lastFormat });
    }
  }

  private async writeVerified(id: string, bytes: Uint8Array, extension: string, skey: string | null) {
    const directory = join(this.mediaRoot, 'objects');
    await mkdir(directory, { recursive: true });
    const target = join(directory, `${id}.${extension}`);
    const temporary = join(directory, `${id}.${randomUUID()}.${extension}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      const written = new Uint8Array(await readFile(temporary));
      let verified;
      try { verified = decodeMediaBytes(written); }
      catch (firstError) {
        if (!skey) throw firstError;
        verified = decodeMediaBytes(written, skey);
      }
      if (verified.format.extension !== extension || verified.bytes.byteLength !== bytes.byteLength) throw new Error('media-write-failed');
      await rename(temporary, target);
      const result = await stat(target);
      if (!result.isFile() || result.size !== bytes.byteLength) throw new Error('media-write-failed');
      return target;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
