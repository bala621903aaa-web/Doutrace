import { createCipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assessMediaRole, decodeMediaBytes, detectMediaFormat } from '../src/core/media-decoder.js';

function pngFixture(): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0], 16);
  bytes.set([0, 0, 0, 0], 29);
  bytes.set([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], 33);
  return bytes;
}

function mp4Fixture(brand = 'isom'): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand), 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]);
  return bytes;
}

function box(type: string, ...parts: Uint8Array[]) {
  const payload = joinBytes(...parts);
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length, false);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function joinBytes(...items: Uint8Array[]) {
  const result = new Uint8Array(items.reduce((length, item) => length + item.length, 0));
  let offset = 0;
  for (const item of items) { result.set(item, offset); offset += item.length; }
  return result;
}

function track(handler: 'soun' | 'vide' | 'meta' | null) {
  const hdlr = handler ? box('hdlr', joinBytes(new Uint8Array(8), new TextEncoder().encode(handler), new Uint8Array(13))) : null;
  const dref = new Uint8Array(8); new DataView(dref.buffer).setUint32(4, 1, false);
  const stsd = new Uint8Array(8); new DataView(stsd.buffer).setUint32(4, 1, false);
  const mediaHeader = box(handler === 'vide' ? 'vmhd' : 'smhd', new Uint8Array(handler === 'vide' ? 12 : 8));
  return box('trak', box('tkhd', new Uint8Array(84)), box('mdia', box('mdhd', new Uint8Array(24)), ...(hdlr ? [hdlr] : []),
    box('minf', mediaHeader, box('dinf', box('dref', dref)), box('stbl', box('stsd', stsd)))));
}

function mp4WithTracks(...handlers: Array<'soun' | 'vide' | 'meta' | null>) {
  return joinBytes(mp4Fixture(), box('moov', ...handlers.map(track)));
}

function encryptAesGcm(plain: Uint8Array, keyHex: string, iv = new Uint8Array(12).fill(3)) {
  const key = Buffer.from(keyHex, 'hex');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return new Uint8Array(Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]));
}

