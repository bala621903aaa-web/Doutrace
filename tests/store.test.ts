import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ArchiveStore } from '../src/store';
import type { Conversation } from '../src/types';
describe('local archive store', () => {
  it('persists interrupted runs and never stores temporary attachment URLs', async () => {
    const store = new ArchiveStore(`test-${crypto.randomUUID()}`);
    const c: Conversation = { key: 'one', title: '好友', messages: [], runs: [{ id: 'r', startedAt: '', mode: 'loaded', batches: 0, added: 0 }], warnings: [], updatedAt: '' };
    await store.save(c, [{ id: 'a', kind: 'image', quality: 'displayed', status: 'pending', attempts: 0, sourceUrl: 'data:image/png;base64,c2VjcmV0' }]);
    let value = await store.load('one');
    expect(value?.attachments[0]).not.toHaveProperty('sourceUrl');
    expect(JSON.stringify(value)).not.toContain('data:image/png');
    await store.recover();
    value = await store.load('one');
    expect(value?.conversation.runs[0].reason).toBe('interrupted');
    expect(value?.conversation.runs[0].finishedAt).toBeTruthy();
    await store.remove('one');
    expect(await store.load('one')).toBeUndefined();
  });
});
