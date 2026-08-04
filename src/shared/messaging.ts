// Shared safe messaging utility used by content scripts.
// Mirrors the robust logic originally in content/index.ts.
import browser from 'webextension-polyfill';

let _contextInvalidated = false;
let _swWakeRetryTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Reset module-level state. Call this if the extension runtime becomes
 * available again after being invalidated (e.g., during extension reload in
 * development). Tests can also call this between cases.
 */
export function resetMessagingState(): void {
  _contextInvalidated = false;
  if (_swWakeRetryTimer) { clearTimeout(_swWakeRetryTimer); _swWakeRetryTimer = null; }
}

/**
 * Swallow a non-critical error but keep it observable: log it through
 * console.debug, which the content-script console monkey-patch forwards to
 * the background debug-log buffer (visible in the popup's Debug panel).
 * Centralizing this avoids repeating a nested try/catch at every call site.
 */
export function logSwallowed(context: string, err: unknown): void {
  try {
    console.debug(`[FDF Pro] swallowed error in ${context}:`, err);
  } catch {
    // console itself is unavailable — nothing more we can do
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function sendMessageSafe<T = unknown, R = unknown>(
  msg: T,
): Promise<R | { success: false; error: string }> {
  // If we previously flagged the context as invalidated, re-check: the runtime
  // may have recovered (e.g., MV3 service-worker restart). Only trust the cached
  // flag when browser.runtime.id is truly absent.
  if (_contextInvalidated) {
    try {
      if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) {
        _contextInvalidated = false; // runtime is alive again
      }
    } catch (err) { logSwallowed('sendMessageSafe:recheck-runtime', err); }
  }
  if (_contextInvalidated) return { success: false, error: 'context-invalidated' };
  try {
    if (typeof browser === 'undefined' || !browser.runtime || !browser.runtime.id) {
      _contextInvalidated = true;
      return { success: false, error: 'No runtime' };
    }
    const res = (await browser.runtime.sendMessage(msg)) as R | undefined;
    if (_swWakeRetryTimer) { clearTimeout(_swWakeRetryTimer); _swWakeRetryTimer = null; }
    return res ?? { success: false, error: 'no-response' };
  } catch (err) {
    const message = errorMessage(err);
    if (/extension context invalidated/i.test(message)) {
      _contextInvalidated = true;
      return { success: false, error: message };
    }
    if (/no.+sw|service worker|receiving end does not exist/i.test(message)) {
      if (!_swWakeRetryTimer) {
        _swWakeRetryTimer = setTimeout(() => {
          _swWakeRetryTimer = null;
          try {
            if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) {
              browser.runtime.sendMessage({ action: 'PING' }).catch((pingErr: unknown) => logSwallowed('sendMessageSafe:wake-ping', pingErr));
            }
          } catch (err2) { logSwallowed('sendMessageSafe:wake-retry', err2); }
        }, 300);
      }
      return { success: false, error: message };
    }
    return { success: false, error: message };
  }
}
