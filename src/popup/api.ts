import type { ExtensionMessage, ExtensionResponse } from '@/shared/types';
import { logSwallowed } from '@/shared/messaging';

/**
 * Send a message to the content script running in the active tab.
 * Returns a normalised ExtensionResponse — never throws on missing listener.
 */
export async function sendToActiveTab<T = unknown>(
  message: ExtensionMessage,
): Promise<ExtensionResponse<T>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found.');
  try {
    const resp = await chrome.tabs.sendMessage<ExtensionMessage, ExtensionResponse<T>>(tab.id, message);
    return resp ?? { success: false, error: 'No response from content script.' };
  } catch (err) {
    // Typical error when content script is not present in the tab
    const msg = err instanceof Error ? err.message : String(err);
    if (/receiving end does not exist|could not establish connection/i.test(msg)) {
      try {
        // Try to inject the content script bundle and retry once. Try the
        // built JS bundle first (packaged builds), then fall back to the
        // source TS path for dev/unpacked installs.
        if (chrome.scripting && typeof chrome.scripting.executeScript === 'function') {
          const tryFiles = ['src/content/index.js', 'src/content/index.ts'];
          let injected = false;
          for (const f of tryFiles) {
            try {
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [f] });
              injected = true;
              break;
            } catch (e) {
              logSwallowed(`src/popup/api.ts: inject ${f} failed, trying next`, e);
            }
          }
          if (!injected) return { success: false, error: 'injection_failed: no injectable file found' } as ExtensionResponse<T>;
          // give the injected script a moment to register its listener
          await new Promise((r) => setTimeout(r, 250));
          const retry = await chrome.tabs.sendMessage<ExtensionMessage, ExtensionResponse<T>>(tab.id, message);
          return retry ?? { success: false, error: 'No response after injection.' };
        }
      } catch (injectErr) {
        return { success: false, error: `injection_failed: ${String(injectErr)}` } as ExtensionResponse<T>;
      }
    }
    return { success: false, error: `send_failed: ${msg}` } as ExtensionResponse<T>;
  }
}

/**
 * Send a message to the extension background service worker.
 * Returns a normalised ExtensionResponse — never throws on missing listener.
 */
export async function sendToBackground<T = unknown>(
  message: ExtensionMessage,
): Promise<ExtensionResponse<T>> {
  const resp = await chrome.runtime.sendMessage<ExtensionMessage, ExtensionResponse<T>>(message);
  return resp ?? { success: false, error: 'No response from background.' };
}
