import { createDecipheriv } from 'node:crypto';

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export type MediaFormatFamily = 'image' | 'audio' | 'video-container' | 'ambiguous-container';

export interface DetectedMediaFormat {
  format: 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'avif' | 'mp4' | 'mp3' | 'aac' | 'wav' | 'ogg';
  mime: string;
  extension: string;
  family: MediaFormatFamily;
}

export interface DecodedMedia {
  bytes: Uint8Array;
  format: DetectedMediaFormat;
  encrypted: boolean;
}

export type MediaRoleAssessment = 'compatible' | 'ambiguous' | 'mismatch';

export function assessMediaRole(expected: 'image' | 'audio' | 'video' | 'poster' | 'emoji', format: DetectedMediaFormat): MediaRoleAssessment {
  if (format.family === 'ambiguous-container') return 'ambiguous';
  if (expected === 'audio') return format.family === 'audio' ? 'compatible' : 'mismatch';
  if (expected === 'video') return format.family === 'video-container' ? 'compatible' : 'mismatch';
  return format.family === 'image' ? 'compatible' : 'mismatch';
}

export class MediaDecodeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MediaDecodeError';
  }
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

interface Mp4Box { type: string; payloadStart: number; end: number }
const MP4_MAX_BOXES = 4_096;
const MP4_MAX_DEPTH = 8;
const MP4_MAX_TRACKS = 256;

function invalidMp4(): never { throw new MediaDecodeError('media-container-invalid'); }

function readMp4Box(bytes: Uint8Array, offset: number, parentEnd: number): Mp4Box {
  if (offset < 0 || parentEnd > bytes.length || offset + 8 > parentEnd) return invalidMp4();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(offset, false);
  const type = ascii(bytes, offset + 4, offset + 8);
  let headerSize = 8;
  let size: number;
  if (size32 === 1) {
    if (offset + 16 > parentEnd) return invalidMp4();
    const extended = view.getBigUint64(offset + 8, false);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return invalidMp4();
    size = Number(extended);
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  } else {
    size = size32;
  }
  if (size < headerSize || size > parentEnd - offset) return invalidMp4();
  return { type, payloadStart: offset + headerSize, end: offset + size };
}

function forEachMp4Box(bytes: Uint8Array, start: number, end: number, visit: (box: Mp4Box) => void, state: { count: number }, depth: number) {
  if (depth > MP4_MAX_DEPTH) return invalidMp4();
  let offset = start;
  while (offset < end) {
    if (++state.count > MP4_MAX_BOXES) return invalidMp4();
    const box = readMp4Box(bytes, offset, end);
    visit(box);
    if (box.end <= offset) return invalidMp4();
    offset = box.end;
  }
  if (offset !== end) return invalidMp4();
}

