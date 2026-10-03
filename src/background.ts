chrome.action.onClicked.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) await chrome.storage.session.set({ sourceTabId: tab.id });
  if (tab?.id === undefined) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' });
  } catch {
    // Browser-managed pages (chrome://, edge://, store pages, etc.) reject injection.
    // The action remains harmless there; the panel can be opened again on a Douyin tab.
  }
});
