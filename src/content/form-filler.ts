import type { FieldAnalysis, FormAnalysis, ErrorType } from '@/shared/types';
import { ERROR_SELECTORS, DEFAULT_SETTINGS } from '@/shared/constants';

// Lightweight safe-send helper (mirrors the one in index.ts) so
// form-filler never throws when the service worker is unavailable.
async function sendMessageSafe(msg: unknown): Promise<any> {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return { success: false, error: 'no-runtime' };
    const res = await chrome.runtime.sendMessage(msg as any);
    return res ?? { success: false, error: 'no-response' };
  } catch { return { success: false, error: 'send-failed' }; }
}

// =============================================================
// FormFiller
// Fills form fields with generated values.
// Handles React, Angular, Vue, and plain HTML forms by
// firing the right synthetic events for each framework.
// =============================================================

// Cache native value setters so React's synthetic events fire correctly
const nativeInputSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)?.set;

const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  'value',
)?.set;

const nativeSelectSetter = Object.getOwnPropertyDescriptor(
  window.HTMLSelectElement.prototype,
  'value',
)?.set;

export class FormFiller {
  // -----------------------------------------------------------
  // Fill all fields in a form analysis
  // -----------------------------------------------------------

  async fillForm(formAnalysis: FormAnalysis): Promise<{ filled: number; skipped: number }> {
    // Perform multiple passes to handle fields that depend on previous inputs
    // (e.g. country -> state dropdown population). We attempt up to
    // `maxPasses` rounds and stop early if no progress is made.
    const interFieldDelay = (typeof process !== 'undefined' && (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test')) ? 0 : 30;
    const maxPasses = 3;

    const filledSet = new Set<string>();
    // Pre-mark fields that should be skipped (explicit skip or no provided value)
    const allFields = formAnalysis.fields ?? [];
    for (const f of allFields) {
      if (f.skip || f.value === undefined || f.value === null) {
        // leave as not-fillable; they'll count as skipped at the end
        continue;
      }
    }

    for (let pass = 0; pass < maxPasses; pass++) {
      let progress = false;

      for (const field of allFields) {
        if (filledSet.has(field.id)) continue;
        if (field.skip || field.value === undefined || field.value === null) continue;

        const el = this.resolveElement(field.selector);
        if (!el) {
          // Element not present yet — maybe created after another field is set.
          // Defer to subsequent passes.
          continue;
        }

        const success = await this.fillField(el, field);
        if (success) {
          filledSet.add(field.id);
          progress = true;
        }

        // Small delay between fields to allow validation libraries to react
        await this.sleep(interFieldDelay);
      }

      if (!progress) break;
    }

    const filled = filledSet.size;
    const skipped = Math.max(0, allFields.length - filled);
    return { filled, skipped };
  }

  // -----------------------------------------------------------
  // Fill a single field
  // -----------------------------------------------------------

  async fillField(
    el: HTMLElement,
    field: FieldAnalysis,
  ): Promise<boolean> {
    if (!field.value) return false;

    // Skip read-only and disabled elements — they cannot accept user input
    const inputEl = el as HTMLInputElement;
    if (inputEl.readOnly && !['checkbox', 'radio'].includes(inputEl.type ?? '')) return false;
    if (inputEl.disabled) return false;

      try {
        // Debug log which field and value we're about to set
        try { console.debug('[FDF Pro] fillField:', field.selector, '=>', field.value); } catch {}

        // Precompute whether this field looks like a telephone/mobile input
        const isTelField = (inputEl.type === 'tel') || field.type === 'phone' || /phone|mobile|tel|contact/i.test((field.name || '') + ' ' + (field.label || ''));

      // Handle selects (native and custom) by field.type first
      if (field.type === 'select') {
        return await this.fillSelect(el as any, String(field.value));
      }

      // Handle custom display-only containers (e.g., vue-multiselect) where the
      // visible selected value is rendered in a <span> or <div> and the actual
      // input may be hidden. Try to set hidden input value or click the option.
      const tag = el.tagName?.toLowerCase();
      if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
        try {
          // Common display selectors for custom selects
          const display = el.querySelector('.multiselect__single, .vs__selected, .Select__single-value, .chosen-single, .select2-selection__rendered') as HTMLElement | null;
          // Prefer an existing FDF-managed hidden input for stability
          let hiddenInput = el.querySelector<HTMLInputElement>(`input[data-fdf-field-id="${field.id}"]`)
            ?? el.querySelector<HTMLInputElement>('input[type="hidden"][name], input[name]')
            ?? el.querySelector<HTMLInputElement>('input[type="hidden"], input');

              if (display) {
            try {
              // If there is no hidden input or it lacks a name attribute, create or assign one
              if (!hiddenInput) {
                const nameToUse = (field.name && field.name.trim().length > 0) ? field.name : `fdf_${field.id}`;
                const formEl = el.closest('form') ?? document.body;
                const created = document.createElement('input');
                created.type = 'hidden';
                created.name = nameToUse;
                created.setAttribute('data-fdf-field-id', field.id);
                formEl.appendChild(created);
                hiddenInput = created;
              } else if (!hiddenInput.name || hiddenInput.name.trim() === '') {
                const nameToUse = (field.name && field.name.trim().length > 0) ? field.name : `fdf_${field.id}`;
                hiddenInput.name = nameToUse;
                hiddenInput.setAttribute('data-fdf-field-id', field.id);
              }
              
              // Set hidden input value so form submissions and generators can read it
                try {
                let hiddenVal = String(field.value);
                if (isTelField) hiddenVal = hiddenVal.replace(/\D/g, '');
                nativeInputSetter?.call(hiddenInput, hiddenVal);
                try { hiddenInput.value = hiddenVal; } catch {}
                this.dispatch(hiddenInput, 'input');
                this.dispatch(hiddenInput, 'change');
              } catch {}

              // Also update visible display for immediate UX
              try { display.textContent = isTelField ? String(field.value).replace(/\D/g, '') : String(field.value); } catch {}
              return true;
            } catch {}
          }

          // If no hidden input, try opening the dropdown and selecting matching option
          try { el.click(); } catch {}
          const optionCandidates = Array.from(document.querySelectorAll<HTMLElement>('.multiselect__element li, .multiselect__option, [role="option"], .vs__dropdown-option, .Select__option'));
          if (optionCandidates.length > 0) {
            const match = optionCandidates.find((c) => (c.textContent || '').trim().toLowerCase() === String(field.value).trim().toLowerCase());
            const chosen = match ?? optionCandidates[Math.floor(Math.random() * optionCandidates.length)];
            try { chosen.click(); } catch { try { chosen.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch {} }
            // If we have a hidden input target, set it to a digits-only value for phone fields
            try {
              if (hiddenInput) {
                let val = String(field.value);
                if (isTelField) val = val.replace(/\D/g, '');
                nativeInputSetter?.call(hiddenInput, val);
                try { hiddenInput.value = val; } catch {}
                this.dispatch(hiddenInput, 'input');
                this.dispatch(hiddenInput, 'change');
              }
            } catch {}
            return true;
          }
        } catch {}
      }

      if ((el as HTMLInputElement).type === 'checkbox') {
        return this.fillCheckbox(el as HTMLInputElement, String(field.value));
      }

      if ((el as HTMLInputElement).type === 'radio' || field.htmlType === 'radiogroup' || el.getAttribute('role') === 'radiogroup') {
        return this.fillRadio(el as HTMLInputElement, String(field.value));
      }

      if ((el as HTMLInputElement).type === 'file') {
        return false; // Cannot programmatically set file inputs
      }

      if ((el as HTMLInputElement).type === 'date') {
        return this.fillDateInput(el as HTMLInputElement, String(field.value));
      }

      // Handle time, datetime-local, month, week via native setter
      // Also coerce the value to the correct format if the background
      // produced a mismatched format (e.g. lorem text for a time input)
      const inputType = (el as HTMLInputElement).type;
      if (inputType === 'time') {
        const coerced = this.coerceToTime(String(field.value));
        return this.fillDateInput(el as HTMLInputElement, coerced);
      }
      if (inputType === 'datetime-local') {
        const coerced = this.coerceToDatetimeLocal(String(field.value));
        return this.fillDateInput(el as HTMLInputElement, coerced);
      }
      if (inputType === 'month') {
        const coerced = this.coerceToMonth(String(field.value));
        return this.fillDateInput(el as HTMLInputElement, coerced);
      }
      if (inputType === 'week') {
        const coerced = this.coerceToWeek(String(field.value));
        return this.fillDateInput(el as HTMLInputElement, coerced);
      }

      // Standard text / email / tel / password / number / textarea
      // If this is a telephone/mobile field, coerce to digits only
      try {
        const inputEl = el as HTMLInputElement;
        const isTel = inputEl.type === 'tel' || field.type === 'phone' || /phone|mobile|tel|contact/i.test((field.name || '') + ' ' + (field.label || ''));
        if (isTel && field.value) {
          const digits = String(field.value).replace(/\D/g, '');
          // If we ended up with no digits, fall back to original value
          const newVal = digits.length > 0 ? digits : String(field.value);
          field = { ...field, value: newVal } as FieldAnalysis;
        }

        // If input uses a <datalist>, prefer selecting one of its <option>s
        try {
          if ((el as HTMLInputElement).hasAttribute && (el as HTMLInputElement).hasAttribute('list')) {
            const listId = (el as HTMLInputElement).getAttribute('list');
            if (listId) {
              const dl = document.getElementById(listId) as HTMLDataListElement | null;
              if (dl) {
                const opts = Array.from(dl.querySelectorAll('option')).map((o) => (o.value ?? '').toString()).filter(Boolean);
                if (opts.length > 0) {
                  // Prefer exact match (case-insensitive), else pick first deterministic option
                  const lower = String(field.value ?? '').trim().toLowerCase();
                  let chosen = opts.find((o) => o.trim().toLowerCase() === lower) ?? opts[0];
                  try {
                    // Use native setter + direct assignment then dispatch events
                    const val = String(chosen);
                    nativeInputSetter?.call(el as HTMLInputElement, val);
                    try { (el as HTMLInputElement).value = val; } catch {}
                    this.dispatch(el as Element, 'input', val);
                    this.dispatch(el as Element, 'change');
                    this.dispatch(el as Element, 'blur');
                    return true;
                  } catch {}
                }
              }
            }
          }
        } catch {}
      } catch {}

      return this.fillTextInput(el as HTMLInputElement | HTMLTextAreaElement, String(field.value));
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------
  // Text/email/password/number/textarea
  // -----------------------------------------------------------

  private fillTextInput(
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ): boolean {
    // Focus first so validation listeners attach
    el.focus();

    // If this looks like a combobox/react-select input, prefer selecting
    // one of the rendered options instead of inserting arbitrary text.
    try {
      const role = (el.getAttribute && el.getAttribute('role')) || '';
      const ariaAuto = (el.getAttribute && el.getAttribute('aria-autocomplete')) || '';
      const isComboboxLike = role === 'combobox' || ariaAuto === 'list' || !!el.closest('.react-select') || !!el.closest('.Select') || !!el.closest('[data-reactroot]');
      if (isComboboxLike) {
        try { el.focus(); } catch {}
        try { el.click(); } catch {}
        // Give the dropdown a moment to render
        try { /* fallthrough */ } catch {}
        // Look for visible option-like elements near the page
        const optionSelectors = ['[role="option"]', '.react-select__option', '.Select__option', '.multiselect__option', '.vs__dropdown-option', '.option', '.ant-select-dropdown-item'];
        const candidates: HTMLElement[] = [];
        for (const sel of optionSelectors) {
          try {
            const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((n) => n.offsetParent !== null || (typeof process !== 'undefined' && process.env.JEST_WORKER_ID));
            if (nodes.length > 0) candidates.push(...nodes);
          } catch {}
        }

        // Narrow candidates to those within a reasonable ancestor (dropdown or listbox)
        const inputRoot = el.closest('[role="combobox"], .react-select, .Select, .vs__dropdown, .multiselect__element, .ant-select') as Element | null;
        let scoped: HTMLElement[] = [];
        if (inputRoot) {
          for (const c of candidates) {
            if (inputRoot.contains(c) || !!c.closest('.ant-select-dropdown') || !!c.closest('.Select__menu') || !!c.closest('.react-select__menu')) scoped.push(c);
          }
        }
        if (scoped.length === 0) scoped = candidates;

        if (scoped.length > 0) {
          const lower = String(value ?? '').trim().toLowerCase();
          let chosen = scoped.find((c) => (c.textContent ?? '').trim().toLowerCase() === lower) ?? scoped[0];
          try { chosen.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
          try { chosen.click(); } catch { try { chosen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); chosen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); chosen.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch {} }
          // If this input looks like a telephone field, sanitize chosen text to digits-only
          try {
            const isTel = (el instanceof HTMLInputElement && el.type === 'tel') || /phone|mobile|tel|contact/i.test((el.getAttribute && el.getAttribute('name') || '') + ' ' + (el.getAttribute && el.getAttribute('placeholder') || '') + ' ' + (el.id || ''));
            let chosenText = chosen.textContent?.trim() ?? '';
            if (isTel) chosenText = chosenText.replace(/\D/g, '');
            try { nativeInputSetter?.call(el, chosenText); } catch {}
            try { (el as HTMLInputElement).value = chosenText; } catch {}
            this.dispatch(el, 'input', chosenText);
            this.dispatch(el, 'change');
            this.dispatch(el, 'blur');
            return true;
          } catch {}
        }
      }
    } catch {}

    // --- Strategy 1: Native setter (required for React) ---
    // React intercepts the property setter on HTMLInputElement.prototype.value
    // and swallows direct .value assignments. Using the original setter
    // bypasses React's interception while still triggering React's synthetic
    // event system (via the InputEvent dispatched below).
    if (el instanceof HTMLTextAreaElement) {
      nativeTextareaSetter?.call(el, value);
    } else {
      nativeInputSetter?.call(el, value);
    }

    // --- Strategy 2: Direct assignment (required for Vue 2/3, Angular) ---
    // Vue 2's v-model installs a setter interceptor via Object.defineProperty.
    // Vue 3 uses Proxy-based reactivity. Angular uses (input) event binding.
    // All three need the direct property assignment to trigger their internal
    // observers. This line works alongside the native setter above — React
    // ignores it (already set), Vue/Angular pick it up.
      try {
        // Enforce minlength / maxlength if present on the element or in field constraints
        let finalValue = String(value ?? '');
        // If the input appears to require digits-only (tel, numeric inputmode,
        // or name/label hints like postal/zip/ssn/cvv/account/card), strip
        // all non-digit characters to avoid special-character formatting.
        // Also apply early formatting for SSN, card expiry (MM/YY), and
        // IFSC-like codes so validators see the final human-friendly format.
        try {
          const inputEl = el as HTMLInputElement;
          const nameHint = ((inputEl.name || '') + ' ' + (inputEl.id || '') + ' ' + (inputEl.placeholder || '')).toLowerCase();
          const inputMode = (inputEl.getAttribute && inputEl.getAttribute('inputmode')) || '';
          const patternAttr = (inputEl.getAttribute && inputEl.getAttribute('pattern')) || '';
          // Narrow integer-like hints so we don't strip letters from alphanumeric IDs
          const integerHints = /phone|mobile|tel|contact|postal|zip|zipcode|ssn|cvv|cvc|routing|routingnumber|bankaccount|accountnumber|age|years|number/i;
          const alphaIdHints = /visa|passport|driving|license|dl|national\s*id|nationalid|id\b|ifsc|tax|pan|tin|swift|bic/i;
          const expiryHints = /expir|exp.?date|exp.?month|expiry/i;
          const ifscHints = /ifsc|ifsccode|ifsc_code|ifsc code/i;
          // If the pattern explicitly includes separators (/, -, .), avoid treating
          // it as a plain integer-only field so formats like MM/YY or NNN-NN-NNNN
          // are preserved.
          const patternHasSeparators = /[.,\-\/]/.test(patternAttr);
          const patternHasLetters = /[A-Za-z]/.test(patternAttr);
          const looksInteger = inputEl.type === 'tel' || inputMode === 'numeric' || ((integerHints.test(nameHint) && !expiryHints.test(nameHint) && !alphaIdHints.test(nameHint))) || (/\d/.test(patternAttr) && !patternHasSeparators && !expiryHints.test(patternAttr) && !patternHasLetters);
          if (looksInteger) {
            finalValue = finalValue.replace(/\D/g, '');
          }

          // SSN: if the field looks like SSN and we have 9 digits, format as NNN-NN-NNNN
          try {
            if (/\bssn\b/i.test(nameHint) || /social.?security/i.test(nameHint)) {
              const digits = finalValue.replace(/\D/g, '');
              if (digits.length === 9) finalValue = `${digits.slice(0,3)}-${digits.slice(3,5)}-${digits.slice(5)}`;
            }
          } catch {}

          // Card expiry / expiry-like: prefer MM/YY formatting when possible
          try {
            if (expiryHints.test(nameHint) || /mm\/?yy|mm-yy|expiry/i.test(patternAttr)) {
              const digits = finalValue.replace(/\D/g, '');
              if (digits.length === 4) finalValue = `${digits.slice(0,2)}/${digits.slice(2)}`;
              // If already in MMYY or MM/YY, normalize separator
              else {
                const m = finalValue.match(/^(\d{2})\D?(\d{2})$/);
                if (m) finalValue = `${m[1]}/${m[2]}`;
              }
            }
          } catch {}

          // IFSC-like codes: uppercase, remove whitespace
          try {
            if (ifscHints.test(nameHint) || /ifsc/i.test(patternAttr)) {
              finalValue = finalValue.replace(/\s+/g, '').toUpperCase();
            }
          } catch {}
        } catch {}
      try {
        const maxAttr = (el.getAttribute && el.getAttribute('maxlength')) ? parseInt(el.getAttribute('maxlength') as string, 10) : null;
        const minAttr = (el.getAttribute && el.getAttribute('minlength')) ? parseInt(el.getAttribute('minlength') as string, 10) : null;
        if (maxAttr && !isNaN(maxAttr) && finalValue.length > maxAttr) finalValue = finalValue.slice(0, maxAttr);
        if (minAttr && !isNaN(minAttr) && finalValue.length < minAttr) {
          // Pad with digits if the field appears numeric, else with 'a'
          const padChar = /^[0-9]+$/.test(finalValue) ? '0' : 'a';
          while (finalValue.length < minAttr) finalValue += padChar;
        }

        // Align numeric values to the input's `step` when applicable so
        // HTML5 constraint validation (step mismatch) doesn't fail.
        try {
          if (el instanceof HTMLInputElement) {
            const stepAttr = (el.getAttribute && el.getAttribute('step')) || null;
            const isNumberLike = el.type === 'number' || /\bnumber\b|numeric|tel/.test((el.getAttribute && el.getAttribute('inputmode') || '') + ' ' + (el.type || ''));
            if (isNumberLike && stepAttr !== 'any') {
              const step = stepAttr ? parseFloat(stepAttr) : 1;
              const num = parseFloat(finalValue);
              if (!isNaN(num) && isFinite(num) && step > 0) {
                const aligned = Math.round(num / step) * step;
                // If step is an integer (>=1), write an integer string
                if (step >= 1) finalValue = String(Math.round(aligned));
                else finalValue = String(aligned);
              }
            }
          }
        } catch {}
      } catch {}

        // Additional targeted normalizations:
        try {
          const inputEl = el as HTMLInputElement;
          const nameHintFull = ((inputEl.name || '') + ' ' + (inputEl.id || '') + ' ' + (inputEl.placeholder || '')).toLowerCase();

          // Telephone-like fields: ensure digits-only early so validators that
          // require numeric patterns see a clean value.
          if (/phone|mobile|tel|contact/i.test(nameHintFull) || inputEl.type === 'tel') {
            const digitsOnly = finalValue.replace(/\D/g, '');
            if (digitsOnly.length > 0) finalValue = digitsOnly;
          }

          // Latitude / Longitude: clamp to valid ranges and normalise precision
          if (/\blatitude\b/i.test(nameHintFull) || (inputEl.name && inputEl.name.toLowerCase() === 'latitude')) {
            const n = parseFloat(finalValue);
            if (!isNaN(n) && isFinite(n)) {
              const clamped = Math.max(-90, Math.min(90, n));
              finalValue = clamped.toFixed(6).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1');
            }
          }
          if (/\blongitude\b/i.test(nameHintFull) || (inputEl.name && inputEl.name.toLowerCase() === 'longitude')) {
            const n = parseFloat(finalValue);
            if (!isNaN(n) && isFinite(n)) {
              const clamped = Math.max(-180, Math.min(180, n));
              finalValue = clamped.toFixed(6).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1');
            }
          }
        } catch {}

      el.value = finalValue;
    } catch { /* Some frameworks freeze the element */ }

    // For telephone fields, ensure value contains only digits and respect
    // minlength/maxlength attributes.
      try {
      const inputEl = el as HTMLInputElement;
      const isTel = inputEl.type === 'tel' || /phone|mobile|tel|contact/i.test((inputEl.name || '') + ' ' + (inputEl.placeholder || '') + ' ' + (inputEl.id || ''));
      if (isTel) {
        try {
          let v = (el.value ?? '').toString();
          const digits = v.replace(/\D/g, '');
          v = digits;
          const maxAttr = (inputEl.getAttribute && inputEl.getAttribute('maxlength')) ? parseInt(inputEl.getAttribute('maxlength') as string, 10) : null;
          const minAttr = (inputEl.getAttribute && inputEl.getAttribute('minlength')) ? parseInt(inputEl.getAttribute('minlength') as string, 10) : null;
          if (maxAttr && !isNaN(maxAttr) && v.length > maxAttr) v = v.slice(0, maxAttr);
          if (minAttr && !isNaN(minAttr) && v.length < minAttr) {
            while (v.length < minAttr) v += String(Math.floor(Math.random() * 10));
          }
          nativeInputSetter?.call(el, v);
          try { el.value = v; } catch {}
        } catch {}
      }
    } catch {}

    // Fire compositionend to flush any pending IME state (Vue 2 ignores
    // 'input' events while a composition is active).
    try { el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value })); } catch {}

    // Fire events in the order that most frameworks expect.
    // Include 'data' and 'inputType' on the InputEvent so frameworks that
    // inspect event.data (Vue 3, some Angular validators) see the value.
    this.dispatch(el, 'input', value);
    this.dispatch(el, 'change');
    this.dispatch(el, 'blur');

    return true;
  }

  // -----------------------------------------------------------
  // Date input
  // -----------------------------------------------------------

  private fillDateInput(el: HTMLInputElement, value: string): boolean {
    // Normalise to YYYY-MM-DD (required for <input type="date">)
    const normalised = this.normaliseDateValue(value);
    if (!normalised) return false;

    el.focus();
    nativeInputSetter?.call(el, normalised);
    try { el.value = normalised; } catch {}
    this.dispatch(el, 'input', normalised);
    this.dispatch(el, 'change');
    this.dispatch(el, 'blur');
    return true;
  }

  private normaliseDateValue(value: string): string | null {
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

    // time format HH:MM or HH:MM:SS
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return value;

    // datetime-local format YYYY-MM-DDTHH:MM
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;

    // month format YYYY-MM
    if (/^\d{4}-\d{2}$/.test(value)) return value;

    // week format YYYY-Www
    if (/^\d{4}-W\d{2}$/.test(value)) return value;

    // Try constructing a Date
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }

    return null;
  }

