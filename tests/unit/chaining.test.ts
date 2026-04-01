import type { FieldAnalysis, FormAnalysis, Settings } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

// =============================================================
// formFingerprint – extracted inline for unit-testing
// (mirrors the implementation in src/content/index.ts)
// =============================================================

function formFingerprint(fields: Pick<FieldAnalysis, 'name' | 'id' | 'htmlType'>[]): string {
  return fields
    .map((f) => `${f.name || f.id}:${f.htmlType}`)
    .sort()
    .join('|');
}

// =============================================================
// formFingerprint tests
// =============================================================

describe('formFingerprint()', () => {
  const makeField = (name: string, htmlType: string, id?: string) =>
    ({ name, htmlType, id: id ?? name }) as Pick<FieldAnalysis, 'name' | 'id' | 'htmlType'>;

  it('produces a deterministic string for a set of fields', () => {
    const fields = [makeField('email', 'email'), makeField('password', 'password')];
    const fp = formFingerprint(fields);
    expect(fp).toBe('email:email|password:password');
  });

  it('produces the same fingerprint regardless of field order', () => {
    const a = [makeField('email', 'email'), makeField('name', 'text')];
    const b = [makeField('name', 'text'), makeField('email', 'email')];
    expect(formFingerprint(a)).toBe(formFingerprint(b));
  });

  it('produces different fingerprints for different field sets', () => {
    const step1 = [makeField('firstName', 'text'), makeField('lastName', 'text')];
    const step2 = [makeField('address', 'text'), makeField('city', 'text')];
    expect(formFingerprint(step1)).not.toBe(formFingerprint(step2));
  });

  it('uses id when name is empty', () => {
    const fields = [makeField('', 'text', 'field-0')];
    expect(formFingerprint(fields)).toBe('field-0:text');
  });

  it('returns empty string for empty array', () => {
    expect(formFingerprint([])).toBe('');
  });

  it('detects when a field type changes (same name, different htmlType)', () => {
    const v1 = [makeField('dob', 'text')];
    const v2 = [makeField('dob', 'date')];
    expect(formFingerprint(v1)).not.toBe(formFingerprint(v2));
  });
});

// =============================================================
// Chaining settings defaults
// =============================================================

describe('Chaining settings defaults', () => {
  it('chainingEnabled defaults to false', () => {
    expect(DEFAULT_SETTINGS.chainingEnabled).toBe(false);
  });

  it('chainingTimeoutMs defaults to 600000 (10 minutes)', () => {
    expect(DEFAULT_SETTINGS.chainingTimeoutMs).toBe(600_000);
  });

  it('maxChainSteps defaults to 10', () => {
    expect(DEFAULT_SETTINGS.maxChainSteps).toBe(10);
  });

  it('chainingDelayMs defaults to 500', () => {
    expect(DEFAULT_SETTINGS.chainingDelayMs).toBe(500);
  });

  it('autoSubmitOnChaining defaults to false', () => {
    expect(DEFAULT_SETTINGS.autoSubmitOnChaining).toBe(false);
  });
});

// =============================================================
// Background chaining helpers (unit-tested via extracted logic)
// =============================================================

