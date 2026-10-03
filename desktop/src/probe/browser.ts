import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type BrowserKind = 'chrome' | 'edge';

export interface BrowserExecutable {
  kind: BrowserKind;
  path: string;
}

function envPath(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function resolveBrowserExecutable(): BrowserExecutable {
  const localAppData = envPath('LOCALAPPDATA');
  const programFiles = envPath('PROGRAMFILES');
  const programFilesX86 = envPath('PROGRAMFILES(X86)');
  const candidates: Array<BrowserExecutable | undefined> = [
    envPath('DOUYIN_CHROME_PATH') ? { kind: 'chrome', path: envPath('DOUYIN_CHROME_PATH')! } : undefined,
    envPath('DOUYIN_EDGE_PATH') ? { kind: 'edge', path: envPath('DOUYIN_EDGE_PATH')! } : undefined,
    localAppData ? { kind: 'chrome', path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') } : undefined,
    programFiles ? { kind: 'chrome', path: join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') } : undefined,
    programFilesX86 ? { kind: 'chrome', path: join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') } : undefined,
    localAppData ? { kind: 'edge', path: join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe') } : undefined,
    programFiles ? { kind: 'edge', path: join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe') } : undefined,
    programFilesX86 ? { kind: 'edge', path: join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') } : undefined
  ];
  const found = candidates.filter((candidate): candidate is BrowserExecutable => Boolean(candidate && existsSync(candidate.path)));
  if (!found.length) {
    throw new Error('未找到 Chrome 或 Edge。可设置 DOUYIN_CHROME_PATH / DOUYIN_EDGE_PATH 后重试。');
  }
  return found[0];
}

export function appDataRoot() {
  const localAppData = envPath('LOCALAPPDATA');
  const base = localAppData || join(process.cwd(), '.desktop-data');
  return join(base, 'DouyinChatArchive');
}

export function probeProfilePath() {
  return join(appDataRoot(), 'probe-browser-profile');
}

export function probeReportDirectory() {
  return join(appDataRoot(), 'probe-reports');
}
