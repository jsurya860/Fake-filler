// =============================================================
// API Response Interceptor
// Intercepts XHR and fetch responses after form submission to
// capture server-side validation errors from API responses.
// =============================================================

export interface ApiErrorEntry {
  /** The URL the request was sent to */
  url: string;
  /** HTTP status code */
  status: number;
  /** ISO timestamp of when the response was received */
  timestamp: string;
  /** Parsed field-level errors extracted from the response body */
  fieldErrors: ApiFieldError[];
  /** Raw error message from the response (top-level) */
  message?: string;
}

export interface ApiFieldError {
  /** Field name/key from the API response */
  field: string;
  /** Error message(s) for this field */
  messages: string[];
}

/** Ring buffer of recent API error responses */
const recentApiErrors: ApiErrorEntry[] = [];
const MAX_ENTRIES = 20;

/** Callbacks registered via onApiError */
const listeners: Array<(entry: ApiErrorEntry) => void> = [];

/** Register a callback that fires when an API error response is captured */
export function onApiError(cb: (entry: ApiErrorEntry) => void): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/** Get a shallow copy of recent API errors */
export function getRecentApiErrors(): ApiErrorEntry[] {
  return recentApiErrors.slice();
}

/** Drain and return all recent API errors (clears the buffer) */
export function drainApiErrors(): ApiErrorEntry[] {
  return recentApiErrors.splice(0, recentApiErrors.length);
}

// -----------------------------------------------------------
// Parse common API error response formats
// -----------------------------------------------------------

/**
 * Attempts to extract field-level errors from an API JSON response body.
 *
 * Recognises many common patterns:
 *  - Laravel:    { errors: { email: ["already taken"], name: ["required"] } }
 *  - Rails:      { errors: { email: ["is invalid"] } }
 *  - Django DRF: { email: ["This field is required."], name: ["..."] }
 *  - Spring:     { errors: [{ field: "email", defaultMessage: "..." }] }
 *  - Express/Joi:{ details: [{ path: ["email"], message: "..." }] }
 *  - Generic:    { error: { fields: { email: "invalid" } } }
 *  - Array:      [{ field: "email", message: "already taken" }]
 *  - .NET:       { errors: { Email: ["The Email field is required."] } }
 *  - message-only: { message: "Validation failed", errors: [...] }
 */
export function parseApiErrors(body: unknown): { fieldErrors: ApiFieldError[]; message?: string } {
  if (!body || typeof body !== 'object') return { fieldErrors: [] };

  const obj = body as Record<string, unknown>;
  const fieldErrors: ApiFieldError[] = [];
  let message: string | undefined;

  // Extract top-level message
  if (typeof obj.message === 'string') message = obj.message;
  if (typeof obj.error === 'string') message = message ?? obj.error;

  // --- Pattern 1: { errors: { field: [...messages] } } (Laravel / Rails / .NET)
  const errorsObj = obj.errors ?? obj.Errors ?? obj.fieldErrors ?? obj.field_errors;
  if (errorsObj && typeof errorsObj === 'object' && !Array.isArray(errorsObj)) {
    for (const [field, msgs] of Object.entries(errorsObj as Record<string, unknown>)) {
      const messages = normalizeMessages(msgs);
      if (messages.length > 0) fieldErrors.push({ field, messages });
    }
    if (fieldErrors.length > 0) return { fieldErrors, message };
  }

  // --- Pattern 2: { errors: [{ field, message/defaultMessage }] } (Spring / custom)
  if (Array.isArray(errorsObj)) {
    for (const item of errorsObj) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const field = (it.field ?? it.name ?? it.param ?? it.path ?? it.property ?? it.source) as string | undefined;
      const msg = (it.message ?? it.defaultMessage ?? it.msg ?? it.detail ?? it.error ?? it.description) as string | undefined;
      if (field && typeof field === 'string' && msg && typeof msg === 'string') {
        fieldErrors.push({ field, messages: [msg] });
      }
    }
    if (fieldErrors.length > 0) return { fieldErrors, message };
  }

  // --- Pattern 3: Top-level { field: [...messages] } (Django DRF)
  // Only if the object has string-array values and no "success" key
  if (!('success' in obj)) {
    for (const [key, val] of Object.entries(obj)) {
      if (key === 'message' || key === 'error' || key === 'status' || key === 'statusCode' || key === 'code') continue;
      const messages = normalizeMessages(val);
      if (messages.length > 0 && messages.some(m => m.length >= 3)) {
        fieldErrors.push({ field: key, messages });
      }
    }
    if (fieldErrors.length > 0) return { fieldErrors, message };
  }

  // --- Pattern 4: { details: [{ path: [...], message }] } (Joi / Celebrate)
  if (Array.isArray(obj.details)) {
    for (const item of obj.details) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const msg = typeof it.message === 'string' ? it.message : undefined;
      let field: string | undefined;
      if (Array.isArray(it.path) && it.path.length > 0) field = String(it.path[it.path.length - 1]);
      else if (typeof it.context === 'object' && it.context && typeof (it.context as Record<string, unknown>).key === 'string') field = (it.context as Record<string, unknown>).key as string;
      if (field && msg) fieldErrors.push({ field, messages: [msg] });
    }
    if (fieldErrors.length > 0) return { fieldErrors, message };
  }

  // --- Pattern 5: { error: { fields: { ... } } }
  if (typeof obj.error === 'object' && obj.error && !Array.isArray(obj.error)) {
    const inner = obj.error as Record<string, unknown>;
    const fields = inner.fields ?? inner.errors ?? inner.details;
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [field, msgs] of Object.entries(fields as Record<string, unknown>)) {
        const messages = normalizeMessages(msgs);
        if (messages.length > 0) fieldErrors.push({ field, messages });
      }
      if (fieldErrors.length > 0) return { fieldErrors, message };
    }
  }

  // --- Pattern 6: Root-level array [{ field, message }]
  if (Array.isArray(body)) {
    for (const item of body) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const field = (it.field ?? it.name ?? it.param) as string | undefined;
      const msg = (it.message ?? it.msg ?? it.error) as string | undefined;
      if (field && typeof field === 'string' && msg && typeof msg === 'string') {
        fieldErrors.push({ field, messages: [msg] });
      }
    }
    if (fieldErrors.length > 0) return { fieldErrors, message };
  }

  return { fieldErrors, message };
}