function mediaTracks(bytes: Uint8Array, moov: Mp4Box, state: { count: number }) {
  let audio = 0;
  let video = 0;
  let unknown = 0;
  let tracks = 0;
  forEachMp4Box(bytes, moov.payloadStart, moov.end, box => {
    if (box.type !== 'trak') return;
    if (++tracks > MP4_MAX_TRACKS) return invalidMp4();
    let trackHeaders = 0;
    let mediaDescriptions = 0;
    let handler: string | null = null;
    let mediaDescriptionComplete = false;
    forEachMp4Box(bytes, box.payloadStart, box.end, child => {
      if (child.type === 'tkhd') trackHeaders++;
      if (child.type !== 'mdia') return;
      if (++mediaDescriptions > 1) return invalidMp4();
      let mediaHeaders = 0;
      let handlers = 0;
      let mediaInfos = 0;
      let dataInfos = 0;
      let sampleTables = 0;
      let sampleHeaders: string[] = [];
      let hasDataReference = false;
      let hasSampleDescription = false;
      forEachMp4Box(bytes, child.payloadStart, child.end, mediaChild => {
        if (mediaChild.type === 'mdhd') {
          mediaHeaders++;
          const length = mediaChild.end - mediaChild.payloadStart;
          const version = bytes[mediaChild.payloadStart];
          if ((version === 0 && length < 24) || (version === 1 && length < 36) || (version !== 0 && version !== 1)) return invalidMp4();
        }
        if (mediaChild.type === 'hdlr') {
          if (++handlers > 1 || mediaChild.end - mediaChild.payloadStart < 12 || bytes[mediaChild.payloadStart] !== 0 ||
              bytes[mediaChild.payloadStart + 1] !== 0 || bytes[mediaChild.payloadStart + 2] !== 0 || bytes[mediaChild.payloadStart + 3] !== 0 ||
              new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(mediaChild.payloadStart + 4, false) !== 0) return invalidMp4();
          handler = ascii(bytes, mediaChild.payloadStart + 8, mediaChild.payloadStart + 12);
        }
        if (mediaChild.type !== 'minf') return;
        if (++mediaInfos > 1) return invalidMp4();
        forEachMp4Box(bytes, mediaChild.payloadStart, mediaChild.end, infoChild => {
          if (infoChild.type === 'smhd' || infoChild.type === 'vmhd') {
            if (sampleHeaders.length > 0) return invalidMp4();
            sampleHeaders.push(infoChild.type);
          }
          if (infoChild.type === 'dinf') {
            if (++dataInfos > 1) return invalidMp4();
            forEachMp4Box(bytes, infoChild.payloadStart, infoChild.end, dataChild => {
              if (dataChild.type === 'dref') {
                if (hasDataReference || dataChild.end - dataChild.payloadStart < 8) return invalidMp4();
                const entries = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(dataChild.payloadStart + 4, false);
                if (entries < 1) return invalidMp4();
                hasDataReference = true;
              }
            }, state, 5);
          }
          if (infoChild.type === 'stbl') {
            if (++sampleTables > 1) return invalidMp4();
            forEachMp4Box(bytes, infoChild.payloadStart, infoChild.end, sampleChild => {
              if (sampleChild.type === 'stsd') {
                if (hasSampleDescription || sampleChild.end - sampleChild.payloadStart < 8) return invalidMp4();
                const entries = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(sampleChild.payloadStart + 4, false);
                if (entries < 1) return invalidMp4();
                hasSampleDescription = true;
              }
            }, state, 5);
          }
        }, state, 4);
      }, state, 3);
      const matchingMediaHeader = handler === 'soun' ? sampleHeaders.includes('smhd') && !sampleHeaders.includes('vmhd')
        : handler === 'vide' ? sampleHeaders.includes('vmhd') && !sampleHeaders.includes('smhd') : false;
      mediaDescriptionComplete = mediaHeaders === 1 && handlers === 1 && mediaInfos === 1 && dataInfos === 1 &&
        sampleTables === 1 && hasDataReference && hasSampleDescription && matchingMediaHeader;
    }, state, 2);
    if (trackHeaders > 1) return invalidMp4();
    if (trackHeaders !== 1 || mediaDescriptions !== 1 || !mediaDescriptionComplete || !handler) unknown++;
    else if (handler === 'soun') audio++;
    else if (handler === 'vide') video++;
    else unknown++;
  }, state, 1);
  return { audio, video, unknown, tracks };
}

function detectMp4Family(bytes: Uint8Array): DetectedMediaFormat | null {
  if (bytes.length < 8 || ascii(bytes, 4, 8) !== 'ftyp') return null;
  const state = { count: 0 };
  let ftyp: Mp4Box | undefined;
  let moov: Mp4Box | undefined;
  forEachMp4Box(bytes, 0, bytes.length, box => {
    if (state.count === 1) {
      if (box.type !== 'ftyp') invalidMp4();
      ftyp = box;
    }
    if (box.type === 'ftyp' && ftyp !== box) invalidMp4();
    if (box.type === 'moov') {
      if (moov) invalidMp4();
      moov = box;
    }
  }, state, 0);
  const parsedFtyp = ftyp as Mp4Box | undefined;
  const parsedMoov = moov as Mp4Box | undefined;
  if (!parsedFtyp || parsedFtyp.end - parsedFtyp.payloadStart < 8 || (parsedFtyp.end - parsedFtyp.payloadStart - 8) % 4 !== 0) invalidMp4();
  const brands = [ascii(bytes, parsedFtyp.payloadStart, parsedFtyp.payloadStart + 4)];
  for (let offset = parsedFtyp.payloadStart + 8; offset < parsedFtyp.end; offset += 4) brands.push(ascii(bytes, offset, offset + 4));
  if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))) {
    return { format: 'heic', mime: 'image/heic', extension: 'heic', family: 'image' };
  }
  if (brands.some(brand => ['avif', 'avis'].includes(brand))) {
    return { format: 'avif', mime: 'image/avif', extension: 'avif', family: 'image' };
  }
  if (!parsedMoov) return { format: 'mp4', mime: 'video/mp4', extension: 'mp4', family: 'ambiguous-container' };
  const tracks = mediaTracks(bytes, parsedMoov, state);
  if (tracks.video > 0) return { format: 'mp4', mime: 'video/mp4', extension: 'mp4', family: 'video-container' };
  if (tracks.audio > 0 && tracks.unknown === 0) return { format: 'mp4', mime: 'audio/mp4', extension: 'm4a', family: 'audio' };
  return { format: 'mp4', mime: 'video/mp4', extension: 'mp4', family: 'ambiguous-container' };
}

