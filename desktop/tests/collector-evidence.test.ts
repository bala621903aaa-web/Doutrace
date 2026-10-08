import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CollectorCursorEvidence, loadOrCreateCollectorEvidenceKey } from '../src/core/collector-evidence.js';

describe('collector cursor acceptance evidence', () => {
  it('persists one local HMAC key and records only bounded fingerprints and counters', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-collector-evidence-'));
    const keyPath = join(directory, 'acceptance', 'cursor.key');
    try {
      const key = await loadOrCreateCollectorEvidenceKey(keyPath);
      const reopenedKey = await loadOrCreateCollectorEvidenceKey(keyPath);
      expect(key).toHaveLength(32);
      expect(reopenedKey).toEqual(key);
      expect((await stat(keyPath)).size).toBe(32);

      const evidence = new CollectorCursorEvidence(key);
      const request = evidence.request({
        runId: 'private-run-id', accountId: 'private-account-id', conversationId: 'private-conversation-id', pageIndex: 1,
        checkpoint: { resumeRequested: true, state: 'partial', cursor: 'private-checkpoint-cursor' },
        inputCursor: 'private-checkpoint-cursor'
      });
      const committed = evidence.committed(request, {
        accountId: 'private-account-id', conversationId: 'private-conversation-id', outputCursor: 'private-next-cursor',
        pageMessageCount: 2, newMessageCount: 1, uniquePlatformMessageIdCount: 2, hasMore: true
      });
      expect(request).toMatchObject({ resumeRequested: true, checkpointCursorPresent: true, inputCursorPresent: true, inputMatchesCheckpoint: true });
      expect(committed).toMatchObject({ pageMessageCount: 2, newMessageCount: 1, uniquePlatformMessageIdCount: 2, identityValidated: true, checkpointCommitted: true });
      expect(committed.inputCursorFingerprint).toBe(committed.checkpointCursorFingerprint);
      const serialized = JSON.stringify({ request, committed });
      for (const privateValue of ['private-run-id', 'private-account-id', 'private-conversation-id', 'private-checkpoint-cursor', 'private-next-cursor']) {
        expect(serialized).not.toContain(privateValue);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
