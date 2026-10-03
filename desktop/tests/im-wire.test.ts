import { describe, expect, it } from 'vitest';
import { decodeHistoryRequest, decodeHistoryResponse, updateHistoryRequest } from '../src/im/protocol.js';
import { bytesField, encodeWireFields, readWireFields, uint64Field } from '../src/im/wire.js';

describe('bounded IM wire reader and history protocol', () => {
  it('round-trips uint64 values without Number conversion', () => {
    const value = (1n << 63n) + 123_456_789n;
    const encoded = encodeWireFields([uint64Field(3, value)]);
    const decoded = readWireFields(encoded);
    expect(decoded[0].value).toBe(value);
  });

  it('updates only the pagination field while preserving unknown repeated fields', () => {
    const conversation = 'opaque-conversation';
    const originalCursor = 123_456_789_012_345n;
    const newCursor = (1n << 63n) + 11n;
    const query = encodeWireFields([
      bytesField(1, conversation),
      uint64Field(3, 7_600_000_000_000_000_123n),
      uint64Field(5, originalCursor),
      uint64Field(6, 50n),
      bytesField(15, 'unknown-a'),
      bytesField(15, 'unknown-b')
    ]);
    const request = encodeWireFields([
      uint64Field(1, 301n),
      uint64Field(2, 123n),
      bytesField(8, encodeWireFields([bytesField(301, query)])),
      bytesField(15, 'outer-unknown')
    ]);
    const updated = updateHistoryRequest(request, { cursor: newCursor });
    const decoded = decodeHistoryRequest(updated);
    expect(decoded.conversationId).toBe(conversation);
    expect(decoded.cursor).toBe(newCursor);
    const outer = readWireFields(updated);
    const body = readWireFields(outer.find(field => field.number === 8)!.value as Uint8Array);
    const updatedQuery = readWireFields(body.find(field => field.number === 301)!.value as Uint8Array);
    expect(updatedQuery.filter(field => field.number === 15)).toHaveLength(2);
    expect(updatedQuery.filter(field => field.number === 15).map(field => new TextDecoder().decode(field.value as Uint8Array))).toEqual(['unknown-a', 'unknown-b']);
  });

  it('distinguishes business errors, missing flags, and malformed wrappers', () => {
    const page = encodeWireFields([bytesField(301, new Uint8Array())]);
    const success = encodeWireFields([uint64Field(1, 301n), uint64Field(3, 0n), bytesField(6, page)]);
    expect(decodeHistoryResponse(success)).toMatchObject({ state: 'decoded', hasMore: null });

    const businessError = encodeWireFields([uint64Field(1, 301n), uint64Field(3, 4n)]);
    expect(decodeHistoryResponse(businessError)).toMatchObject({ state: 'server-error', statusCode: 4n });

    expect(() => decodeHistoryResponse(encodeWireFields([uint64Field(1, 301n), uint64Field(3, 0n)]))).toThrow('missing-field-6');
  });

  it('rejects truncated and duplicate singular fields before active use', () => {
    expect(() => readWireFields(new Uint8Array([0x0a, 0x02, 0x01]))).toThrow('truncated-bytes');
    expect(() => readWireFields(new Uint8Array([0x08, 0x80]))).toThrow('truncated-varint');
    const duplicate = encodeWireFields([uint64Field(1, 301n), uint64Field(1, 301n)]);
    expect(() => decodeHistoryRequest(duplicate)).toThrow('duplicate-singular-field');
  });
});
