import type {
  ExtensionMessage,
  ExtensionResponse,
  FormAnalysis,
  FieldAnalysis,
} from '@/shared/types';
import { ERROR_SELECTORS, LIMITS } from '@/shared/constants';
import { FormDetectionEngine } from './form-detection';
import { FormFiller } from './form-filler';
import { matchesHostnameList } from '@/shared/utils';
import { parseCanonicalHotkey } from '@/shared/hotkey';
import { DEFAULT_SETTINGS } from '@/shared/constants';
import { installApiInterceptor, onApiError } from './api-interceptor';
import type { ApiErrorEntry } from './api-interceptor';

// Safe sendMessage wrapper to avoid uncaught runtime errors when the
// background/service-worker is unavailable or the extension context is
// being restarted. Returns an object similar to ExtensionResponse.
/** Whether the extension context has been permanently invalidated (e.g. extension reloaded/unloaded). */
let _contextInvalidated = false;

let _swWakeRetryTimer: ReturnType<typeof setTimeout> | null = null;

async function sendMessageSafe<T = unknown, R = any>(msg: T): Promise<R | { success: false; error: string }> {
  // Permanent context invalidation — stop all messaging.
  if (_contextInvalidated) return { success: false, error: 'context-invalidated' } as any;
  try {
    // Some environments (tests) may not have chrome.runtime
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      // chrome.runtime.id is falsy only when the extension context is truly gone.
      _contextInvalidated = true;
      return { success: false, error: 'No runtime' } as any;
    }
    const res = await chrome.runtime.sendMessage(msg as any);
    // On a successful send, clear any pending wake retry.
    if (_swWakeRetryTimer) { clearTimeout(_swWakeRetryTimer); _swWakeRetryTimer = null; }
    return res ?? ({ success: false, error: 'no-response' } as any);
  } catch (err: any) {
    const msg2 = String(err && err.message ? err.message : err);

    // Permanent extension context invalidation — disable all future messaging.
    if (/extension context invalidated/i.test(msg2)) {
      _contextInvalidated = true;
      return { success: false, error: msg2 } as any;
    }

    // Temporary SW sleep — the service worker was idle and Chrome killed it.
    // Mark as sleeping and schedule a wake-up ping so the next real call
    // succeeds. Do NOT set _contextInvalidated.
    if (/no.+sw|service worker|receiving end does not exist/i.test(msg2)) {
      // Wake the SW by sending a no-op ping. Use the raw API to avoid recursion.
      if (!_swWakeRetryTimer) {
        _swWakeRetryTimer = setTimeout(() => {
          _swWakeRetryTimer = null;
          try {
            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
              // Sending any message wakes the SW; ignore errors here.
              chrome.runtime.sendMessage({ action: 'PING' } as any).then(() => {
                // SW is back up; nothing more to do.
              }).catch(() => { /* ignore */ });
            }
          } catch { /* ignore */ }
        }, 300);
      }
      return { success: false, error: msg2 } as any;
    }

    return { success: false, error: msg2 } as any;
  }
}

// Forward content-script console messages to background for popup debug panel
(() => {
  try {
    const origConsole: Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...a: unknown[]) => void> = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      debug: (console.debug ?? console.log).bind(console),
    };

    const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of levels) {
      (console as unknown as Record<string, (...a: unknown[]) => void>)[level] = (...args: unknown[]) => {
        origConsole[level](...args);
        // Fire-and-forget: forward log to background debug panel.
        // Explicitly suppress rejection so it never shows as "Uncaught (in promise)".
        sendMessageSafe({ action: 'REPORT_DEBUG_LOG', payload: { ts: Date.now(), source: 'content', level, message: String(args[0] ?? ''), args } }).catch(() => { /* ignore */ });
      };
    }
    let lastHotkeyTs = 0;
    let parsedHotkeyGlobal = parseCanonicalHotkey(undefined);

    function shouldIgnoreForHotkey(): boolean {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return false;
      const tag = active.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return true;
      if (active.isContentEditable) return true;
      return false;
    }

    async function refreshHotkeyFromSettings(): Promise<void> {
      try {
        const resp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GET_SETTINGS' }) as ExtensionResponse | { success: false; error: string };
        if (!resp.success || !resp.data) return;
        const s = resp.data as { oneClickHotkey?: string };
        parsedHotkeyGlobal = parseCanonicalHotkey(s.oneClickHotkey);
        try { console.debug('[FDF Pro] hotkey updated to', s.oneClickHotkey, parsedHotkeyGlobal); } catch {}
      } catch (err) {
        try { console.debug('[FDF Pro] failed to refresh hotkey', err); } catch {}
      }
    }

    // Single global keydown handler uses parsedHotkeyGlobal state
    window.addEventListener('keydown', async (e) => {
      try {
        const parsed = parsedHotkeyGlobal;
        if (!parsed || !parsed.key) return;
        if (Date.now() - lastHotkeyTs < 500) return;
        if (shouldIgnoreForHotkey()) return;
        if (!!e.ctrlKey !== parsed.ctrl) return;
        if (!!e.shiftKey !== parsed.shift) return;
        if (!!e.altKey !== parsed.alt) return;
        if (!!e.metaKey !== parsed.meta) return;
        const key = (e.key || '').toLowerCase();
        if (!key) return;
        if (key !== parsed.key) return;
        lastHotkeyTs = Date.now();

        // Prefer modal targets when present (hotkey should operate on modals)
        const openModals = getOpenModalsIncludingPaymentIframes();
        console.debug('[FDF Pro] hotkey: detected', openModals.length, 'open modals');
        if (openModals.length > 0) {
          for (const m of openModals) {
            const mInputs = m.querySelectorAll('input:not([type="hidden"]), textarea, select').length;
            const mIframe = m.querySelector('iframe') instanceof HTMLIFrameElement;
            const mForm = m.querySelector('form') !== null;
            console.debug('[FDF Pro] hotkey modal candidate:', m.tagName, m.id || m.className?.toString().slice(0, 60), '| inputs:', mInputs, '| form:', mForm, '| iframe:', mIframe);
          }
          // When multiple modals are open (chained flow), prefer the one
          // that actually contains fillable inputs over a wrapper/selection modal.
          const modalWithInputs = openModals.find((m) =>
            m.querySelector('input:not([type="hidden"]), textarea, select') !== null
            || m.querySelector('iframe') instanceof HTMLIFrameElement
          ) ?? openModals[openModals.length - 1]; // fallback to last (usually topmost)
          const modal = modalWithInputs;
          try {
            const iframe = modal.querySelector('iframe');
            if (iframe instanceof HTMLIFrameElement) {
              // Try same-origin iframe fill first
              try {
                const doc = iframe.contentDocument;
                if (doc) {
                  const formEl = doc.querySelector('form') as HTMLElement | null;
                  if (formEl) {
                    const fa = buildFormAnalysisFromIframe(formEl, doc, iframe);
                    const genResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: fa } }) as ExtensionResponse | { success: false; error: string };
                    if (genResp && (genResp as any).success && (genResp as any).data) {
                      const enriched = (genResp as any).data as FormAnalysis;
                      hotkeyFillInProgress = true;
                      try { await dispatch({ action: 'FILL_FORM', payload: { formAnalysis: enriched } }); } catch (err) { console.debug('[FDF Pro] hotkey modal fill failed', err); } finally { hotkeyFillInProgress = false; }
                      return;
                    }
                  }
                }
              } catch { /* cross-origin or other access error */ }

              // Cross-origin iframe or no in-iframe form: first try stored generated payment
              const src = iframe.getAttribute('src') || iframe.src || undefined;
              try {
                const stored = await getLastGeneratedPayment();
                if (stored && stored.generated && stored.generated.fields && stored.generated.fields.length > 0) {
                  const text = stored.generated.fields.map((f) => `${f.name || f.label || f.id}: ${f.value ?? ''}`).join('\n');
                  await copyTextToClipboard(text);
                  showTransientToast('Payment data copied to clipboard (saved)');
                  console.info('[FDF Pro] hotkey used stored generated payment');
                  return;
                }
              } catch (err) {
                try { console.debug('[FDF Pro] failed reading stored payment', err); } catch {}
              }

              // Fallback: generate and copy now
              try { await handleCopyPaymentForModal(modal, src); } catch (err) { console.debug('[FDF Pro] hotkey copy payment failed', err); }
              return;
            }

            // Modal without iframe — look for fillable content inside the modal
            // First try: find a <form> tag and analyze it directly
            const formEl = modal.querySelector('form') as HTMLElement | null;
            if (formEl) {
              console.debug('[FDF Pro] hotkey: found <form> inside modal, analyzing directly');
              const fa = detector.analyzeForm(formEl);
              if (fa.fields.length > 0) {
                console.debug('[FDF Pro] hotkey: modal form has', fa.fields.length, 'fields');
                const genResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: fa } }) as ExtensionResponse | { success: false; error: string };
                if (genResp && (genResp as any).success && (genResp as any).data) {
                  const enriched = (genResp as any).data as FormAnalysis;
                  hotkeyFillInProgress = true;
                  try { await dispatch({ action: 'FILL_FORM', payload: { formAnalysis: enriched } }); } catch (err) { console.debug('[FDF Pro] hotkey modal fill failed', err); } finally { hotkeyFillInProgress = false; }
                }
                return;
              }
              console.debug('[FDF Pro] hotkey: <form> inside modal had 0 fields, trying loose inputs');
            }

            // Modal has inputs but no <form> tag — build an ad-hoc form analysis
            // from inputs found directly inside the modal container
            const looseInputs = modal.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
              'input:not([type="hidden"]), textarea, select',
            );
            console.debug('[FDF Pro] hotkey: modal has', looseInputs.length, 'loose inputs (no form tag)');
            if (looseInputs.length > 0) {
              const fa = buildFormAnalysisFromContainer(modal);
              console.debug('[FDF Pro] hotkey: built ad-hoc analysis with', fa.fields.length, 'fields');
              if (fa.fields.length > 0) {
                const genResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: fa } }) as ExtensionResponse | { success: false; error: string };
                if (genResp && (genResp as any).success && (genResp as any).data) {
                  const enriched = (genResp as any).data as FormAnalysis;
                  hotkeyFillInProgress = true;
                  try { await dispatch({ action: 'FILL_FORM', payload: { formAnalysis: enriched } }); } catch (err) { console.debug('[FDF Pro] hotkey modal formless fill failed', err); } finally { hotkeyFillInProgress = false; }
                }
                return;
              }
            }
          } catch (err) { console.debug('[FDF Pro] hotkey modal handling error', err); }
        }

        // Fallback: operate on the first detected form in the page
        cachedForms = detector.detectForms();
        if (!cachedForms || cachedForms.length === 0) return;
        const formToFill = cachedForms[0];

        const genResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: formToFill } }) as ExtensionResponse | { success: false; error: string };
        if (!genResp || !(genResp as any).success || !(genResp as any).data) return;
        const enriched = (genResp as any).data as FormAnalysis;

        try {
          await dispatch({ action: 'FILL_FORM', payload: { formAnalysis: enriched } });
        } catch (err) {
          try { console.debug('[FDF Pro] hotkey fill failed', err); } catch {}
        }

        // Blur the active element so subsequent hotkey presses are not
        // blocked by shouldIgnoreForHotkey (which skips when focus is
        // on an input/textarea).
        try {
          const ae = document.activeElement as HTMLElement | null;
          if (ae && typeof ae.blur === 'function') ae.blur();
        } catch { /* ignore */ }
      } catch (err) {
        try { console.debug('[FDF Pro] hotkey handler error', err); } catch {}
      }
    });

    // Watch for settings changes in storage so hotkey updates without reload
    if (chrome.storage && chrome.storage.onChanged && typeof chrome.storage.onChanged.addListener === 'function') {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes.settings) {
          try {
            const newSettings = changes.settings.newValue as { oneClickHotkey?: string } | undefined;
            parsedHotkeyGlobal = parseCanonicalHotkey(newSettings?.oneClickHotkey);
            try { console.debug('[FDF Pro] storage:onChanged hotkey updated', newSettings?.oneClickHotkey); } catch {}
          } catch (e) {
            try { console.debug('[FDF Pro] failed parsing hotkey in storage.onChanged', e); } catch {}
          }
        }
      });
    }

    // Load initial hotkey value. If the background/storage request fails
    // (e.g. service worker restart), fall back to the bundled default.
    try {
      void refreshHotkeyFromSettings();
    } catch {
      parsedHotkeyGlobal = parseCanonicalHotkey(DEFAULT_SETTINGS.oneClickHotkey);
      try { console.debug('[FDF Pro] hotkey using fallback default', DEFAULT_SETTINGS.oneClickHotkey); } catch {}
    }

  } catch (err) {
    console.error('[FDF Pro] console/hotkey wrapper init failed', err);
  }
})();