describe('media decoder', () => {
  it('identifies supported image and audio signatures from bytes', () => {
    expect(detectMediaFormat(pngFixture())).toMatchObject({ format: 'png', mime: 'image/png', family: 'image' });
    expect(detectMediaFormat(new Uint8Array([0xff, 0xd8, 0xff, 0, 0xff, 0xd9]))).toMatchObject({ format: 'jpeg', extension: 'jpg' });
    expect(detectMediaFormat(new Uint8Array([...new TextEncoder().encode('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b]))).toMatchObject({ format: 'gif', mime: 'image/gif' });

    const webp = new Uint8Array(16);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    new DataView(webp.buffer).setUint32(4, 8, true);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    expect(detectMediaFormat(webp)).toMatchObject({ format: 'webp', mime: 'image/webp' });
    expect(detectMediaFormat(new Uint8Array([...new TextEncoder().encode('ID3'), 0, 0, 0]))).toMatchObject({ format: 'mp3', family: 'audio' });
  });

  it('decrypts AES-256-GCM with a 12-byte IV and trailing 16-byte tag before format detection', () => {
    const key = 'ab'.repeat(32);
    const encrypted = encryptAesGcm(pngFixture(), key);
    const decoded = decodeMediaBytes(encrypted, key);
    expect(decoded.encrypted).toBe(true);
    expect(decoded.bytes).toEqual(pngFixture());
    expect(decoded.format).toMatchObject({ format: 'png', mime: 'image/png' });
    expect(assessMediaRole('image', decoded.format)).toBe('compatible');
  });

  it('rejects malformed keys, truncated ciphertext, wrong keys, and corrupted authentication tags', () => {
    const key = '11'.repeat(32);
    const encrypted = encryptAesGcm(pngFixture(), key);
    expect(() => decodeMediaBytes(encrypted, '1'.repeat(63))).toThrow('media-key-invalid');
    expect(() => decodeMediaBytes(new Uint8Array(27), key)).toThrow('media-ciphertext-truncated');
    expect(() => decodeMediaBytes(encrypted, '22'.repeat(32))).toThrow('media-authentication-failed');
    const corrupted = new Uint8Array(encrypted);
    corrupted[corrupted.length - 1] ^= 1;
    expect(() => decodeMediaBytes(corrupted, key)).toThrow('media-authentication-failed');
  });

  it('does not treat bytes as plaintext when a key is supplied', () => {
    expect(() => decodeMediaBytes(pngFixture(), '33'.repeat(32))).toThrow('media-authentication-failed');
    expect(() => decodeMediaBytes(pngFixture())).not.toThrow();
  });

  it('treats ftyp as an ambiguous MP4 container, not proof of an audio track', () => {
    const format = detectMediaFormat(mp4Fixture('M4A '));
    expect(format).toMatchObject({ format: 'mp4', mime: 'video/mp4', family: 'ambiguous-container' });
    expect(assessMediaRole('audio', format)).toBe('ambiguous');
    expect(assessMediaRole('video', format)).toBe('ambiguous');
  });

  it('uses bounded moov/trak/mdia/hdlr structure to classify audio, video, and mixed tracks', () => {
    expect(detectMediaFormat(mp4WithTracks('soun'))).toMatchObject({ format: 'mp4', mime: 'audio/mp4', extension: 'm4a', family: 'audio' });
    expect(assessMediaRole('audio', detectMediaFormat(mp4WithTracks('soun')))).toBe('compatible');
    expect(assessMediaRole('video', detectMediaFormat(mp4WithTracks('soun')))).toBe('mismatch');
    expect(detectMediaFormat(mp4WithTracks('vide'))).toMatchObject({ mime: 'video/mp4', family: 'video-container' });
    expect(detectMediaFormat(mp4WithTracks('soun', 'vide'))).toMatchObject({ mime: 'video/mp4', family: 'video-container' });
  });

  it('keeps missing tracks and media-like bytes outside hdlr ambiguous', () => {
    expect(detectMediaFormat(joinBytes(mp4Fixture(), box('moov'))).family).toBe('ambiguous-container');
    expect(detectMediaFormat(mp4WithTracks(null)).family).toBe('ambiguous-container');
    const fakeTrack = joinBytes(mp4Fixture(), box('mdat', new TextEncoder().encode('soun')), box('moov'));
    expect(detectMediaFormat(fakeTrack).family).toBe('ambiguous-container');
  });

  it('rejects truncated, out-of-bounds, and excessive MP4 box structures without scanning forever', () => {
    const truncated = joinBytes(mp4Fixture(), new Uint8Array([0, 0, 0, 40, ...new TextEncoder().encode('moov'), 0, 0, 0, 0]));
    expect(() => detectMediaFormat(truncated)).toThrow('media-container-invalid');
    const huge = joinBytes(mp4Fixture(), new Uint8Array([0xff, 0xff, 0xff, 0xf0, ...new TextEncoder().encode('moov')]));
    expect(() => detectMediaFormat(huge)).toThrow('media-container-invalid');
    const manyBoxes = joinBytes(mp4Fixture(), box('moov', ...Array.from({ length: 4_100 }, () => box('free'))));
    expect(() => detectMediaFormat(manyBoxes)).toThrow('media-container-invalid');
  });

  it('rejects truncated, unknown, and oversized media', () => {
    expect(() => detectMediaFormat(new Uint8Array([1, 2, 3]))).toThrow('media-truncated');
    expect(() => detectMediaFormat(new Uint8Array(32).fill(7))).toThrow('media-format-unrecognized');
    expect(() => detectMediaFormat(new Uint8Array(64 * 1024 * 1024 + 1))).toThrow('media-too-large');
  });
});