  // Coerce any value to HH:MM format — generates a fallback if the value isn't already valid
  private coerceToTime(value: string): string {
    if (/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return value;
    // If it contains a T (datetime-local), extract the time part
    const tMatch = value.match(/T(\d{2}:\d{2})/);
    if (tMatch) return tMatch[1];
    // Generate a random business-hours time as fallback
    const h = String(Math.floor(Math.random() * 11) + 8).padStart(2, '0');
    const m = String(Math.floor(Math.random() * 60)).padStart(2, '0');
    return `${h}:${m}`;
  }

  // Coerce any value to YYYY-MM-DDTHH:MM format
  private coerceToDatetimeLocal(value: string): string {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return value;
    // If it's a date-only value, append a time
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const h = String(Math.floor(Math.random() * 11) + 8).padStart(2, '0');
      const m = String(Math.floor(Math.random() * 60)).padStart(2, '0');
      return `${value}T${h}:${m}`;
    }
    // Try to parse as Date
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
    }
    // Fallback: future date with time
    const now = new Date();
    now.setDate(now.getDate() + Math.floor(Math.random() * 60) + 1);
    return now.toISOString().slice(0, 16);
  }

  // Coerce any value to YYYY-MM format
  private coerceToMonth(value: string): string {
    if (/^\d{4}-\d{2}$/.test(value)) return value;
    // If it's a full date, trim to month
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
    // Try to parse
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 7);
    // Fallback
    const now = new Date();
    const year = now.getFullYear() + Math.floor(Math.random() * 2);
    const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  // Coerce any value to YYYY-Www format
  private coerceToWeek(value: string): string {
    if (/^\d{4}-W\d{2}$/.test(value)) return value;
    // If it's a date, compute the ISO week
    let d: Date;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      d = new Date(value);
    } else {
      d = new Date(value);
    }
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      // ISO week calculation
      const jan4 = new Date(year, 0, 4);
      const daysDiff = Math.floor((d.getTime() - jan4.getTime()) / 86400000);
      const weekNum = Math.max(1, Math.min(53, Math.ceil((daysDiff + jan4.getDay() + 1) / 7)));
      return `${year}-W${String(weekNum).padStart(2, '0')}`;
    }
    // Fallback
    const now = new Date();
    const year = now.getFullYear() + Math.floor(Math.random() * 2);
    const week = String(Math.floor(Math.random() * 52) + 1).padStart(2, '0');
    return `${year}-W${week}`;
  }

  // -----------------------------------------------------------
  // Select
  // -----------------------------------------------------------

  private async fillSelect(el: any, value: string): Promise<boolean> {
    // If this is a real <select> element, use native option handling
    if (el && el.tagName && el.tagName.toLowerCase() === 'select') {
      const selectEl = el as HTMLSelectElement;
      let option = Array.from(selectEl.options).find(
        (o) => (o.value && o.value === value) || (o.text && o.text.trim().toLowerCase() === value.toLowerCase()),
      );

      if (!option) {
        const nonEmpty = Array.from(selectEl.options).filter((o) => (o.value ?? '').toString().trim() !== '');
        if (nonEmpty.length === 0) return false;
        option = nonEmpty[Math.floor(Math.random() * nonEmpty.length)];
      }

      try {
        selectEl.focus();
        option.selected = true;
        try { option.dispatchEvent(new Event('click', { bubbles: true })); } catch (e) { try { console.debug('[FDF Pro] option click failed', e); } catch {} }
        if (nativeSelectSetter) nativeSelectSetter.call(selectEl, option.value);
        // Direct assignment for Vue/Angular reactivity
        try { selectEl.value = option.value; } catch {}
        this.dispatch(selectEl, 'input');
        this.dispatch(selectEl, 'change');
        this.dispatch(selectEl, 'blur');
        try { console.debug('[FDF Pro] fillSelect (native):', this.cssSelector(selectEl), '=>', option.value); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
        return true;
      } catch {
        return false;
      }
    }

    // Custom dropdowns (div-based listboxes / comboboxes)
    try {
    el.focus();

    // If the selector points to an inner <input> of a custom widget (react-select, Select, etc.),
    // prefer the closest widget root so option queries find the menu items.
    let root: Element = el as Element;
    const wrapper = (el as Element).closest('.react-select, .Select, .vs__dropdown, .multiselect__element, .ant-select');
    if (wrapper) root = wrapper;

    // Detect if this is a Vue Multiselect component
    const isMultiselect = !!root.querySelector('.multiselect__content, .multiselect__tags');

    // For Vue Multiselect, click the toggle/tags area to open the dropdown
    const selectTrigger = root.querySelector('.multiselect__select, .multiselect__tags, .vs__dropdown-toggle') as HTMLElement | null;
      if (selectTrigger) {
        try { selectTrigger.click(); } catch (e) { try { console.debug('[FDF Pro] trigger click failed', e); } catch {} }
      } else {
        try { el.click(); } catch (e) { try { console.debug('[FDF Pro] element click failed', e); } catch {} }
      }

      // Wait for Vue/React/Angular to process the dropdown opening
      if (isMultiselect) await this.sleep(100);

      // For Vue Multiselect, prefer multiselect-specific selectors first
      let optionCandidates: HTMLElement[] = [];
      // Use the previously determined root (wrapper or the element itself)
      // to scope option searching so inputs inside widgets work as expected.
      if (isMultiselect) {
        // Use .multiselect__element for Vue Multiselect (each list item)
        optionCandidates = Array.from(
          root.querySelectorAll<HTMLElement>('.multiselect__element'),
        ).filter((li) => {
          // Skip hidden placeholder items ("No elements found", "List is empty")
          const s = (li as HTMLElement).style;
          if (s && s.display === 'none') return false;
          // Skip items that don't have role="option"
          if (!li.getAttribute('role') && !li.querySelector('[role="option"]')) return false;
          return true;
        });
      }
      if (optionCandidates.length === 0) {
        optionCandidates = Array.from(
          root.querySelectorAll<HTMLElement>('[role="option"], [data-value], [data-option], .option, .multiselect__option, .vs__dropdown-option'),
        );
      }

      if (optionCandidates.length === 0) {
        const popovers = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"], .dropdown-menu, .popover, .multiselect__content-wrapper'));
        for (const p of popovers) {
          optionCandidates.push(...Array.from(p.querySelectorAll<HTMLElement>('[role="option"], [data-value], [data-option], .option, .multiselect__option')));
          if (optionCandidates.length > 0) break;
        }
      }

      if (optionCandidates.length === 0) return false;

      let chosen: HTMLElement | null = null;
      for (const c of optionCandidates) {
        const text = (c.textContent ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
        const dataVal = (c.getAttribute('data-value') ?? '').toString().trim().toLowerCase();
        if (dataVal && dataVal === value.toLowerCase()) { chosen = c; break; }
        if (text && text === value.toLowerCase()) { chosen = c; break; }
      }

      if (!chosen) chosen = optionCandidates[Math.floor(Math.random() * optionCandidates.length)];

      // Prefer clicking the inner .multiselect__option span (Vue Multiselect
      // attaches its selection handler there, not on the outer <li>).
      let clickTarget: HTMLElement = chosen;
      const innerOption = chosen.querySelector<HTMLElement>('.multiselect__option');
      if (innerOption) clickTarget = innerOption;

      try { clickTarget.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
      // Use mousedown + click to support Vue Multiselect (uses @mousedown.prevent)
      try { clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch {}
      try { clickTarget.click(); } catch {
        try { clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e) { try { console.debug('[FDF Pro] chosen click sequence failed', e); } catch {} }
      }
      // For Vue Multiselect, also try setting the internal hidden input value
      if (isMultiselect) {
        const chosenText = (clickTarget.textContent ?? '').trim().replace(/\s+/g, ' ');
        try {
          const hiddenInput = root.querySelector<HTMLInputElement>('input[type="hidden"]');
          if (hiddenInput) {
            nativeInputSetter?.call(hiddenInput, chosenText);
            try { hiddenInput.value = chosenText; } catch {}
            this.dispatch(hiddenInput, 'input');
            this.dispatch(hiddenInput, 'change');
          }
        } catch {}
        // Also update the visible display text
        try {
          const display = root.querySelector<HTMLElement>('.multiselect__single');
          if (display) display.textContent = chosenText;
        } catch {}
      }

      // If the original element was an inner input (e.g., react-select input),
      // also set its value so callers (and tests) observe the selected text.
      try {
        const chosenText = (clickTarget.textContent ?? '').trim().replace(/\s+/g, ' ');
        if (el instanceof HTMLInputElement) {
          try { nativeInputSetter?.call(el, chosenText); } catch {}
          try { (el as HTMLInputElement).value = chosenText; } catch {}
          this.dispatch(el, 'input', chosenText);
          this.dispatch(el, 'change');
          this.dispatch(el, 'blur');
        }
      } catch {}

      this.dispatch(root, 'input');
      this.dispatch(root, 'change');
      this.dispatch(root, 'blur');

      try { console.debug('[FDF Pro] fillSelect (custom):', this.cssSelector(root), '=>', chosen?.textContent?.trim() ?? ''); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------
  // Checkbox
  // -----------------------------------------------------------

  private fillCheckbox(el: HTMLInputElement, value: string): boolean {
    const shouldCheck = value === 'true' || value === '1' || value === 'on';
    if (el.checked !== shouldCheck) {
      el.click(); // click() triggers all associated listeners
    }
    try { console.debug('[FDF Pro] fillCheckbox:', this.cssSelector(el), '=>', shouldCheck); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
    return true;
  }

  // -----------------------------------------------------------
  // Radio
  // -----------------------------------------------------------

  private fillRadio(el: HTMLInputElement | HTMLElement, value: string): boolean {
    // If the element itself is a [role="radiogroup"], skip native handling
    // and go straight to custom radio selection within this group.
    const isRadioGroup = el.getAttribute('role') === 'radiogroup';

    // First, attempt to find a native input radio with matching name/value
    const form = el.closest('form') ?? document;
    const groupName = (el as HTMLInputElement).name;

    try {
      if (groupName && !isRadioGroup) {
        // Try exact match by value
        const sel = `input[type="radio"][name="${groupName}"][value="${CSS.escape(value)}"]`;
        const nativeTarget = form.querySelector<HTMLInputElement>(sel);
        if (nativeTarget) {
          if (!nativeTarget.checked) nativeTarget.click();
          try { console.debug('[FDF Pro] fillRadio (native):', this.cssSelector(nativeTarget), '=>', value); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
          try {
            void sendMessageSafe({ action: 'REPORT_RADIO_DIAGNOSTIC', payload: {
              chosenSelector: this.cssSelector(nativeTarget),
              chosenText: nativeTarget.value ?? null,
              chosenAria: nativeTarget.getAttribute('aria-label') ?? null,
              chosenDataValue: nativeTarget.getAttribute('data-value') ?? null,
              kind: 'native', requestedValue: value, chosenIndex: null, candidatesCount: null, ts: new Date().toISOString(),
            } });
          } catch (e) { try { console.debug('[FDF Pro] native radio handler error', e); } catch {} }
          return true;
        }
      }
    } catch {
      // fall through to custom radio handling
    }

    // Some sites (e.g., Google Forms) render custom radio options as divs
    // with role="radio" or clickable labels. Attempt to find such options
    // within the narrowest scope and click the best match.
    //
    // Prefer the closest [role="radiogroup"] ancestor as search scope — this
    // ensures we only match options belonging to this specific question,
    // rather than all radio options on the page (critical for Google Forms
    // which put many questions inside one <form>).
    try {
      const radioGroupScope = isRadioGroup ? el : (el.closest('[role="radiogroup"]') ?? form);
      const candidates: HTMLElement[] = Array.from(
        radioGroupScope.querySelectorAll<HTMLElement>('[role="radio"], [data-value], .radio, .option, label')
      ).filter((c) => c.offsetParent !== null);
      try { console.debug('[FDF Pro] fillRadio scope:', isRadioGroup ? 'radiogroup-el' : (radioGroupScope === form ? 'form' : 'radiogroup'), '| candidates:', candidates.length); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }

      if (candidates.length > 0) {
        // Prefer aria-label or data-value, then visible text
        const lower = value.trim().toLowerCase();
        let chosen: HTMLElement | null = null;
        for (const c of candidates) {
          const aria = (c.getAttribute('aria-label') ?? '').toString().trim().toLowerCase();
          const data = (c.getAttribute('data-value') ?? '').toString().trim().toLowerCase();
          const text = c.textContent?.trim().toLowerCase() ?? '';
          if (aria && aria === lower) { chosen = c; break; }
          if (data && data === lower) { chosen = c; break; }
          if (text && text === lower) { chosen = c; break; }
        }

        // If no exact match, attempt partial/contains matching (useful for appended hints)
        if (!chosen) {
          for (const c of candidates) {
            const data = (c.getAttribute('data-value') ?? '').toString().trim().toLowerCase();
            const text = c.textContent?.trim().toLowerCase() ?? '';
            if (data && data.includes(lower)) { chosen = c; break; }
            if (text && text.includes(lower)) { chosen = c; break; }
            // Also allow value to be a superset (generated value contains option text)
            if (data && lower.includes(data) && data.length > 0) { chosen = c; break; }
            if (text && lower.includes(text) && text.length > 0) { chosen = c; break; }
          }
        }

        let idxChosen: number | null = null;
        if (!chosen) {
          // Deterministic index-based fallback instead of random choice.
          // Compute a simple stable hash from the value so repeated runs
          // select the same index for the same generated value.
          try {
            const len = candidates.length;
            let h = 0;
            for (let i = 0; i < lower.length; i++) h = (h * 31 + lower.charCodeAt(i)) >>> 0;
            const idx = len > 0 ? (h % len) : 0;
            idxChosen = idx;
            chosen = candidates[idx] ?? candidates[Math.floor(Math.random() * candidates.length)];
            try { console.debug('[FDF Pro] fillRadio (index-fallback):', { index: idx, total: candidates.length, chosen: this.cssSelector(chosen), value }); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
          } catch (err) {
            chosen = candidates[Math.floor(Math.random() * candidates.length)];
          }
        }

        if (chosen) {
          try { chosen.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
          try { chosen.click(); } catch {
            try { chosen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); chosen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); chosen.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch (e) { try { console.debug('[FDF Pro] chosen click sequence failed', e); } catch {} }
          }
          try { console.debug('[FDF Pro] fillRadio (custom):', this.cssSelector(chosen), '=>', value); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
          try {
            void sendMessageSafe({ action: 'REPORT_RADIO_DIAGNOSTIC', payload: {
              chosenSelector: this.cssSelector(chosen),
              chosenText: chosen.textContent?.trim() ?? null,
              chosenAria: chosen.getAttribute?.('aria-label') ?? null,
              chosenDataValue: chosen.getAttribute?.('data-value') ?? null,
              kind: 'custom', requestedValue: value, chosenIndex: idxChosen, candidatesCount: candidates.length, ts: new Date().toISOString(),
            } });
          } catch (e) { try { console.debug('[FDF Pro] custom radio handler error', e); } catch {} }
          return true;
        }
      }
    } catch (e) { try { console.debug('[FDF Pro] fillRadio top-level error', e); } catch {} }

    // Fallback: if we still have the original input element, click it
    try {
      if (!(el as HTMLInputElement).checked) el.click();
      try { console.debug('[FDF Pro] fillRadio (fallback):', this.cssSelector(el), '=>', value); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
      try {
        void sendMessageSafe({ action: 'REPORT_RADIO_DIAGNOSTIC', payload: {
          chosenSelector: this.cssSelector(el),
          chosenText: (el as HTMLElement).textContent?.trim() ?? null,
          chosenAria: (el as HTMLElement).getAttribute?.('aria-label') ?? null,
          chosenDataValue: (el as HTMLElement).getAttribute?.('data-value') ?? null,
          kind: 'fallback', requestedValue: value, chosenIndex: null, candidatesCount: null, ts: new Date().toISOString(),
        } });
      } catch (e) { try { console.debug('[FDF Pro] radio fallback error', e); } catch {} }
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------

  private dispatch(el: Element, eventName: string, data?: string): void {
    if (eventName === 'input') {
      // Use InputEvent for 'input' — required by React 17+ synthetic event system.
      // Include `data` and `inputType` so Vue 3 and Angular can read event.data.
      el.dispatchEvent(new InputEvent(eventName, {
        bubbles: true,
        cancelable: true,
        data: data ?? null,
        inputType: 'insertText',
      }));
    } else if (eventName === 'blur' || eventName === 'focus') {
      el.dispatchEvent(new FocusEvent(eventName, { bubbles: true, cancelable: true }));
    } else {
      el.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
    }
  }

  private resolveElement(selector: string): HTMLElement | null {
    try {
      return document.querySelector<HTMLElement>(selector);
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Simple stable selector helper used for debug logs
  private cssSelector(el: Element): string {
    try {
      if ((el as HTMLElement).id) return `#${CSS.escape((el as HTMLElement).id)}`;
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      if (name) return `${tag}[name="${CSS.escape(name)}"]`;
      const path: string[] = [];
      let node: Element | null = el;
      while (node && node !== document.body) {
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
    } catch {
      return el.tagName.toLowerCase();
    }
  }

  // -----------------------------------------------------------
  // Post-fill inline error check
  // Returns true when the element carries a validation error
  // immediately after a value has been set.
  // -----------------------------------------------------------

  checkFieldError(el: HTMLElement): boolean {
    const input = el as HTMLInputElement;
    // HTML5 Constraint Validation API
    if (typeof input.validity !== 'undefined' && !input.validity.valid) return true;
    // ARIA invalid attribute (used by many custom validation libs)
    if (el.getAttribute('aria-invalid') === 'true') return true;
    // CSS :invalid pseudo-class (catches pattern/min/max violations)
    try {
      if (el.matches(':invalid')) return true;
    } catch {
      // matches() unavailable – ignore
    }
    return false;
  }

  // -----------------------------------------------------------
  // DOM error scanner
  // Queries ERROR_SELECTORS within a scope element (the form or
  // the whole document) and associates each message with the
  // nearest field from the provided list.
  // -----------------------------------------------------------

  scanDomErrors(
    fields: Array<{ id: string; selector: string; name: string; label: string }>,
    scopeEl?: Element,
  ): Array<{ fieldId: string; selector: string; text: string; nearFieldName?: string; nearFieldId?: string }> {
    const scope = scopeEl ?? document;
    const seen = new Set<Element>();
    const results: Array<{ fieldId: string; selector: string; text: string; nearFieldName?: string; nearFieldId?: string }> = [];

    for (const sel of ERROR_SELECTORS) {
      try {
        scope.querySelectorAll(sel).forEach((errorEl) => {
          if (seen.has(errorEl)) return;
          seen.add(errorEl);
          const text = errorEl.textContent?.trim() ?? '';
          if (text.length < 3) return;

          // Skip error elements that are inside a form-group container without
          // an active error class.  Many validators pre-render error message
          // divs and toggle visibility via a class on the parent container.
          if (!this.isErrorElementActive(errorEl)) return;

          const nearField = this.findNearestField(errorEl, fields);

          // If the matched field's container has .success OR the input
          // passes HTML5 validity, the field is valid — skip this error
          // so the field never enters the recovery loop.
          if (nearField) {
            try {
              const matchedField = fields.find((f) => f.id === nearField.id);
              if (matchedField) {
                const fieldEl = document.querySelector(matchedField.selector);
                if (fieldEl) {
                  const container = fieldEl.closest('.form-group, .form-field, .field-group');
                  if (container && container.classList.contains('success')) return;
                  // Browser says the value is valid — trust it over stale DOM error text
                  // BUT: if the input itself has a server-side error class (e.g.
                  // 'error-input'), the server rejected it despite HTML5 validity.
                  const inputEl = fieldEl as HTMLInputElement;
                  const hasServerErrorClass = inputEl.classList?.contains('error-input')
                    || inputEl.classList?.contains('is-invalid')
                    || inputEl.classList?.contains('has-error')
                    || inputEl.getAttribute('aria-invalid') === 'true';
                  if (inputEl.value && typeof inputEl.validity !== 'undefined' && inputEl.validity.valid && !hasServerErrorClass) return;
                }
              }
            } catch (e) { try { console.debug('[FDF Pro] final catch suppressed', e); } catch {} }
          }

          results.push({
            fieldId: nearField?.id ?? '',
            selector: this.buildErrorSelector(errorEl),
            text,
            nearFieldName: nearField
              ? (nearField.name || nearField.label || nearField.id)
              : undefined,
            nearFieldId: nearField?.id,
          });
        });
      } catch {
        // Invalid selector string – skip
      }
    }

    // ---------------------------------------------------------
    // Second pass: scan inputs directly for error markers.
    // Catches fields marked invalid via CSS classes, aria, or
    // :invalid pseudo-class that have no associated error text
    // element picked up by the selectors above.
    // ---------------------------------------------------------
    const fieldsWithErrors = new Set(results.map((r) => r.fieldId).filter(Boolean));
    for (const field of fields) {
      if (fieldsWithErrors.has(field.id)) continue; // Already have an error for this field
      try {
        const el = scope.querySelector(field.selector) as HTMLElement | null;
        if (!el) continue;
        const input = el as HTMLInputElement;

        const hasErrorClass =
          input.classList?.contains('is-invalid') ||
          input.classList?.contains('error-input') ||
          input.classList?.contains('has-error') ||
          input.classList?.contains('ng-invalid') ||
          input.classList?.contains('error');

        const hasAriaInvalid = input.getAttribute('aria-invalid') === 'true';

        // HTML5 constraint validation
        const isHtml5Invalid =
          typeof input.validity !== 'undefined' &&
          !input.validity.valid &&
          input.value !== ''; // Only flag non-empty values — empty + required is handled separately

        if (!hasErrorClass && !hasAriaInvalid && !isHtml5Invalid) continue;

        // Try to extract error text from:
        // 1. The validationMessage (native HTML5)
        // 2. An aria-errormessage reference
        // 3. A sibling error element
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
          // Look for adjacent siblings with error text
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
          // Look in parent for error sibling
          const parent = input.parentElement;
          if (parent) {
            const errChild = parent.querySelector('.text-error, .error-message, .invalid-feedback, .field-error, [role="alert"], .text-danger, .help-block, .mat-error, .el-form-item__error, .ant-form-item-explain-error');
            if (errChild) {
              const childText = errChild.textContent?.trim() ?? '';
              if (childText.length >= 3) errorText = childText;
            }
          }
        }

        // Fallback: generic description based on what we can detect
        if (!errorText) {
          if (hasErrorClass || hasAriaInvalid) {
            errorText = 'Invalid value';
          } else if (isHtml5Invalid) {
            errorText = input.validationMessage || 'Invalid value';
          }
        }

        if (errorText && errorText.length >= 3) {
          results.push({
            fieldId: field.id,
            selector: field.selector,
            text: errorText,
            nearFieldName: field.name || field.label || field.id,
            nearFieldId: field.id,
          });
        }
      } catch {}
    }

    return results;
  }

  // -----------------------------------------------------------
  // Fill → detect errors → recover → refill loop (silent)
  //
  // 1. Fill all fields once.
  // 2. Wait 200 ms for validation to run.
  // 3. Scan DOM for error messages.
  // 4. If none (or retries exhausted) → stop.
  // 5. Send errors to background for recovery values.
  // 6. Partially refill only the recovered fields.
  // 7. Repeat from step 2.
  // -----------------------------------------------------------

  async fillFormWithRecovery(
    formAnalysis: FormAnalysis,
    options: { maxRetries?: number } = {},
  ): Promise<{ filled: number; skipped: number; retries: number; finalErrors: string[] }> {
    const maxRetries = options.maxRetries ?? DEFAULT_SETTINGS.maxRetryAttempts ?? 3;

    // Initial fill
    const initial = await this.fillForm(formAnalysis);
    let filled = initial.filled;
    const { skipped } = initial;
    let retries = 0;

    // Track field ids that had errors in the previous iteration
    let previousErrorFieldIds = new Set<string>();
    let stagnantRounds = 0;
    // Map of fieldId -> detected ErrorType returned by background (populated per attempt)
    const detectedErrorTypes = new Map<string, ErrorType>();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Exponential backoff before each attempt to give validators time
      const backoffMs = 200 * Math.pow(2, attempt);
      await this.sleep(backoffMs);

      const domErrors = this.scanDomErrors(formAnalysis.fields);
      // Only consider field-associated errors for recovery (ignore page-level messages)
      let fieldErrors = domErrors.filter((e) => e.fieldId && e.fieldId.length > 0);

      // If selector-pass found unassociated errors, try to match them to fields
      // by scanning error text for field names/labels.
      const unassociated = domErrors.filter((e) => !e.fieldId || e.fieldId.length === 0);
      if (unassociated.length > 0 && fieldErrors.length === 0) {
        for (const err of unassociated) {
          const lower = err.text.toLowerCase();
          for (const fld of formAnalysis.fields) {
            const nameMatch = fld.name && fld.name.length > 2 && lower.includes(fld.name.toLowerCase());
            const labelMatch = fld.label && fld.label.length > 2 && lower.includes(fld.label.toLowerCase());
            if (nameMatch || labelMatch) {
              fieldErrors.push({
                ...err,
                fieldId: fld.id,
                nearFieldName: fld.name || fld.label,
                nearFieldId: fld.id,
              });
              break;
            }
          }
        }
      }

      try { console.info('[FDF] domErrors:', domErrors.length, '| fieldErrors:', fieldErrors.length, '| unassociated:', unassociated.length, fieldErrors.map(f => ({ id: f.fieldId, name: f.nearFieldName, text: f.text }))); } catch (e) { try { console.debug('[FDF Pro] debug log failed', e); } catch {} }
      if (fieldErrors.length === 0) break; // All field-level errors resolved

      // Detect stagnation: same fields and same count failing despite retries
      const currentErrorIds = new Set(fieldErrors.map((e) => e.fieldId).filter(Boolean));
      const sameFields =
        currentErrorIds.size === previousErrorFieldIds.size &&
        [...currentErrorIds].every((id) => previousErrorFieldIds.has(id));
      if (sameFields) {
        stagnantRounds++;
        // Allow at least 2 stagnant rounds before giving up
        if (stagnantRounds >= 2) break;
      } else {
        stagnantRounds = 0;
      }
      previousErrorFieldIds = currentErrorIds;

      // Ask background for recovery values (send only field-level errors)
      let recoveryFields: Array<{ field: string; value: string }> = [];
      // Map of fieldId -> detected ErrorType returned by background
      const detectedErrorTypes = new Map<string, ErrorType>();
      try {
        console.info('[FDF] requesting recovery for detected errors', fieldErrors.map(d => d.selector));
        const response = await sendMessageSafe({
          action: 'DETECT_ERRORS',
          payload: {
            errorElements: fieldErrors.map((e) => {
              let elementHtml: string | null = null;
              try {
                const el = document.querySelector(e.selector);
                elementHtml = el ? (el as HTMLElement).outerHTML : null;
              } catch {}
              return {
                selector: e.selector,
                text: e.text,
                nearFieldName: e.nearFieldName,
                nearFieldId: (e as any).nearFieldId,
                elementHtml,
              };
            }),
            fields: formAnalysis.fields,
            consoleLogs: (window as any).__fdf_console_capture?.entries ?? [],
          },
        });

        if (response.success) {
          console.info('[FDF] recovery response', response.data?.recovery ?? null);
          if (response.data?.recovery?.updatedFields?.length) {
            recoveryFields = response.data.recovery.updatedFields;
          }
          // record detected error types (if provided)
          const errorInfo = response.data?.errorInfo;
          if (errorInfo && Array.isArray(errorInfo.messages)) {
            for (const m of errorInfo.messages) {
              if (m && m.fieldName) {
                // fieldName may be a name/label; try to resolve to field id
                const fld = formAnalysis.fields.find((f) => f.name === m.fieldName || f.label === m.fieldName || f.id === m.fieldName);
                if (fld) detectedErrorTypes.set(fld.id, m.type as ErrorType);
              }
            }
          }
        }
      } catch {
        // Cannot reach background – attempt local quick fixes before aborting
        recoveryFields = [];
      }

      // If background provided no suggestions, try small local reformat/cleanup heuristics
      if (recoveryFields.length === 0) {
        const localFixes: Array<{ id: string; value: string }> = [];
        for (const err of fieldErrors) {
          const fld = formAnalysis.fields.find((f) => f.id === err.fieldId);
          if (!fld) continue;
          const el = this.resolveElement(fld.selector) as HTMLInputElement | null;
          if (!el) continue;
          const cur = (el).value ?? '';
          const errText = err.text.toLowerCase();
          const fldHint = `${fld.name} ${fld.label}`.toLowerCase();

          // --------------------------------------------------
          // Phone: try alternate formats
          // --------------------------------------------------
          if (fld.type === 'phone' || el.type === 'tel' || /phone|tel|mobile|contact/i.test(fldHint)) {
            const digits = cur.replace(/\D/g, '').slice(-10);
            if (digits.length >= 10) {
              // Prefer plain digits first (no separators) to respect pattern="\\d*" and minlength/maxlength
              const candidates = [
                digits,
                `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`,
                `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6)}`,
                `+1${digits}`,
              ];
              const pattern = fld.constraints?.pattern;
              if (pattern) {
                try {
                  if (pattern.length <= 200) {
                    const re = new RegExp(pattern);
                    for (const c of candidates) {
                      if (re.test(c) && c !== cur) {
                        localFixes.push({ id: fld.id, value: c });
                        break;
                      }
                    }
                  }

                  // --------------------------------------------------
                  // Pattern / format mismatch: attempt to synthesize a value
                  // that matches the input's `pattern` or HTML5 validity hints.
                  // This addresses messages like "Please match the requested format."
                  // --------------------------------------------------
                  try {
                    const inputEl = el as HTMLInputElement;
                    const looksLikePatternError = /please match the requested format|format/i.test(errText) || (inputEl.validity && (inputEl.validity.patternMismatch || inputEl.validity.typeMismatch));
                    if (looksLikePatternError) {
                      const rawPattern = fld.constraints?.pattern || (inputEl.getAttribute && inputEl.getAttribute('pattern')) || '';
                      let candidate = '';
                      if (rawPattern) {
                        // Simple heuristic generators for common patterns
                        //  - \d{N}  => N digits
                        //  - \d+    => 10 digits
                        //  - [0-9]{N} => N digits
                        const repeatMatch = rawPattern.match(/\\d\{(\d+)\}/) || rawPattern.match(/\[0-9\]\{(\d+)\}/);
                        if (repeatMatch) {
                          const n = parseInt(repeatMatch[1], 10) || 6;
                          candidate = Array.from({ length: n }, () => String(Math.floor(Math.random() * 10))).join('');
                        } else if (/\\d\+/.test(rawPattern) || /\[0-9\]\+/.test(rawPattern) || /\d\*/.test(rawPattern)) {
                          candidate = Array.from({ length: 10 }, () => String(Math.floor(Math.random() * 10))).join('');
                        } else if (/email|e-?mail/i.test(inputEl.type || '') || /@/.test(rawPattern)) {
                          candidate = `user${Math.floor(Math.random() * 10000)}@example.test`;
                        } else if (/iso|yyyy|mm|dd|date/i.test(rawPattern) || inputEl.type === 'date') {
                          const d = new Date(); d.setDate(d.getDate() + 7);
                          candidate = d.toISOString().slice(0, 10);
                        } else {
                          // Fallback: try digits for tel, email fallback, else reuse current value
                          if (inputEl.type === 'tel') {
                            const digits = (cur || '').replace(/\D/g, '').slice(-10) || '5551234567';
                            candidate = digits;
                          } else if (inputEl.type === 'email') {
                            candidate = `user${Math.floor(Math.random() * 10000)}@example.test`;
                          } else {
                            candidate = String(fld.value ?? cur ?? '').slice(0, 64) || '';
                          }
                        }
                      } else {
                        // No explicit pattern: try simple type-based fixes
                        if ((el as HTMLInputElement).type === 'tel') candidate = ((cur || '').replace(/\D/g, '').slice(-10) || '5551234567');
                        else if ((el as HTMLInputElement).type === 'email') candidate = `user${Math.floor(Math.random() * 10000)}@example.test`;
                        else candidate = String(fld.value ?? cur ?? '');
                      }

                      if (candidate && candidate.length > 0) {
                        localFixes.push({ id: fld.id, value: candidate });
                        continue;
                      }
                    }
                  } catch {}
                } catch {
                  if (candidates[0] !== cur) localFixes.push({ id: fld.id, value: candidates[0] });
                }
              } else if (digits !== cur) {
                localFixes.push({ id: fld.id, value: candidates[0] });
              }
              continue;
            }
          }

          // --------------------------------------------------
          // Email: trim, lowercase, regenerate if "already taken"
          // --------------------------------------------------
          if (fld.type === 'email' || el.type === 'email' || /email|e-?mail/i.test(fldHint)) {
            if (/already|taken|exists|duplicate|in use/i.test(errText)) {
              // Uniqueness error → regenerate with timestamp
              const ts = Date.now() % 100000;
              const base = cur.split('@')[0]?.replace(/\d+$/, '') || 'user';
              const domain = cur.split('@')[1] || 'example.com';
              localFixes.push({ id: fld.id, value: `${base}${ts}@${domain}` });
            } else {
              const cleaned = cur.trim().toLowerCase();
              // If no @ sign, add @example.com
              if (!cleaned.includes('@')) {
                localFixes.push({ id: fld.id, value: `${cleaned.replace(/[^a-z0-9._-]/g, '')}@example.com` });
              } else if (cleaned !== cur) {
                localFixes.push({ id: fld.id, value: cleaned });
              }
            }
            continue;
          }

          // --------------------------------------------------
          // Username: strip special chars, add suffix for uniqueness
          // --------------------------------------------------
          if (fld.type === 'username' || /username|user.?name|login/i.test(fldHint)) {
            if (/already|taken|exists|not available|in use/i.test(errText)) {
              const base = cur.replace(/\d+$/, '');
              localFixes.push({ id: fld.id, value: `${base}${Date.now() % 10000}` });
            } else {
              // Strip disallowed characters
              const cleaned = cur.replace(/[^A-Za-z0-9._-]/g, '');
              if (cleaned !== cur && cleaned.length > 0) {
                localFixes.push({ id: fld.id, value: cleaned });
              }
            }
            continue;
          }

          // --------------------------------------------------
          // Password: strengthen complexity
          // --------------------------------------------------
          if (fld.type === 'password' || el.type === 'password' || /password|passwd/i.test(fldHint)) {
            const minLen = fld.constraints?.minLength ?? 8;
            let pw = cur;
            // Ensure minimum length
            while (pw.length < minLen) pw += 'Aa1!';
            // Ensure at least one uppercase
            if (!/[A-Z]/.test(pw)) pw = pw.slice(0, -1) + 'A';
            // Ensure at least one lowercase
            if (!/[a-z]/.test(pw)) pw = pw.slice(0, -1) + 'a';
            // Ensure at least one digit
            if (!/\d/.test(pw)) pw = pw.slice(0, -1) + '7';
            // Ensure at least one special character
            if (!/[^A-Za-z0-9]/.test(pw)) pw = pw.slice(0, -1) + '@';
            if (pw !== cur) localFixes.push({ id: fld.id, value: pw });
            continue;
          }

          // --------------------------------------------------
          // Credit card: strip non-digits
          // --------------------------------------------------
          if (fld.type === 'creditCard' || /card.?number|credit.?card/i.test(fldHint)) {
            const cleaned = cur.replace(/[^0-9]/g, '');
            if (cleaned.length >= 12 && cleaned !== cur) localFixes.push({ id: fld.id, value: cleaned });
            continue;
          }

          // --------------------------------------------------
          // Credit card expiry: ensure MM/YY format
          // --------------------------------------------------
          if (fld.type === 'creditCardExpiry' || /expir|exp.?date|exp.?month/i.test(fldHint)) {
            const digits = cur.replace(/\D/g, '');
            if (digits.length >= 4) {
              const mm = digits.slice(0, 2);
              const yy = digits.slice(2, 4);
              const formatted = `${mm}/${yy}`;
              if (formatted !== cur) localFixes.push({ id: fld.id, value: formatted });
            } else {
              // Generate valid future expiry
              const now = new Date();
              const futureMonth = String(now.getMonth() + 2).padStart(2, '0');
              const futureYear = String((now.getFullYear() + 2) % 100).padStart(2, '0');
              localFixes.push({ id: fld.id, value: `${futureMonth}/${futureYear}` });
            }
            continue;
          }

          // --------------------------------------------------
          // CVV: ensure 3-4 digits
          // --------------------------------------------------
          if (fld.type === 'creditCardCvv' || /cvv|cvc|security.?code/i.test(fldHint)) {
            const digits = cur.replace(/\D/g, '').slice(0, 4);
            if (digits.length < 3) {
              localFixes.push({ id: fld.id, value: String(Math.floor(Math.random() * 900) + 100) });
            } else if (digits !== cur) {
              localFixes.push({ id: fld.id, value: digits });
            }
            continue;
          }

          // --------------------------------------------------
          // Date: reformat based on error hints
          // --------------------------------------------------
          if (fld.type === 'date' || fld.type === 'birthdate' || el.type === 'date' || /date|dob|birth/i.test(fldHint)) {
            if (/cannot be in the future|must (be|occur).*(past|before|prior)|before today|must not be.*(future|after)/i.test(errText)) {
              const past = new Date();
              past.setFullYear(past.getFullYear() - 1);
              localFixes.push({ id: fld.id, value: past.toISOString().slice(0, 10) });
            } else if (/cannot be in the past|must (be|occur).*(future|after|ahead)|after today|must not be.*(past|before)/i.test(errText)) {
              const future = new Date();
              future.setMonth(future.getMonth() + 3);
              localFixes.push({ id: fld.id, value: future.toISOString().slice(0, 10) });
            } else if (/18|age|birth/i.test(errText) || fld.type === 'birthdate') {
              // Must be 18+ → generate DOB 25 years ago
              const dob = new Date();
              dob.setFullYear(dob.getFullYear() - 25);
              localFixes.push({ id: fld.id, value: dob.toISOString().slice(0, 10) });
            } else {
              // Try ISO format
              const d = new Date(cur);
              if (!isNaN(d.getTime())) {
                const iso = d.toISOString().slice(0, 10);
                if (iso !== cur) localFixes.push({ id: fld.id, value: iso });
              }
            }
            continue;
          }

          // --------------------------------------------------
          // URL: fix format
          // --------------------------------------------------
          if (fld.type === 'url' || el.type === 'url' || /url|website|link|homepage/i.test(fldHint)) {
            let fixed = cur.trim();
            if (fixed && !/^https?:\/\//i.test(fixed)) {
              fixed = `https://${fixed}`;
            }
            if (!fixed || fixed === 'https://') {
              fixed = 'https://www.example.com';
            }
            if (fixed !== cur) localFixes.push({ id: fld.id, value: fixed });
            continue;
          }

          // --------------------------------------------------
          // Zipcode / postal code
          // --------------------------------------------------
          if (fld.type === 'zipcode' || /zip|postal/i.test(fldHint)) {
            const digits = cur.replace(/\D/g, '');
            const targetLen = fld.constraints?.maxLength ?? 5;
            const fixed = digits.slice(0, targetLen).padEnd(Math.min(targetLen, 5), '0');
            if (fixed !== cur && fixed.length >= 3) {
              localFixes.push({ id: fld.id, value: fixed });
            }
            continue;
          }

          // --------------------------------------------------
          // Number / numeric: coerce to number, respect range
          // --------------------------------------------------
          if (fld.type === 'number' || fld.type === 'currency' || fld.type === 'range'
              || el.type === 'number' || el.type === 'range'
              || /digits only|numbers only|numeric only|must be a number|not a.*number|enter a.*number|must be numeric/i.test(errText)) {
            // Strip non-numeric characters (keep decimal point and minus)
            let numeric = cur.replace(/[^0-9.\-]/g, '');
            if (numeric === '' || isNaN(Number(numeric))) {
              // Generate a fresh number within constraints
              const minVal = fld.constraints?.min != null ? Number(fld.constraints.min) : 1;
              const maxVal = fld.constraints?.max != null ? Number(fld.constraints.max) : 100;
              numeric = String(Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal);
            } else {
              // Clamp to min/max
              let num = Number(numeric);
              if (fld.constraints?.min != null && num < Number(fld.constraints.min)) num = Number(fld.constraints.min);
              if (fld.constraints?.max != null && num > Number(fld.constraints.max)) num = Number(fld.constraints.max);
              // Handle range errors
              if (/greater than|at least|minimum|too small|below/i.test(errText)) {
                const minHint = errText.match(/(\d+)/);
                if (minHint) num = Math.max(num, parseInt(minHint[1], 10));
              }
              if (/less than|at most|maximum|too large|above|cannot exceed/i.test(errText)) {
                const maxHint = errText.match(/(\d+)/);
                if (maxHint) num = Math.min(num, parseInt(maxHint[1], 10));
              }
              numeric = String(num);
            }
            if (numeric !== cur) localFixes.push({ id: fld.id, value: numeric });
            continue;
          }

          // --------------------------------------------------
          // Alphanumeric / "code" fields (MUST come before name handler
          // to avoid "only contain letters and numbers" being caught
          // by the more generic "only.*letters" name regex)
          // --------------------------------------------------
          const isAlphanumericError = /only contain letters and numbers|only.*alphanumeric|must be alphanumeric|letters.*numbers only|alphanumeric only/i.test(errText);
          const isCodeLabel = /\bcode\b/i.test(fldHint) && !/postal|zip|pin|area/i.test(fldHint);
          if (isAlphanumericError || isCodeLabel) {
            const cleaned = cur.replace(/[^A-Za-z0-9]/g, '');
            if (cleaned !== cur && cleaned.length > 0) {
              localFixes.push({ id: fld.id, value: cleaned });
            } else if (cleaned.length === 0 || isCodeLabel) {
              const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
              const maxLen = fld.constraints?.maxLength ?? 8;
              const prefixLen = Math.min(2, Math.max(1, maxLen - 2));
              const prefix = Array.from({ length: prefixLen }, () => letters[Math.floor(Math.random() * 26)]).join('');
              const digitLen = Math.max(1, Math.min(6, maxLen - prefixLen));
              const num = String(Math.floor(Math.random() * Math.pow(10, digitLen))).padStart(digitLen, '0');
              localFixes.push({ id: fld.id, value: `${prefix}${num}` });
            }
            continue;
          }

          // --------------------------------------------------
          // Name fields: letters/spaces only (strip digits & special chars)
          // --------------------------------------------------
          if (fld.type === 'firstName' || fld.type === 'lastName' || fld.type === 'fullName'
              || /only.*letters|letters only|alphabetic|must contain only letters|name.*invalid|cannot contain.*numbers/i.test(errText)) {
            const cleaned = cur.replace(/[^A-Za-z\s'-]/g, '').trim();
            if (cleaned !== cur && cleaned.length > 0) {
              localFixes.push({ id: fld.id, value: cleaned });
            }
            continue;
          }

          // --------------------------------------------------
          // No spaces: strip all whitespace
          // --------------------------------------------------
          if (/no spaces|cannot contain spaces|spaces\s*(not|aren't|are not)\s*allowed|whitespace\s*(not|are not)\s*allowed|no whitespace/i.test(errText)) {
            const cleaned = cur.replace(/\s+/g, '');
            if (cleaned !== cur && cleaned.length > 0) {
              localFixes.push({ id: fld.id, value: cleaned });
            }
            continue;
          }

          // --------------------------------------------------
          // No special characters: strip non-alphanumeric
          // --------------------------------------------------
          if (/no special char|special char.*(not|aren't) allowed|invalid char/i.test(errText)) {
            const cleaned = cur.replace(/[^A-Za-z0-9\s]/g, '');
            if (cleaned !== cur && cleaned.length > 0) {
              localFixes.push({ id: fld.id, value: cleaned });
            }
            continue;
          }

          // --------------------------------------------------
          // Digits only: strip non-digits
          // --------------------------------------------------
          if (/only.*digits|digits only|must contain only digits/i.test(errText)) {
            const cleaned = cur.replace(/\D/g, '');
            if (cleaned !== cur && cleaned.length > 0) {
              localFixes.push({ id: fld.id, value: cleaned });
            }
            continue;
          }

          // --------------------------------------------------
          // Length errors: trim or pad
          // --------------------------------------------------
          if (/too long|maximum|at most|no more than|must not exceed|characters? or (less|fewer)/i.test(errText)) {
            const maxHint = errText.match(/(\d+)/);
            const maxLen = maxHint ? parseInt(maxHint[1], 10) : (fld.constraints?.maxLength ?? cur.length);
            if (cur.length > maxLen) {
              localFixes.push({ id: fld.id, value: cur.slice(0, maxLen) });
            }
            continue;
          }
          if (/too short|at least|minimum|no fewer|characters? or more/i.test(errText) && cur.length > 0) {
            const minHint = errText.match(/(\d+)/);
            const minLen = minHint ? parseInt(minHint[1], 10) : (fld.constraints?.minLength ?? cur.length);
            if (cur.length < minLen) {
              // Pad with repeated chars or lorem
              let padded = cur;
              while (padded.length < minLen) padded += 'a';
              localFixes.push({ id: fld.id, value: padded });
            }
            continue;
          }

          // --------------------------------------------------
          // Required / empty: re-trigger fill (value was probably cleared by JS)
          // --------------------------------------------------
          if (/required|cannot be empty|must fill|blank|please (enter|fill|provide|select)/i.test(errText)) {
            if (!cur || cur.trim().length === 0) {
              // The field is truly empty. No local fix possible — need background to regenerate.
              // But we can at least try a simple placeholder-based value.
              const ph = fld.placeholder;
              if (ph && ph.length > 0 && !/enter|type|select|choose/i.test(ph)) {
                localFixes.push({ id: fld.id, value: ph });
              }
            }
            continue;
          }

          // --------------------------------------------------
          // SSN: reformat to NNN-NN-NNNN
          // --------------------------------------------------
          if (/ssn|social.?security/i.test(fldHint)) {
            const digits = cur.replace(/\D/g, '');
            if (digits.length >= 9) {
              localFixes.push({ id: fld.id, value: `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}` });
            }
            continue;
          }
        }

        if (localFixes.length > 0) {
          retries++;
          const interFieldDelay = (typeof process !== 'undefined' && (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test')) ? 0 : 30;
          for (const fix of localFixes) {
            const fld = formAnalysis.fields.find((f) => f.id === fix.id);
            if (!fld) continue;
            const el = this.resolveElement(fld.selector);
            if (!el) continue;
            const success = await this.fillField(el, { ...fld, value: fix.value });
            if (success) filled++;
            await this.sleep(interFieldDelay);
          }
          // continue to next attempt to let validators run
          try { console.info('[FDF] applied local fixes:', localFixes.map(l => ({ id: l.id, value: l.value }))); } catch {}
          continue;
        }

        // If no local fixes, give up contacting background
        break;
      }

      // Refill only the fields with new recovery values
      retries++;
      const recoveryMap = new Map(recoveryFields.map((u) => [u.field, u.value]));
      for (const fieldAnalysis of formAnalysis.fields) {
        const newValue = recoveryMap.get(fieldAnalysis.id);
        if (newValue === undefined) continue;

        // Only apply recovery to fields that were actually flagged with errors
        // in this round — prevents name-based mismatches from overwriting
        // unrelated valid fields.
        if (!currentErrorIds.has(fieldAnalysis.id)) continue;

        const el = this.resolveElement(fieldAnalysis.selector);
        if (!el) continue;

        // Skip if the field's current value already passes HTML5 validation
        // to avoid overwriting valid data with a different (but also valid) value.
        // BUT: don't skip if the input itself carries a server-side error class.
        const input = el as HTMLInputElement;
        const hasServerErr = input.classList?.contains('error-input')
          || input.classList?.contains('is-invalid')
          || input.classList?.contains('has-error')
          || input.getAttribute('aria-invalid') === 'true';
        if (!hasServerErr && input.value && typeof input.validity !== 'undefined' && input.validity.valid) {
          // Also check that the form-group isn't marked as error
          const container = el.closest('.form-group, .form-field, .field-group');
          if (!container || !container.classList.contains('error')) {
            continue;
          }
        }

        const success = await this.fillField(el, { ...fieldAnalysis, value: newValue });
        if (success) filled++;
        const interFieldDelay = (typeof process !== 'undefined' && (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test')) ? 0 : 30;
        await this.sleep(interFieldDelay);
      }
      try {
        const after = this.scanDomErrors(formAnalysis.fields).filter((e) => e.fieldId && e.fieldId.length > 0);
        console.info('[FDF] post-recovery remaining:', after.map(a => ({ id: a.fieldId, text: a.text, name: a.nearFieldName })));
      } catch {}
    }

    // After recovery loop, report newly-clean fields to background learning DB
    if (retries > 0) {
      const remainingErrors = this.scanDomErrors(formAnalysis.fields);
      const stillErrIds = new Set(remainingErrors.map((e) => e.fieldId));
      for (const field of formAnalysis.fields) {
        if (
          field.value &&
          previousErrorFieldIds.has(field.id) &&
          !stillErrIds.has(field.id)
        ) {
          // Use the detected error type for this field if available, otherwise fall back to 'unknown'
          const detected = detectedErrorTypes.get(field.id) ?? 'unknown';
          void sendMessageSafe({
              action: 'MARK_RECOVERY_SUCCESS',
              payload: {
                fieldType: field.type,
                errorType: detected,
                successValue: field.value,
              },
            });
        }
      }
    }

    // Final normalization pass: for some fields (SSN, card expiry) the value
    // may have been written without separators by earlier sanitization or
    // timing issues. Attempt one last passive normalization before reporting
    // final errors so tests and consumers observe correctly formatted values.
    for (const fld of formAnalysis.fields) {
      try {
        const el = this.resolveElement(fld.selector) as HTMLInputElement | null;
        if (!el) continue;
        const raw = (el.value ?? '').toString();
        // If the element is empty or not properly formatted but the fieldAnalysis
        // has a generated value, attempt a final write/normalisation for
        // date/expiry-like fields so validators see a correct format before
        // we compute finalErrors.
        try {
          const fldVal = fld.value ?? '';
          const fldHint = `${fld.name} ${fld.label || ''}`.toLowerCase();
          // Passport / license / visa expiries are real dates (YYYY-MM-DD)
          const looksDocExpiry = /passport|license|visa/i.test(fldHint) || (el.type === 'date');
          if (looksDocExpiry) {
            const cur = raw;
            const needsWrite = !/^\d{4}-\d{2}-\d{2}$/.test(cur);
            if (needsWrite) {
              if (fldVal) {
                try { this.fillDateInput(el, String(fldVal)); } catch {}
              } else {
                // Fallback: synthesise a reasonable future date to satisfy validators
                try {
                  const d = new Date();
                  d.setFullYear(d.getFullYear() + 1);
                  const synthesized = d.toISOString().slice(0, 10);
                  try { nativeInputSetter?.call(el, synthesized); } catch {}
                  try { el.value = synthesized; } catch {}
                  this.dispatch(el, 'input', synthesized);
                  this.dispatch(el, 'change');
                  this.dispatch(el, 'blur');
                } catch {}
              }
            }
          }
        } catch {}
        // Re-read raw after attempted write
        const rawAfter = (el.value ?? '').toString();
        if (!rawAfter) continue;
        const fldHint = `${fld.name} ${fld.label || ''}`.toLowerCase();

        // SSN: format 9 digits to NNN-NN-NNNN
        if (/ssn|social.?security/i.test(fldHint) || (fld.constraints?.pattern && /\\d\{3\}.*\\d\{2\}.*\\d\{4\}/.test(String(fld.constraints.pattern)))) {
          const digits = raw.replace(/\D/g, '');
          if (digits.length === 9) {
            const formatted = `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`;
            if (formatted !== raw) {
              try { nativeInputSetter?.call(el, formatted); } catch {}
              try { el.value = formatted; } catch {}
              this.dispatch(el, 'input', formatted);
              this.dispatch(el, 'change');
              this.dispatch(el, 'blur');
            }
          }
        }

        // Credit card expiry: digits like 1229 -> 12/29
        if (fld.type === 'creditCardExpiry' || /card.?expir/i.test(fldHint)) {
          const digits = raw.replace(/\D/g, '');
          if (digits.length >= 4) {
            const mm = digits.slice(0, 2);
            const yy = digits.slice(2, 4);
            const formatted = `${mm}/${yy}`;
            if (formatted !== raw) {
              try { nativeInputSetter?.call(el, formatted); } catch {}
              try { el.value = formatted; } catch {}
              this.dispatch(el, 'input', formatted);
              this.dispatch(el, 'change');
              this.dispatch(el, 'blur');
            }
          }
        }
      } catch {}
    }

    const finalErrors = this.scanDomErrors(formAnalysis.fields)
      .filter((e) => e.fieldId && e.fieldId.length > 0)
      .map((e) => e.text);
    // debug logs removed
    // If auto-retries exhausted and there are still errors, focus first failing field
    if (finalErrors.length > 0) {
      try {
        const remaining = this.scanDomErrors(formAnalysis.fields);
        if (remaining.length > 0) {
          const first = remaining[0];
          const fld = formAnalysis.fields.find((f) => f.id === first.fieldId);
          if (fld) {
            const el = this.resolveElement(fld.selector);
            if (el) {
              try { (el).focus(); } catch {}
            }
          }
        }
      } catch {}
    }
    return { filled, skipped, retries, finalErrors };
  }

  // -----------------------------------------------------------
  // Associate an error element with the nearest tracked field
  // -----------------------------------------------------------

  private findNearestField(
    errorEl: Element,
    fields: Array<{ id: string; selector: string; name: string; label: string }>,
  ): { id: string; name: string; label: string } | null {
    // 1. data-field / for attribute on the error element or an ancestor
    const dataField = errorEl.getAttribute('data-field')
      ?? errorEl.closest('[data-field]')?.getAttribute('data-field');
    if (dataField) {
      const match = fields.find((f) => f.name === dataField || f.id === dataField);
      if (match) return match;
    }

    // 2. aria-describedby / aria-errormessage cross-reference
    //    Some frameworks set aria-errormessage="errorId" on the input and
    //    render <div id="errorId">...</div>.  Check if errorEl has an id
    //    that is referenced by an input's aria attribute.
    if (errorEl.id) {
      const referencingInput = document.querySelector(
        `[aria-errormessage="${CSS.escape(errorEl.id)}"], [aria-describedby~="${CSS.escape(errorEl.id)}"]`,
      );
      if (referencingInput) {
        const match = fields.find((f) => {
          try { return document.querySelector(f.selector) === referencingInput; }
          catch { return false; }
        });
        if (match) return match;
      }
    }

    // 3. Previous sibling: error element is right after an input
    const prevSibling = errorEl.previousElementSibling;
    if (prevSibling) {
      const prevTag = prevSibling.tagName.toLowerCase();
      if (prevTag === 'input' || prevTag === 'select' || prevTag === 'textarea') {
        const match = fields.find((f) => {
          try { return document.querySelector(f.selector) === prevSibling; }
          catch { return false; }
        });
        if (match) return match;
      }
      // Error might be after a wrapper div that contains the input
      const innerInput = prevSibling.querySelector('input, textarea, select');
      if (innerInput) {
        const match = fields.find((f) => {
          try { return document.querySelector(f.selector) === innerInput; }
          catch { return false; }
        });
        if (match) return match;
      }
    }

    // 4. Walk up ancestors looking for a container with inputs.
    //    Prefer containers with exactly one input, but if a container
    //    has multiple inputs, try to find the closest one spatially.
    let node: Element | null = errorEl.parentElement;
    let depth = 0;
    while (node && depth < 8) {
      const inputs = Array.from(node.querySelectorAll('input, textarea, select'));
      if (inputs.length === 1) {
        const inputEl = inputs[0];
        const match = fields.find((f) => {
          try { return document.querySelector(f.selector) === inputEl; }
          catch { return false; }
        });
        if (match) return match;
      } else if (inputs.length > 1 && inputs.length <= 6) {
        // Multiple inputs: find the one closest to the error element.
        // Check if any input has an error class — pick that one.
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
            if (match) return match;
          }
        }
        // No error-marked input — pick the closest by DOM position
        // (the input that immediately precedes the error in DOM order)
        for (let i = inputs.length - 1; i >= 0; i--) {
          const inp = inputs[i];
          // Check if errorEl comes after this input in document order
          if (inp.compareDocumentPosition(errorEl) & Node.DOCUMENT_POSITION_FOLLOWING) {
            const match = fields.find((f) => {
              try { return document.querySelector(f.selector) === inp; }
              catch { return false; }
            });
            if (match) return match;
          }
        }
      }

      // Handle custom select/display widgets
      try {
        const display = node.querySelector('.multiselect__single, .vs__selected, .Select__single-value, .chosen-single, .select2-selection__rendered');
        if (display) {
          const hidden = node.querySelector<HTMLInputElement>('input[type="hidden"], input');
          if (hidden) {
            const match = fields.find((f) => {
              try { return document.querySelector(f.selector) === hidden; } catch { return false; }
            });
            if (match) return match;
          }
        }
      } catch {}
      node = node.parentElement;
      depth++;
    }

    // 5. Last resort: match error text against field names/labels
    const errText = errorEl.textContent?.trim().toLowerCase() ?? '';
    if (errText) {
      for (const f of fields) {
        const name = f.name?.toLowerCase();
        const label = f.label?.toLowerCase();
        if (name && name.length > 2 && errText.includes(name)) return f;
        if (label && label.length > 2 && errText.includes(label)) return f;
      }
    }

    return null;
  }

  // -----------------------------------------------------------
  // Check whether an error element appears to be actively displayed.
  // Template-based validators pre-render error messages and toggle
  // visibility via a CSS class on a parent container (e.g.
  // .form-group.error).  This method returns false for such elements
  // when the parent container does NOT carry an error-indicating class.
  // -----------------------------------------------------------

  private isErrorElementActive(el: Element): boolean {
    // 1. Inline style hiding
    const htmlEl = el as HTMLElement;
    if (htmlEl.style?.display === 'none' || htmlEl.style?.visibility === 'hidden') return false;

    // 2. Check computed visibility (catches CSS class-based hiding)
    try {
      if (typeof window.getComputedStyle === 'function') {
        const cs = window.getComputedStyle(htmlEl);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      }
    } catch {}

    // 3. Look for a form-group-like ancestor container
    const container = el.closest(
      '.form-group, .form-field, .field-group, .input-group, .field-wrapper, .form-row',
    );
    if (container) {
      // Container explicitly indicates an error state → active
      if (
        container.classList.contains('error') ||
        container.classList.contains('has-error') ||
        container.classList.contains('is-invalid')
      ) {
        return true;
      }

      // Check if the nearest input INSIDE this container has error markers.
      // Many frameworks (Bootstrap 5, etc.) put .is-invalid on the input
      // rather than on the container.
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

      // Container explicitly indicates a success/neutral state → not active
      if (
        container.classList.contains('success') ||
        container.classList.contains('is-valid') ||
        container.classList.contains('has-success')
      ) {
        return false;
      }

      // Container present but carries no error/success state.
      // Treat the error element as a hidden template unless it was
      // dynamically injected (i.e. the element tag/class looks like a
      // typical pre-rendered template message).
      const cls = el.className?.toString() ?? '';
      if (
        /\b(error-message|invalid-feedback|field-error|form-error|help-block)\b/.test(cls)
      ) {
        return false;
      }
    }

    // 4. No recognised container → element may be dynamically injected → report it
    return true;
  }

  // Build a stable CSS selector string for an arbitrary DOM element
  private buildErrorSelector(el: Element): string {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList)
      .slice(0, 2)
      .map((c) => `.${CSS.escape(c)}`)
      .join('');
    return cls ? `${tag}${cls}` : tag;
  }
}