// Global error capture: forward uncaught errors and unhandled promise rejections
try {
  window.addEventListener('error', (evt: ErrorEvent) => {
    try {
      const target = (evt as any).target as Element | undefined;
      const resource = target && (target as HTMLScriptElement).src ? (target as HTMLScriptElement).src : undefined;
      void sendMessageSafe({
        action: 'LOG_CONTENT_ERROR',
        payload: {
          message: evt.message,
          filename: evt.filename,
          lineno: evt.lineno,
          colno: evt.colno,
          stack: (evt.error && (evt.error.stack ?? String(evt.error))) ?? null,
          resource,
        },
      });
    } catch { /* ignore */ }
  });

  window.addEventListener('unhandledrejection', (evt: PromiseRejectionEvent) => {
    try {
      const reason: any = (evt && (evt as any).reason) || null;
      void sendMessageSafe({
        action: 'LOG_CONTENT_ERROR',
        payload: {
          message: reason && reason.message ? reason.message : String(reason || 'Unhandled rejection'),
          stack: reason && reason.stack ? reason.stack : null,
          reason,
        },
      });
    } catch { /* ignore */ }
  });
} catch { /* ignore */ }

/** Produces a stable fingerprint for a set of fields so we can detect form changes. */
function formFingerprint(fields: FieldAnalysis[]): string {
  return fields
    .map((f) => `${f.name || f.id}:${f.htmlType}`)
    .sort()
    .join('|');
}

// -----------------------------------------------------------
// Module-level state
// -----------------------------------------------------------

const detector = new FormDetectionEngine();
const filler = new FormFiller();
let cachedForms: FormAnalysis[] = [];
let chainingActive = false;
let lastFilledFingerprint = '';
/** Set of all fingerprints filled during this chaining session — prevents re-filling wizard steps we already completed. */
const filledFingerprintHistory = new Set<string>();
let isFilling = false;
let chainFillPending = false;
let pageObserverTimer: ReturnType<typeof setTimeout> | null = null;
let errorObserverTimer: ReturnType<typeof setTimeout> | null = null;
/** When true, the current FILL_FORM was triggered by the hotkey handler which
 *  already validated modal context — skip the modal-outside guard. */
let hotkeyFillInProgress = false;
/** Configured delay between chain steps (populated from settings). */
let chainingDelayMs = 500;

// -----------------------------------------------------------
// Modal auto-fill state
// -----------------------------------------------------------

/** Whether auto-fill for modals is enabled (refreshed from settings). */
let autoFillModals = true;
/** Guard: a modal fill is already in flight. */
let modalFillPending = false;
/** Debounce timer for the modal MutationObserver. */
let modalObserverTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Tracks fingerprints of modal forms filled during the current page session.
 * Cleared when all modals close so that re-opened modals can be filled again.
 */
const modalFilledHistory = new Set<string>();

/** Simpler selector list used for MutationObserver matching (broader net). */
const MODAL_MATCH_SELECTORS = [
  'dialog',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '.modal',
  '.popup',
  '.overlay',
  '.lightbox',
  '.dialog',
  '[data-modal]',
  '[data-dialog]',
  '[data-popup]',
  '.MuiDialog-root',
  '.MuiModal-root',
  '.ant-modal-wrap',
  '.chakra-modal__content-container',
  '.ui.modal',
  // YouTube-specific
  'ytd-popup-container',
  'tp-yt-paper-dialog',
  'ytd-consent-bump-renderer',
  'ytd-dialog-renderer',
  'ytd-confirm-dialog-renderer',
  '.ytp-popup',
  // YouTube mobile / m.youtube.com
  'ytm-popup-container',
  'ytm-dialog-renderer',
  'ytm-purchase-dialog-renderer',
  'ytd-purchase-dialog-renderer',
  '.ytp-modal',
] as const;

const MODAL_MATCH_COMBINED = MODAL_MATCH_SELECTORS.join(', ');

// We inject one or more small badge buttons for modals. Use a data-attribute
// to mark them so we can clean them up easily.

function createModalBadge(modal: HTMLElement, label: string, href?: string): HTMLElement {
  // Deduplicate: if a badge with the same label already exists, return it
  const existing = document.querySelector<HTMLElement>(`button[data-fdf-badge][data-fdf-label="${label}"]`);
  if (existing) return existing;

  const btn = document.createElement('button');
  btn.textContent = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('data-fdf-badge', '1');
  btn.setAttribute('data-fdf-label', label);
  btn.style.position = 'fixed';
  btn.style.zIndex = '2147483647';
  btn.style.right = '12px';
  btn.style.top = String(12 + (document.querySelectorAll('button[data-fdf-badge]').length * 40));
  btn.style.background = '#0b69ff';
  btn.style.color = '#fff';
  btn.style.border = 'none';
  btn.style.padding = '6px 10px';
  btn.style.borderRadius = '6px';
  btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '12px';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      if (label === 'Copy payment data') {
        // Attempt to generate payment data for this modal and copy to clipboard.
        try { await handleCopyPaymentForModal(modal, href); } catch (err) { console.debug('[FDF Pro] copy payment data failed', err); }
        return;
      }
      // For other Copy payment variants (JSON/single), prevent the default
      // behaviour (which would open href) so their custom listeners can run.
      if (label.startsWith('Copy payment')) {
        return;
      }
      if (href) {
        window.open(href, '_blank');
      } else {
        modal.focus();
      }
    } catch { /* ignore */ }
  });

  document.body.appendChild(btn);
  // Schedule auto-remove so badges don't linger indefinitely
  try { scheduleBadgeAutoRemove(btn); } catch {}
  return btn;
}

