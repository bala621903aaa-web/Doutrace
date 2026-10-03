import { describe, expect, it } from 'vitest';
import { redactUrl, summarizeJson, summarizeProtobuf } from '../src/probe/report.js';

describe('probe privacy and protocol summaries', () => {
  it('redacts query values while preserving parameter names', () => {
    expect(redactUrl('https://www.douyin.com/im/history?cursor=secret&token=credential')).toEqual({
      origin: 'https://www.douyin.com',
      pathname: '/im/history',
      queryKeys: ['cursor', 'token']
    });
  });

  it('keeps structural evidence without retaining message values', () => {
    const shape = summarizeJson({ data: { messages: [{ messageId: 'private-id', createTime: 1770000000000, text: 'private body' }], nextCursor: 'private-cursor' } });
    expect(shape.interestingPaths).toContain('$.data.messages');
    expect(shape.interestingPaths).toContain('$.data.nextCursor');
    expect(shape.scalarHints.some(item => item.path.endsWith('.text'))).toBe(false);
    expect(shape.scalarHints.some(item => item.path.endsWith('.messageId'))).toBe(true);
  });

  it('summarizes protobuf tags without retaining payload values', () => {
    const bytes = new Uint8Array([0x0a, 0x03, 0x66, 0x6f, 0x6f, 0x10, 0x96, 0x01]);
    const shape = summarizeProtobuf(bytes);
    expect(shape.parseStatus).toBe('parsed');
    expect(shape.fields.map(field => [field.fieldNumber, field.wireType])).toEqual([[1, 2], [2, 0]]);
    expect(JSON.stringify(shape)).not.toContain('foo');
  });
});
