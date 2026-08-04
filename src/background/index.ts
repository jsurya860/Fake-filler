import browser from 'webextension-polyfill';
import type { Runtime } from 'webextension-polyfill';
import { MessageHandler } from './message-handler';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants';
import type { ExtensionMessage, ExtensionResponse, FormAnalysis, RadioDiagnostic, Settings } from '@/shared/types';
import { logSwallowed } from '@/shared/messaging';
import { matchesHostnameList } from '@/shared/utils';

// =============================================================
// Background Service Worker Entry Point
// =============================================================

const handler = new MessageHandler();

// -----------------------------------------------------------
// Chaining state – tracks which tabs have chaining active
// -----------------------------------------------------------

interface ChainingEntry {
  startedAt: number;
  fillCount: number;
  timeoutId?: ReturnType<typeof setTimeout> | null;
}

const chainingTabs = new Map<number, ChainingEntry>();

// Guard: tabs currently being filled (prevents overlapping chain fills)
const fillingTabs = new Set<number>();

// Chain log: recent chain step events per tab (for popup display)
interface ChainLogEntry {
  step: number;
  url: string;
  fieldsCount: number;
  ts: number;
}
const chainLogs = new Map<number, ChainLogEntry[]>();

function addChainLog(tabId: number, url: string, fieldsCount: number): void {
  let log = chainLogs.get(tabId);
  if (!log) {
    log = [];
    chainLogs.set(tabId, log);
  }
  const entry = chainingTabs.get(tabId);
  log.push({ step: entry?.fillCount ?? log.length + 1, url, fieldsCount, ts: Date.now() });
  // Keep only last 50 entries
  if (log.length > 50) log.splice(0, log.length - 50);
}

// Store the last radio diagnostic per tab for popup/debugging
interface RadioDiagnosticStoreEntry {
  diag: RadioDiagnostic | null;
  ts: number;
}
const radioDiagnostics = new Map<number, RadioDiagnosticStoreEntry | null>();

// Debug log buffer (keeps recent logs from background + content)
import type { DebugLogEntry } from '@/shared/types';
const debugLogs: DebugLogEntry[] = [];
function pushDebugLog(entry: DebugLogEntry) {
  debugLogs.push(entry);
  // keep only last 500
  if (debugLogs.length > 500) debugLogs.splice(0, debugLogs.length - 500);
}

// Wrap background console methods so background logs are captured too
(() => {
  try {
    const origConsole: Record<DebugLogEntry['level'], (...a: unknown[]) => void> = {
      // eslint-disable-next-line no-console -- capturing the native method reference, not calling it
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      // eslint-disable-next-line no-console -- fallback to native console.log if console.debug is unavailable
      debug: (console.debug ?? console.log).bind(console),
    };

    const levels: DebugLogEntry['level'][] = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of levels) {
      (console as unknown as Record<string, (...a: unknown[]) => void>)[level] = (...args: unknown[]) => {
        try {
          pushDebugLog({ ts: Date.now(), source: 'background', level, message: String(args[0] ?? ''), args });
        } catch (err) {
          origConsole.error('Failed to push debug log', err);
        }
        try {
          origConsole[level](...args);
        } catch (err) {
          // Swallow to avoid breaking background flow
          origConsole.error('Console forwarding failed', err);
        }
      };
    }
  } catch (err) {
    // If wrapping fails, log with the original console
    console.error('[FDF Pro] console wrapper init failed', err);
  }
})();

function enableChaining(tabId: number, _settings?: Settings): void {
  disableChaining(tabId); // clear any previous entry

  // Do not auto-disable chaining on a timeout — chaining remains active
  // until the user explicitly disables it via the popup. Keep timeoutId
  // as null for compatibility with existing cleanup code.
  chainingTabs.set(tabId, { startedAt: Date.now(), fillCount: 0, timeoutId: null });

  void browser.action.setBadgeText({ tabId, text: '⛓' });
  void browser.action.setBadgeBackgroundColor({ tabId, color: '#4CAF50' });
  console.info('[FDF Pro] chaining enabled on tab', tabId);
}