/** Create copy-format badges (multiline, JSON, single-line) and wire format-specific handlers. */
function createCopyBadges(modal: HTMLElement, href?: string | undefined): void {
  try {
    // Multiline (default) — createModalBadge already wires this label
    createModalBadge(modal, 'Copy payment data', href);

    // JSON format
    const jsonBtn = createModalBadge(modal, 'Copy payment (JSON)', href);
    jsonBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await handleCopyPaymentForModalWithFormat(modal, href, 'json'); } catch (err) { console.debug('[FDF Pro] copy json failed', err); }
    });

    // Single-line format
    const singleBtn = createModalBadge(modal, 'Copy payment (single)', href);
    singleBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try { await handleCopyPaymentForModalWithFormat(modal, href, 'single'); } catch (err) { console.debug('[FDF Pro] copy single failed', err); }
    });
  } catch { /* ignore */ }
}

/** Show a small confirmation modal before performing the copy action. */
// (confirmation modal and auto-remove badge helpers removed — revert to original behavior)

function removeAllModalBadges(): void {
  try {
    for (const el of Array.from(document.querySelectorAll('button[data-fdf-badge]'))) {
      try { el.remove(); } catch {}
    }
  } catch {}
}

// Schedule auto-remove for a badge element. Keeps a WeakMap of timers
// so multiple calls won't schedule multiple removals. Hovering pauses
// removal until mouseleave.
const badgeAutoRemoveTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
function scheduleBadgeAutoRemove(btn: HTMLElement, ms = 8000): void {
  try {
    // Clear any previous timer
    const prev = badgeAutoRemoveTimers.get(btn);
    if (prev) clearTimeout(prev);

    const t = setTimeout(() => {
      try { btn.remove(); } catch {}
      badgeAutoRemoveTimers.delete(btn);
    }, ms);
    badgeAutoRemoveTimers.set(btn, t);

    const onEnter = () => {
      const timer = badgeAutoRemoveTimers.get(btn);
      if (timer) {
        clearTimeout(timer);
        badgeAutoRemoveTimers.delete(btn);
      }
    };
    const onLeave = () => {
      if (!badgeAutoRemoveTimers.has(btn)) {
        const t2 = setTimeout(() => { try { btn.remove(); } catch {} badgeAutoRemoveTimers.delete(btn); }, ms);
        badgeAutoRemoveTimers.set(btn, t2);
      }
    };

    btn.addEventListener('mouseenter', onEnter);
    btn.addEventListener('mouseleave', onLeave);
  } catch {}
}

// Small helpers: toast + storage for last generated payment data
function showTransientToast(message: string, ms = 2200): void {
  try {
    const id = 'fdf-transient-toast';
    let el = document.getElementById(id) as HTMLDivElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.position = 'fixed';
      el.style.right = '12px';
      el.style.bottom = '12px';
      el.style.zIndex = '2147483647';
      el.style.background = 'rgba(0,0,0,0.8)';
      el.style.color = '#fff';
      el.style.padding = '8px 12px';
      el.style.borderRadius = '6px';
      el.style.fontSize = '12px';
      el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.opacity = '1';
    setTimeout(() => {
      try { el!.style.transition = 'opacity 400ms'; el!.style.opacity = '0'; setTimeout(() => { try { el!.remove(); } catch {} }, 500); } catch {}
    }, ms);
  } catch {}
}

async function saveLastGeneratedPayment(generated: FormAnalysis, src?: string | undefined): Promise<void> {
  try {
    const payload = { ts: Date.now(), generated, src };
    if (chrome?.storage?.local && typeof chrome.storage.local.set === 'function') {
      await chrome.storage.local.set({ fdf_last_generated_payment: payload } as any);
    }
  } catch {}
}

async function getLastGeneratedPayment(): Promise<{ ts: number; generated: FormAnalysis; src?: string } | null> {
  try {
    if (chrome?.storage?.local && typeof chrome.storage.local.get === 'function') {
      return await new Promise((resolve) => {
        try {
          chrome.storage.local.get('fdf_last_generated_payment', (v: any) => {
            try { resolve(v?.fdf_last_generated_payment ?? null); } catch { resolve(null); }
          });
        } catch {
          resolve(null);
        }
      });
    }
  } catch {}
  return null;
}

/** Return elements that look like open/visible modals or contain payment iframes. */
function getOpenModalsIncludingPaymentIframes(): HTMLElement[] {
  try {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(MODAL_MATCH_COMBINED));
    // Only include iframe parents that themselves match a modal selector –
    // a bare <div> wrapping an ad/analytics iframe should NOT block fills.
    const extras = Array.from(document.querySelectorAll<HTMLElement>('iframe'))
      .map((f) => f.closest(MODAL_MATCH_COMBINED) as HTMLElement | null)
      .filter((x): x is HTMLElement => !!x);
    const all = [...candidates, ...extras];
    const uniq = new Set<HTMLElement>();
    return all.filter((el) => {
      if (!el) return false;
      if (uniq.has(el)) return false;
      uniq.add(el);
      try {
        if ((el as HTMLElement).offsetParent === null) return false;
        const style = window.getComputedStyle(el);
        if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
      } catch {}
      return true;
    });
  } catch { return []; }
}


async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
    // Fallback: textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {}
    try { ta.remove(); } catch {}
    return;
  } catch (e) {
    try { console.debug('[FDF Pro] copyTextToClipboard failed', e); } catch {}
  }
}

// Legacy handler kept for callers that expect the simple signature
async function handleCopyPaymentForModal(modal: HTMLElement, iframeSrc?: string | null | undefined): Promise<void> {
  return handleCopyPaymentForModalWithFormat(modal, iframeSrc, 'text');
}

// New handler supporting format selection: 'text' (multiline), 'json', or 'single' (one-line key=value)
async function handleCopyPaymentForModalWithFormat(modal: HTMLElement, iframeSrc?: string | null | undefined, format: 'text' | 'json' | 'single' = 'text'): Promise<void> {
  try {
    const iframe = modal.querySelector('iframe');
    let generated: FormAnalysis | null = null;

    if (iframe instanceof HTMLIFrameElement) {
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          const formEl = doc.querySelector('form') as HTMLElement | null;
          if (formEl) {
            const fa = buildFormAnalysisFromIframe(formEl, doc, iframe);
            const resp = await sendMessageSafe({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: fa } }) as ExtensionResponse | { success: false; error: string };
            if (resp && (resp as any).success && (resp as any).data) {
              generated = (resp as any).data as FormAnalysis;
            }
          }
        }
      } catch {
        // cross-origin — ignore and fall through to synthetic
      }
    }

    if (!generated) {
      const synthetic: FormAnalysis = {
        index: Date.now(),
        type: 'payment',
        fields: [
          { id: `cc-${Date.now()}-1`, index: 0, type: 'creditCard', htmlType: 'text', name: 'cardNumber', label: 'Card Number', placeholder: '4242 4242 4242 4242', constraints: { minLength: null, maxLength: null, min: null, max: null, pattern: null, step: null, required: false, readOnly: false, disabled: false, multiple: false, accept: null }, required: false, selector: '#fdf-synthetic-card-number', formIndex: 0, confidence: 0.5 },
          { id: `cc-${Date.now()}-2`, index: 1, type: 'creditCardExpiry', htmlType: 'text', name: 'exp', label: 'Expiry', placeholder: '12/34', constraints: { minLength: null, maxLength: null, min: null, max: null, pattern: null, step: null, required: false, readOnly: false, disabled: false, multiple: false, accept: null }, required: false, selector: '#fdf-synthetic-exp', formIndex: 0, confidence: 0.5 },
          { id: `cc-${Date.now()}-3`, index: 2, type: 'creditCardCvv', htmlType: 'text', name: 'cvc', label: 'CVC', placeholder: '123', constraints: { minLength: null, maxLength: null, min: null, max: null, pattern: null, step: null, required: false, readOnly: false, disabled: false, multiple: false, accept: null }, required: false, selector: '#fdf-synthetic-cvc', formIndex: 0, confidence: 0.5 },
        ],
        selector: iframeSrc || (modal.getAttribute && modal.getAttribute('id')) || 'modal-payment',
        action: '', method: 'POST', hasSubmitButton: false, isMultiStep: false, currentStep: 1, totalSteps: 1, analyzedAt: new Date().toISOString(),
      };
      const genResp = await sendMessageSafe({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis: synthetic } }) as ExtensionResponse | { success: false; error: string };
      if (genResp && (genResp as any).success && (genResp as any).data) generated = (genResp as any).data as FormAnalysis;
    }

    if (!generated) return;

    let payloadText = '';
    if (format === 'text') {
      payloadText = generated.fields.map((f) => `${f.name || f.label || f.id}: ${f.value ?? ''}`).join('\n');
    } else if (format === 'single') {
      payloadText = generated.fields.map((f) => `${f.name || f.label || f.id}=${String(f.value ?? '')}`).join(' ');
    } else if (format === 'json') {
      const obj: Record<string, string> = {};
      for (const f of generated.fields) obj[f.name || f.label || f.id] = String(f.value ?? '');
      payloadText = JSON.stringify(obj);
    }

    await copyTextToClipboard(payloadText);
    showTransientToast('Payment data copied to clipboard');
    try { await saveLastGeneratedPayment(generated, iframeSrc ?? undefined); } catch {}
    console.info('[FDF Pro] copied generated payment data to clipboard (format=' + format + ')');
  } catch (err) {
    try { console.debug('[FDF Pro] handleCopyPaymentForModal error', err); } catch {}
  }
}


