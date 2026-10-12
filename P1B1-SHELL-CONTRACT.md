# P1-b1 AppShell contract for P1-b2

## Shell boundary

- desktop/src/renderer/index.html contains the one application title bar, one primary navigation rail, and the stable module roots. Keep #app-titlebar, #primary-navigation, #app-view, and module data-module names unchanged.
- desktop/src/renderer/shell/app-shell.js owns in-memory module navigation, the four analysis tabs, and the pinned analysis context. It exports navigateAppShell(module, analysisTab?, analysisContext?). Valid module names are archive, analysis, media, reminders, and settings. Analysis tab names are overview, interaction, journey, and ai. Omitting analysisContext preserves the previous module navigation.
- desktop/src/renderer/renderer.js is the composition entry and owns the single archive-controller instance plus Shell lifecycle callbacks. Leaving archive invalidates its pending message request and invokes the controller media cleanup; returning reloads the currently selected archive.
- desktop/src/renderer/styles/tokens.css and styles/shell.css are shared design tokens and Shell layout. renderer.css only assembles local CSS imports. Keep page-specific styles out of the Shell stylesheet.
- desktop/src/renderer/icons/*.svg are local assets copied by the Renderer build. They are not served from a CDN.

## Chat Archive boundary

- #chat-archive-page is the persistent archive module root, initially mounted and visible. The Shell only toggles the module root hidden state; it does not rebuild the archive DOM during navigation.
- desktop/src/renderer/chat-archive-view.js owns the archive markup inside that root. Preserve the existing business DOM IDs used by renderer.js, chat-archive.js, and message-view.js.
- desktop/src/renderer/styles/archive.css owns Chat Archive styles and scopes selectors under .chat-archive-page. The existing chat-archive.js and message-view.js controller behavior remains the source of truth for selection, search, filtering, paging, references, and media.
- Shell module roots are the only supported mount points for future modules. Analysis currently contains four honest empty states; do not replace them with Stitch example metrics or AI copy.

This split keeps AppShell ownership separate from P1-b2 archive presentation while preserving one trusted index.html entry and the existing narrow preload bridge.

## Analysis session context

UI product baseline for this contract remains `15d6d9243c69d54488c0b96f6e55c63b79dcc3e0`. These clauses are offline Shell contract work. They do not change `DEV_BASELINE_READY`, `RELEASE_READY`, formal P1, `implementationMatches`, or `p2GateOpen`, and they do not enable collection, model calls, retrieval, or persistence.

- `#analyzeConversation` in `desktop/src/renderer/chat-archive-view.js` is the 「分析此会话」 action. `desktop/src/renderer/renderer.js` owns its enabled state and click. The control is disabled unless the current `chatArchive.getSnapshot()` has stable `accountId` and `conversationId` strings. Empty or whitespace-only values are not a selection. A nickname, filter, query, offset, or message body is not an identity.
- A successful click copies only those two IDs and calls `navigateAppShell('analysis', 'ai', { accountId, conversationId })`. The shell stores its own copy. Later archive selection, search, or filters do not rewrite the pinned pair. Replacing it requires another successful call with a new stable pair.
- `navigateAppShell('analysis', 'ai')` still lands on 聊天分析 → AI 洞察 when no context argument is passed. Rail navigation keeps the existing module and tab behavior and does not require a pinned pair. An invalid context argument is rejected and does not change the active module, the analysis tab, or a previously pinned pair.
- The pinned pair is readable from the shell snapshot as `analysisContext` and from `[data-module="analysis"]` as `data-analysis-account` and `data-analysis-conversation`. AI 洞察 stays the honest empty state. This contract does not display sample answers or send archive data.