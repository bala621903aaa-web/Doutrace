import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { probeReportDirectory } from './browser.js';
import type { HistoryProtocolEvidence } from './im-protocol.js';

export interface RedactedUrl {
  origin: string;
  pathname: string;
  queryKeys: string[];
}

export interface ResponseObservation {
  observedAt: string;
  method: string;
  url: RedactedUrl;
  resourceType: string;
  status: number;
  contentType: string;
  bodyKind: 'json' | 'protobuf-or-binary' | 'text' | 'unreadable' | 'not-read';
  bodyBytes?: number;
  shape?: JsonShape;
  protobuf?: ProtobufShape;
}

export interface RequestObservation {
  observedAt: string;
  method: string;
  url: RedactedUrl;
  resourceType: string;
  contentType: string;
  bodyKind: 'json' | 'protobuf-or-binary' | 'text' | 'empty' | 'unreadable';
  bodyBytes?: number;
  shape?: JsonShape;
  protobuf?: ProtobufShape;
}

export interface ProtobufFieldShape {
  fieldNumber: number;
  wireType: number;
  occurrences: number;
  lengthBuckets?: string[];
  varintDigitCounts?: number[];
  nested?: ProtobufShape;
}

export interface ProtobufShape {
  byteLength: number;
  parseStatus: 'parsed' | 'partial' | 'invalid' | 'empty';
  fields: ProtobufFieldShape[];
}

export interface SdkObjectObservation {
  name: string;
  type: 'function' | 'object' | 'other' | 'accessor' | 'missing';
  functionArity?: number;
  ownKeys?: string[];
  nestedKeyTypes?: Record<string, string>;
  collectionCounts?: Record<string, number>;
  referencedEndpoints?: string[];
}

export interface JsonShape {
  root: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | 'unknown';
  arrayLength?: number;
  objectKeys?: string[];
  interestingPaths: string[];
  candidateArrays: Array<{ path: string; length: number; itemKeys: string[] }>;
  scalarHints: Array<{ path: string; type: string; length?: number; digits?: number; hash?: string }>;
}

export interface ProbeReport {
  reportVersion: 1 | 2;
  generatedAt: string;
  browser: { kind: string; executablePath: string };
  target: { origin: string; pathname: string };
  observations: {
    initial: PageSnapshot;
    selected: PageSnapshot;
    sdkGlobalCandidates: string[];
    sdkObjects: SdkObjectObservation[];
    requestCount: number;
    responseCount: number;
    pendingResponseCount?: number;
    relevantRequests: RequestObservation[];
    structuredResponses: ResponseObservation[];
    websocketUrls: RedactedUrl[];
    historyProtocol?: Array<{ observedAt: string; evidence: HistoryProtocolEvidence }>;
  };
  privacy: {
    note: string;
    omitted: string[];
  };
}

export interface PageSnapshot {
  capturedAt: string;
  origin: string;
  pathname: string;
  messageRowCount: number;
  scrollAreaCount: number;
  scrollPositions: Array<{ selector: string; top: number; height: number; viewport: number }>;
  sdkGlobalCandidates: string[];
}

export function redactUrl(raw: string): RedactedUrl {
  const url = new URL(raw);
  return { origin: url.origin, pathname: url.pathname, queryKeys: [...new Set([...url.searchParams.keys()])].sort() };
}

function scalarHint(value: unknown, path: string) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return { path, type: 'string', length: normalized.length, hash: createHash('sha256').update(normalized).digest('hex').slice(0, 12) };
  }
  if (typeof value === 'number') {
    return { path, type: Number.isInteger(value) ? 'integer' : 'number', digits: Number.isFinite(value) ? String(Math.trunc(Math.abs(value))).length : undefined };
  }
  if (typeof value === 'boolean') return { path, type: 'boolean' };
  if (value === null) return { path, type: 'null' };
  return undefined;
}