/**
 * Detect visible modal forms and fill them automatically.
 * If no modals are open the history is cleared so future opens are filled again.
 */
async function checkAndFillModals(): Promise<void> {
  if (modalFillPending || isFilling) return;

  const openModals = getOpenModalsIncludingPaymentIframes();

  if (openModals.length === 0) {
    // All modals are now closed — allow the next open to be filled again.
    modalFilledHistory.clear();
    // Remove any injected UI for modals
    try { removeAllModalBadges(); } catch {}
    return;
  }

  // Refresh the setting from storage (cheap; only done when a modal-related mutation fires)
  try {
    const resp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GET_SETTINGS' }) as ExtensionResponse | { success: false; error: string };
    if (resp && (resp as any).success && (resp as any).data) {
      autoFillModals = ((resp as any).data as { autoFillModals?: boolean }).autoFillModals ?? true;
    }
  } catch { /* keep cached value */ }

  if (!autoFillModals) return;

  // NOTE: By design we do NOT auto-fill detected modal forms. Auto-filling
  // forms rendered inside modal overlays can target the wrong inputs or
  // interact with cross-origin payment frames. Keep detecting modals and
  // injecting helpful UI (e.g., 'Open payment' badge), but skip any
  // automated fill actions here. Manual fills (hotkey/popup) still work
  // and are guarded elsewhere.
  //
  // EXCEPTION: when a modal contains a same-origin form (not inside a
  // cross-origin iframe) and the autoFillModals setting is enabled,
  // auto-fill it. This handles chained modal flows where the second
  // modal contains the actual form.
  try {
    for (const modal of openModals) {
      try {
        // Log truncated outerHTML for debugging
        try { console.info('[FDF Pro] detected modal outerHTML (truncated):', modal.outerHTML.slice(0, 800)); } catch {}

        const iframe = modal.querySelector('iframe');
        if (iframe instanceof HTMLIFrameElement) {
          const src = iframe.getAttribute('src') || iframe.src || undefined;
          createModalBadge(modal, 'Open payment', src);
          createCopyBadges(modal, src);
          try { console.info('[FDF Pro] modal contains iframe — injected Open payment badge'); } catch {}
          continue;
        }

        // Same-origin modal with a form — auto-fill it
        const hasInputs = modal.querySelector('input:not([type="hidden"]), textarea, select') !== null;
        console.debug('[FDF Pro] checkAndFillModals: modal hasInputs=', hasInputs, 'tagName=', modal.tagName, 'id=', modal.id || '(none)');
        if (!hasInputs) {
          try { (modal as HTMLElement).focus?.(); } catch {}
          continue;
        }

        // Build fingerprint and skip if already filled
        const inputEls = Array.from(modal.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select'));
        const fp = inputEls.map((el) => `${(el as HTMLInputElement).name || el.id}:${(el as HTMLInputElement).type || el.tagName}`).sort().join('|');
        if (modalFilledHistory.has(fp)) continue;

        // Find matching detected form, or build ad-hoc analysis
        let formAnalysis: FormAnalysis | null = null;
        const modalFormEl = modal.querySelector('form') as HTMLElement | null;
        if (modalFormEl) {
          formAnalysis = detector.analyzeForm(modalFormEl);
        }
        if (!formAnalysis || formAnalysis.fields.length === 0) {
          formAnalysis = buildFormAnalysisFromContainer(modal);
        }

        if (!formAnalysis || formAnalysis.fields.length === 0) continue;

        modalFillPending = true;
        try {
          const genResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GENERATE_DATA_FOR_FORM', payload: { formAnalysis } }) as ExtensionResponse | { success: false; error: string };
          if (genResp && (genResp as any).success && (genResp as any).data) {
            const enriched = (genResp as any).data as FormAnalysis;
            hotkeyFillInProgress = true;
            try { await dispatch({ action: 'FILL_FORM', payload: { formAnalysis: enriched } }); } finally { hotkeyFillInProgress = false; }
            modalFilledHistory.add(fp);
            console.info('[FDF Pro] auto-filled modal form');
          }
        } finally {
          modalFillPending = false;
        }
      } catch {}
    }
  } catch {}
}

/** Build a simple FormAnalysis for a form root inside a same-origin iframe document. */
function buildFormAnalysisFromIframe(formEl: HTMLElement, iframeDoc: Document, _iframeEl: HTMLIFrameElement): FormAnalysis {
  const inputEls = Array.from(
    formEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'),
  ).filter((el) => el.getAttribute('type') !== 'hidden').slice(0, 200);

  const fields = inputEls.map((el, i) => {
    const htmlType = ((el as HTMLInputElement).type || (el.tagName || '').toLowerCase()).toLowerCase();
    const name = el.name ?? '';
    const id = el.id ?? '';
    const placeholder = (el as HTMLInputElement).placeholder ?? '';
    const label = (function findLabel(): string {
      try {
        const byFor = id ? iframeDoc.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (byFor) return (byFor.textContent || '').trim();
        const parentLabel = el.closest('label');
        if (parentLabel) return (parentLabel.textContent || '').trim();
      } catch {}
      return '';
    })();

    return {
      id: `iframe-${i}-${Date.now()}`,
      index: i,
      type: 'text' as const,
      htmlType,
      name,
      label,
      placeholder,
      constraints: {
        minLength: null,
        maxLength: null,
        min: null,
        max: null,
        pattern: null,
        step: null,
        required: false,
        readOnly: false,
        disabled: false,
        multiple: false,
        accept: null,
      },
      required: (el as HTMLInputElement).required ?? false,
      selector: cssSelectorInDocument(el, iframeDoc),
      formIndex: 0,
      confidence: 0.5,
    };
  });

  return {
    index: Date.now(),
    type: 'unknown',
    fields,
    selector: cssSelectorInDocument(formEl, iframeDoc),
    action: '',
    method: 'GET',
    hasSubmitButton: formEl.querySelector('[type="submit"], button:not([type="button"])') !== null,
    isMultiStep: false,
    currentStep: 1,
    totalSteps: 1,
    analyzedAt: new Date().toISOString(),
  } as FormAnalysis;
}

/** Build a FormAnalysis from loose inputs inside a container (no <form> tag needed). */
function buildFormAnalysisFromContainer(container: HTMLElement): FormAnalysis {
  const inputEls = Array.from(
    container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input:not([type="hidden"]), textarea, select',
    ),
  ).slice(0, 200);

  const fields = inputEls.map((el, i) => {
    const htmlType = ((el as HTMLInputElement).type || (el.tagName || '').toLowerCase()).toLowerCase();
    const name = el.name ?? '';
    const id = el.id ?? '';
    const placeholder = (el as HTMLInputElement).placeholder ?? '';
    const label = (function findLabel(): string {
      try {
        const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (byFor) return (byFor.textContent || '').trim();
        const parentLabel = el.closest('label');
        if (parentLabel) return (parentLabel.textContent || '').trim();
        // Try aria-label
        const aria = el.getAttribute('aria-label');
        if (aria) return aria.trim();
      } catch {}
      return '';
    })();

    return {
      id: `modal-${i}-${Date.now()}`,
      index: i,
      type: 'text' as const,
      htmlType,
      name,
      label,
      placeholder,
      constraints: {
        minLength: null,
        maxLength: null,
        min: null,
        max: null,
        pattern: null,
        step: null,
        required: false,
        readOnly: false,
        disabled: false,
        multiple: false,
        accept: null,
      },
      required: (el as HTMLInputElement).required ?? false,
      selector: cssSelectorInDocument(el, document),
      formIndex: 0,
      confidence: 0.5,
    };
  });

  const containerSelector = container.id
    ? `#${CSS.escape(container.id)}`
    : cssSelectorInDocument(container, document);

  return {
    index: Date.now(),
    type: 'unknown',
    fields,
    selector: containerSelector,
    action: '',
    method: 'GET',
    hasSubmitButton: container.querySelector('[type="submit"], button:not([type="button"])') !== null,
    isMultiStep: false,
    currentStep: 1,
    totalSteps: 1,
    analyzedAt: new Date().toISOString(),
  } as FormAnalysis;
}

