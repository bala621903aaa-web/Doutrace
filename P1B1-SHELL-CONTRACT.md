# P1-b1 AppShell contract for P1-b2

## Shell boundary

- desktop/src/renderer/index.html contains the one application title bar, one primary navigation rail, and the stable module roots. Keep #app-titlebar, #primary-navigation, #app-view, and module data-module names unchanged.
- desktop/src/renderer/shell/app-shell.js owns in-memory module navigation and the four analysis tabs. It exports navigateAppShell(module, analysisTab?); valid module names are archive, analysis, media, reminders, and settings. Analysis tab names are overview, interaction, journey, and ai.
- desktop/src/renderer/renderer.js is the composition entry and owns the single archive-controller instance plus Shell lifecycle callbacks. Leaving archive invalidates its pending message request and invokes the controller media cleanup; returning reloads the currently selected archive.
- desktop/src/renderer/styles/tokens.css and styles/shell.css are shared design tokens and Shell layout. renderer.css only assembles local CSS imports. Keep page-specific styles out of the Shell stylesheet.
- desktop/src/renderer/icons/*.svg are local assets copied by the Renderer build. They are not served from a CDN.

## Chat Archive boundary

- #chat-archive-page is the persistent archive module root, initially mounted and visible. The Shell only toggles the module root hidden state; it does not rebuild the archive DOM during navigation.
- desktop/src/renderer/chat-archive-view.js owns the archive markup inside that root. Preserve the existing business DOM IDs used by renderer.js, chat-archive.js, and message-view.js.
- desktop/src/renderer/styles/archive.css owns Chat Archive styles and scopes selectors under .chat-archive-page. The existing chat-archive.js and message-view.js controller behavior remains the source of truth for selection, search, filtering, paging, references, and media.
- Shell module roots are the only supported mount points for future modules. Analysis currently contains four honest empty states; do not replace them with Stitch example metrics or AI copy.

This split keeps AppShell ownership separate from P1-b2 archive presentation while preserving one trusted index.html entry and the existing narrow preload bridge.