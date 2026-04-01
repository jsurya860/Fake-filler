# Fake Data Filler Pro

A **robust, future-friendly** browser extension that intelligently fills web forms with realistic fake data — featuring context-aware field detection, built-in error recovery, encrypted profile management, and a polished React popup UI.

---

## Features

| Feature | Description |
|---|---|
| **Smart detection** | Identifies field types via HTML5 attributes → autocomplete hints → regex patterns → heuristic analysis |
| **Locale-aware generation** | 14 locales with correct phone formats, date formats, addresses, and names |
| **Consistent persona** | Name, email, username all derived from the same generated identity |
| **Error recovery** | Detects validation errors after submission, classifies them, and auto-retries affected fields |
| **Encrypted profiles** | AES-256-GCM encryption via Web Crypto API — all data stays local |
| **React popup** | Preview and edit every field value before filling; per-field skip controls |
| **Manifest V3** | Built on the latest Chrome Extension standard for forward compatibility |
| **Zero backend** | No network requests, no telemetry, no third-party services |

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
│   │   └── utils.ts            # Pure helpers (Luhn, crypto random, date utils…)
│   │
│   ├── background/             # MV3 Service Worker
│   │   ├── index.ts            # Entry – wires up message listener
│   │   ├── data-generator.ts   # Faker.js-backed data generation per field type
│   │   ├── error-recovery.ts   # Error classification & recovery actions
│   │   ├── profile-manager.ts  # AES-256-GCM encrypted profile CRUD
│   │   └── message-handler.ts  # Routes chrome.runtime messages
│   │
│   ├── content/                # Injected into web pages
│   │   ├── index.ts            # Entry – detection, filling, error observation
│   │   ├── form-detection.ts   # DOM scanning, field analysis, CSS selector generation
│   │   └── form-filler.ts      # Fills fields with React/Angular/Vue compatibility
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
│           └── SettingsPanel.tsx   # All extension settings with toggle switches
│
└── tests/
    ├── setup.ts                    # Chrome API + crypto stubs for Jest
    └── unit/
        ├── data-generator.test.ts  # Full generator coverage
        ├── error-recovery.test.ts  # Error classification & recovery
        └── utils.test.ts           # Pure utility functions
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- npm 10+

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
│   ├─ profile-manager.ts  (AES-256-GCM, crypto.subtle)      │
│   └─ error-recovery.ts   (classify, recover, learn)        │
└───────────────────────┬────────────────────────────────────┘
                        │ chrome.tabs.sendMessage
                        ▼
┌────────────────────────────────────────────────────────────┐
│  Content Script (injected into web pages)                  │
│  form-detection.ts  – DOM scan, field type classification  │
│  form-filler.ts     – Fill with native setter + events     │
│  index.ts           – MutationObserver, error observation  │
└────────────────────────────────────────────────────────────┘
                        │ chrome.storage.local (encrypted)
                        ▼
┌────────────────────────────────────────────────────────────┐
│  Local Storage (AES-256-GCM)                               │
│  • Profiles   • Settings   • Error learning DB             │
└────────────────────────────────────────────────────────────┘
```

---

## Field Detection Priority

1. **HTML5 `type` attribute** — `email`, `tel`, `password`, `date`, `url`, `color`, `range`, `file`
2. **`autocomplete` attribute** — `given-name`, `family-name`, `postal-code`, `cc-number`, etc.
3. **Regex patterns** (name, id, label, placeholder, aria-label combined) — ordered by specificity
4. **Heuristic fallback** — defaults to `text`

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

---

## Security Model

- **No remote code** — CSP blocks all external scripts
- **Minimal permissions** — `activeTab`, `scripting`, `storage` only; no `<all_urls>` host permissions
- **Encrypted at rest** — AES-256-GCM via `crypto.subtle`; 256-bit key generated on first install
- **No telemetry** — zero outbound network calls
- **XSS safe** — React's auto-escaping + no `dangerouslySetInnerHTML` + no `eval()`
- **Domain blocklist** — hard-coded defaults for banking sites; user-configurable

---

## Test Coverage Targets

| Domain | Target |
|---|---|
| `utils.ts` | 100% |
| `data-generator.ts` | 85% |
| `error-recovery.ts` | 80% |
| `form-detection.ts` | 75% |
| Overall | ≥ 80% |

---

## Roadmap

- **v1.1** — TensorFlow.js ML model for improved field detection accuracy
- **v1.2** — Multi-step form tracking across page navigations
- **v1.3** — Shadow DOM & Web Components support
- **v2.0** — Firefox + Edge release; shared encrypted team profiles

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