/** Generate a stable selector for an element relative to a given document. */
function cssSelectorInDocument(el: Element, doc: Document): string {
  try {
    const asEl = el as HTMLElement;
    const df = asEl.getAttribute('data-field');
    if (df) return `[data-field="${CSS.escape(df)}"]`;
    const td = asEl.getAttribute('data-testid') || asEl.getAttribute('data-test');
    if (td) return `[data-testid="${CSS.escape(td)}"]`;
    const aria = asEl.getAttribute('aria-label');
    if (aria) return `${asEl.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
  } catch {}

  if ((el as HTMLElement).id) return `#${CSS.escape((el as HTMLElement).id)}`;

  const tag = el.tagName.toLowerCase();
  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;

  const path: string[] = [];
  let node: Element | null = el;
  while (node && node !== doc.body) {
    let selector = node.tagName.toLowerCase();
    if ((node as HTMLElement).id) {
      selector = `#${CSS.escape((node as HTMLElement).id)}`;
      path.unshift(selector);
      break;
    } else {
      const siblings = Array.from(node.parentElement?.children ?? []).filter((s) => s.tagName === node!.tagName);
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    path.unshift(selector);
    node = node.parentElement;
  }
  return path.join(' > ');
}

// -----------------------------------------------------------
// Message listener (from popup and background)
// -----------------------------------------------------------

try {
  chrome.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ExtensionResponse) => void,
    ) => {
      handleMessage(message, sendResponse);
      return true; // keep async channel open
    },
  );
} catch {
  // Extension context already invalidated — content script will
  // continue running but cannot communicate with the background.
}

function handleMessage(
  message: ExtensionMessage,
  sendResponse: (response: ExtensionResponse) => void,
): void {
  void (async () => {
    try {
      console.debug('[FDF Pro] content script received message', message.action);
      const data = await dispatch(message);
      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: (err as Error).message });
    }
  })();
}

async function dispatch(message: ExtensionMessage): Promise<unknown> {
  switch (message.action) {
    case 'ANALYZE_FORMS': {
      cachedForms = detector.detectForms();
      return cachedForms;
    }

    case 'GET_FORM_DATA': {
      if (cachedForms.length === 0) {
        cachedForms = detector.detectForms();
      }
      return cachedForms;
    }

    case 'FILL_FORM': {
      const { formAnalysis, maxRetries } = message.payload as {
        formAnalysis: FormAnalysis;
        maxRetries?: number;
      };
      try { console.info('[FDF Pro] FILL_FORM request for selector', formAnalysis.selector, 'fields:', formAnalysis.fields.length); } catch {}
      // If a modal is currently open, avoid filling forms that are not
      // contained inside that modal. This prevents auto-fill from targeting
      // inputs visible behind overlays (e.g., search box under a payments modal).
      // Skip this guard when the hotkey handler already validated modal context.
      try {
        const open = !hotkeyFillInProgress ? getOpenModalsIncludingPaymentIframes() : [];
        if (open.length > 0) {
          try {
            const formEl = document.querySelector(formAnalysis.selector);
            const insideModal = formEl ? open.some((m) => m.contains(formEl) || m === formEl) : false;
            if (!insideModal) {
              // Inject badge on first modal to let user open payment iframe/tab
              const m = open[0];
              try {
                const iframe = m.querySelector('iframe');
                const src = iframe instanceof HTMLIFrameElement ? (iframe.getAttribute('src') || iframe.src) : undefined;
                createModalBadge(m, 'Open payment', src);
                createCopyBadges(m, src);
              } catch {}
              try { console.info('[FDF Pro] Skipping fill because a modal overlay is open and target form is outside it'); } catch {}
              return { skipped: true, reason: 'modal_overlay_present' };
            }
          } catch {}
        }
      } catch {}
      isFilling = true;
      const result = await filler.fillFormWithRecovery(formAnalysis, {
        maxRetries: maxRetries ?? 3,
      });

      try { console.info('[FDF Pro] FILL_FORM result for selector', formAnalysis.selector, result); } catch {}

      // Keep the mutation observer for server-side / post-submit errors.
      // During chaining, skip the error observer — it causes recovery loops
      // that repeatedly change field values on the current page.
      if (!chainingActive) {
        startErrorObserver(formAnalysis.fields);
      }

      // Send a short confirmation payload back to the background so
      // the service worker can log the exact values that were set.
      try {
        const filledSamples: Array<{ fieldId: string; selector: string; value: string }> = [];
        for (const f of formAnalysis.fields) {
          if (!f.selector) continue;
          const el = document.querySelector<HTMLElement>(f.selector);
          if (!el) continue;
          let val = '';
          try {
            if ((el as HTMLInputElement).value !== undefined) val = (el as HTMLInputElement).value;
            else val = el.textContent?.trim() ?? '';
          } catch {
            val = '';
          }
          if (val) filledSamples.push({ fieldId: f.id, selector: f.selector, value: val });
          if (filledSamples.length >= 12) break;
        }

        void sendMessageSafe({ action: 'REPORT_FILLED', payload: { filled: filledSamples } });
      } catch (e) {
        try { console.debug('[FDF Pro] failed to send REPORT_FILLED', e); } catch {}
      }

      // Track fingerprint so chaining won't re-fill the same form.
      // Use all currently cached forms (not just the single form that was
      // filled) so the pageObserver fingerprint comparison stays consistent.
      if (cachedForms.length > 0) {
        lastFilledFingerprint = formFingerprint(cachedForms.flatMap((f) => f.fields));
      } else {
        lastFilledFingerprint = formFingerprint(formAnalysis.fields);
      }
      filledFingerprintHistory.add(lastFilledFingerprint);
      isFilling = false;

      return result;
    }

    case 'ENABLE_CHAINING': {
      // Only reset history when chaining is first enabled for this
      // content session. Subsequent ENABLE_CHAINING messages (sent
      // after navigation) should preserve the history so we don't
      // re-fill previously completed wizard steps.
      const wasActive = chainingActive;
      chainingActive = true;
      if (!wasActive) {
        filledFingerprintHistory.clear();
      }
      // Capture current form fingerprint so the observer won't
      // immediately re-trigger for the current page.
      if (cachedForms.length > 0) {
        const fp = formFingerprint(cachedForms.flatMap((f) => f.fields));
        lastFilledFingerprint = fp;
        filledFingerprintHistory.add(fp);
      }
      // Load delay setting
      try {
        const resp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({ action: 'GET_SETTINGS' }) as ExtensionResponse | { success: false; error: string };
        if (resp && (resp as any).success && (resp as any).data) {
          chainingDelayMs = Math.max(500, ((resp as any).data as { chainingDelayMs?: number }).chainingDelayMs ?? 500);
        }
      } catch { /* use default */ }
      console.debug('[FDF Pro] chaining enabled on content script');
      return { active: true };
    }

    case 'DISABLE_CHAINING': {
      chainingActive = false;
      lastFilledFingerprint = '';
      filledFingerprintHistory.clear();
      console.debug('[FDF Pro] chaining disabled on content script');
      return { active: false };
    }

    case 'AUTO_SUBMIT': {
      // Disconnect the error observer before submitting so wizard/page
      // DOM changes don't trigger stale error recovery on the form we
      // just filled.
      if (activeErrorObserver) {
        try { activeErrorObserver.disconnect(); } catch { /* ignore */ }
        activeErrorObserver = null;
      }
      if (activeErrorObserverTimeout) {
        clearTimeout(activeErrorObserverTimeout);
        activeErrorObserverTimeout = null;
      }
      return autoSubmitForm();
    }

    case 'UPDATE_FIELD_VALUE': {
      const { fieldSelector, value } = message.payload as {
        fieldSelector: string;
        value: string;
      };
      const el = document.querySelector<HTMLElement>(fieldSelector);
      if (!el) throw new Error(`Element not found: ${fieldSelector}`);

      const dummyField: FieldAnalysis = {
        id: 'manual',
        index: 0,
        type: 'text',
        htmlType: (el as HTMLInputElement).type ?? 'text',
        name: (el as HTMLInputElement).name ?? '',
        label: '',
        placeholder: '',
        constraints: {
          minLength: null,
          maxLength: null,
          min: null,
          max: null,
          pattern: null,
          step: null,
          required: false,
          readOnly: false,
          disabled: false,
          multiple: false,
          accept: null,
        },
        required: false,
        selector: fieldSelector,
        formIndex: 0,
        value,
        confidence: 1,
      };

      return filler.fillField(el, dummyField);
    }

    case 'DETECT_ERRORS': {
      const payload = message.payload as { fields?: FieldAnalysis[] } | undefined;
      const errorElements = collectErrorElements(payload?.fields);
      return errorElements;
    }

    default:
      throw new Error(`Unhandled content action: ${message.action}`);
  }
}

