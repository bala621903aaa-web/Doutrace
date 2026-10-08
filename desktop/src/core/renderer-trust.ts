interface ArchiveWindow {
  webContents: { mainFrame: { url: string } };
}

interface ArchiveIpcSender {
  sender: unknown;
  senderFrame: { url: string } | null;
}

export function assertTrustedArchiveSender(event: ArchiveIpcSender, window: ArchiveWindow | undefined, entryUrl: string): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url !== entryUrl) {
    throw new Error('archive-renderer-untrusted');
  }
}