describe('Background chaining state', () => {
  // Simulate the chaining state management from background/index.ts
  const chainingTabs = new Map<number, { startedAt: number; fillCount: number; timeoutId: ReturnType<typeof setTimeout> }>();

  function enableChaining(tabId: number, timeoutMs: number): void {
    disableChaining(tabId);
    const timeoutId = setTimeout(() => disableChaining(tabId), timeoutMs);
    chainingTabs.set(tabId, { startedAt: Date.now(), fillCount: 0, timeoutId });
  }

  function disableChaining(tabId: number): void {
    const entry = chainingTabs.get(tabId);
    if (!entry) return;
    clearTimeout(entry.timeoutId);
    chainingTabs.delete(tabId);
  }

  function incrementChainCount(tabId: number, maxSteps: number): boolean {
    const entry = chainingTabs.get(tabId);
    if (!entry) return false;
    entry.fillCount++;
    return entry.fillCount < maxSteps;
  }

  afterEach(() => {
    for (const [tabId] of chainingTabs) {
      disableChaining(tabId);
    }
  });

  it('enableChaining adds a tab to the map', () => {
    enableChaining(10, 60_000);
    expect(chainingTabs.has(10)).toBe(true);
    disableChaining(10);
  });

  it('disableChaining removes the tab', () => {
    enableChaining(10, 60_000);
    disableChaining(10);
    expect(chainingTabs.has(10)).toBe(false);
  });

  it('enableChaining replaces previous entry for same tab', () => {
    enableChaining(10, 60_000);
    const first = chainingTabs.get(10)!;
    enableChaining(10, 60_000);
    const second = chainingTabs.get(10)!;
    expect(second).not.toBe(first);
    disableChaining(10);
  });

  it('incrementChainCount returns true while under limit', () => {
    enableChaining(10, 60_000);
    expect(incrementChainCount(10, 3)).toBe(true); // count 1
    expect(incrementChainCount(10, 3)).toBe(true); // count 2
    expect(incrementChainCount(10, 3)).toBe(false); // count 3 → at limit
    disableChaining(10);
  });

  it('incrementChainCount returns false if tab not tracked', () => {
    expect(incrementChainCount(999, 10)).toBe(false);
  });

  it('disableChaining is idempotent for unknown tabs', () => {
    expect(() => disableChaining(999)).not.toThrow();
  });
});

// =============================================================
// Content-side chaining state logic
// =============================================================

describe('Content chaining state', () => {
  let chainingActive = false;
  let lastFilledFingerprint = '';

  const makeField = (name: string, htmlType: string) =>
    ({ name, htmlType, id: name }) as Pick<FieldAnalysis, 'name' | 'id' | 'htmlType'>;

  beforeEach(() => {
    chainingActive = false;
    lastFilledFingerprint = '';
  });

  it('should not trigger chain fill when chaining is inactive', () => {
    const fields = [makeField('email', 'email')];
    const fp = formFingerprint(fields);
    // Simulating the pageObserver logic
    const shouldTrigger = chainingActive && fp !== lastFilledFingerprint;
    expect(shouldTrigger).toBe(false);
  });

  it('should trigger chain fill when chaining is active and fingerprint changes', () => {
    chainingActive = true;
    lastFilledFingerprint = formFingerprint([makeField('name', 'text')]);
    const newFields = [makeField('address', 'text'), makeField('city', 'text')];
    const fp = formFingerprint(newFields);
    const shouldTrigger = chainingActive && fp !== lastFilledFingerprint;
    expect(shouldTrigger).toBe(true);
  });

  it('should NOT re-trigger for same form fingerprint', () => {
    chainingActive = true;
    const fields = [makeField('email', 'email')];
    lastFilledFingerprint = formFingerprint(fields);
    const fp = formFingerprint(fields);
    const shouldTrigger = chainingActive && fp !== lastFilledFingerprint;
    expect(shouldTrigger).toBe(false);
  });

  it('should detect wizard step change (same form element, different fields)', () => {
    chainingActive = true;
    const step1 = [makeField('firstName', 'text'), makeField('lastName', 'text'), makeField('email', 'email')];
    const step2 = [makeField('address', 'text'), makeField('city', 'text'), makeField('zipCode', 'text')];
    lastFilledFingerprint = formFingerprint(step1);
    const fp = formFingerprint(step2);
    expect(fp).not.toBe(lastFilledFingerprint);
    const shouldTrigger = chainingActive && fp !== lastFilledFingerprint;
    expect(shouldTrigger).toBe(true);
  });

  it('updates lastFilledFingerprint after fill to prevent re-trigger', () => {
    chainingActive = true;
    const fields = [makeField('email', 'email')];
    lastFilledFingerprint = formFingerprint(fields);
    // After fill, fingerprint should match — no re-trigger
    const shouldTrigger = chainingActive && formFingerprint(fields) !== lastFilledFingerprint;
    expect(shouldTrigger).toBe(false);
  });
});

// =============================================================
// MessageAction type includes chaining actions
// =============================================================

