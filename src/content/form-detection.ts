import type {
  FieldAnalysis,
  FieldConstraints,
  FieldType,
  FormAnalysis,
  FormType,
  SelectOption,
} from '@/shared/types';
import {
  DATA_ATTRIBUTE_NAMES,
  FIELD_CONTEXT_CHAINS,
  FIELD_PATTERNS,
  INPUTMODE_FIELD_MAP,
  LIMITS,
  SECTION_HEADING_PATTERNS,
} from '@/shared/constants';
import { generateId } from '@/shared/utils';

// =============================================================
// FormDetectionEngine
// Runs entirely in the content-script context.
// =============================================================

export class FormDetectionEngine {
  private formCounter = 0;

  // -----------------------------------------------------------
  // Public: scan the whole page
  // -----------------------------------------------------------

  detectForms(): FormAnalysis[] {
    const explicitForms = Array.from(
      document.querySelectorAll<HTMLElement>('form, [role="form"]'),
    ).filter((el) => this.isElementVisible(el));
    const implicitContainers = this.detectImplicitForms(explicitForms);

    const all = [...explicitForms, ...implicitContainers];

    return all
      .map((el) => this.analyzeForm(el))
      .filter((f) => f.fields.length > 0);
  }

  /**
   * Reactive detection: watch for DOM mutations and return forms once the
   * page has settled for `settleMs` milliseconds or when `timeoutMs` is reached.
   * Useful for SPA pages that render fields asynchronously.
   */
  async detectFormsReactive(options?: { timeoutMs?: number; settleMs?: number }): Promise<FormAnalysis[]> {
    const timeoutMs = options?.timeoutMs ?? 1500;
    const settleMs = options?.settleMs ?? 250;

    const self = this;
    return new Promise<FormAnalysis[]>((resolve) => {
      let settledTimer: number | null = null;
      let overallTimer: number | null = null;

      function clearTimers() {
        try { if (settledTimer) clearTimeout(settledTimer); } catch {}
        try { if (overallTimer) clearTimeout(overallTimer); } catch {}
      }

      const observer = new MutationObserver(() => {
        // Reset settle timer on each mutation
        try { if (settledTimer) clearTimeout(settledTimer); } catch {}
        settledTimer = window.setTimeout(finish, settleMs);
      });

      function finish() {
        observer.disconnect();
        clearTimers();
        // Return the latest detection
        resolve(self.detectForms());
      }

      // Start observing the whole document body for additions/changes
      try {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      } catch {
        // If observe fails (e.g., test env), just resolve immediately
        resolve(self.detectForms());
        return;
      }

      // Kick off timers: if no mutations occur, settle after settleMs
      settledTimer = window.setTimeout(finish, settleMs);
      overallTimer = window.setTimeout(() => {
        // Timeout reached — return whatever we have
        try { observer.disconnect(); } catch {}
        clearTimers();
        resolve(self.detectForms());
      }, timeoutMs);
    });
  }

  /** Returns false for elements that are hidden via display:none, visibility:hidden, or the hidden attribute. */
  private isElementVisible(el: HTMLElement): boolean {
    try {
      if (el.style?.display === 'none' || el.style?.visibility === 'hidden') return false;
      if (el.hasAttribute('hidden')) return false;
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    } catch {
      // In test environments getComputedStyle may not be available; assume visible
    }
    return true;
  }

  /**
   * Returns false if the field or any ancestor (up to the form boundary / body)
   * is hidden via inline display:none, visibility:hidden, or the hidden attribute.
   * This catches fields inside hidden wizard-step containers within a single form.
   */
  private isFieldVisible(el: Element): boolean {
    try {
      let node: Element | null = el;
      while (node && node !== document.body) {
        if (node instanceof HTMLElement) {
          if (node.style?.display === 'none' || node.style?.visibility === 'hidden') return false;
          if (node.hasAttribute('hidden')) return false;
        }
        node = node.parentElement;
      }
    } catch {
      // In test environments, assume visible
    }
    return true;
  }

