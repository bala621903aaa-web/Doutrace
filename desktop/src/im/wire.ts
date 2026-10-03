export type WireValue = bigint | Uint8Array;

export interface WireField {
  number: number;
  wireType: 0 | 1 | 2 | 5;
  value: WireValue;
}

export class WireError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'WireError';
    this.code = code;
  }
}

export interface WireLimits {
  maxBytes?: number;
  maxFields?: number;
  maxNestedBytes?: number;
}

const DEFAULT_LIMITS: Required<WireLimits> = {
  maxBytes: 4 * 1024 * 1024,
  maxFields: 25_000,
  maxNestedBytes: 4 * 1024 * 1024
};

const MAX_FIELD_NUMBER = 536_870_911;
const UINT64_MAX = (1n << 64n) - 1n;

function asBytes(value: WireValue): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new WireError('expected-bytes');
  return value;
}

function asUint64(value: WireValue): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) throw new WireError('invalid-uint64');
  return value;
}

export function cloneWireField(field: WireField): WireField {
  return {
    number: field.number,
    wireType: field.wireType,
    value: typeof field.value === 'bigint' ? field.value : new Uint8Array(field.value)
  };
}

export function readWireFields(input: Uint8Array, suppliedLimits: WireLimits = {}): WireField[] {
  const limits = { ...DEFAULT_LIMITS, ...suppliedLimits };
  if (input.length > limits.maxBytes) throw new WireError('body-too-large');

  let offset = 0;
  let count = 0;
  const result: WireField[] = [];

  const readVarint = () => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= input.length) throw new WireError('truncated-varint');
      const byte = input[offset++];
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if (value > UINT64_MAX) throw new WireError('varint-overflow');
      if ((byte & 0x80) === 0) return value;
    }
    throw new WireError('varint-overflow');
  };

  while (offset < input.length) {
    if (count++ >= limits.maxFields) throw new WireError('too-many-fields');
    const tag = readVarint();
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (!Number.isInteger(number) || number < 1 || number > MAX_FIELD_NUMBER) throw new WireError('invalid-field-number');

    if (wireType === 0) {
      result.push({ number, wireType, value: readVarint() });
      continue;
    }
    if (wireType !== 1 && wireType !== 2 && wireType !== 5) throw new WireError('unsupported-wire-type');

    let size: number;
    if (wireType === 1) {
      size = 8;
    } else if (wireType === 5) {
      size = 4;
    } else {
      const length = readVarint();
      if (length > BigInt(limits.maxNestedBytes) || length > BigInt(input.length - offset)) throw new WireError('truncated-bytes');
      size = Number(length);
    }
    if (size > input.length - offset) throw new WireError('truncated-fixed-field');
    result.push({ number, wireType, value: new Uint8Array(input.subarray(offset, offset + size)) });
    offset += size;
  }
  return result;
}

function appendVarint(target: number[], value: bigint) {
  let current = asUint64(value);
  do {
    const byte = Number(current & 0x7fn);
    current >>= 7n;
    target.push(byte | (current ? 0x80 : 0));
  } while (current);
}

export function encodeWireField(field: WireField): Uint8Array {
  if (!Number.isInteger(field.number) || field.number < 1 || field.number > MAX_FIELD_NUMBER) throw new WireError('invalid-field-number');
  if (![0, 1, 2, 5].includes(field.wireType)) throw new WireError('unsupported-wire-type');
  const result: number[] = [];
  appendVarint(result, (BigInt(field.number) << 3n) | BigInt(field.wireType));
  if (field.wireType === 0) {
    appendVarint(result, field.value as bigint);
  } else if (field.wireType === 1 || field.wireType === 5) {
    const bytes = asBytes(field.value);
    const expected = field.wireType === 1 ? 8 : 4;
    if (bytes.length !== expected) throw new WireError('invalid-fixed-field');
    result.push(...bytes);
  } else {
    const bytes = asBytes(field.value);
    appendVarint(result, BigInt(bytes.length));
    result.push(...bytes);
  }
  return new Uint8Array(result);
}

export function encodeWireFields(fields: readonly WireField[]): Uint8Array {
  const chunks = fields.map(encodeWireField);
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function fieldValues(fields: readonly WireField[], number: number, wireType?: WireField['wireType']): WireField[] {
  const matches = fields.filter(field => field.number === number);
  if (wireType !== undefined && matches.some(field => field.wireType !== wireType)) throw new WireError('unexpected-wire-type');
  return matches;
}

export function oneWireField(fields: readonly WireField[], number: number, wireType: WireField['wireType']): WireField | undefined {
  const matches = fieldValues(fields, number, wireType);
  if (matches.length > 1) throw new WireError('duplicate-singular-field');
  return matches[0];
}

export function requiredWireField(fields: readonly WireField[], number: number, wireType: WireField['wireType']): WireField {
  const field = oneWireField(fields, number, wireType);
  if (!field) throw new WireError(`missing-field-${number}`);
  return field;
}

export function wireVarint(fields: readonly WireField[], number: number): bigint | undefined {
  return oneWireField(fields, number, 0)?.value as bigint | undefined;
}

export function requiredWireVarint(fields: readonly WireField[], number: number): bigint {
  return requiredWireField(fields, number, 0).value as bigint;
}

export function wireBytes(fields: readonly WireField[], number: number): Uint8Array | undefined {
  return oneWireField(fields, number, 2)?.value as Uint8Array | undefined;
}

export function requiredWireBytes(fields: readonly WireField[], number: number): Uint8Array {
  return requiredWireField(fields, number, 2).value as Uint8Array;
}

export function repeatedWireBytes(fields: readonly WireField[], number: number): Uint8Array[] {
  return fieldValues(fields, number, 2).map(field => field.value as Uint8Array);
}

export function decodeUtf8(value: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new WireError('invalid-utf8');
  }
}

export function wireText(fields: readonly WireField[], number: number): string | undefined {
  const value = wireBytes(fields, number);
  return value === undefined ? undefined : decodeUtf8(value);
}

export function requiredWireText(fields: readonly WireField[], number: number): string {
  return decodeUtf8(requiredWireBytes(fields, number));
}

export function replaceSingularWireField(fields: readonly WireField[], number: number, replacement: WireField): WireField[] {
  const matches = fieldValues(fields, number);
  if (matches.length > 1) throw new WireError('duplicate-singular-field');
  if (replacement.number !== number) throw new WireError('replacement-field-number');
  if (matches.length === 0) return [...fields.map(cloneWireField), cloneWireField(replacement)];
  return fields.map(field => field.number === number ? cloneWireField(replacement) : cloneWireField(field));
}

export function replaceNestedWireField(fields: readonly WireField[], number: number, nested: Uint8Array): WireField[] {
  return replaceSingularWireField(fields, number, { number, wireType: 2, value: new Uint8Array(nested) });
}

export function uint64Field(number: number, value: bigint): WireField {
  asUint64(value);
  return { number, wireType: 0, value };
}

export function bytesField(number: number, value: Uint8Array | string): WireField {
  return { number, wireType: 2, value: typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value) };
}

export function isUint64(value: bigint): boolean {
  return value >= 0n && value <= UINT64_MAX;
}