function disableChaining(tabId: number): void {
  const entry = chainingTabs.get(tabId);
  if (!entry) return;
  if (entry.timeoutId) clearTimeout(entry.timeoutId);
  chainingTabs.delete(tabId);
  // Keep chainLogs so popup can still review them after stopping

  // .catch (not try/catch) — setBadgeText is promise-based; a sync try/catch
  // here would never actually observe a rejection (e.g. tab already closed).
  void browser.action.setBadgeText({ tabId, text: '' }).catch((e: unknown) => logSwallowed('src/background/index.ts:disableChaining', e));

  // Notify the content script to stop monitoring
  try {
    browser.tabs.sendMessage(tabId, { action: 'DISABLE_CHAINING' }).catch(() => { /* tab may be gone */ });
  } catch {
    // ignore
  }
  console.info('[FDF Pro] chaining disabled on tab', tabId);
}

/** Increments chain count; returns false if max steps reached (caller should disable). */
function incrementChainCount(tabId: number, maxSteps: number): boolean {
  const entry = chainingTabs.get(tabId);
  if (!entry) return false;
  // If we've already reached or exceeded maxSteps, don't increment further.
  if (entry.fillCount >= maxSteps) {
    void browser.action.setBadgeText({ tabId, text: `⛓${entry.fillCount}` }).catch((e: unknown) => logSwallowed('src/background/index.ts:incrementChainCount', e));
    return true; // indicate max reached
  }
  entry.fillCount++;
  // Update badge with step count
  void browser.action.setBadgeText({ tabId, text: `⛓${entry.fillCount}` }).catch((e: unknown) => logSwallowed('src/background/index.ts:incrementChainCount', e));
  return entry.fillCount >= maxSteps;
}

