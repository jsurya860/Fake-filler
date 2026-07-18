# Fake Data Filler Pro

A browser extension that intelligently fills web forms with realistic fake data — featuring context-aware field detection, built-in error recovery, local profile management, and a polished React popup UI.

---

## Features

| Feature | Description |
|---|---|
| **Smart detection** | Identifies field types via HTML5 attributes → autocomplete hints → regex patterns → section-heading context → heuristic fallback (5 layers), each with a confidence score |
| **Locale-aware generation** | 14 locales with correct phone formats and locale-appropriate faker data; address/date formatting is currently a single generic template regardless of locale |
| **Consistent persona** | Name, email, username all derived from the same generated identity |
| **Error recovery** | Detects validation errors after submission, classifies them, and auto-retries affected fields — **opt-in**, off by default (`errorRecoveryEnabled`) |
| **Multi-step chaining** | Auto-fills forms across page navigations/SPA steps until disabled or a step limit is reached — opt-in (`chainingEnabled`) |
| **Local profiles** | Save, edit, import/export named field-value sets in `chrome.storage.local`; stored as plain JSON, not encrypted (see Security Model) |
| **React popup** | Preview and edit every field value before filling; per-field skip controls |
| **Manifest V3** | Built on the latest Chrome Extension standard for forward compatibility |
| **No telemetry by default** | No outbound network calls unless you explicitly opt in and configure your own endpoint (see Security Model) |

---

## Project Structure

```
fake-filler/
├── manifest.json               # MV3 manifest (source paths – transformed by build)
├── package.json
├── tsconfig.json               # Main TypeScript config
├── tsconfig.test.json          # Jest-specific TypeScript config
├── vite.config.ts              # Vite + vite-plugin-web-extension
├── jest.config.ts
├── .eslintrc.json
├── .prettierrc
│
├── src/
│   ├── shared/
│   │   ├── types.ts            # All TypeScript interfaces & enums
│   │   ├── constants.ts        # Defaults, patterns, test card numbers
│   │   ├── utils.ts            # Pure helpers (Luhn, crypto random, date utils, hostname matching…)
│   │   ├── messaging.ts        # sendMessageSafe() + logSwallowed() shared across content scripts
│   │   └── hotkey.ts           # Canonical hotkey parsing shared between popup and content script
│   │
│   ├── background/             # MV3 Service Worker
│   │   ├── index.ts            # Entry – message listener, chaining state, action-click handler
│   │   ├── data-generator.ts   # Faker.js-backed data generation per field type
│   │   ├── error-recovery.ts   # Error classification & recovery actions
│   │   ├── profile-manager.ts  # Profile CRUD (plaintext JSON in chrome.storage.local)
│   │   └── message-handler.ts  # Routes chrome.runtime messages
│   │
│   ├── content/                # Injected into web pages
│   │   ├── index.ts            # Entry – detection, filling, error observation, hotkey, modal handling
│   │   ├── form-detection.ts   # DOM scanning, field analysis, CSS selector generation
│   │   ├── form-filler.ts      # Fills fields with React/Angular/Vue compatibility + recovery loop
│   │   ├── api-interceptor.ts  # Parses fetch/XHR error responses for the recovery engine
│   │   ├── api-interceptor-main.ts  # MAIN-world entry that installs the interceptor (see below)
│   │   └── dev-fill-helper.ts  # `window.FDF_devFillFormById()` console helper, dev builds only
│   │
│   └── popup/                  # React 18 UI
│       ├── index.html
│       ├── main.tsx            # ReactDOM.createRoot entry
│       ├── App.tsx             # Root component with tab navigation
│       ├── popup.css           # Dark-mode design system
│       └── components/
│           ├── FormPreview.tsx     # Field list with inline editing & skip toggles
│           ├── ProfileSelector.tsx # Profile CRUD, import/export
│           ├── StatusBadge.tsx     # Live status indicator
│           ├── DebugPanel.tsx      # Live view of the background debug-log buffer
│           └── SettingsPanel.tsx   # All extension settings with toggle switches
│
└── tests/
    ├── setup.ts                    # Chrome API + crypto stubs for Jest
    └── unit/                       # 18 suites — unit + integration (see `npm test`)
```