export function detectMediaFormat(bytes: Uint8Array): DetectedMediaFormat {
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaDecodeError('media-too-large');
  if (bytes.length < 4) throw new MediaDecodeError('media-truncated');
  if (startsWith(bytes, [0xff, 0xd8, 0xff]) && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    return { format: 'jpeg', mime: 'image/jpeg', extension: 'jpg', family: 'image' };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && bytes.length >= 33 &&
      bytes[8] === 0 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 13 && ascii(bytes, 12, 16) === 'IHDR' &&
      ascii(bytes, bytes.length - 8, bytes.length - 4) === 'IEND') {
    return { format: 'png', mime: 'image/png', extension: 'png', family: 'image' };
  }
  if ((ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') && bytes.length >= 14 && bytes[bytes.length - 1] === 0x3b) {
    return { format: 'gif', mime: 'image/gif', extension: 'gif', family: 'image' };
  }
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    const riffLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (riffLength + 8 === bytes.length) return { format: 'webp', mime: 'image/webp', extension: 'webp', family: 'image' };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') {
    const riffLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (riffLength + 8 <= bytes.length) return { format: 'wav', mime: 'audio/wav', extension: 'wav', family: 'audio' };
  }
  if (ascii(bytes, 0, 4) === 'OggS') return { format: 'ogg', mime: 'audio/ogg', extension: 'ogg', family: 'audio' };
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)) {
    return { format: 'mp3', mime: 'audio/mpeg', extension: 'mp3', family: 'audio' };
  }
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return { format: 'aac', mime: 'audio/aac', extension: 'aac', family: 'audio' };
  }
  const mp4 = detectMp4Family(bytes);
  if (mp4) return mp4;
  throw new MediaDecodeError('media-format-unrecognized');
}

function decryptAes256Gcm(ciphertext: Uint8Array, skeyHex: string): Uint8Array {
  if (!/^[\da-f]{64}$/i.test(skeyHex)) throw new MediaDecodeError('media-key-invalid');
  if (ciphertext.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) throw new MediaDecodeError('media-ciphertext-truncated');
  const key = Buffer.from(skeyHex, 'hex');
  const iv = ciphertext.subarray(0, GCM_IV_BYTES);
  const tagStart = ciphertext.length - GCM_TAG_BYTES;
  const body = ciphertext.subarray(GCM_IV_BYTES, tagStart);
  const tag = ciphertext.subarray(tagStart);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    throw new MediaDecodeError('media-authentication-failed');
  } finally {
    key.fill(0);
  }
}

/** Decode an authenticated skey-protected resource, then identify its actual file format. */
export function decodeMediaBytes(input: Uint8Array, skeyHex?: string | null): DecodedMedia {
  if (!(input instanceof Uint8Array) || input.length === 0) throw new MediaDecodeError('media-empty');
  if (input.length > MAX_MEDIA_BYTES) throw new MediaDecodeError('media-too-large');
  const encrypted = skeyHex !== null && skeyHex !== undefined && skeyHex.length > 0;
  const bytes = encrypted ? decryptAes256Gcm(input, skeyHex!) : new Uint8Array(input);
  if (bytes.length > MAX_MEDIA_BYTES) throw new MediaDecodeError('media-too-large');
  const format = detectMediaFormat(bytes);
  return { bytes, format, encrypted };
}