  // Heuristic: determine whether an input is search-like (used for standalone inputs)
  private isSearchLike(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
    try {
      const htmlType = (el as HTMLInputElement).type?.toLowerCase() ?? '';
      if (htmlType === 'search') return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'search' || role === 'searchbox') return true;
      const name = (el.getAttribute('name') || '').toLowerCase();
      const id = (el.getAttribute('id') || '').toLowerCase();
      const placeholder = ((el as HTMLInputElement).placeholder || '').toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const combined = [name, id, placeholder, aria].join(' ');
      if (/(?:\b|^)(search|q|query|site search)(?:\b|$)/i.test(combined)) return true;
      const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.includes('search')) return true;
    } catch {
      // ignore
    }
    return false;
  }

  // -----------------------------------------------------------
  // Private: find groups of inputs not inside a <form>
  // -----------------------------------------------------------

  private detectImplicitForms(_knownForms: HTMLElement[]): HTMLElement[] {
    // Exclude inputs inside ANY <form> (visible or hidden) — they belong
    // to that form and should not be treated as orphaned inputs.  This
    // prevents hidden wizard-step forms from being re-detected as implicit
    // containers.
    const allFormElements = Array.from(
      document.querySelectorAll<HTMLElement>('form, [role="form"]'),
    );
    const allInputs = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input:not([type="hidden"]), textarea, select',
      ),
    ).filter((el) => !allFormElements.some((f) => f.contains(el)));

    if (allInputs.length === 0) return [];

    // Cluster by nearest common ancestor
    const containerSet = new Set<HTMLElement>();
    for (const input of allInputs) {
      const container = this.findNearestContainer(input);
      if (container) containerSet.add(container);
    }

    // If there are leftover single inputs that weren't clustered (e.g., standalone
    // search bars), include them when they are clearly standalone search-like
    // fields. This ensures inputs outside forms are still analyzed.
    const clustered = new Set<Element>();
    for (const c of containerSet) {
      for (const el of Array.from(c.querySelectorAll('input, textarea, select'))) clustered.add(el);
    }

    for (const input of allInputs) {
      if (clustered.has(input)) continue;
      if (this.isSearchLike(input)) {
        // Prefer nearest container, fall back to the input element itself
        const container = this.findNearestContainer(input) ?? (input.parentElement ?? input);
        if (container) containerSet.add(container);
      }
    }
    return Array.from(containerSet);
  }

  private findNearestContainer(el: Element): HTMLElement | null {
    let node: Element | null = el.parentElement;
    while (node && node !== document.body) {
      const inputs = node.querySelectorAll('input, textarea, select');
      if (inputs.length >= 2) return node as HTMLElement;
      // If this container has a role indicating search or form-like semantics,
      // accept it even if it only contains one input.
      const role = node.getAttribute('role') ?? '';
      if (/(?:\b|^)(search|searchbox|form)(?:\b|$)/i.test(role)) return node as HTMLElement;
      // If the container has a heading that suggests a search area, accept it.
      const heading = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4');
      if (heading) return node as HTMLElement;
      node = node.parentElement;
    }
    return null;
  }

  // -----------------------------------------------------------
  // Analyse one form element
  // -----------------------------------------------------------

  analyzeForm(formEl: HTMLElement): FormAnalysis {
    const index = this.formCounter++;
    const inputEls = Array.from(
      formEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select',
      ),
    )
    .filter((el) => this.isFieldVisible(el))
    .slice(0, LIMITS.MAX_FORM_FIELDS);

    const fields: FieldAnalysis[] = inputEls
      .map((el, i) => this.analyzeField(el, i, index, formEl))
      .filter((f): f is FieldAnalysis => f !== null);

    // Detect custom radio groups (e.g., Google Forms) that use
    // [role="radiogroup"] with [role="radio"] children instead of
    // native <input type="radio"> elements.
    const radioGroups = Array.from(
      formEl.querySelectorAll<HTMLElement>('[role="radiogroup"]'),
    ).filter((rg) => {
      // Skip if native radio inputs exist inside — already handled above
      return rg.querySelectorAll('input[type="radio"]').length === 0;
    });

    for (const rg of radioGroups) {
      const rgField = this.analyzeRadioGroup(rg, fields.length, index);
      if (rgField) fields.push(rgField);
    }

    // Second pass: promote low-confidence fallbacks using neighbor context
    this.runContextChainInference(fields);

    const formType = this.detectFormType(fields);

    return {
      index,
      type: formType,
      fields,
      selector: this.cssSelector(formEl),
      action: (formEl as HTMLFormElement).action ?? '',
      method: ((formEl as HTMLFormElement).method ?? 'get').toUpperCase(),
      hasSubmitButton: formEl.querySelector('[type="submit"], button:not([type="button"])') !== null,
      isMultiStep: this.detectMultiStep(formEl),
      currentStep: 1,
      totalSteps: 1,
      analyzedAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------
  // Analyse one field
  // -----------------------------------------------------------

  analyzeField(
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    index: number,
    formIndex: number,
    formEl?: HTMLElement,
  ): FieldAnalysis | null {
    const htmlType = (el as HTMLInputElement).type?.toLowerCase() ?? 'text';

    // Skip submit, button, image, hidden, and non-interactive inputs
    if (['submit', 'button', 'image', 'reset', 'hidden'].includes(htmlType)) return null;
    // Skip read-only fields (except checkboxes/radios where readOnly doesn't prevent interaction)
    if ((el as HTMLInputElement).readOnly && !['checkbox', 'radio'].includes(htmlType)) return null;
    // Skip disabled fields — cannot be interacted with
    if (el.disabled) return null;

    const label = this.findLabel(el);
    const placeholder = (el as HTMLInputElement).placeholder ?? '';
    const name = el.name ?? '';
    const id = el.id ?? '';
    const ariaLabel = el.getAttribute('aria-label') ?? '';
    const className = (el.className || '').toString();
    // Resolve aria-labelledby text for detection (findLabel already uses it
    // for label resolution, but we include the raw text in `combined` so
    // the regex pipeline can also match against it).
    let ariaLabelledByText = '';
    try {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const refEl = document.getElementById(labelledBy);
        if (refEl) ariaLabelledByText = refEl.textContent?.trim() ?? '';
      }
    } catch { /* best-effort */ }
    const combined = [name, id, label, placeholder, ariaLabel, ariaLabelledByText, className].join(' ');

    const { type, confidence } = this.detectFieldType(el, combined, htmlType);
    const constraints = this.extractConstraints(el);

    // For radios and checkboxes, collect options from inputs sharing the same name
    try {
      const htmlInput = el as HTMLInputElement;
      if (htmlInput.type === 'radio' || htmlInput.type === 'checkbox') {
        const nm = htmlInput.name || '';
        if (nm) {
          const scope = formEl ?? document;
          const group = Array.from(
            scope.querySelectorAll<HTMLInputElement>(
              `input[type="${htmlInput.type}"][name="${CSS.escape(nm)}"]`,
            ),
          );
          if (group.length > 0) {
            const opts = group
              .map((g) => ({ value: g.value || 'on', label: this.findLabel(g) || g.value || '' }))
              .filter((o) => o.value !== undefined);
            if (opts.length > 0) constraints.options = opts;
            // If more than one checkbox with same name, treat as multiple-choice
            if (htmlInput.type === 'checkbox' && group.length > 1) constraints.multiple = true;
          }
        }
      }
    } catch {
      // best-effort only
    }

    // Detect non-native/custom dropdowns (e.g., div-based dropdowns)
    try {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute('role') ?? '';
      const cls = (el.className || '').toString().toLowerCase();
        const looksLikeDropdown =
          tag !== 'select' && (/(?:\b|^)(listbox|combobox)(?:\b|$)/i.test(role) || /\bselect\b|\bdropdown\b|\bcombobox\b/.test(cls));

      if (looksLikeDropdown) {
        // Try to find option-like children within the element
        const optionNodes = Array.from(
          el.querySelectorAll<HTMLElement>('[role="option"], [data-value], li, [data-option]'),
        ).slice(0, 200);

        if (optionNodes.length > 0) {
          const opts = optionNodes.map((o) => ({ value: o.getAttribute('data-value') ?? o.textContent?.trim() ?? '', label: o.textContent?.trim() ?? '' }));
          if (opts.length > 0) constraints.options = opts;
        }
      }
    } catch {
      // ignore
    }

    // Detect Vue Multiselect / vue-select custom dropdown containers.
    // The <input> found inside these is a search/filter input, not the
    // actual form field.  Promote it to a 'select' field targeting the
    // parent container so the filler can click real options.
    try {
      const multiselectContainer = el.closest('.multiselect, .v-select');
      if (multiselectContainer && el.tagName.toLowerCase() === 'input') {
        // Extract options from the dropdown list (works even when display:none)
        // Prefer .multiselect__element list items (each wraps a single option)
        let optionEls = Array.from(
          multiselectContainer.querySelectorAll<HTMLElement>('.multiselect__element'),
        ).filter((li) => {
          // Skip hidden placeholder items
          if ((li as HTMLElement).style?.display === 'none') return false;
          // Must have role="option" or contain an option span
          if (li.getAttribute('role') === 'option' || li.querySelector('[role="option"]')) return true;
          return false;
        });
        // Fallback: try direct option selectors
        if (optionEls.length === 0) {
          optionEls = Array.from(
            multiselectContainer.querySelectorAll<HTMLElement>('.multiselect__option, .vs__dropdown-option'),
          );
        }
        const multiOptions = Array.from(optionEls)
          .map((o) => {
            const text = (o.textContent ?? '').trim().replace(/\s+/g, ' ');
            return { value: text, label: text };
          })
          .filter((o) => {
            if (o.value.length === 0 || o.value.length >= 200) return false;
            // Filter out common placeholder messages
            const lower = o.value.toLowerCase();
            if (/^(no (elements?|results?|options?|items?) found|list is empty|no match|type to search|select|search)/i.test(lower)) return false;
            return true;
          });

        // Fix label: walk up to find a proper <label> element
        let multiselectLabel = label;
        try {
          let wrap: Element | null = multiselectContainer.parentElement;
          for (let d = 0; wrap && wrap !== document.body && d < 3; d++) {
            const lbl = wrap.querySelector<HTMLLabelElement>('label');
            if (lbl) {
              const clone = lbl.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('.required-indc, .required, .popover-btn, button, i').forEach((c) => c.remove());
              const cleaned = clone.textContent?.trim().replace(/\s*\*+\s*$/g, '').trim();
              if (cleaned && cleaned.length > 0) { multiselectLabel = cleaned; break; }
            }
            wrap = wrap.parentElement;
          }
        } catch { /* best-effort */ }

        return {
          id: generateId('fld'),
          index,
          type: 'select' as FieldType,
          htmlType: 'select',
          name: name || multiselectContainer.getAttribute('name') || '',
          label: multiselectLabel,
          placeholder,
          ariaLabel: ariaLabel || undefined,
          className: className || undefined,
          constraints: {
            ...constraints,
            options: multiOptions.length > 0 ? multiOptions : constraints.options,
          },
          required: el.required || el.getAttribute('aria-required') === 'true',
          selector: this.cssSelector(multiselectContainer),
          formIndex,
          confidence: 0.9,
        };
      }
    } catch {
      // best-effort only
    }


    return {
      id: generateId('fld'),
      index,
      type,
      htmlType,
      name,
      label,
      placeholder,
      ariaLabel: ariaLabel || undefined,
      className: className || undefined,
      constraints,
      required: el.required || el.getAttribute('aria-required') === 'true',
      selector: this.cssSelector(el),
      formIndex,
      confidence,
    };
  }

  // -----------------------------------------------------------
  // Field type detection  (5-layer pipeline)
  // Layer 1 : HTML5 input type        (confidence 0.9–1.0)
  // Layer 2 : data-* / inputmode      (confidence 0.85)
  // Layer 3 : autocomplete attribute  (confidence 0.80)
  // Layer 4 : regex on combined text  (confidence 0.75)
  // Layer 5 : section/fieldset heading context (confidence 0.65 – tie-breaker)
  // Multi-signal agreement boost: +0.1 when two independent layers agree
  // -----------------------------------------------------------

  private detectFieldType(
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    combined: string,
    htmlType: string,
  ): { type: FieldType; confidence: number } {
    // ── Layer 1: structural HTML5 types (always authoritative) ───────────────
    const html5 = this.detectFromHtmlType(htmlType, el);
    if (html5 && html5.confidence >= 0.9) {
      // Check if a data-attribute agrees → agreement boost
      const dataResult = this.detectFromDataAttributes(el);
      if (dataResult && dataResult.type === html5.type) {
        return { type: html5.type, confidence: Math.min(1.0, html5.confidence + 0.1) };
      }
      return html5;
    }

    // ── For generic text inputs: accumulate all remaining signals ────────────
    const candidates: Array<{ type: FieldType; confidence: number }> = [];

    // Layer 2: data-* attributes and inputmode
    const dataResult = this.detectFromDataAttributes(el);
    if (dataResult) candidates.push(dataResult);

    // Layer 3: autocomplete attribute
    const autoType = this.typeFromAutocomplete(el.getAttribute('autocomplete') ?? '');
    if (autoType) candidates.push({ type: autoType, confidence: 0.8 });

    // Layer 4: regex on combined label/name/placeholder text
    const regexResult = this.detectFromRegex(combined);
    if (regexResult) candidates.push(regexResult);

    // Layer 5: section/fieldset heading context (confidence 0.65 – only boosts if agrees)
    const sectionResult = this.detectFromSectionContext(el, candidates[0]?.type);
    if (sectionResult) candidates.push(sectionResult);

    // Include a below-threshold html5 result as a fallback candidate
    if (html5 && html5.confidence > 0) candidates.push(html5);

    if (candidates.length === 0) return { type: 'text', confidence: 0.3 };

    // Multi-signal agreement boost: if ≥2 sources agree on the same type, +0.1
    const typeCounts = new Map<FieldType, number>();
    for (const c of candidates) typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
    const boosted = candidates.map((c) =>
      (typeCounts.get(c.type) ?? 1) >= 2
        ? { type: c.type, confidence: Math.min(1.0, c.confidence + 0.1) }
        : c,
    );

    return boosted.reduce((best, c) => (c.confidence > best.confidence ? c : best));
  }

  // ── Layer 1 helper ──────────────────────────────────────────────────────────
  private detectFromHtmlType(
    htmlType: string,
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  ): { type: FieldType; confidence: number } | null {
    switch (htmlType) {
      case 'search':   return { type: 'text',     confidence: 0.9 };
      case 'email':    return { type: 'email',    confidence: 1.0 };
      case 'tel':      return { type: 'phone',    confidence: 1.0 };
      case 'password': return { type: 'password', confidence: 1.0 };
      case 'date':
      case 'time':
      case 'datetime-local':
      case 'month':
      case 'week':     return { type: 'date',     confidence: 0.95 };
      case 'number':   return { type: 'number',   confidence: 0.9 };
      case 'url':      return { type: 'url',      confidence: 1.0 };
      case 'color':    return { type: 'color',    confidence: 1.0 };
      case 'range':    return { type: 'range',    confidence: 1.0 };
      case 'file':     return { type: 'file',     confidence: 1.0 };
      case 'hidden':   return { type: 'hidden',   confidence: 1.0 };
      case 'checkbox': return { type: 'checkbox', confidence: 1.0 };
      case 'radio':    return { type: 'radio',    confidence: 1.0 };
      case 'textarea': return { type: 'textarea', confidence: 0.9 };
    }
    if (el.tagName.toLowerCase() === 'textarea') return { type: 'textarea', confidence: 0.9 };
    if (el.tagName.toLowerCase() === 'select')   return { type: 'select',   confidence: 1.0 };
    return null; // generic <input type="text"> – continue to deeper layers
  }

  // ── Layer 2 helper: data-* attributes + inputmode ───────────────────────────
  private detectFromDataAttributes(
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  ): { type: FieldType; confidence: number } | null {
    // inputmode gives strong semantic intent
    const inputMode = el.getAttribute('inputmode')?.toLowerCase();
    if (inputMode) {
      const mapped = INPUTMODE_FIELD_MAP[inputMode];
      if (mapped) return { type: mapped, confidence: 0.85 };
    }

    // Scan data-* attribute values and dataset keys for FieldType tokens
    for (const attrName of DATA_ATTRIBUTE_NAMES) {
      const val = el.getAttribute(attrName)?.toLowerCase().trim();
      if (val) {
        const token = val.replace(/[-_\s]/g, '');
        const fieldType = this.fieldTypeFromToken(token);
        if (fieldType) return { type: fieldType, confidence: 0.85 };
      }
    }

    // Also inspect dataset keys and values (data-foo="...")
    try {
      const ds = (el as HTMLElement).dataset;
      for (const [k, v] of Object.entries(ds)) {
        const keyToken = k.toLowerCase().replace(/[-_\s]/g, '');
        const keyType = this.fieldTypeFromToken(keyToken);
        if (keyType) return { type: keyType, confidence: 0.8 };
        if (v) {
          const valToken = v.toLowerCase().replace(/[-_\s]/g, '');
          const valType = this.fieldTypeFromToken(valToken);
          if (valType) return { type: valType, confidence: 0.8 };
        }
      }
    } catch {
      // best-effort only
    }
    return null;
  }

  // Maps normalised token strings to FieldType
  private fieldTypeFromToken(token: string): FieldType | null {
    const map: Record<string, FieldType> = {
      email: 'email',
      phone: 'phone', tel: 'phone', telephone: 'phone', mobile: 'phone', cell: 'phone',
      password: 'password', passwd: 'password', pwd: 'password',
      firstname: 'firstName', givenname: 'firstName', fname: 'firstName',
      lastname: 'lastName',  surname: 'lastName', familyname: 'lastName', lname: 'lastName',
      fullname: 'fullName', name: 'fullName', displayname: 'fullName',
      username: 'username', userid: 'username', login: 'username', handle: 'username',
      birthdate: 'birthdate', birthday: 'birthdate', dob: 'birthdate', born: 'birthdate',
      date: 'date',
      creditcard: 'creditCard', cardnumber: 'creditCard', ccnumber: 'creditCard', pan: 'creditCard',
      creditcardexpiry: 'creditCardExpiry', expiry: 'creditCardExpiry', expdate: 'creditCardExpiry', ccexp: 'creditCardExpiry',
      cvv: 'creditCardCvv', cvc: 'creditCardCvv', csc: 'creditCardCvv', securitycode: 'creditCardCvv',
      address: 'address',
      street: 'street', addressline: 'street', addressline1: 'street',
      city: 'city', town: 'city', locality: 'city',
      state: 'state', province: 'state', region: 'state',
      zipcode: 'zipcode', zip: 'zipcode', postalcode: 'zipcode', postcode: 'zipcode',
      country: 'country',
      company: 'company', organisation: 'company', organization: 'company',
      jobtitle: 'jobTitle', position: 'jobTitle', title: 'jobTitle',
      url: 'url', website: 'url',
      number: 'number', quantity: 'number', age: 'number',
      currency: 'currency', price: 'currency', amount: 'currency',
      color: 'color', colour: 'color',
    };
    return map[token] ?? null;
  }

  // ── Layer 3 helper: autocomplete attribute ───────────────────────────────────
  private typeFromAutocomplete(ac: string): FieldType | null {
    const map: Record<string, FieldType> = {
      email: 'email',
      tel: 'phone',
      'tel-national': 'phone',
      'current-password': 'password',
      'new-password': 'password',
      username: 'username',
      name: 'fullName',
      'given-name': 'firstName',
      'family-name': 'lastName',
      bday: 'birthdate',
      'street-address': 'street',
      'address-line1': 'street',
      'address-level2': 'city',
      'address-level1': 'state',
      'postal-code': 'zipcode',
      'country-name': 'country',
      organization: 'company',
      url: 'url',
      'cc-number': 'creditCard',
      'cc-exp': 'creditCardExpiry',
      'cc-csc': 'creditCardCvv',
    };
    return map[ac.toLowerCase()] ?? null;
  }

  // ── Layer 4 helper: ordered regex match ──────────────────────────────────────
  private detectFromRegex(combined: string): { type: FieldType; confidence: number } | null {
    const orderedTypes: FieldType[] = [
      'password', 'email', 'phone',
      'creditCard', 'creditCardExpiry', 'creditCardCvv',
      'birthdate', 'date',
      'zipcode', 'country', 'state', 'city', 'street', 'address',
      'firstName', 'lastName', 'fullName', 'username',
      'company', 'jobTitle', 'url',
      'currency', 'number', 'color', 'text',
    ];
    for (const candidate of orderedTypes) {
      const pattern = FIELD_PATTERNS[candidate];
      if (pattern && pattern.test(combined)) return { type: candidate, confidence: 0.75 };
    }
    return null;
  }

  // ── Layer 5 helper: section/fieldset heading context ─────────────────────────
  // Only confirms an existing candidate – it never introduces a brand-new type
  private detectFromSectionContext(
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    existingType?: FieldType,
  ): { type: FieldType; confidence: number } | null {
    if (!existingType) return null;
    const heading = this.findSectionHeading(el);
    if (!heading) return null;
    for (const { pattern, types } of SECTION_HEADING_PATTERNS) {
      if (pattern.test(heading) && types.includes(existingType)) {
        return { type: existingType, confidence: 0.65 };
      }
    }
    return null;
  }

  private findSectionHeading(el: Element): string | null {
    let node: Element | null = el.parentElement;
    let depth = 0;
    while (node && node !== document.body && depth < 8) {
      if (node.tagName.toLowerCase() === 'fieldset') {
        const legend = node.querySelector(':scope > legend');
        if (legend) return legend.textContent?.trim() ?? null;
      }
      if (['section', 'div', 'article', 'aside'].includes(node.tagName.toLowerCase())) {
        const heading = node.querySelector(
          ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6,' +
          ' :scope > legend, :scope > [class*="title"], :scope > [class*="heading"]',
        );
        if (heading) return heading.textContent?.trim() ?? null;
      }
      const sectionAttr =
        node.getAttribute('data-section') ?? node.getAttribute('data-group');
      if (sectionAttr) return sectionAttr;
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  // ── Context-chain inference (second pass) ────────────────────────────────────
  // Promotes low-confidence fallback fields by inspecting high-confidence neighbors.
  private runContextChainInference(fields: FieldAnalysis[]): void {
    const LOW = 0.5;   // promote fields below this threshold
    const HIGH = 0.75; // trust neighbors above this threshold

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (field.confidence >= LOW) continue; // already well-typed

      for (const chain of FIELD_CONTEXT_CHAINS) {
        if (chain.position === 'after') {
          // anchor must be one of the immediately preceding fields (within 2 positions)
          const prev = fields[i - 1] ?? fields[i - 2];
          if (
            prev &&
            prev.confidence >= HIGH &&
            chain.anchor.includes(prev.type)
          ) {
            field.type = chain.infer;
            field.confidence = 0.6;
            break;
          }
        } else {
          // anchor must be one of the immediately following fields (within 2 positions)
          const next = fields[i + 1] ?? fields[i + 2];
          if (
            next &&
            next.confidence >= HIGH &&
            chain.anchor.includes(next.type)
          ) {
            field.type = chain.infer;
            field.confidence = 0.6;
            break;
          }
        }
      }
    }
  }

  // -----------------------------------------------------------
  // Custom radiogroup analysis (Google Forms, etc.)
  // -----------------------------------------------------------

  private analyzeRadioGroup(
    rg: HTMLElement,
    index: number,
    formIndex: number,
  ): FieldAnalysis | null {
    const radioChildren = Array.from(
      rg.querySelectorAll<HTMLElement>('[role="radio"]'),
    );
    if (radioChildren.length === 0) return null;

    const label = this.findLabel(rg);
    const ariaLabel = rg.getAttribute('aria-label') ?? '';
    const name = rg.getAttribute('name') ?? rg.getAttribute('data-name') ?? '';

    // Collect options from the radio children
    const options = radioChildren.map((c) => {
      const val =
        c.getAttribute('data-value') ??
        c.getAttribute('aria-label') ??
        c.textContent?.trim() ??
        '';
      const lbl =
        c.getAttribute('aria-label') ??
        c.textContent?.trim() ??
        val;
      return { value: val, label: lbl };
    }).filter((o) => o.value.length > 0);

    if (options.length === 0) return null;

    const combined = [name, label, ariaLabel].join(' ');
    // Try to infer the field type from surrounding text
    const regexResult = this.detectFromRegex(combined);

    return {
      id: generateId('fld'),
      index,
      type: regexResult?.type ?? 'radio',
      htmlType: 'radiogroup',
      name,
      label: label || ariaLabel,
      placeholder: '',
      constraints: {
        minLength: null,
        maxLength: null,
        min: null,
        max: null,
        pattern: null,
        step: null,
        required: rg.getAttribute('aria-required') === 'true',
        readOnly: false,
        disabled: rg.getAttribute('aria-disabled') === 'true',
        multiple: false,
        accept: null,
        options,
      },
      required: rg.getAttribute('aria-required') === 'true',
      selector: this.cssSelector(rg),
      formIndex,
      confidence: 0.9,
    };
  }

  // -----------------------------------------------------------
  // Constraint extraction
  // -----------------------------------------------------------

  private extractConstraints(
    el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  ): FieldConstraints {
    const input = el as HTMLInputElement;
    const options: SelectOption[] =
      el.tagName.toLowerCase() === 'select'
        ? Array.from((el as HTMLSelectElement).options)
            .filter((o) => o.value !== '')
            .map((o) => ({ value: o.value, label: o.text.trim() }))
        : [];

    return {
      minLength: input.minLength > 0 ? input.minLength : null,
      maxLength: input.maxLength > 0 ? input.maxLength : null,
      min: input.min || null,
      max: input.max || null,
      pattern: input.pattern || null,
      step: input.step || null,
      required: el.required,
      readOnly: input.readOnly ?? false,
      disabled: el.disabled,
      multiple: input.multiple ?? false,
      accept: input.accept || null,
      options: options.length > 0 ? options : undefined,
    };
  }

  // -----------------------------------------------------------
  // Label discovery
  // -----------------------------------------------------------

  private findLabel(el: HTMLElement): string {
    // 1. Explicit <label for="id">
    if (el.id) {
      const explicit = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`);
      if (explicit) return explicit.textContent?.trim() ?? '';
    }

    // 2. Wrapping <label>
    const wrap = el.closest('label');
    if (wrap) {
      const clone = wrap.cloneNode(true) as HTMLElement;
      // Remove the input element from clone to get the label text only
      clone.querySelectorAll('input, textarea, select').forEach((c) => c.remove());
      const text = clone.textContent?.trim();
      if (text) return text;
    }

    // 3. aria-labelledby (checked FIRST — more specific than aria-label)
    // Google Forms inputs have aria-label="Your answer" (generic) alongside
    // aria-labelledby="i12" pointing to the actual question text. We must
    // check aria-labelledby first to get the real question.
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) {
        // Prefer a known question-title child (e.g., Google Forms .M7eMe)
        const qChild = labelEl.querySelector<HTMLElement>('.M7eMe, .exportItemTitle, [data-question-title]');
        if (qChild) {
          const qText = qChild.textContent?.trim();
          if (qText) return qText;
        }
        // Clone and strip required indicators (e.g., <span class="vnumgf">*</span>)
        const clone = labelEl.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.vnumgf, .required-indc, .required, [class*="required-"], .asterisk').forEach((c) => c.remove());
        const text = clone.textContent?.trim()
          .replace(/\s*\*+\s*$/g, '')
          .replace(/^\s*\*+\s*/g, '')
          .trim();
        if (text) return text;
      }
    }

    // 3b. aria-label (skip generic form-builder placeholders)
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const generic = /^(your answer|enter your (answer|response|text)|type your answer|response|respuesta|réponse|antwort|jawaban|ここに入力|답변)$/i;
      if (!generic.test(ariaLabel.trim())) {
        return ariaLabel.trim();
      }
    }

    // 3b. Form-builder question text selectors (Google Forms, Typeform, etc.)
    // Walk up the DOM looking for known question-text elements. These carry
    // the human-readable question string in form builders that don't use
    // standard <label> elements.
    const QUESTION_SELECTORS = [
      '.M7eMe',                                      // Google Forms question title
      '.freebirdFormviewItemMinimizedTitleText',      // Google Forms (old/minimised)
      '.exportItemTitle',                             // Google Forms export view
      '[data-question-title]',                        // Generic data-attribute
      '.office-form-question-title',                  // Microsoft Forms
      '.question-title-text',                         // SurveyMonkey
      '.FormField-label',                             // Typeform
      '[data-qa="question-title"]',                   // Typeform (QA hook)
      '.jfQuestion-label',                            // JotForm
      '.form-question-headline',                      // Cognito Forms
      '.ssq-question-title',                          // Smartsheet
    ];
    const qSelector = QUESTION_SELECTORS.join(',');
    let qAncestor: HTMLElement | null = el.parentElement;
    for (let qd = 0; qAncestor && qAncestor !== document.body && qd < 8; qd++) {
      const qEl = qAncestor.querySelector<HTMLElement>(qSelector);
      if (qEl) {
        const qText = qEl.textContent?.trim();
        if (qText && qText.length < 300) return qText;
      }
      qAncestor = qAncestor.parentElement;
    }

    // 4. Sibling check — prefer <label> siblings over <span>/other siblings
    const prevSiblings: Element[] = [];
    let sib = el.previousElementSibling;
    while (sib) { prevSiblings.push(sib); sib = sib.previousElementSibling; }
    const nextSiblings: Element[] = [];
    sib = el.nextElementSibling;
    while (sib) { nextSiblings.push(sib); sib = sib.nextElementSibling; }
    const allSiblings = [...prevSiblings, ...nextSiblings];

    // 4a. Prefer a <label> sibling first (highest priority among siblings)
    for (const s of allSiblings) {
      if (s.tagName.toLowerCase() === 'label') {
        const text = s.textContent?.trim();
        if (text && text.length < 120) return text;
      }
    }

    // 4b. Fall back to non-form-control previous sibling text
    const prev = el.previousElementSibling;
    if (prev && !['input', 'select', 'textarea', 'button'].includes(prev.tagName.toLowerCase())) {
      const text = prev.textContent?.trim();
      if (text && text.length < 120) return text;
    }

    // 4c. Fall back to non-form-control next sibling text
    const next = el.nextElementSibling;
    if (next && !['input', 'select', 'textarea', 'button'].includes(next.tagName.toLowerCase())) {
      const ntext = next.textContent?.trim();
      if (ntext && ntext.length < 120) return ntext;
    }

    // 4d. Ancestor walk (up to 4 levels) — prefer <label> inside ancestor, then raw text
    // Handles Vue/React wrapper components where label text sits in an
    // ancestor <span>/<div> above intermediate wrapper divs:
    //   <span>"Plan Code" <span class="required-indc">*</span> <div><input/></div></span>
    //   <span><label>Plan Code</label><div class="input-icon"><input/></div></span>
    let ancestor: HTMLElement | null = el.parentElement;
    for (let depth = 0; ancestor && ancestor !== document.body && depth < 4; depth++) {
      // Stop if ancestor wraps multiple form controls (multi-field container)
      if (ancestor.querySelectorAll('input, textarea, select').length > 1) break;

      // Priority: look for a <label> element inside this ancestor first
      const labelInAncestor = ancestor.querySelector<HTMLLabelElement>('label');
      if (labelInAncestor) {
        const labelText = labelInAncestor.textContent?.trim();
        if (labelText && labelText.length < 200) return labelText;
      }

      // Fallback: extract all text content from ancestor (strip form controls + required markers)
      const clone = ancestor.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, textarea, select, button').forEach((c) => c.remove());
      // Strip required-indicator markers (* badges, "required" text spans)
      clone.querySelectorAll('.required-indc, .required, [class*="required-"], .asterisk').forEach((c) => c.remove());
      const ptext = clone.textContent?.trim()
        .replace(/\s*\*+\s*$/g, '')
        .replace(/^\s*\*+\s*/g, '')
        .trim();
      if (ptext && ptext.length > 0 && ptext.length < 200) {
        // Prefer concise snippets (split lines and pick closest short line)
        const lines = ptext.split(/\n|\r/).map((s) => s.trim()).filter(Boolean);
        if (lines.length > 0) return lines[0];
      }
      ancestor = ancestor.parentElement;
    }

    return '';
  }

  // -----------------------------------------------------------
  // Form type classification
  // -----------------------------------------------------------

  private detectFormType(fields: FieldAnalysis[]): FormType {
    const types = new Set(fields.map((f) => f.type));

    // Exclude non-fillable field types from classification count
    const fillableFields = fields.filter((f) => !['hidden', 'file'].includes(f.type));
    const hasPassword = types.has('password');
    const hasEmail = types.has('email');
    const hasCreditCard = types.has('creditCard') || types.has('creditCardExpiry');
    const hasName = types.has('firstName') || types.has('lastName') || types.has('fullName');

    if (hasCreditCard) return 'payment';
    if (hasPassword && fillableFields.length <= 3 && hasEmail) return 'login';
    if (hasPassword && (hasName || fillableFields.length > 3)) return 'signup';
    if (types.has('textarea') && hasEmail && hasName) return 'contact';
    if (fields.length === 1 && types.has('text')) return 'search';

    return 'unknown';
  }

  private detectMultiStep(formEl: HTMLElement): boolean {
    const stepIndicators = formEl.querySelectorAll(
      '.step, [data-step], .wizard-step, .form-step, [class*="step"]',
    );
    return stepIndicators.length > 1;
  }

  // -----------------------------------------------------------
  // Stable CSS selector for an element
  // -----------------------------------------------------------

  cssSelector(el: Element): string {
    // Prefer stable attributes often used in SPAs: data-field, data-testid, aria-label
    try {
      const asEl = el as HTMLElement;
      const df = asEl.getAttribute('data-field');
      if (df) return `[data-field="${CSS.escape(df)}"]`;
      const td = asEl.getAttribute('data-testid') || asEl.getAttribute('data-test');
      if (td) return `[data-testid="${CSS.escape(td)}"]`;
      const aria = asEl.getAttribute('aria-label');
      if (aria) return `${asEl.tagName.toLowerCase()}[aria-label="${CSS.escape(aria)}"]`;
    } catch {
      // ignore
    }

    if (el.id) return `#${CSS.escape(el.id)}`;

    const tag = el.tagName.toLowerCase();
    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${CSS.escape(name)}"]`;

    // Build path from root
    const path: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        selector = `#${CSS.escape(node.id)}`;
        path.unshift(selector);
        break;
      } else {
        const siblings = Array.from(node.parentElement?.children ?? []).filter(
          (s) => s.tagName === node!.tagName,
        );
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
}