function normalizeMessages(val: unknown): string[] {
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) return val.filter((v): v is string => typeof v === 'string');
  return [];
}

// -----------------------------------------------------------
// Determine if a response status indicates a validation error
// -----------------------------------------------------------

function isErrorStatus(status: number): boolean {
  // 400 Bad Request, 422 Unprocessable Entity, 409 Conflict are common validation responses
  // Also catch 401/403 for auth-related form errors
  return status >= 400 && status < 600;
}

// -----------------------------------------------------------
// Record an error entry and notify listeners
// -----------------------------------------------------------

function recordError(entry: ApiErrorEntry): void {
  if (entry.fieldErrors.length === 0 && !entry.message) return;
  recentApiErrors.push(entry);
  if (recentApiErrors.length > MAX_ENTRIES) recentApiErrors.shift();
  for (const cb of listeners) {
    try { cb(entry); } catch { /* ignore listener errors */ }
  }
}

// -----------------------------------------------------------
// Install interceptors
// -----------------------------------------------------------

let installed = false;

/**
 * Monkey-patches fetch() and XMLHttpRequest to capture
 * validation error responses from server APIs.
 */
export function installApiInterceptor(): void {
  if (installed) return;
  installed = true;

  // ---- Fetch interceptor ----
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await origFetch.call(window, input, init);
    try {
      if (isErrorStatus(response.status)) {
        // Clone so the original consumer can still read the body
        const clone = response.clone();
        // Read text async — don't block the caller
        void clone.text().then((text) => {
          try {
            const json = JSON.parse(text);
            const { fieldErrors, message } = parseApiErrors(json);
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
            recordError({
              url,
              status: response.status,
              timestamp: new Date().toISOString(),
              fieldErrors,
              message,
            });
          } catch { /* not JSON or parse failure — ignore */ }
        }).catch(() => { /* ignore */ });
      }
    } catch { /* never break fetch for consumers */ }
    return response;
  };

  // ---- XMLHttpRequest interceptor ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const urlMap = new WeakMap<XMLHttpRequest, string>();

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    urlMap.set(this, typeof url === 'string' ? url : url.href);
    return (origOpen as Function).call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    this.addEventListener('load', function onLoad() {
      try {
        if (isErrorStatus(this.status)) {
          const text = this.responseText;
          if (text) {
            try {
              const json = JSON.parse(text);
              const { fieldErrors, message } = parseApiErrors(json);
              recordError({
                url: urlMap.get(this) ?? '',
                status: this.status,
                timestamp: new Date().toISOString(),
                fieldErrors,
                message,
              });
            } catch { /* not JSON */ }
          }
        }
      } catch { /* never break XHR for consumers */ }
    });
    return origSend.call(this, body);
  };

  try { console.debug('[FDF Pro] API interceptor installed'); } catch { /* ignore */ }
}
