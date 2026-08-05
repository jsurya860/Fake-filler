/**
 * Global Jest setup – stubs the Chrome Extension API surface
 * so unit tests can run in jsdom without a real browser.
 */

// =============================================================
// chrome.storage.local stub
// =============================================================

const store: Record<string, unknown> = {};

const storageMock = {
  local: {
    get: jest.fn(async (keys: string | string[] | null) => {
      if (keys === null) return { ...store };
      const keyArr = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(keyArr.map((k) => [k, store[k]]));
    }),
    set: jest.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: jest.fn(async (keys: string | string[]) => {
      (typeof keys === 'string' ? [keys] : keys).forEach((k) => delete store[k]);
    }),
    clear: jest.fn(async () => {
      Object.keys(store).forEach((k) => delete store[k]);
    }),
  },
};

// =============================================================
// chrome.runtime stub
// =============================================================

const runtimeMock = {
  id: 'test-extension-id',
  sendMessage: jest.fn(),
  onMessage: {
    addListener: jest.fn(),
    removeListener: jest.fn(),
  },
  onInstalled: {
    addListener: jest.fn(),
  },
  lastError: null as chrome.runtime.LastError | null,
};

// =============================================================
// chrome.tabs stub
// =============================================================

const tabsMock = {
  query: jest.fn(async () => [{ id: 1, url: 'https://example.com' }]),
  sendMessage: jest.fn(),
  onUpdated: { addListener: jest.fn(), removeListener: jest.fn() },
  onRemoved: { addListener: jest.fn(), removeListener: jest.fn() },
};

// =============================================================
// chrome.action stub
// =============================================================

const actionMock = {
  onClicked: { addListener: jest.fn() },
  setBadgeText: jest.fn(),
  setBadgeBackgroundColor: jest.fn(),
};

// =============================================================
// chrome.commands stub
// =============================================================

const commandsMock = {
  onCommand: { addListener: jest.fn() },
};

// =============================================================
// Attach as global
// =============================================================

(global as unknown as { chrome: unknown }).chrome = {
  storage: storageMock,
  runtime: runtimeMock,
  tabs: tabsMock,
  action: actionMock,
  commands: commandsMock,
  scripting: { executeScript: jest.fn() },
};

// =============================================================
// crypto.getRandomValues stub (jsdom doesn't include it)
// =============================================================

Object.defineProperty(global, 'crypto', {
  value: {
    getRandomValues: <T extends ArrayBufferView>(arr: T): T => {
      for (let i = 0; i < (arr as unknown as Uint8Array).length; i++) {
        (arr as unknown as Uint8Array)[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    },
    // Minimal crypto.subtle stub (real implementation tested via integration tests)
    subtle: {
      generateKey: jest.fn(),
      importKey: jest.fn(),
      exportKey: jest.fn(),
      encrypt: jest.fn(),
      decrypt: jest.fn(),
    },
  },
  writable: true,
});

// Polyfill CSS.escape for Jest/jsdom environment
if (!(global as any).CSS) {
  (global as any).CSS = {
    escape: (str: string) => String(str).replace(/(["'\\ ])/g, '\\$1').replace(/([^a-zA-Z0-9_-])/g, (c) => `\\${c}`),
  };
}

// =============================================================
// FormFiller test configuration
// =============================================================
// Set interFieldDelayMs to 0 globally so tests run at full speed.
// This runs in setupFiles context (before Jest framework globals are available),
// so we patch the prototype directly.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { FormFiller } = require('../src/content/form-filler');
  if (FormFiller && FormFiller.prototype) {
    FormFiller.prototype.interFieldDelayMs = 0;
    FormFiller.prototype.domSettleQuietMs = 0;
    FormFiller.prototype.domSettleMaxMs = 0;
  }
} catch {
  // Not available in all test suites — safe to ignore
}

export {};