// -----------------------------------------------------------
// Error element collection (sent to background for analysis)
// -----------------------------------------------------------

function collectErrorElements(fields?: FieldAnalysis[]): Array<{
  selector: string;
  text: string;
  nearFieldName?: string;
  nearFieldId?: string;
}> {
  const seen = new Set<Element>();
  const results: Array<{ selector: string; text: string; nearFieldName?: string; nearFieldId?: string }> = [];

  for (const sel of ERROR_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);

        const text = el.textContent?.trim() ?? '';
        if (text.length < 3) return; // Too short to be a real error message

        // Skip error elements that are hidden or inside a container without
        // an active error state (template error messages)
        if (!isErrorElementActive(el)) return;

        let nearFieldName: string | undefined;
        let nearFieldId: string | undefined;

        // Try data-field / label[for] / aria-errormessage first
        nearFieldName = el.getAttribute('data-field')
          ?? el.closest('[data-field]')?.getAttribute('data-field')
          ?? el.closest('label')?.getAttribute('for')
          ?? undefined;

        // Check if any input references this error element via aria
        if (!nearFieldName && el.id && fields) {
          const refInput = document.querySelector(
            `[aria-errormessage="${CSS.escape(el.id)}"], [aria-describedby~="${CSS.escape(el.id)}"]`,
          );
          if (refInput) {
            const match = fields.find((f) => {
              try { return document.querySelector(f.selector) === refInput; }
              catch { return false; }
            });
            if (match) {
              nearFieldName = match.name || match.label || match.id;
              nearFieldId = match.id;
            }
          }
        }

        // Check previous sibling
        if (!nearFieldName && fields) {
          const prev = el.previousElementSibling;
          if (prev) {
            const tag = prev.tagName.toLowerCase();
            const checkEl = (tag === 'input' || tag === 'select' || tag === 'textarea')
              ? prev
              : prev.querySelector('input, textarea, select');
            if (checkEl) {
              const match = fields.find((f) => {
                try { return document.querySelector(f.selector) === checkEl; }
                catch { return false; }
              });
              if (match) {
                nearFieldName = match.name || match.label || match.id;
                nearFieldId = match.id;
              }
            }
          }
        }

        // Walk up ancestors looking for a container with inputs
        if (!nearFieldName && fields) {
          let node: Element | null = el.parentElement;
          let depth = 0;
          while (node && depth < 8) {
            const inputs = Array.from(node.querySelectorAll('input, textarea, select'));
            if (inputs.length === 1) {
              const inputEl = inputs[0];
              const match = fields.find((f) => {
                try { return document.querySelector(f.selector) === inputEl; }
                catch { return false; }
              });
              if (match) {
                nearFieldName = match.name || match.label || match.id;
                nearFieldId = match.id;
              }
              break;
            } else if (inputs.length > 1 && inputs.length <= 6) {
              // Multi-input container: prefer inputs with error markers
              for (const inp of inputs) {
                const isInvalid =
                  inp.classList?.contains('is-invalid') ||
                  inp.classList?.contains('error-input') ||
                  inp.classList?.contains('has-error') ||
                  inp.classList?.contains('ng-invalid') ||
                  inp.getAttribute('aria-invalid') === 'true';
                if (isInvalid) {
                  const match = fields.find((f) => {
                    try { return document.querySelector(f.selector) === inp; }
                    catch { return false; }
                  });
                  if (match) {
                    nearFieldName = match.name || match.label || match.id;
                    nearFieldId = match.id;
                    break;
                  }
                }
              }
              if (nearFieldId) break;
              // Fallback: input preceding the error in DOM order
              for (let i = inputs.length - 1; i >= 0; i--) {
                if (inputs[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
                  const match = fields.find((f) => {
                    try { return document.querySelector(f.selector) === inputs[i]; }
                    catch { return false; }
                  });
                  if (match) {
                    nearFieldName = match.name || match.label || match.id;
                    nearFieldId = match.id;
                    break;
                  }
                }
              }
              if (nearFieldId) break;
            }
            node = node.parentElement;
            depth++;
          }
        }

        // Resolve fieldId if we only have a name
        if (nearFieldName && !nearFieldId && fields) {
          const match = fields.find((f) => f.name === nearFieldName || f.id === nearFieldName);
          if (match) nearFieldId = match.id;
        }

        // Last resort: match error text against field names/labels
        if (!nearFieldId && fields && text) {
          const lower = text.toLowerCase();
          for (const f of fields) {
            const name = f.name?.toLowerCase();
            const label = f.label?.toLowerCase();
            if (name && name.length > 2 && lower.includes(name)) {
              nearFieldName = f.name || f.label || f.id;
              nearFieldId = f.id;
              break;
            }
            if (label && label.length > 2 && lower.includes(label)) {
              nearFieldName = f.name || f.label || f.id;
              nearFieldId = f.id;
              break;
            }
          }
        }

        // If the matched field's container has .success OR the input
        // passes HTML5 validity, skip so it never enters recovery.
        if (nearFieldId && fields) {
          const fld = fields.find((f) => f.id === nearFieldId);
          if (fld) {
            try {
              const fieldEl = document.querySelector(fld.selector);
              if (fieldEl) {
                const container = fieldEl.closest('.form-group, .form-field, .field-group');
                if (container && container.classList.contains('success')) return;
                const inputEl = fieldEl as HTMLInputElement;
                const hasServerErrCls = inputEl.classList?.contains('error-input')
                  || inputEl.classList?.contains('is-invalid')
                  || inputEl.classList?.contains('has-error')
                  || inputEl.getAttribute('aria-invalid') === 'true';
                if (inputEl.value && typeof inputEl.validity !== 'undefined' && inputEl.validity.valid && !hasServerErrCls) return;
              }
            } catch {}
          }
        }

        results.push({
          selector: detector.cssSelector(el),
          text,
          nearFieldName,
          nearFieldId,
        });
      });
    } catch {
      // Invalid selector – skip
    }
  }

  // ---------------------------------------------------------
  // Second pass: directly scan inputs for error markers not
  // already caught by the selector pass above.
  // ---------------------------------------------------------
  if (fields) {
    const fieldsWithErrors = new Set(results.map((r) => r.nearFieldId).filter(Boolean));
    for (const field of fields) {
      if (fieldsWithErrors.has(field.id)) continue;
      try {
        const el = document.querySelector(field.selector) as HTMLElement | null;
        if (!el) continue;
        const input = el as HTMLInputElement;

        const hasErrorClass =
          input.classList?.contains('is-invalid') ||
          input.classList?.contains('error-input') ||
          input.classList?.contains('has-error') ||
          input.classList?.contains('ng-invalid') ||
          input.classList?.contains('error');

        const hasAriaInvalid = input.getAttribute('aria-invalid') === 'true';
        const isHtml5Invalid =
          typeof input.validity !== 'undefined' &&
          !input.validity.valid &&
          input.value !== '';

        if (!hasErrorClass && !hasAriaInvalid && !isHtml5Invalid) continue;

        let errorText = '';
        if (input.validationMessage && input.validationMessage.length > 3) {
          errorText = input.validationMessage;
        }
        if (!errorText) {
          const errMsgId = input.getAttribute('aria-errormessage');
          if (errMsgId) {
            try {
              const errMsgEl = document.getElementById(errMsgId);
              if (errMsgEl) errorText = errMsgEl.textContent?.trim() ?? '';
            } catch {}
          }
        }
        if (!errorText) {
          const sibling = input.nextElementSibling;
          if (sibling) {
            const sibCls = sibling.className?.toString() ?? '';
            if (/error|invalid|danger|text-red|help-block/i.test(sibCls)) {
              const sibText = sibling.textContent?.trim() ?? '';
              if (sibText.length >= 3) errorText = sibText;
            }
          }
        }
        if (!errorText) {
          const parent = input.parentElement;
          if (parent) {
            const errChild = parent.querySelector('.text-error, .error-message, .invalid-feedback, .field-error, [role="alert"], .text-danger, .help-block, .mat-error, .el-form-item__error, .ant-form-item-explain-error');
            if (errChild) {
              const childText = errChild.textContent?.trim() ?? '';
              if (childText.length >= 3) errorText = childText;
            }
          }
        }
        if (!errorText && (hasErrorClass || hasAriaInvalid)) {
          errorText = 'Invalid value';
        } else if (!errorText && isHtml5Invalid) {
          errorText = input.validationMessage || 'Invalid value';
        }

        if (errorText && errorText.length >= 3) {
          results.push({
            selector: detector.cssSelector(el),
            text: errorText,
            nearFieldName: field.name || field.label || field.id,
            nearFieldId: field.id,
          });
        }
      } catch {}
    }
  }

  return results;
}

