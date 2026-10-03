import { createInterface } from 'node:readline';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { probeProfilePath, resolveBrowserExecutable } from './browser.js';

export const TARGET_CHAT_URL = 'https://www.douyin.com/chat?isPopup=1';

export interface BrowserProbeSession {
  context: BrowserContext;
  page: Page;
  executable: ReturnType<typeof resolveBrowserExecutable>;
  close(): Promise<void>;
}

export async function startBrowserProbeSession(onClosed?: () => void): Promise<BrowserProbeSession> {
  const executable = resolveBrowserExecutable();
  const context = await chromium.launchPersistentContext(probeProfilePath(), {
    executablePath: executable.path,
    headless: false,
    viewport: null,
    args: ['--start-maximized']
  });
  const page = context.pages()[0] || await context.newPage();
  let closed = false;
  const handleClosed = () => {
    if (!closed) onClosed?.();
  };
  context.on('close', handleClosed);
  page.on('close', handleClosed);
  return {
    context,
    page,
    executable,
    async close() {
      if (closed) return;
      closed = true;
      context.off('close', handleClosed);
      page.off('close', handleClosed);
      await context.close().catch(() => undefined);
    }
  };
}

export async function waitForEnter(message: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      readline.close();
      resolve(value);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    readline.question(`${message}\n`, () => finish(true));
  });
}

export function installStopSignals(controller: AbortController): () => void {
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

export function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('verification-cancelled');
}

