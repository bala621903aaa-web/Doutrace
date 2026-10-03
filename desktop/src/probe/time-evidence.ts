import { extensionTimeCandidates, type DecodedHistoryMessage } from '../im/protocol.js';
import type { PageRowState } from './page-state.js';
import type { TimeEvidence } from './live-report.js';

function normalizeText(value: string) {
  return value.normalize('NFC').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localTimeFromEpoch(value: bigint, unit: 'milliseconds' | 'seconds'): LocalTime | null {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return null;
  const date = new Date(unit === 'milliseconds' ? number : number * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute) };
}

function localDateFromIso(value: string): { year: number; month: number; day: number } | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
}

function sameLocalTime(left: LocalTime, right: LocalTime) {
  return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute;
}

function validCalendar(value: LocalTime) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return date.getUTCFullYear() === value.year && date.getUTCMonth() + 1 === value.month && date.getUTCDate() === value.day;
}

interface ParsedPageTime {
  value: LocalTime;
  precision: 'minute' | 'minute-only';
}

function parsePageTimeLabel(label: string, capturedAt: string): ParsedPageTime | null {
  const value = label.replace(/[，,]/g, ' ').replace(/\s+/g, ' ').trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/i);
  if (iso) {
    const calendar = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), hour: Number(iso[4]), minute: Number(iso[5]) };
    if (!validCalendar(calendar) || calendar.hour > 23 || calendar.minute > 59 || Number(iso[6]) > 59) return null;
    const epoch = Date.parse(value);
    if (!Number.isSafeInteger(epoch)) return null;
    const local = localTimeFromEpoch(BigInt(epoch), 'milliseconds');
    return local ? { value: local, precision: 'minute' } : null;
  }
  // Do not treat an unsupported explicit timezone as a Shanghai wall clock.
  if (/T\d|(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const clock = value.match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  if (!clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2]);
  if (hour > 23 || minute > 59) return null;
  const date = localDateFromIso(capturedAt);
  if (!date) return null;
  const full = value.match(/(\d{4})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})/);
  if (full) {
    const calendar = { year: Number(full[1]), month: Number(full[2]), day: Number(full[3]), hour, minute };
    return validCalendar(calendar) ? { value: calendar, precision: 'minute' } : null;
  }
  const monthDay = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  // A yearless label does not distinguish this year's message from an older
  // one. Do not silently insert the sampling year into acceptance evidence.
  if (monthDay) return null;
  const relative = value.match(/(今天|昨天|前天)/);
  if (relative) {
    const offset = relative[1] === '今天' ? 0 : relative[1] === '昨天' ? 1 : 2;
    const anchor = new Date(Date.UTC(date.year, date.month - 1, date.day - offset, 12, 0, 0));
    return { value: { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate(), hour, minute }, precision: 'minute' };
  }
  // A bare HH:mm can check a display minute only; it cannot prove the date
  // or year of a message and therefore never counts toward the P1 time gate.
  if (/^\d{1,2}\s*[:：]\s*\d{2}$/.test(value)) return { value: { year: date.year, month: date.month, day: date.day, hour, minute }, precision: 'minute-only' };
  return null;
}

function emptyTimeEvidence(): TimeEvidence {
  return { matched: 0, uniqueMatchedMessageIds: 0, ambiguous: 0, noTime: 0, minuteOnly: 0, outOfWindow: 0, field10Matches: 0, extensionMatches: 0, field10SecondsMatches: 0, extensionSecondsMatches: 0, selectedField: 'unknown', selectedUnit: 'unknown', unresolvedConflicts: 0, orderChecks: 0, duplicateMessageIds: 0, timezone: 'Asia/Shanghai', precision: 'unknown', rowTextCount: 0, rowKeyCount: 0, rowTimeCount: 0, messageTextCount: 0, keyMatches: 0, textMatches: 0, matchedMessageIds: [] };
}