function isErrorElementActive(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.style?.display === 'none' || htmlEl.style?.visibility === 'hidden') return false;

  // Check computed visibility (catches CSS class-based hiding)
  try {
    if (typeof window.getComputedStyle === 'function') {
      const cs = window.getComputedStyle(htmlEl);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    }
  } catch {}

  const container = el.closest(
    '.form-group, .form-field, .field-group, .input-group, .field-wrapper, .form-row',
  );
  if (container) {
    if (
      container.classList.contains('error') ||
      container.classList.contains('has-error') ||
      container.classList.contains('is-invalid')
    ) {
      return true;
    }

    // Check if the nearest input inside this container has error markers.
    // Many frameworks (Bootstrap 5, etc.) put .is-invalid on the input,
    // not on the container.
    const nearestInput = container.querySelector(
      'input, textarea, select',
    ) as HTMLElement | null;
    if (nearestInput) {
      if (
        nearestInput.classList?.contains('is-invalid') ||
        nearestInput.classList?.contains('error-input') ||
        nearestInput.classList?.contains('has-error') ||
        nearestInput.classList?.contains('ng-invalid') ||
        nearestInput.getAttribute('aria-invalid') === 'true'
      ) {
        return true;
      }
    }

    if (
      container.classList.contains('success') ||
      container.classList.contains('is-valid') ||
      container.classList.contains('has-success')
    ) {
      return false;
    }
    const cls = el.className?.toString() ?? '';
    if (
      /\b(error-message|invalid-feedback|field-error|form-error|help-block)\b/.test(cls)
    ) {
      return false;
    }
  }
  return true;
}

// -----------------------------------------------------------
// Mutation observer – watches for dynamic field additions
// and post-submit error messages.
// Guarded: only fires recovery a limited number of times and
// skips fields that already have valid values.
// -----------------------------------------------------------

let observerRecoveryCount = 0;
const MAX_OBSERVER_RECOVERIES = 3;
const observerSeenErrors = new Set<string>();
let activeErrorObserver: MutationObserver | null = null;
let activeErrorObserverTimeout: ReturnType<typeof setTimeout> | null = null;

function startErrorObserver(fields: FieldAnalysis[]): void {
  // Disconnect any previous error observer to prevent accumulation
  if (activeErrorObserver) {
    try { activeErrorObserver.disconnect(); } catch { /* ignore */ }
    activeErrorObserver = null;
  }
  if (activeErrorObserverTimeout) {
    clearTimeout(activeErrorObserverTimeout);
    activeErrorObserverTimeout = null;
  }

  // Reset counters on each new fill cycle
  observerRecoveryCount = 0;
  observerSeenErrors.clear();

  const observer = new MutationObserver(() => {
    // Stop reacting once we've exhausted observer-based recovery attempts
    if (observerRecoveryCount >= MAX_OBSERVER_RECOVERIES) return;

    if (errorObserverTimer) clearTimeout(errorObserverTimer);
    errorObserverTimer = setTimeout(() => {
      void notifyBackgroundOfErrors(fields);
    }, LIMITS.ERROR_OBSERVER_DEBOUNCE_MS);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'aria-invalid', 'data-error'],
  });

  activeErrorObserver = observer;

  // Auto-disconnect after 2 minutes to allow server-side validation
  // and async error messages to appear while the user interacts.
  activeErrorObserverTimeout = setTimeout(() => {
    observer.disconnect();
    if (activeErrorObserver === observer) {
      activeErrorObserver = null;
      activeErrorObserverTimeout = null;
    }
  }, 120_000);
}

async function notifyBackgroundOfErrors(fields: FieldAnalysis[]): Promise<void> {
  const allErrors = collectErrorElements(fields);
  // Only send field-associated errors to avoid page-level noise
  const errorElements = allErrors.filter((e) => (e.nearFieldName && e.nearFieldName.length > 0) || (e.nearFieldId && e.nearFieldId.length > 0));
  if (errorElements.length === 0) return;

  // Deduplicate: skip errors we've already attempted to recover
  const newErrors = errorElements.filter((e) => {
    const key = `${e.nearFieldId || e.nearFieldName}::${e.text}`;
    if (observerSeenErrors.has(key)) return false;
    observerSeenErrors.add(key);
    return true;
  });
  if (newErrors.length === 0) return;

  observerRecoveryCount++;

  const response = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({
    action: 'DETECT_ERRORS',
    payload: { errorElements: newErrors, fields },
  }) as ExtensionResponse | { success: false; error: string };

  if (response && (response as any).success && (response as any).data) {
    const { recovery } = (response as any).data as { recovery: { updatedFields: Array<{ field: string; value: string }> } | null };
    if (recovery?.updatedFields) {
      // Save current active element to restore after recovery fills
      const previousActive = document.activeElement as HTMLElement | null;

      for (const { field: fieldId, value } of recovery.updatedFields) {
        const fieldAnalysis = fields.find((f) => f.id === fieldId);
        if (fieldAnalysis) {
          const el = document.querySelector<HTMLElement>(fieldAnalysis.selector);
          if (!el) continue;

          // Skip fields inside hidden containers (e.g., previous wizard steps)
          try {
            const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
            if (cs && cs.display === 'none') continue;
            if (el.offsetParent === null && (el as HTMLElement).style?.position !== 'fixed') continue;
          } catch { /* ignore */ }

          // Skip if the field already has a valid value (don't overwrite good data)
          // BUT: don't skip if the input itself carries a server-side error class.
          const input = el as HTMLInputElement;
          const hasServerErrCls = input.classList?.contains('error-input')
            || input.classList?.contains('is-invalid')
            || input.classList?.contains('has-error')
            || input.getAttribute('aria-invalid') === 'true';
          if (!hasServerErrCls && input.value && typeof input.validity !== 'undefined' && input.validity.valid) {
            // Also verify the form-group container isn't still marked as error
            const container = el.closest('.form-group, .form-field, .field-group');
            if (!container || !container.classList.contains('error')) {
              continue;
            }
          }

          const updated = { ...fieldAnalysis, value };
          await filler.fillField(el, updated);
        }
      }

      // Restore focus to where it was before recovery, so the hotkey
      // isn't blocked by recovery-induced focus on an input.
      try {
        if (previousActive && typeof previousActive.focus === 'function'
          && previousActive !== document.activeElement) {
          previousActive.focus();
        } else if (document.activeElement
          && (document.activeElement as HTMLElement).tagName?.toLowerCase() === 'input') {
          (document.activeElement as HTMLElement).blur();
        }
      } catch { /* ignore */ }
    }
  }
}

// -----------------------------------------------------------
// Auto-submit: click the form's submit/next button
// -----------------------------------------------------------

