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

  void chrome.action.setBadgeText({ tabId, text: '\u26D3' });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#4CAF50' });
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
  void chrome.action.setBadgeText({ tabId, text: '' }).catch((e: unknown) => logSwallowed('src/background/index.ts:disableChaining', e));

  // Notify the content script to stop monitoring
  try {
    chrome.tabs.sendMessage(tabId, { action: 'DISABLE_CHAINING' }, () => {
      if (chrome.runtime.lastError) { /* tab may be gone */ }
    });
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
    void chrome.action.setBadgeText({ tabId, text: `\u26D3${entry.fillCount}` }).catch((e: unknown) => logSwallowed('src/background/index.ts:incrementChainCount', e));
    return true; // indicate max reached
  }
  entry.fillCount++;
  // Update badge with step count
  void chrome.action.setBadgeText({ tabId, text: `\u26D3${entry.fillCount}` }).catch((e: unknown) => logSwallowed('src/background/index.ts:incrementChainCount', e));
  return entry.fillCount >= maxSteps;
}

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ) => {
    // Defense-in-depth: reject messages not from this extension's own
    // content scripts/popup (see MessageHandler.handle for the same guard).
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: 'Untrusted sender' });
      return false;
    }

    // PING — used by content script to wake the service worker after SW sleep.
    if (message.action === 'PING') {
      sendResponse({ success: true });
      return false;
    }

    // Handle CHAIN_FILL_REQUEST from content script (SPA chaining)
    if (message.action === 'CHAIN_FILL_REQUEST') {
      const tabId = sender.tab?.id;
      if (!tabId || !chainingTabs.has(tabId)) {
        sendResponse({ success: false, error: 'Chaining not active' });
        return false;
      }
      // Prevent overlapping fills on the same tab
      if (fillingTabs.has(tabId)) {
        sendResponse({ success: true, data: { skipped: true, reason: 'fillInProgress' } });
        return false;
      }
      void (async () => {
        fillingTabs.add(tabId);
        try {
          const settings = await getSettings();
          const reachedMax = incrementChainCount(tabId, settings.maxChainSteps);
          if (reachedMax) {
            console.info('[FDF Pro] chaining: max steps reached on tab', tabId);
            // Do not disable automatically; chaining remains active until user stops it.
            sendResponse({ success: true, data: { stopped: false, reason: 'maxSteps' } });
            return;
          }
          const { forms } = message.payload as { forms: FormAnalysis[] };
          await fillForms(tabId, forms, settings);
          sendResponse({ success: true, data: { filled: true } });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        } finally {
          fillingTabs.delete(tabId);
        }
      })();
      return true; // keep channel open
    }

    // Get chaining state for the active tab (popup queries)
    if (message.action === 'GET_CHAINING_STATE') {
      void (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tab?.id;
          const entry = tabId ? chainingTabs.get(tabId) : undefined;
          sendResponse({ success: true, data: { active: !!entry, fillCount: entry?.fillCount ?? 0, startedAt: entry?.startedAt ?? null } });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // Start chaining from the popup (on demand)
    if (message.action === 'START_CHAINING') {
      void (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tab?.id;
          if (!tabId) {
            sendResponse({ success: false, error: 'No active tab' });
            return;
          }
          const settings = await getSettings();
          // Clear old log for this tab
          chainLogs.delete(tabId);
          enableChaining(tabId, settings);
          // Tell content script to start monitoring
          chrome.tabs.sendMessage(tabId, { action: 'ENABLE_CHAINING' }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
          // Immediately analyze & fill the current page
          chrome.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' }, (analyzeResp) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: true, data: { started: true, filled: false } });
              return;
            }
            void (async () => {
              const resp = analyzeResp as ExtensionResponse<FormAnalysis[]> | undefined;
              if (resp?.success && resp.data && resp.data.length > 0) {
                await fillForms(tabId, resp.data, settings);
                addChainLog(tabId, tab.url ?? '', resp.data.reduce((s, f) => s + f.fields.length, 0));
              }
              sendResponse({ success: true, data: { started: true, filled: !!(resp?.data?.length) } });
            })();
          });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // Get chain log for the active tab
    if (message.action === 'GET_CHAIN_LOG') {
      void (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tab?.id;
          const log = tabId ? chainLogs.get(tabId) ?? [] : [];
          sendResponse({ success: true, data: log });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // Report a radio diagnostic from the content script
    if (message.action === 'REPORT_RADIO_DIAGNOSTIC') {
      void (async () => {
        try {
          const tabId = sender.tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (!tabId) {
            sendResponse({ success: false, error: 'No active tab' });
            return;
          }
          radioDiagnostics.set(tabId, { diag: (message.payload as RadioDiagnostic | undefined) ?? null, ts: Date.now() });
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // Allow popup to fetch the last radio diagnostic for the active tab
    if (message.action === 'GET_RADIO_DIAGNOSTIC') {
      void (async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          const tabId = tab?.id;
          const entry = tabId ? radioDiagnostics.get(tabId) ?? null : null;
          sendResponse({ success: true, data: entry?.diag ?? null });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // Content/background log reports
    if (message.action === 'REPORT_DEBUG_LOG') {
      try {
        const payload = message.payload as DebugLogEntry | DebugLogEntry[] | undefined;
        if (!payload) {
          sendResponse({ success: false, error: 'No payload' });
          return true;
        }
        const entries = Array.isArray(payload) ? payload : [payload];
        for (const e of entries) {
          // normalize ts
          const entry = { ts: e.ts ?? Date.now(), source: e.source ?? 'content', level: e.level ?? 'log', message: e.message ?? String(e.args?.[0] ?? ''), args: e.args ?? [] } as DebugLogEntry;
          pushDebugLog(entry);
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: (err as Error).message });
      }
      return true;
    }

    if (message.action === 'GET_DEBUG_LOGS') {
      try {
        // return a shallow copy
        sendResponse({ success: true, data: debugLogs.slice() });
      } catch (err) {
        sendResponse({ success: false, error: (err as Error).message });
      }
      return true;
    }

    if (message.action === 'CLEAR_DEBUG_LOGS') {
      try {
        debugLogs.length = 0;
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: (err as Error).message });
      }
      return true;
    }

    // Allow popup to disable chaining for the active tab
    if (message.action === 'DISABLE_CHAINING') {
      void (async () => {
        try {
          // If sender includes a tab, prefer it; otherwise use active tab
          const tabId = sender.tab?.id ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (!tabId) {
            sendResponse({ success: false, error: 'No active tab' });
            return;
          }
          disableChaining(tabId);
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    return handler.handle(message, sender, sendResponse);
  },
);

// Keep the service worker alive during long async operations
// (Chrome MV3 service workers may be terminated otherwise)
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    console.info('[FDF Pro] Extension installed.');
  } else if (reason === chrome.runtime.OnInstalledReason.UPDATE) {
    console.info('[FDF Pro] Extension updated.');
  }
});

// -----------------------------------------------------------
// Read settings directly from storage (avoid self-messaging)
// -----------------------------------------------------------

async function getSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
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
chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return;
  const tabId = tab.id;

  console.info('[FDF Pro] action clicked, requesting analysis on tab', tabId);
  // Ask the content script to analyze forms on the active tab
  chrome.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' }, (analyzeResp) => {
    if (chrome.runtime.lastError) {
      console.warn('[FDF Pro] analyze message error:', chrome.runtime.lastError.message);

      // Fallback: try injecting the built content script into the page and retry
      try {
        console.info('[FDF Pro] attempting to inject content script fallback');
        chrome.scripting.executeScript(
          { target: { tabId }, files: ['src/content/index.js'] },
          () => {
            if (chrome.runtime.lastError) {
              console.warn('[FDF Pro] injection failed:', chrome.runtime.lastError.message);
              return;
            }
            // Retry sending the analyze message once after injection
            chrome.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' }, (retryResp) => {
              if (chrome.runtime.lastError) {
                console.warn('[FDF Pro] analyze retry error:', chrome.runtime.lastError.message);
                return;
              }
              void processAnalyzeResponse(tabId, retryResp as ExtensionResponse<FormAnalysis[]>);
            });
          },
        );
      } catch (e) {
        console.warn('[FDF Pro] injection exception', e);
      }
      return;
    }
    void processAnalyzeResponse(tabId, analyzeResp as ExtensionResponse<FormAnalysis[]>);
  });
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
    chrome.tabs.sendMessage(tabId, { action: 'ENABLE_CHAINING' }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
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
    const tab = await chrome.tabs.get(tabId);
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

      await new Promise<void>((resolve) => {
        chrome.tabs.sendMessage(
          tabId,
          { action: 'FILL_FORM', payload: { formAnalysis: enriched, maxRetries: settings.maxRetryAttempts } },
          (fillResp) => {
            if (chrome.runtime.lastError) {
              console.warn('[FDF Pro] fill message error:', chrome.runtime.lastError.message);
              resolve();
              return;
            }
            console.info('[FDF Pro] fillResp for', enriched.selector, ':', fillResp);

            if (settings.telemetryEnabled) {
              chrome.storage.local.get('telemetry', (store) => {
                if (chrome.runtime.lastError) return;
                const t = (store.telemetry as { fillCount?: number }) ?? { fillCount: 0 };
                t.fillCount = (t.fillCount ?? 0) + 1;
                void chrome.storage.local.set({ telemetry: t });
              });
            }
            resolve();
          },
        );
      });
    } catch (err) {
      console.error('[FDF Pro] generateDataForFormDirect error:', err);
    }
  }

  // Auto-submit: click the form's submit/next button after filling
  if (settings.autoSubmitOnChaining && chainingTabs.has(tabId)) {
    try {
      // Small delay before clicking submit so validation completes
      await new Promise((r) => setTimeout(r, 800));
      await new Promise<void>((resolve) => {
        chrome.tabs.sendMessage(tabId, { action: 'AUTO_SUBMIT' }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve();
            return;
          }
          // If auto-submit couldn't find a Next/Submit button, the wizard
          // is likely done — disable chaining to prevent endless loops.
          const result = (resp as ExtensionResponse<{ clicked: boolean }>)?.data;
          if (result && !result.clicked) {
            console.info('[FDF Pro] auto-submit found no button — stopping chain on tab', tabId);
            disableChaining(tabId);
          }
          resolve();
        });
      });
    } catch { /* ignore */ }
  }
}