export function summarizeJson(value: unknown, maxNodes = 900): JsonShape {
  const interestingPaths: string[] = [];
  const candidateArrays: Array<{ path: string; length: number; itemKeys: string[] }> = [];
  const scalarHints: Array<{ path: string; type: string; length?: number; digits?: number; hash?: string }> = [];
  let nodes = 0;
  const visit = (node: unknown, path: string, depth: number) => {
    if (nodes++ >= maxNodes || depth > 7) return;
    if (node === null || ['string', 'number', 'boolean'].includes(typeof node)) {
      const hint = scalarHint(node, path);
      const leaf = path.split('.').at(-1)?.replace(/\[\d+\]$/, '') || '';
      if (hint && /id|time|date|cursor|token|sender|reply|hasmore|next/i.test(leaf)) scalarHints.push(hint);
      return;
    }
    if (Array.isArray(node)) {
      const objects = node.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 4) as Array<Record<string, unknown>>;
      if (objects.length) candidateArrays.push({ path, length: node.length, itemKeys: [...new Set(objects.flatMap(item => Object.keys(item)))].sort().slice(0, 80) });
      node.slice(0, 25).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    const object = node as Record<string, unknown>;
    const keys = Object.keys(object);
    keys.forEach(key => {
      const next = path ? `${path}.${key}` : key;
      if (/[Ii][dD]|time|date|cursor|token|message|conversation|account|user|sender|reply|history|hasMore|next/i.test(key)) interestingPaths.push(next);
      visit(object[key], next, depth + 1);
    });
  };
  visit(value, '$', 0);
  const root = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value as JsonShape['root'] : 'unknown';
  return {
    root,
    arrayLength: Array.isArray(value) ? value.length : undefined,
    objectKeys: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value as object).sort().slice(0, 100) : undefined,
    interestingPaths: [...new Set(interestingPaths)].slice(0, 300),
    candidateArrays: candidateArrays.slice(0, 100),
    scalarHints: scalarHints.slice(0, 120)
  };
}

function lengthBucket(length: number) {
  if (length === 0) return '0';
  if (length < 16) return '1-15';
  if (length < 128) return '16-127';
  if (length < 1024) return '128-1023';
  if (length < 16 * 1024) return '1-15KB';
  if (length < 1024 * 1024) return '16-1023KB';
  return '1MB+';
}

function readVarint(bytes: Uint8Array, offset: number) {
  let cursor = offset;
  let value = 0n;
  let shift = 0n;
  while (cursor < bytes.length && cursor - offset < 10) {
    const byte = bytes[cursor++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, next: cursor };
    shift += 7n;
  }
  return undefined;
}

export function summarizeProtobuf(input: Uint8Array, maxDepth = 4, maxFields = 240): ProtobufShape {
  if (!input.length) return { byteLength: 0, parseStatus: 'empty', fields: [] };
  const fields = new Map<number, ProtobufFieldShape>();
  let cursor = 0;
  let parsed = 0;
  let partial = false;
  while (cursor < input.length && parsed < maxFields) {
    const key = readVarint(input, cursor);
    if (!key) { partial = true; break; }
    cursor = key.next;
    const fieldNumber = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    if (!fieldNumber || wireType === 3 || wireType === 4 || wireType > 5) { partial = true; break; }
    const shape = fields.get(fieldNumber) || { fieldNumber, wireType, occurrences: 0, lengthBuckets: [], varintDigitCounts: [] };
    shape.occurrences++;
    if (wireType === 0) {
      const value = readVarint(input, cursor);
      if (!value) { partial = true; break; }
      shape.varintDigitCounts!.push(value.value.toString().length);
      cursor = value.next;
    } else if (wireType === 1) {
      if (cursor + 8 > input.length) { partial = true; break; }
      cursor += 8;
    } else if (wireType === 2) {
      const length = readVarint(input, cursor);
      if (!length) { partial = true; break; }
      cursor = length.next;
      const size = Number(length.value);
      if (!Number.isSafeInteger(size) || size < 0 || cursor + size > input.length) { partial = true; break; }
      shape.lengthBuckets!.push(lengthBucket(size));
      // A message page may be a single nested protobuf containing many messages.
      // Parse its structure in memory, but still discard every payload value.
      if (maxDepth > 0 && size > 0 && size <= 4 * 1024 * 1024) {
        const child = summarizeProtobuf(input.subarray(cursor, cursor + size), maxDepth - 1, Math.min(120, maxFields - parsed));
        if (child.fields.length && child.parseStatus !== 'invalid') shape.nested = child;
      }
      cursor += size;
    } else if (wireType === 5) {
      if (cursor + 4 > input.length) { partial = true; break; }
      cursor += 4;
    }
    fields.set(fieldNumber, shape);
    parsed++;
  }
  if (cursor !== input.length) partial = true;
  return { byteLength: input.length, parseStatus: fields.size ? (partial ? 'partial' : 'parsed') : 'invalid', fields: [...fields.values()].sort((a, b) => a.fieldNumber - b.fieldNumber) };
}

export async function saveProbeReport(report: ProbeReport) {
  const directory = probeReportDirectory();
  await mkdir(directory, { recursive: true });
  const filename = `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const path = join(directory, filename);
  await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}