function autoSubmitForm(): { clicked: boolean; selector: string | null } {
  // Find a submit or next button — prioritise buttons inside forms
  const selectors = [
    'form button[type="submit"]',
    'form input[type="submit"]',
    'form button:not([type="button"])',
    // Google Forms-style submit
    '[role="button"][aria-label*="Submit"]',
    '[role="button"][aria-label*="Next"]',
    // Generic next/submit/continue buttons (visible only)
    'button[type="submit"]',
    'input[type="submit"]',
  ];

  // Also match buttons by visible text (Next, Submit, Continue, etc.)
  const textPatterns = /\b(next|submit|continue|proceed|save|send|go|weiter|suivant|enviar|invia|siguiente)\b/i;

  for (const sel of selectors) {
    const btn = document.querySelector<HTMLElement>(sel);
    if (btn && btn.offsetParent !== null) {
      try { console.info('[FDF Pro] auto-submit clicking:', sel); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
      btn.click();
      return { clicked: true, selector: sel };
    }
  }

  // Fallback: search all visible buttons/links by text content
  const allButtons = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], a.btn, a.button, input[type="submit"]'),
  ).filter((b) => b.offsetParent !== null);

  for (const btn of allButtons) {
    const text = btn.textContent?.trim() ?? '';
    if (textPatterns.test(text)) {
      try { console.info('[FDF Pro] auto-submit clicking by text:', text); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
      btn.click();
      return { clicked: true, selector: text };
    }
  }

  try { console.info('[FDF Pro] auto-submit: no submit/next button found'); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
  return { clicked: false, selector: null };
}

// -----------------------------------------------------------
// Domain allow/block check
// -----------------------------------------------------------

async function shouldActivateOnCurrentDomain(): Promise<boolean> {
  const settingsResp = await sendMessageSafe<ExtensionMessage, ExtensionResponse>({
    action: 'GET_SETTINGS',
  }) as ExtensionResponse | { success: false; error: string };
  if (!settingsResp || !(settingsResp as any).success || !(settingsResp as any).data) return true;

  const settings = (settingsResp as any).data as {
    domainBlacklist: string[];
    domainWhitelist: string[];
  };
  const hostname = location.hostname;

  if (matchesHostnameList(hostname, settings.domainBlacklist)) return false;
  if (
    settings.domainWhitelist.length > 0 &&
    !matchesHostnameList(hostname, settings.domainWhitelist)
  ) {
    return false;
  }

  return true;
}

// -----------------------------------------------------------
// Bootstrap
// -----------------------------------------------------------

void (async () => {
  if (!(await shouldActivateOnCurrentDomain())) return;

  // Install the API response interceptor early so it captures all
  // XHR/fetch error responses from form submissions.
  try { installApiInterceptor(); } catch { /* ignore */ }

  // Initial form detection after page load
  await new Promise<void>((resolve) => {
    if (document.readyState === 'complete') return resolve();
    window.addEventListener('load', () => resolve(), { once: true });
  });

  cachedForms = detector.detectForms();

  // Re-detect when the DOM changes significantly (SPAs)
  const pageObserver = new MutationObserver(() => {
    if (pageObserverTimer) clearTimeout(pageObserverTimer);
    pageObserverTimer = setTimeout(() => {
      cachedForms = detector.detectForms();

      // Chaining: if active and new/changed forms appear, request a chain fill.
      // Skip while a fill is in progress to avoid re-triggering from our own DOM mutations.
      // Also skip if a chain fill request is already pending/being processed.
      if (chainingActive && !isFilling && !chainFillPending && cachedForms.length > 0) {
        const fp = formFingerprint(cachedForms.flatMap((f) => f.fields));
        // Skip if this fingerprint matches the last filled form OR any
        // previously filled form in this chaining session (prevents loops
        // when wizard steps cycle back to an earlier form).
        if (fp !== lastFilledFingerprint && !filledFingerprintHistory.has(fp)) {
          lastFilledFingerprint = fp;
          chainFillPending = true;
          console.info('[FDF Pro] chaining: new form detected via SPA mutation, requesting chain fill');
          // Apply chainingDelayMs before sending the request so the page
          // has time to settle (prevents rapid-fire fills on wizard forms).
          setTimeout(() => {
            // Re-check guards after the delay — state may have changed
            if (!chainingActive || isFilling) {
              chainFillPending = false;
              return;
            }
            void sendMessageSafe({ action: 'CHAIN_FILL_REQUEST', payload: { forms: cachedForms } })
              .finally(() => { chainFillPending = false; });
          }, chainingDelayMs);
        }
      }
    }, LIMITS.ANALYSIS_DEBOUNCE_MS);
  });

  pageObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden'],
  });

  // ----------------------------------------------------------
  // Modal auto-fill watcher
  // Fires when a dialog / modal becomes visible and fills any
  // form fields found inside it.
  // ----------------------------------------------------------
  const modalObserver = new MutationObserver((mutations) => {
    // React to mutations that involve dialog/modal-like elements
    let needsCheck = false;
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          try {
            const isModal = node.matches(MODAL_MATCH_COMBINED);
            const containsModal = node.querySelector(MODAL_MATCH_COMBINED) !== null;
            // Also catch when a new node with form inputs is appended
            // to the body (common with portals / React modals)
            const hasInputs = node.querySelector('input, textarea, select') !== null;
            if (isModal || containsModal || hasInputs) {
              needsCheck = true;
              break;
            }
          } catch { needsCheck = true; break; }
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target as HTMLElement;
        try {
          // Check if the mutated element is itself a modal or inside one
          const isModalNode = target.matches?.(MODAL_MATCH_COMBINED)
            ?? target.closest?.(MODAL_MATCH_COMBINED) !== null;
          if (isModalNode) needsCheck = true;
          // Also catch visibility changes on elements that contain forms
          // (e.g., a wrapper div getting style="display:block")
          if (!needsCheck && mutation.attributeName === 'style' && target.querySelector?.('input, textarea, select')) {
            needsCheck = true;
          }
        } catch { needsCheck = true; }
      }
      if (needsCheck) break;
    }

    if (!needsCheck) return;

    if (modalObserverTimer) clearTimeout(modalObserverTimer);
    // Small debounce so CSS transitions finish before we inspect visibility
    modalObserverTimer = setTimeout(() => void checkAndFillModals(), 350);
  });

  modalObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    // aria-hidden → dialog open/close; open → native <dialog>; class/style → CSS-driven modals;
    // role → dynamically added role="dialog"
    attributeFilter: ['aria-hidden', 'open', 'class', 'style', 'role'],
  });

  // ----------------------------------------------------------
  // API error recovery listener
  // After a submit/next triggers a server-side validation error
  // (4xx/5xx), the interceptor fires this callback with the
  // parsed field-level errors. We match API field names to our
  // cached FormAnalysis fields, request recovery values from the
  // background, and re-fill the failing fields.
  // ----------------------------------------------------------
  let apiRecoveryInProgress = false;
  onApiError(async (entry: ApiErrorEntry) => {
    if (apiRecoveryInProgress || isFilling) return;
    if (entry.fieldErrors.length === 0) return;

    // Determine which FormAnalysis to recover against
    const targetForms = cachedForms.length > 0 ? cachedForms : detector.detectForms();
    if (targetForms.length === 0) return;

    // Build a combined field list from all cached forms
    const allFields = targetForms.flatMap((f) => f.fields);
    if (allFields.length === 0) return;

    // Match API field names to FieldAnalysis entries
    // API keys are often camelCase or snake_case versions of the field name/label
    const apiToField = new Map<string, FieldAnalysis>();
    for (const apiErr of entry.fieldErrors) {
      const apiKey = apiErr.field.toLowerCase().replace(/[_\-\s]/g, '');
      const match = allFields.find((f) => {
        const name = (f.name || '').toLowerCase().replace(/[_\-\s]/g, '');
        const label = (f.label || '').toLowerCase().replace(/[_\-\s]/g, '');
        const id = (f.id || '').toLowerCase().replace(/[_\-\s]/g, '');
        return name === apiKey || label === apiKey || id === apiKey
            || name.includes(apiKey) || apiKey.includes(name)
            || label.includes(apiKey) || apiKey.includes(label);
      });
      if (match) apiToField.set(apiErr.field, match);
    }

    if (apiToField.size === 0) {
      try { console.debug('[FDF Pro] API errors captured but no field matches:', entry.fieldErrors.map(e => e.field)); } catch {}
      return;
    }

    apiRecoveryInProgress = true;
    try {
      console.info('[FDF Pro] API error recovery: matched', apiToField.size, 'fields from', entry.url, '(status', entry.status + ')');

      // Build error elements from API errors for the background recovery engine
      const errorElements = entry.fieldErrors
        .filter((e) => apiToField.has(e.field))
        .map((e) => ({
          selector: apiToField.get(e.field)!.selector,
          text: e.messages.join('; '),
          nearFieldName: apiToField.get(e.field)!.name || apiToField.get(e.field)!.label,
          nearFieldId: apiToField.get(e.field)!.id,
        }));

      const resp = await sendMessageSafe({
        action: 'DETECT_ERRORS',
        payload: {
          errorElements,
          fields: allFields,
        },
      }) as any;

      if (resp && resp.success && resp.data?.recovery?.updatedFields?.length) {
        const updates = resp.data.recovery.updatedFields as Array<{ field: string; value: string }>;
        console.info('[FDF Pro] API recovery: applying', updates.length, 'field corrections');

        for (const { field: fieldId, value } of updates) {
          const fieldAnalysis = allFields.find((f) => f.id === fieldId);
          if (!fieldAnalysis) continue;

          const el = document.querySelector<HTMLElement>(fieldAnalysis.selector);
          if (!el) continue;

          await filler.fillField(el, { ...fieldAnalysis, value });
        }
      } else {
        try { console.debug('[FDF Pro] API recovery: no recovery suggestions from background'); } catch {}
      }
    } catch (err) {
      try { console.debug('[FDF Pro] API error recovery failed', err); } catch {}
    } finally {
      apiRecoveryInProgress = false;
    }
  });

  // ----------------------------------------------------------
  // Resume / visibility handlers
  // Some pages are suspended or restored (bfcache) or become
  // visible again after long idle periods. Re-run form detection
  // and clear transient modal/filled history so filler works
  // without requiring a manual page refresh.
  // ----------------------------------------------------------
  function reinitializeContentScript(): void {
    try {
      console.debug('[FDF Pro] reinitialize content script: resume/visibility/focus/popstate');
      // Re-detect forms and update cached state
      cachedForms = detector.detectForms();
      // Clear modal fill history so re-opened modals can be filled again
      modalFilledHistory.clear();
      // Also clear short-lived filled fingerprint so chaining can continue
      lastFilledFingerprint = '';
      // Re-run modal checks in case a modal appeared while the
      // page was suspended or an SPA restored UI.
      void checkAndFillModals();
    } catch (err) {
      try { console.debug('[FDF Pro] reinitialize failed', err); } catch {}
    }
  }

  window.addEventListener('pageshow', () => {
    // pageshow fires when a page is restored from bfcache; always
    // reinitialize so content script resumes operation.
    reinitializeContentScript();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reinitializeContentScript();
  });

  // Focus/popstate are useful for SPA navigations or when a tab
  // regains focus after long idle periods.
  window.addEventListener('focus', () => reinitializeContentScript());
  window.addEventListener('popstate', () => reinitializeContentScript());
})();

export {};

// -----------------------------------------------------------
// Visual confirmation overlay for debugging/final check
// -----------------------------------------------------------
// visual overlay removed for zero-UI behavior
