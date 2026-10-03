import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { DecodedHistoryMessage } from '../im/protocol.js';
import { readPageState, type PageRowState, type PageState } from './page-state.js';

export interface MessageInfoDiagnostics {
  attempted: number;
  accepted: number;
  exactMillisecondsMatches: number;
  exactSecondsMatches: number;
  rejected: Record<string, number>;
  clipboardRestored: boolean;
  copyEvents: number;
  clipboardOutputFormats: Record<string, number>;
  copyHelperVerified?: boolean;
}

function decimal(value: unknown): string | null {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

const normalized = (value: string) => value.normalize('NFC').replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();

/** Parses only the official row's newly copied UI output. Nothing private is serialized. */
export function associateCopiedMessageInfo(raw: string, row: PageRowState, messages: DecodedHistoryMessage[], account: string, conversation: string):
  { row: PageRowState; unit: 'millisecond' | 'second' } | { failure: string } {
  if (raw.length > 1_000_000) return { failure: 'copy-too-large' };
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { return { failure: 'copy-not-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { failure: 'copy-not-object' };
  const id = decimal(value.serverId);
  if (!id || decimal(value.userId) !== account || value.conversationId !== conversation) return { failure: 'copy-identity-mismatch' };
  const candidates = messages.filter(message => message.platformMessageId === id && message.conversationId === conversation);
  if (candidates.length !== 1) return { failure: 'copy-message-not-covered' };
  const message = candidates[0];
  if (decimal(value.conversationShortId) !== message.conversationShortId?.toString() ||
      decimal(value.indexInConversation) !== message.indexInConversation?.toString() ||
      decimal(value.sender) !== message.senderUid?.toString() || value.content !== message.contentJson) return { failure: 'copy-message-mismatch' };
  if (row.sideKnown === false || row.fromMe !== (message.senderUid?.toString() === account) ||
      row.text && normalized(row.text) !== normalized(message.content.text ?? '')) return { failure: 'copy-row-mismatch' };
  // The UI contains BOTH getTime() and Date.toString(), including an explicit
  // timezone. Their equality proves a full calendar instant, without inventing
  // a date for the abbreviated row label or using digit count as a unit test.
  const time = typeof value.createdAt === 'string' ? value.createdAt.match(/^([0-9]+) (.+ GMT\+0800 \([^\r\n]+\))$/) : null;
  if (!time) return { failure: 'copy-full-time-missing' };
  const epoch = Number(time[1]);
  const calendarEpoch = Date.parse(time[2]);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(calendarEpoch) || Math.floor(epoch / 1_000) * 1_000 !== calendarEpoch) return { failure: 'copy-calendar-mismatch' };
  if (message.timeField10 === null) return { failure: 'copy-wire-time-missing' };
  const units = (['millisecond', 'second'] as const).filter(unit => message.timeField10! * (unit === 'second' ? 1_000n : 1n) === BigInt(epoch));
  if (units.length !== 1) return { failure: 'copy-wire-time-mismatch' };
  const iso = new Date(epoch).toISOString();
  return { row: { ...row, messageKey: id, timeLabel: iso, timeLabels: [...new Set([...(row.timeLabels ?? []), row.timeLabel, iso].filter(Boolean))], timeAssociation: 'row' }, unit: units[0] };
}

/** Product integration probe: the pinned client's five-context-menu gesture.
 * Does not read React internals, change messages, scroll, or request history.
 * Clipboard JSON and original clipboard text exist in memory only.
 */
export async function collectMessageInfoTimes(input: {
  page: Page; state: PageState; messages: DecodedHistoryMessage[]; account: string; conversation: string; signal: AbortSignal;
}): Promise<{ rows: PageRowState[]; diagnostics: MessageInfoDiagnostics }> {
  const diagnostics: MessageInfoDiagnostics = { attempted: 0, accepted: 0, exactMillisecondsMatches: 0, exactSecondsMatches: 0, rejected: {}, clipboardRestored: false, copyEvents: 0, clipboardOutputFormats: {} };
  const reject = (code: string) => diagnostics.rejected[code] = (diagnostics.rejected[code] ?? 0) + 1;
  const rows = input.state.rows.map(row => ({ ...row }));
  let original: string | null = null;
  let lastOwned: string | null = null;
  let permissionsGranted = false;
  const probeKey = `__p1Copy_${randomUUID().replaceAll('-', '')}`;
  let copyFrame: ReturnType<Page['mainFrame']> | undefined;
  try {
    await input.page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: input.state.origin });
    permissionsGranted = true;
    const frame = input.page.frames().find(candidate => {
      try { const url = new URL(candidate.url()); return url.origin === input.state.ui.frameOrigin && url.pathname === input.state.ui.framePathname; } catch { return false; }
    });
    if (!frame) { reject('copy-frame-not-found'); return { rows, diagnostics }; }
    copyFrame = frame;
    original = await frame.evaluate(() => navigator.clipboard.readText());
    // Observe the official copy helper's newly created, selected DOM span.
    // Native clipboard formats may be changed by the host page. This passive
    // listener does not prevent copy, inject text, or read an application store.
    await frame.evaluate(`(() => {
      const key = ${JSON.stringify(probeKey)};
      const probe = { events: [], listener: null };
      probe.listener = () => {
        const selection = document.getSelection();
        const anchor = selection?.anchorNode;
        const span = anchor?.nodeType === 1 ? anchor : anchor?.parentElement;
        const text = selection?.toString() || '';
        if (span?.tagName === 'SPAN' && span.getAttribute('aria-hidden') === 'true' &&
            span.style.position === 'fixed' && span.textContent === text && text.length <= 1000000) probe.events.push(text);
      };
      window[key] = probe;
      document.addEventListener('copy', probe.listener, true);
    })()`);
    const seen = new Set<string>();
    for (let index = 0; index < Math.min(rows.length, 30) && !input.signal.aborted; index++) {
      const stable = await readPageState(input.page);
      if (stable.selectedConversationIds.length !== 1 || stable.selectedConversationIds[0] !== input.conversation ||
          stable.rows.length !== rows.length || stable.rows.some((row, i) => row.text !== input.state.rows[i].text || row.fromMe !== input.state.rows[i].fromMe) ||
          stable.messageList.scrollTop !== input.state.messageList.scrollTop) { reject('copy-window-changed'); break; }
      await frame.evaluate(`window[${JSON.stringify(probeKey)}].events = []`);
      diagnostics.attempted++;
      const row = frame.locator('.messageMessageBoxmessageBox').nth(index);
      // DOM input events go through the actual mounted page handler. No handler
      // or store is called directly and no copied values are supplied by us.
      for (let count = 0; count < 5; count++) await row.dispatchEvent('contextmenu', { bubbles: true, button: 2 });
      let copied: string | null = null;
      const deadline = Date.now() + 3_000;
      while (copied === null && Date.now() < deadline && !input.signal.aborted) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const events = await frame.evaluate(`window[${JSON.stringify(probeKey)}].events.splice(0)`) as string[];
        diagnostics.copyEvents += events.length;
        if (events.length === 1) copied = events[0];
        else if (events.length > 1) { reject('copy-multiple-events'); break; }
      }
      if (copied === null) { reject('copy-ui-no-output'); continue; }
      lastOwned = await frame.evaluate(() => navigator.clipboard.readText());
      const outputFormat = lastOwned.trimStart().startsWith('{') ? 'json-object' : lastOwned.length ? 'other-text' : 'empty';
      diagnostics.clipboardOutputFormats[outputFormat] = (diagnostics.clipboardOutputFormats[outputFormat] ?? 0) + 1;
      const associated = associateCopiedMessageInfo(copied, rows[index], input.messages, input.account, input.conversation);
      if ('failure' in associated) { reject(associated.failure); continue; }
      const id = associated.row.messageKey!;
      if (seen.has(id)) { reject('copy-duplicate-message'); continue; }
      seen.add(id);
      rows[index] = associated.row;
      diagnostics.accepted++;
      if (associated.unit === 'millisecond') diagnostics.exactMillisecondsMatches++;
      else diagnostics.exactSecondsMatches++;
    }
  } catch { reject('copy-ui-unavailable'); }
  finally {
    if (copyFrame) await copyFrame.evaluate(`(() => { const key = ${JSON.stringify(probeKey)}; const probe = window[key]; if (probe) document.removeEventListener('copy', probe.listener, true); delete window[key]; })()`).catch(() => undefined);
    if (original !== null && lastOwned !== null) {
      try {
        diagnostics.clipboardRestored = await input.page.evaluate(async ({ original, lastOwned }) => {
          if (await navigator.clipboard.readText() !== lastOwned) return false;
          await navigator.clipboard.writeText(original);
          return true;
        }, { original, lastOwned });
      } catch { /* Kept as a diagnostic, never disclose clipboard text. */ }
    }
    if (permissionsGranted) await input.page.context().clearPermissions().catch(() => undefined);
  }
  return { rows, diagnostics };
}