browser.runtime.onMessage.addListener(async (
  rawMessage: unknown,
  sender: Runtime.MessageSender,
): Promise<ExtensionResponse> => {
  const message = rawMessage as ExtensionMessage;
  // Defense-in-depth: reject messages not from this extension's own
  // content scripts/popup (see MessageHandler.handle for the same guard).
  if (sender.id !== browser.runtime.id) {
    return { success: false, error: 'Untrusted sender' };
  }

  // PING — used by content script to wake the service worker after SW sleep.
  if (message.action === 'PING') {
    return { success: true };
  }

  // Handle CHAIN_FILL_REQUEST from content script (SPA chaining)
  if (message.action === 'CHAIN_FILL_REQUEST') {
    const tabId = sender.tab?.id;
    if (!tabId || !chainingTabs.has(tabId)) {
      return { success: false, error: 'Chaining not active' };
    }
    // Prevent overlapping fills on the same tab
    if (fillingTabs.has(tabId)) {
      return { success: true, data: { skipped: true, reason: 'fillInProgress' } };
    }
    fillingTabs.add(tabId);
    try {
      const settings = await getSettings();
      const reachedMax = incrementChainCount(tabId, settings.maxChainSteps);
      if (reachedMax) {
        console.info('[FDF Pro] chaining: max steps reached on tab', tabId);
        // Do not disable automatically; chaining remains active until user stops it.
        return { success: true, data: { stopped: false, reason: 'maxSteps' } };
      }
      const { forms } = message.payload as { forms: FormAnalysis[] };
      await fillForms(tabId, forms, settings);
      return { success: true, data: { filled: true } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    } finally {
      fillingTabs.delete(tabId);
    }
  }

  // Get chaining state for the active tab (popup queries)
  if (message.action === 'GET_CHAINING_STATE') {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      const entry = tabId ? chainingTabs.get(tabId) : undefined;
      return { success: true, data: { active: !!entry, fillCount: entry?.fillCount ?? 0, startedAt: entry?.startedAt ?? null } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Start chaining from the popup (on demand)
  if (message.action === 'START_CHAINING') {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      if (!tabId) {
        return { success: false, error: 'No active tab' };
      }
      const settings = await getSettings();
      // Clear old log for this tab
      chainLogs.delete(tabId);
      enableChaining(tabId, settings);
      // Tell content script to start monitoring
      browser.tabs.sendMessage(tabId, { action: 'ENABLE_CHAINING' }).catch(() => { /* ignore */ });
      // Immediately analyze & fill the current page
      let analyzeResp: ExtensionResponse<FormAnalysis[]> | undefined;
      try {
        analyzeResp = await browser.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' });
      } catch {
        return { success: true, data: { started: true, filled: false } };
      }
      if (analyzeResp?.success && analyzeResp.data && analyzeResp.data.length > 0) {
        await fillForms(tabId, analyzeResp.data, settings);
        addChainLog(tabId, tab.url ?? '', analyzeResp.data.reduce((s, f) => s + f.fields.length, 0));
      }
      return { success: true, data: { started: true, filled: !!(analyzeResp?.data?.length) } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Get chain log for the active tab
  if (message.action === 'GET_CHAIN_LOG') {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      const log = tabId ? chainLogs.get(tabId) ?? [] : [];
      return { success: true, data: log };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Report a radio diagnostic from the content script
  if (message.action === 'REPORT_RADIO_DIAGNOSTIC') {
    try {
      const tabId = sender.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) {
        return { success: false, error: 'No active tab' };
      }
      radioDiagnostics.set(tabId, { diag: (message.payload as RadioDiagnostic | undefined) ?? null, ts: Date.now() });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Allow popup to fetch the last radio diagnostic for the active tab
  if (message.action === 'GET_RADIO_DIAGNOSTIC') {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const tabId = tab?.id;
      const entry = tabId ? radioDiagnostics.get(tabId) ?? null : null;
      return { success: true, data: entry?.diag ?? null };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Content/background log reports
  if (message.action === 'REPORT_DEBUG_LOG') {
    try {
      const payload = message.payload as DebugLogEntry | DebugLogEntry[] | undefined;
      if (!payload) {
        return { success: false, error: 'No payload' };
      }
      const entries = Array.isArray(payload) ? payload : [payload];
      for (const e of entries) {
        // normalize ts
        const entry = { ts: e.ts ?? Date.now(), source: e.source ?? 'content', level: e.level ?? 'log', message: e.message ?? String(e.args?.[0] ?? ''), args: e.args ?? [] } as DebugLogEntry;
        pushDebugLog(entry);
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  if (message.action === 'GET_DEBUG_LOGS') {
    try {
      // return a shallow copy
      return { success: true, data: debugLogs.slice() };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  if (message.action === 'CLEAR_DEBUG_LOGS') {
    try {
      debugLogs.length = 0;
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // Allow popup to disable chaining for the active tab
  if (message.action === 'DISABLE_CHAINING') {
    try {
      // If sender includes a tab, prefer it; otherwise use active tab
      const tabId = sender.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (!tabId) {
        return { success: false, error: 'No active tab' };
      }
      disableChaining(tabId);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  return handler.handle(message, sender);
});

// Keep the service worker alive during long async operations
// (Chrome MV3 service workers may be terminated otherwise)
browser.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.info('[FDF Pro] Extension installed.');
  } else if (reason === 'update') {
    console.info('[FDF Pro] Extension updated.');
  }
});

// -----------------------------------------------------------
// Read settings directly from storage (avoid self-messaging)
// -----------------------------------------------------------

async function getSettings(): Promise<Settings> {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.SETTINGS);
    if (stored[STORAGE_KEYS.SETTINGS]) {
      return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] as Partial<Settings>) };
    }
  } catch {
    // Ignore storage errors and fall back to defaults
  }
  return { ...DEFAULT_SETTINGS };
}

// -----------------------------------------------------------
// Domain blocklist — checked here too, not just in the content
// script, so a toolbar click or an active chaining session can never
// fill a form on a blocklisted domain (e.g. banking sites) even if the
// content script's own gate is bypassed or hasn't loaded yet.
// -----------------------------------------------------------

function isUrlBlocked(url: string | undefined, blacklist: string[]): boolean {
  if (!url) return false;
  try {
    return matchesHostnameList(new URL(url).hostname, blacklist);
  } catch (e) {
    logSwallowed('src/background/index.ts:isUrlBlocked', e);
    return false;
  }
}

// -----------------------------------------------------------
// Action click handler – fill the first detected form silently
// -----------------------------------------------------------
browser.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;

  console.info('[FDF Pro] action clicked, requesting analysis on tab', tabId);
  // Ask the content script to analyze forms on the active tab
  void (async () => {
    let analyzeResp: ExtensionResponse<FormAnalysis[]> | undefined;
    try {
      analyzeResp = await browser.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' });
    } catch (err) {
      console.warn('[FDF Pro] analyze message error:', (err as Error).message);

      // Fallback: try injecting the built content script into the page and retry
      try {
        console.info('[FDF Pro] attempting to inject content script fallback');
        await browser.scripting.executeScript({ target: { tabId }, files: ['src/content/index.js'] });
        // Retry sending the analyze message once after injection
        try {
          const retryResp: ExtensionResponse<FormAnalysis[]> | undefined = await browser.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' });
          void processAnalyzeResponse(tabId, retryResp);
        } catch (retryErr) {
          console.warn('[FDF Pro] analyze retry error:', (retryErr as Error).message);
        }
      } catch (e) {
        console.warn('[FDF Pro] injection failed', e);
      }
      return;
    }
    void processAnalyzeResponse(tabId, analyzeResp);
  })();
});

async function processAnalyzeResponse(
  tabId: number,
  analyzeResp: ExtensionResponse<FormAnalysis[]> | undefined,
): Promise<void> {
  console.info('[FDF Pro] analyzeResp:', analyzeResp);
  if (!analyzeResp || !analyzeResp.success) return;
  const forms = analyzeResp.data;
  if (!forms || forms.length === 0) {
    console.info('[FDF Pro] no forms detected');
    return;
  }

  // Read settings directly from storage instead of self-messaging
  const settings = await getSettings();
  if (settings.autoFillOnAction === false) {
    console.info('[FDF Pro] autoFillOnAction is disabled; aborting fill.');
    return;
  }

  await fillForms(tabId, forms, settings);

  // Enable chaining if the setting is on
  if (settings.chainingEnabled) {
    enableChaining(tabId, settings);
    browser.tabs.sendMessage(tabId, { action: 'ENABLE_CHAINING' }).catch(() => { /* ignore */ });
  }
}

// -----------------------------------------------------------
// Shared helper: generate data & fill every detected form
// -----------------------------------------------------------

async function fillForms(tabId: number, forms: FormAnalysis[], settings: Settings): Promise<void> {
  // Single choke point for every fill path (toolbar click, hotkey, and
  // chaining) — never fill a blocklisted domain, regardless of how the
  // fill was triggered or whether the content script's own gate ran.
  try {
    const tab = await browser.tabs.get(tabId);
    if (isUrlBlocked(tab.url, settings.domainBlacklist)) {
      console.info('[FDF Pro] fillForms: blocked domain, refusing to fill on tab', tabId, tab.url);
      return;
    }
  } catch (e) {
    logSwallowed('src/background/index.ts:fillForms:blocklist-check', e);
  }

  for (const formAnalysis of forms) {
    try {
      const enriched = await handler.generateDataForFormDirect(formAnalysis);
      console.info('[FDF Pro] generated enriched form for selector', enriched.selector);

      try {
        const fillResp = await browser.tabs.sendMessage(
          tabId,
          { action: 'FILL_FORM', payload: { formAnalysis: enriched, maxRetries: settings.maxRetryAttempts } },
        );
        console.info('[FDF Pro] fillResp for', enriched.selector, ':', fillResp);

        if (settings.telemetryEnabled) {
          try {
            const store = await browser.storage.local.get('telemetry');
            const t = (store.telemetry as { fillCount?: number }) ?? { fillCount: 0 };
            t.fillCount = (t.fillCount ?? 0) + 1;
            await browser.storage.local.set({ telemetry: t });
          } catch (e) { logSwallowed('src/background/index.ts:fillForms:telemetry', e); }
        }
      } catch (err) {
        console.warn('[FDF Pro] fill message error:', (err as Error).message);
      }
    } catch (err) {
      console.error('[FDF Pro] generateDataForFormDirect error:', err);
    }
  }

  // Auto-submit: click the form's submit/next button after filling
  if (settings.autoSubmitOnChaining && chainingTabs.has(tabId)) {
    try {
      // Small delay before clicking submit so validation completes
      await new Promise((r) => setTimeout(r, 800));
      try {
        const resp = await browser.tabs.sendMessage(tabId, { action: 'AUTO_SUBMIT' });
        // If auto-submit couldn't find a Next/Submit button, the wizard
        // is likely done — disable chaining to prevent endless loops.
        const result = (resp as ExtensionResponse<{ clicked: boolean }>)?.data;
        if (result && !result.clicked) {
          console.info('[FDF Pro] auto-submit found no button — stopping chain on tab', tabId);
          disableChaining(tabId);
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  }
}

// Keyboard shortcut support: trigger the same action when a command fires.
browser.commands?.onCommand.addListener((command) => {
  if (command !== 'trigger-fill') return;
  void (async () => {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0] || !tabs[0].id) return;
      const tabId = tabs[0].id;
      try {
        const resp = await browser.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' });
        void processAnalyzeResponse(tabId, resp as ExtensionResponse<FormAnalysis[]>);
      } catch { /* ignore */ }
    } catch (e) {
      logSwallowed('src/background/index.ts:onCommand', e);
    }
  })();
});

// -----------------------------------------------------------
// Chaining: auto-fill after full-page navigation
// -----------------------------------------------------------

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  if (!chainingTabs.has(tabId)) return;

  console.info('[FDF Pro] chaining: tab navigated, checking for forms on tab', tabId);

  // Configurable delay to let the content script bootstrap on the new page
  void (async () => {
    const settings = await getSettings();
    const delay = Math.max(500, settings.chainingDelayMs ?? 500);

    setTimeout(() => {
      void (async () => {
        let analyzeResp: ExtensionResponse<FormAnalysis[]> | undefined;
        try {
          analyzeResp = await browser.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' });
        } catch {
          console.info('[FDF Pro] chaining: content script not ready, will retry on next navigation for tab', tabId);
          return;
        }

        if (!analyzeResp?.success || !analyzeResp.data || analyzeResp.data.length === 0) {
          console.info('[FDF Pro] chaining: no forms on new page, leaving chaining active for tab', tabId);
          return;
        }

        // Increment the chain count; if max steps is reached we do not
        // automatically disable chaining — keep it active until the user
        // explicitly disables it via the popup.
        const reachedMax = incrementChainCount(tabId, settings.maxChainSteps);
        if (reachedMax) {
          console.info('[FDF Pro] chaining: max steps reached on tab', tabId);
          // Do not disable; simply return so we don't perform another fill.
          return;
        }

        // Log this chain step
        try {
          const tab = await browser.tabs.get(tabId);
          addChainLog(tabId, tab.url ?? '', analyzeResp.data.reduce((s, f) => s + f.fields.length, 0));
        } catch { /* ignore */ }

        await fillForms(tabId, analyzeResp.data, settings);

        // Re-enable chaining on the content script (new page = new content script)
        browser.tabs.sendMessage(tabId, { action: 'ENABLE_CHAINING' }).catch(() => { /* ignore */ });
      })();
    }, delay);
  })();
});

// Clean up chaining state when a tab is closed
browser.tabs.onRemoved.addListener((tabId) => {
  const entry = chainingTabs.get(tabId);
  if (entry) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    chainingTabs.delete(tabId);
    chainLogs.delete(tabId);
    console.info('[FDF Pro] chaining: tab closed, cleaned up tab', tabId);
  }
});

export {};
