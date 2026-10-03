import { describe, expect, it } from 'vitest';
import { mergeBatch, AmbiguousMergeError } from '../src/merge';
import type { CaptureBatch, Conversation, CapturedMessage } from '../src/types';
const msg = (id: string | undefined, text: string): CapturedMessage => ({ platformId: id, sender: '小王', senderId: 'u1', side: 'other', timestamp: '2025-01-01T00:00:00Z', timeText: '2025-01-01 08:00', kind: 'text', text, media: [] });
const conv = (): Conversation => ({ key: 'c1', title: '小王', messages: [], runs: [], warnings: [], updatedAt: '' });
const batch = (...messages: CapturedMessage[]): CaptureBatch => ({ conversationKey: 'c1', title: '小王', messages, historyEnd: false, warnings: [] });
describe('message merge', () => {
  it('keeps consecutive identical messages as separate occurrences', () => {
    let id = 0;
    const first = mergeBatch(conv(), batch(msg('1', '在吗'), msg('2', '在吗')), () => String(++id));
    expect(first.conversation.messages).toHaveLength(2);
    expect(first.conversation.messages[0].ref).not.toBe(first.conversation.messages[1].ref);
  });
  it('uses an overlapping batch to add older rows without duplicating the overlap', () => {
    const initial = mergeBatch(conv(), batch(msg('2', '中间'), msg('3', '较新')), () => crypto.randomUUID()).conversation;
    const next = mergeBatch(initial, batch(msg('1', '较早'), msg('2', '中间'), msg('3', '较新')));
    expect(next.added).toBe(1);
    expect(next.conversation.messages.map(m => m.platformId)).toEqual(['1', '2', '3']);
  });
  it('fails closed when a batch has no reliable overlap', () => {
    const initial = mergeBatch(conv(), batch(msg(undefined, '同一句'))).conversation;
    expect(() => mergeBatch(initial, batch(msg(undefined, '另一句')))).toThrow(AmbiguousMergeError);
  });
});