### Two content scripts, two JS worlds

`manifest.json` declares **two** content scripts on `<all_urls>`:

- `src/content/index.ts` — the main script, in the isolated world (Chrome's default). Owns detection, filling, the hotkey, and modal handling.
- `src/content/api-interceptor-main.ts` — injected into the page's **MAIN world** (`"world": "MAIN"`, requires Chrome 111+) so it can patch the page's *real* `fetch`/`XMLHttpRequest`. The isolated world has its own separate copies of those globals that the page never calls, so this patch would be a no-op there.

The two worlds don't share JS state, so captured API errors cross back to the isolated-world script via a `CustomEvent` on `window` (`API_ERROR_EVENT` in `api-interceptor.ts`) rather than a shared module import.

---

## Quick Start

### Prerequisites
- Node.js 20+
- npm 10+
- Chrome 111+ (required for the MAIN-world content script — see above)

### Install dependencies

```bash
npm install
```

### Development (watch mode)

```bash
npm run dev
```

This runs Vite in `--watch` mode and rebuilds on every change to `src/`.

### Production build

```bash
npm run build
```

Output lands in `dist/`. Load it as an unpacked extension in Chrome.

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

### Run tests

```bash
npm test                  # run once
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

### Lint & format

```bash
npm run lint              # ESLint
npm run format            # Prettier
npm run typecheck         # tsc --noEmit
npm run validate          # typecheck + lint + test (CI gate)
```

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────┐
│  Popup (React 18)                                          │
│  App.tsx ─► FormPreview │ ProfileSelector │ SettingsPanel  │
└───────────────────────┬────────────────────────────────────┘
                        │ chrome.runtime.sendMessage
                        ▼
┌────────────────────────────────────────────────────────────┐
│  Background Service Worker (MV3)                           │
│  message-handler.ts                                        │
│   ├─ data-generator.ts   (Faker.js, locale-aware)          │
│   ├─ profile-manager.ts  (plaintext JSON, chrome.storage)  │
│   └─ error-recovery.ts   (classify, recover, learn)        │
│  index.ts also enforces the domain blocklist before        │
│  dispatching any fill — see Security Model                 │
└───────────────────────┬────────────────────────────────────┘
                        │ chrome.tabs.sendMessage
                        ▼
┌────────────────────────────────────────────────────────────┐
│  Content Scripts (injected into web pages)                 │
│  index.ts (isolated world) – detection, filling, hotkey,    │
│    modal handling, error observation                        │
│  form-detection.ts  – DOM scan, field type classification   │
│  form-filler.ts     – Fill with native setter + events,      │
│    recovery retry loop                                       │
│  api-interceptor-main.ts (MAIN world) – real fetch/XHR       │
│    error capture, bridged back via a CustomEvent             │
└───────────────────────┬────────────────────────────────────┘
                        │ chrome.storage.local (plaintext)
                        ▼
┌────────────────────────────────────────────────────────────┐
│  Local Storage                                              │
│  • Profiles   • Settings   • Error learning DB               │
└────────────────────────────────────────────────────────────┘
```

---

## Field Detection Priority

1. **HTML5 `type` attribute** — `email`, `tel`, `password`, `date`, `url`, `color`, `range`, `file`
2. **`data-*` / `inputmode` attributes** — `data-field`, `data-testid`, `inputmode="tel"`, etc.
3. **`autocomplete` attribute** — `given-name`, `family-name`, `postal-code`, `cc-number`, etc.
4. **Regex patterns** (name, id, label, placeholder, aria-label combined) — ordered by specificity
5. **Section-heading context** — a `<h2>Billing</h2>` above a low-confidence field nudges it toward address-type fields
6. **Heuristic fallback / context chaining** — defaults to `text`, or is promoted based on a high-confidence neighbor (e.g. a field right after `firstName` is inferred as `lastName`)

Each detection result includes a **confidence score** (0–1). Fields with confidence < 0.6 show a warning indicator in the popup preview.

---

## Supported Locales

| Code | Language |
|---|---|
| `en-US` | English (US) |
| `en-GB` | English (UK) |
| `de-DE` | German |
| `fr-FR` | French |
| `es-ES` | Spanish |
| `it-IT` | Italian |
| `pt-BR` | Portuguese (Brazil) |
| `ja-JP` | Japanese |
| `ko-KR` | Korean |
| `zh-CN` | Chinese (Simplified) |
| `ru-RU` | Russian |
| `nl-NL` | Dutch |
| `pl-PL` | Polish |
| `sv-SE` | Swedish |

Phone number formats are locale-specific. Address and date formatting are not yet locale-specific (tracked as a known gap, not a roadmap commitment).

---

## Security Model

- **No remote code** — CSP blocks all external scripts (`script-src 'self'; object-src 'self'`)
- **Minimal declared permissions** — `activeTab`, `scripting`, `storage`; no `host_permissions` entries. The content scripts do run on `<all_urls>` (required for the core fill feature to work on any site), which is a real, broad capability even though it isn't a separate `host_permissions` grant.
- **Not encrypted at rest** — profiles are stored as plain JSON in `chrome.storage.local`. An earlier AES-256-GCM scheme was removed because the encryption key was stored in the same storage area as the ciphertext, which provided no real protection against anything with access to that storage — not stronger than plaintext in practice. If you need encryption-at-rest guarantees, don't store sensitive real data in profiles; they're meant for fake/test data.
- **No telemetry by default** — `telemetryEnabled` defaults to `false` and there's no fixed collection endpoint; if you opt in, you provide your own HTTPS endpoint and only aggregate, scrubbed statistics (no field values, no selectors) are POSTed to it. The endpoint is rejected if it isn't HTTPS or resolves to a loopback/private-network address.
- **XSS safe** — React's auto-escaping + no `dangerouslySetInnerHTML` + no `eval()`
- **Domain blocklist** — hard-coded defaults for banking sites (`paypal.com`, `chase.com`, etc.), user-configurable. Enforced at every entry point that can trigger a fill — toolbar click, hotkey, multi-step chaining, and the content script's own message dispatcher — not just one of them.
- **Sender validation** — the background message dispatcher rejects any message whose sender isn't this extension's own content scripts/popup, as defense-in-depth (no `externally_connectable` is declared, so this isn't reachable externally today).

---

## Test Coverage

18 test suites (unit + integration) covering data generation, error classification/recovery, field detection, form filling across native/React/Vue/Angular-style inputs, hotkey handling, chaining, and the dev-fill helper. Run `npm run test:coverage` for the current numbers — coverage is collected across the whole `src/` tree, including `background/index.ts` and `content/index.ts` (previously excluded, which hid that they had close to 0% coverage).

The thresholds in `jest.config.ts` are a regression floor, not an aspirational target — `background/index.ts` and `content/index.ts` are large browser-bootstrap/wiring files (MutationObservers, hotkey handling, modal detection) that are inherently harder to unit test than pure logic modules. Pure-logic files (`utils.ts`, `data-generator.ts`, `error-recovery.ts`) are held to a meaningfully higher bar in practice; the global number is pulled down by the wiring files.

---

## Roadmap

- **Multi-step form tracking across page navigations** — done (see `chainingEnabled` in Settings), not just planned
- **Locale-aware address & date formatting** — close the gap noted above under Supported Locales
- **Shadow DOM & Web Components support** — not started
- **Firefox + Edge release** — blocked on adopting `webextension-polyfill`; the codebase is currently hard-wired to `chrome.*` APIs throughout
- **TensorFlow.js ML field detection** — under re-evaluation; the current 5-layer heuristic detector already exceeds the coverage this was originally meant to add, so this may be dropped rather than built
- **Under consideration**: undo-last-fill, first-class same-site iframe payment fill (today this falls back to a copy-to-clipboard flow), per-site custom field-type rules, CSV/bulk profile import, popup UI localization

---

## Contributing

Pull requests are welcome. Please:

1. Fork → branch from `main`
2. Follow the existing TypeScript strict-mode conventions
3. Add / update unit tests for changed logic
4. Run `npm run validate` and ensure it passes before opening a PR

---

## License

MIT © 2026 Fake Data Filler Pro contributors