// Keyboard shortcut support: trigger the same action when a command fires.
chrome.commands?.onCommand.addListener((command) => {
  if (command !== 'trigger-fill') return;
  void (async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs || !tabs[0] || !tabs[0].id) return;
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' }, (resp) => {
        if (chrome.runtime.lastError) return;
        void processAnalyzeResponse(tabId, resp as ExtensionResponse<FormAnalysis[]>);
      });
    } catch (e) {
      logSwallowed('src/background/index.ts:onCommand', e);
    }
  })();
});

// -----------------------------------------------------------
// Chaining: auto-fill after full-page navigation
// -----------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  if (!chainingTabs.has(tabId)) return;

  console.info('[FDF Pro] chaining: tab navigated, checking for forms on tab', tabId);

  // Configurable delay to let the content script bootstrap on the new page
  void (async () => {
    const settings = await getSettings();
    const delay = Math.max(500, settings.chainingDelayMs ?? 500);

    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { action: 'ANALYZE_FORMS' }, (analyzeResp) => {
        if (chrome.runtime.lastError) {
          console.info('[FDF Pro] chaining: content script not ready, will retry on next navigation for tab', tabId);
          return;
        }

        void (async () => {
          const resp = analyzeResp as ExtensionResponse<FormAnalysis[]> | undefined;
          if (!resp?.success || !resp.data || resp.data.length === 0) {
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
            const tab = await chrome.tabs.get(tabId);
            addChainLog(tabId, tab.url ?? '', resp.data.reduce((s, f) => s + f.fields.length, 0));
          } catch { /* ignore */ }

          await fillForms(tabId, resp.data, settings);

          // Re-enable chaining on the content script (new page = new content script)
          chrome.tabs.sendMessage(tabId, { action: 'ENABLE_CHAINING' }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        })();
      });
    }, delay);
  })();
});

// Clean up chaining state when a tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = chainingTabs.get(tabId);
  if (entry) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    chainingTabs.delete(tabId);
    chainLogs.delete(tabId);
    console.info('[FDF Pro] chaining: tab closed, cleaned up tab', tabId);
  }
});

export {};
