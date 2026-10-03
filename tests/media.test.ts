import { describe, expect, it } from 'vitest';
import { decodeDataImage } from '../src/media';
describe('inline image attachments', () => {
  it('decodes page-embedded PNG bytes and rejects active SVG data', async () => {
    const blob = decodeDataImage('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    expect(blob.type).toBe('image/png');
    expect([...new Uint8Array(await blob.arrayBuffer()).slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => decodeDataImage('data:image/svg+xml;base64,PHN2Zz4=')).toThrow();
  });
});