describe('MessageAction chaining types', () => {
  it('ENABLE_CHAINING is a valid message action', () => {
    const action: import('../../src/shared/types').MessageAction = 'ENABLE_CHAINING';
    expect(action).toBe('ENABLE_CHAINING');
  });

  it('DISABLE_CHAINING is a valid message action', () => {
    const action: import('../../src/shared/types').MessageAction = 'DISABLE_CHAINING';
    expect(action).toBe('DISABLE_CHAINING');
  });

  it('CHAIN_FILL_REQUEST is a valid message action', () => {
    const action: import('../../src/shared/types').MessageAction = 'CHAIN_FILL_REQUEST';
    expect(action).toBe('CHAIN_FILL_REQUEST');
  });

  it('START_CHAINING is a valid message action', () => {
    const action: import('../../src/shared/types').MessageAction = 'START_CHAINING';
    expect(action).toBe('START_CHAINING');
  });

  it('GET_CHAIN_LOG is a valid message action', () => {
    const action: import('../../src/shared/types').MessageAction = 'GET_CHAIN_LOG';
    expect(action).toBe('GET_CHAIN_LOG');
  });

  it('AUTO_SUBMIT is a valid message action', () => {
    const action: import('../../src/shared/types').MessageAction = 'AUTO_SUBMIT';
    expect(action).toBe('AUTO_SUBMIT');
  });
});

// =============================================================
// Chain log helper (mirrors background/index.ts addChainLog)
// =============================================================

describe('Chain log', () => {
  interface ChainLogEntry {
    step: number;
    url: string;
    fieldsCount: number;
    ts: number;
  }
  const chainLogs = new Map<number, ChainLogEntry[]>();

  function addChainLog(tabId: number, url: string, fieldsCount: number, fillCount: number): void {
    if (!chainLogs.has(tabId)) chainLogs.set(tabId, []);
    const log = chainLogs.get(tabId)!;
    log.push({ step: fillCount, url, fieldsCount, ts: Date.now() });
    if (log.length > 50) log.splice(0, log.length - 50);
  }

  afterEach(() => chainLogs.clear());

  it('adds entries for a tab', () => {
    addChainLog(1, 'https://example.com/step1', 5, 1);
    addChainLog(1, 'https://example.com/step2', 3, 2);
    expect(chainLogs.get(1)?.length).toBe(2);
    expect(chainLogs.get(1)?.[0].url).toBe('https://example.com/step1');
    expect(chainLogs.get(1)?.[1].step).toBe(2);
  });

  it('keeps only last 50 entries', () => {
    for (let i = 0; i < 55; i++) {
      addChainLog(2, `https://example.com/step${i}`, 1, i);
    }
    expect(chainLogs.get(2)?.length).toBe(50);
  });

  it('separate logs per tab', () => {
    addChainLog(10, 'https://a.com', 2, 1);
    addChainLog(20, 'https://b.com', 4, 1);
    expect(chainLogs.get(10)?.length).toBe(1);
    expect(chainLogs.get(20)?.length).toBe(1);
  });
});

// =============================================================
// Auto-submit button detection (mirrors content/index.ts autoSubmitForm)
// =============================================================

describe('Auto-submit button detection', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clicks a submit button inside a form', () => {
    document.body.innerHTML = '<form><button type="submit" id="sub">Submit</button></form>';
    const btn = document.querySelector<HTMLElement>('#sub')!;
    const clicked = { v: false };
    btn.addEventListener('click', () => { clicked.v = true; });
    // Simulate the autoSubmitForm logic
    const sel = 'form button[type="submit"]';
    const found = document.querySelector<HTMLElement>(sel);
    expect(found).toBeTruthy();
    found!.click();
    expect(clicked.v).toBe(true);
  });

  it('finds a Next button by text content', () => {
    document.body.innerHTML = '<div><button id="nxt">Next</button></div>';
    const textPatterns = /^(next|submit|continue|proceed|save|send|go|weiter|suivant|enviar|invia|siguiente)$/i;
    const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
    const match = allButtons.find((b) => textPatterns.test(b.textContent?.trim() ?? ''));
    expect(match).toBeTruthy();
    expect(match!.textContent?.trim()).toBe('Next');
  });

  it('does not match arbitrary button text', () => {
    document.body.innerHTML = '<div><button>Cancel</button></div>';
    const textPatterns = /^(next|submit|continue|proceed|save|send|go|weiter|suivant|enviar|invia|siguiente)$/i;
    const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button'));
    const match = allButtons.find((b) => textPatterns.test(b.textContent?.trim() ?? ''));
    expect(match).toBeUndefined();
  });
});
