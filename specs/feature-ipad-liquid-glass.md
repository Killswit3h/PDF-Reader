# Feature: Liquid Glass on iPad / iOS

Short-form pipeline record (research → spec → plan → inspection) for a
styling-only change. Approval checkpoint: the draft PR.

## Research

- The macOS skin (`src/renderer/styles/liquid-glass.css`, PR #56/#57) was scoped to
  `html.platform-mac`, set by `js/theme-boot.js` from `window.api.isMac`. The iOS
  Capacitor WebView was excluded on purpose: the Mac glass frosts the desktop
  through Electron's native `vibrancy`, which a WKWebView does not have.
- `theme-boot.js` runs in `<head>` before `platform-web.js` is injected, so
  `window.api` does not exist there on iOS. Capacitor iOS injects `window.Capacitor`
  as a `WKUserScript` at `.atDocumentStart` (`@capacitor/ios` `JSExport.swift`), so
  `Capacitor.getPlatform() === 'ios'` is available before first paint.
- iPad full-screen widths (> 820px) use the desktop layout (top bar + left rail);
  Split View / Slide Over and iPhone fall into the ≤ 820px bottom-bar layout.
- Moving the pages to scroll *under* the bars was rejected: `--toolbar-h` offsets
  are shared by the banner, props bar, find bar and every panel, and
  `viewer.js` does its own `scrollTop` zoom anchoring. Too much regression risk for
  measurement/markup placement for a visual change.
- Found while here: styles.css gives `.modal-backdrop` its own `backdrop-filter`,
  which makes it a backdrop root, so every dialog's glass sampled only the scrim
  on macOS too.

## Spec

- FR-1 The iOS app (iPad and iPhone — one binary) gets the Liquid Glass material
  on first paint; Windows, Android and plain browsers are unchanged.
- FR-2 macOS keeps its existing look and window behaviour (vibrancy, traffic-light
  clearance, drag regions).
- FR-3 On iOS every floating surface (menus, bottom sheets, dialogs, toast, find
  bar, markup rail) frosts the drawing beneath it; the fixed bars frost a soft
  blueprint light field painted behind the app. The document canvas stays opaque.
- FR-4 Touch: no hover lift latched after a tap; a press-in response instead; no
  grey tap highlight over glass.
- FR-5 Dialog glass blurs the page behind it on both hosts (backdrop-root fix).
- FR-6 Honour Reduce Motion and Reduce Transparency.

## Plan

1. `theme-boot.js`: add `lg-glass` + `platform-mac` / `platform-ios`.
2. `liquid-glass.css`: shared material under `html.lg-glass`; Mac-only window
   rules under `platform-mac`; iOS light field, floating tools, touch press and
   narrow-layout fixes under `platform-ios`; hover gated by `(hover: hover)`.
3. `verify-web.js`: run the glass checks for both hosts; extend the structural
   backdrop-root assertion to dialogs, toast, find bar and markup rail.

## Inspection

- `npm test`, `npm run verify:web` (both hosts), `npm run test:e2e`.
- WebKit (the iOS engine) via Playwright with `window.Capacitor` injected at
  document start: class present at first paint, computed blur on each surface,
  screenshots in dark, light and Split View; control run without Capacitor stays
  opaque.
- Not yet verified: a real device / Simulator build (`npm run ios:open`).