function compareMessagesToRows(messages: DecodedHistoryMessage[], rows: PageRowState[], capturedAt = new Date().toISOString(), selfAccountId?: string, verifiedDisplayField?: 'field10'): TimeEvidence {
  const result = emptyTimeEvidence();
  const textRows = rows.map((row, index) => ({ ...row, index, text: normalizeText(row.text), messageKey: row.messageKey ?? null, timeAssociation: row.timeAssociation ?? (row.timeLabel ? 'row' : 'none') })).filter(row => row.text || row.messageKey);
  const usedRows = new Set<number>();
  const seenMessageIds = new Set<string>();
  const matchedRowIndices: number[] = [];
  const selectedFields = new Set<'field10' | 'server-extension'>();
  const selectedUnits = new Set<'millisecond' | 'second'>();
  result.rowTextCount = textRows.filter(row => Boolean(row.text)).length;
  result.rowKeyCount = textRows.filter(row => Boolean(row.messageKey)).length;
  result.rowTimeCount = textRows.filter(row => row.timeAssociation === 'row' && Boolean(row.timeLabel)).length;
  result.messageTextCount = messages.filter(message => Boolean(normalizeText(message.content.text ?? ''))).length;
  const sameSide = (row: PageRowState, message: DecodedHistoryMessage) => !selfAccountId ||
    row.sideKnown !== false && message.senderUid !== null && row.fromMe === (message.senderUid.toString() === selfAccountId);
  const duplicateTexts = new Map<string, number>();
  for (const message of messages) {
    const text = normalizeText(message.content.text ?? '');
    if (text) {
      const key = `${selfAccountId ? message.senderUid?.toString() === selfAccountId : ''}\0${text}`;
      duplicateTexts.set(key, (duplicateTexts.get(key) ?? 0) + 1);
    }
  }
  for (const message of messages) {
    const messageId = message.platformMessageId;
    if (!messageId) { result.noTime++; continue; }
    if (messageId && seenMessageIds.has(messageId)) {
      result.duplicateMessageIds++;
      continue;
    }
    if (messageId) seenMessageIds.add(messageId);
    const text = normalizeText(message.content.text ?? '');
    const keyCandidates = textRows.filter(row => row.messageKey === messageId && sameSide(row, message) && !usedRows.has(row.index));
    const matchedByKey = keyCandidates.length === 1;
    const candidates = keyCandidates.length ? keyCandidates : text
      ? textRows.filter(row => !row.messageKey && row.text === text && sameSide(row, message) && !usedRows.has(row.index))
      : [];
    const duplicateApiText = (duplicateTexts.get(`${selfAccountId ? message.senderUid?.toString() === selfAccountId : ''}\0${text}`) ?? 0) > 1;
    if (!matchedByKey && candidates.length > 0 && duplicateApiText) { result.ambiguous++; continue; }
    if (candidates.length !== 1) {
      if (candidates.length > 1 || (text && textRows.filter(row => row.text === text).length > 1)) result.ambiguous++;
      else result.noTime++;
      continue;
    }
    const row = candidates[0];
    usedRows.add(row.index);
    if (matchedByKey) result.keyMatches = (result.keyMatches ?? 0) + 1;
    else result.textMatches = (result.textMatches ?? 0) + 1;
    matchedRowIndices.push(row.index);
    if (row.timeAssociation === 'none' || row.timeAssociation === 'sibling') {
      result.noTime++;
      continue;
    }
    const parsedLabels = [...new Set([row.timeLabel, ...(row.timeLabels ?? [])].filter(Boolean))]
      .map(label => parsePageTimeLabel(label, capturedAt)).filter((value): value is ParsedPageTime => value !== null);
    const completeLabels = parsedLabels.filter(label => label.precision === 'minute');
    const uniqueDates = new Map(completeLabels.map(label => [JSON.stringify(label.value), label]));
    if (uniqueDates.size > 1) { result.unresolvedConflicts++; continue; }
    const parsed = [...uniqueDates.values()][0] ?? parsedLabels[0];
    if (!parsed) {
      result.noTime++;
      continue;
    }
    if (parsed.precision === 'minute-only') {
      result.minuteOnly++;
      continue;
    }
    const candidateMatches: Array<{ field: 'field10' | 'server-extension'; unit: 'millisecond' | 'second' }> = [];
    const fieldCandidates: Array<{ field: 'field10' | 'server-extension'; value: bigint }> = [];
    if (message.timeField10 !== null) fieldCandidates.push({ field: 'field10', value: message.timeField10 });
    for (const raw of extensionTimeCandidates(message)) {
      try { fieldCandidates.push({ field: 'server-extension', value: BigInt(raw) }); } catch { /* not evidence */ }
    }
    for (const candidate of fieldCandidates) {
      for (const unit of ['milliseconds', 'seconds'] as const) {
        const local = localTimeFromEpoch(candidate.value, unit);
        if (local && sameLocalTime(local, parsed.value)) candidateMatches.push({ field: candidate.field, unit: unit === 'milliseconds' ? 'millisecond' : 'second' });
      }
    }
    const uniqueCandidateMatches = [...new Map(candidateMatches.map(item => [`${item.field}:${item.unit}`, item])).values()];
    result.field10CandidateMatches = (result.field10CandidateMatches ?? 0) + Number(uniqueCandidateMatches.some(item => item.field === 'field10'));
    result.extensionCandidateMatches = (result.extensionCandidateMatches ?? 0) + Number(uniqueCandidateMatches.some(item => item.field === 'server-extension'));
    result.sameMinuteCandidateMatches = (result.sameMinuteCandidateMatches ?? 0) + Number(uniqueCandidateMatches.length > 1);
    const displayMatches = verifiedDisplayField ? uniqueCandidateMatches.filter(item => item.field === verifiedDisplayField) : uniqueCandidateMatches;
    if (displayMatches.length !== 1) {
      if (displayMatches.length > 1) result.unresolvedConflicts++;
      else result.outOfWindow++;
      continue;
    }
    const match = displayMatches[0];
    result.matched++;
    result.matchedMessageIds?.push(messageId);
    selectedFields.add(match.field);
    selectedUnits.add(match.unit);
    if (match.field === 'field10') result.field10Matches++;
    else result.extensionMatches++;
    if (match.field === 'field10' && match.unit === 'second') result.field10SecondsMatches++;
    if (match.field === 'server-extension' && match.unit === 'second') result.extensionSecondsMatches++;
  }
  const increasing = matchedRowIndices.every((value, index) => index === 0 || value >= matchedRowIndices[index - 1]);
  const decreasing = matchedRowIndices.every((value, index) => index === 0 || value <= matchedRowIndices[index - 1]);
  result.orderChecks = matchedRowIndices.length >= 2 && (increasing || decreasing) ? matchedRowIndices.length : 0;
  result.uniqueMatchedMessageIds = new Set(result.matchedMessageIds).size;
  result.selectedField = selectedFields.size === 1 ? [...selectedFields][0] : 'unknown';
  result.selectedUnit = selectedUnits.size === 1 ? [...selectedUnits][0] : 'unknown';
  result.precision = result.matched > 0 ? 'minute' : 'unknown';
  if (selectedFields.size > 1 || selectedUnits.size > 1) result.unresolvedConflicts++;
  return result;
}

export { compareMessagesToRows, parsePageTimeLabel, emptyTimeEvidence };
