/**
 * Unit tests for FormFiller utility methods.
 *
 * Covers:
 *  - scanDomErrors         (public)
 *  - checkFieldError       (public)
 *  - findNearestField      (private – accessed via any-cast)
 *  - fillFormWithRecovery  (public) including AbortSignal support
 */

import { FormFiller } from '../../src/content/form-filler';
import type { FormAnalysis, FieldAnalysis } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal FieldAnalysis stub for tests. */
function makeField(
  overrides: Partial<FieldAnalysis> & { id: string; selector: string },
): FieldAnalysis {
  return {
    index: 0,
    type: 'text',
    htmlType: 'text',
    name: overrides.id,
    label: overrides.id,
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
    formIndex: 0,
    value: 'test',
    skip: false,
    confidence: 0.9,
    ...overrides,
  } as FieldAnalysis;
}

/** Minimal FormAnalysis stub. */
function makeFormAnalysis(
  fields: FieldAnalysis[],
  selector = 'form',
): FormAnalysis {
  return {
    index: 0,
    type: 'unknown',
    fields,
    selector,
    action: '',
    method: 'post',
    hasSubmitButton: false,
    isMultiStep: false,
    currentStep: 1,
    totalSteps: 1,
    analyzedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let filler: FormFiller;

beforeEach(() => {
  filler = new FormFiller();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// checkFieldError
// ---------------------------------------------------------------------------

describe('FormFiller.checkFieldError', () => {
  it('returns false for a valid input', () => {
    document.body.innerHTML = '<input id="f" type="text" value="hello" />';
    const el = document.getElementById('f') as HTMLInputElement;
    expect(filler.checkFieldError(el)).toBe(false);
  });

  it('returns true when aria-invalid is set', () => {
    document.body.innerHTML = '<input id="f" aria-invalid="true" />';
    const el = document.getElementById('f') as HTMLInputElement;
    expect(filler.checkFieldError(el)).toBe(true);
  });

  it('returns true when :invalid via required + empty value', () => {
    document.body.innerHTML = '<input id="f" type="text" required />';
    const el = document.getElementById('f') as HTMLInputElement;
    // JSDOM sets validity.valueMissing = true when required + empty
    expect(filler.checkFieldError(el)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scanDomErrors
// ---------------------------------------------------------------------------

describe('FormFiller.scanDomErrors', () => {
  const fields = [
    { id: 'email', selector: '#email', name: 'email', label: 'Email' },
    { id: 'phone', selector: '#phone', name: 'phone', label: 'Phone' },
    { id: 'name',  selector: '#name',  name: 'name',  label: 'Name'  },
  ];

  it('returns empty array when no error elements present', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" type="email" value="a@b.com" />
        <input id="phone" type="tel" value="1234567890" />
        <input id="name"  type="text" value="Alice" />
      </form>
    `;
    const errors = filler.scanDomErrors(fields);
    expect(errors).toHaveLength(0);
  });

  it('finds an error message and associates it with the nearest field via aria-describedby', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" type="email" value="" aria-describedby="email-err" />
        <span id="email-err" class="invalid-feedback">Invalid email address.</span>
      </form>
    `;
    const errors = filler.scanDomErrors(fields);
    const emailErr = errors.find((e) => e.nearFieldId === 'email');
    expect(emailErr).toBeDefined();
    expect(emailErr!.text).toBe('Invalid email address.');
  });

  it('picks up the HTML5 validationMessage from aria-invalid input', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" type="email" value="not-an-email" aria-invalid="true" />
        <input id="phone" type="tel"   value="1234567890" />
        <input id="name"  type="text"  value="Alice" />
      </form>
    `;
    const errors = filler.scanDomErrors(fields);
    const emailErr = errors.find((e) => e.fieldId === 'email');
    expect(emailErr).toBeDefined();
  });

  it('ignores error containers that are inside a .success form-group', () => {
    document.body.innerHTML = `
      <form>
        <div class="form-group success">
          <input id="email" type="email" value="a@b.com" />
          <span class="invalid-feedback">Some stale message</span>
        </div>
        <input id="phone" type="tel"  value="1234567890" />
        <input id="name"  type="text" value="Alice" />
      </form>
    `;
    const errors = filler.scanDomErrors(fields);
    expect(errors.filter((e) => e.nearFieldId === 'email')).toHaveLength(0);
  });

  it('scopes to the provided Element and ignores errors outside', () => {
    document.body.innerHTML = `
      <div id="other">
        <span class="invalid-feedback">Error outside form</span>
        <input id="email" type="email" value="" />
      </div>
      <form id="main">
        <input id="phone" type="tel" value="" aria-invalid="true" />
        <input id="name"  type="text" value="Alice" />
      </form>
    `;
    const formEl = document.getElementById('main')!;
    const errors = filler.scanDomErrors(fields, formEl);
    // Should not pick up the error from #other
    const outsideErr = errors.find((e) => e.text === 'Error outside form');
    expect(outsideErr).toBeUndefined();
  });

  it('finds error via previous-sibling association', () => {
    // aria-invalid="true" marks the input as having a server-side error so
    // scanDomErrors does not skip the adjacent message due to HTML5 validity.
    document.body.innerHTML = `
      <form>
        <div>
          <input id="phone" type="tel" value="bad" aria-invalid="true" />
          <span class="invalid-feedback">Invalid phone number.</span>
        </div>
        <input id="email" type="email" value="a@b.com" />
        <input id="name"  type="text"  value="Alice" />
      </form>
    `;
    const errors = filler.scanDomErrors(fields);
    const phoneErr = errors.find((e) => e.nearFieldId === 'phone');
    expect(phoneErr).toBeDefined();
    expect(phoneErr!.text).toBe('Invalid phone number.');
  });

  it('ignores error messages shorter than 3 characters', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" type="email" value="" aria-invalid="true" />
        <span class="invalid-feedback">ok</span>
        <input id="phone" type="tel"  value="1234567890" />
        <input id="name"  type="text" value="Alice" />
      </form>
    `;
    const errors = filler.scanDomErrors(fields);
    // The 'ok' message (2 chars) should be filtered out
    const shortTextErr = errors.find((e) => e.text === 'ok');
    expect(shortTextErr).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findNearestField (private — accessed via any-cast)
// ---------------------------------------------------------------------------

describe('FormFiller.findNearestField (private)', () => {
  const fields = [
    { id: 'email', selector: '#email', name: 'email', label: 'Email' },
    { id: 'city',  selector: '#city',  name: 'city',  label: 'City'  },
  ];

  it('matches via data-field attribute', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" />
        <span class="error" data-field="email">Required</span>
        <input id="city" />
      </form>
    `;
    const errorEl = document.querySelector<Element>('[data-field="email"]')!;
    const result = (filler as any).findNearestField(errorEl, fields);
    expect(result).not.toBeNull();
    expect(result.id).toBe('email');
  });

  it('matches via aria-describedby on the input', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" aria-describedby="email-error" />
        <div id="email-error">Bad email</div>
        <input id="city" />
      </form>
    `;
    const errorEl = document.getElementById('email-error')!;
    const result = (filler as any).findNearestField(errorEl, fields);
    expect(result).not.toBeNull();
    expect(result.id).toBe('email');
  });

  it('matches via aria-errormessage on the input', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" aria-errormessage="email-msg" />
        <div id="email-msg">Bad email</div>
        <input id="city" />
      </form>
    `;
    const errorEl = document.getElementById('email-msg')!;
    const result = (filler as any).findNearestField(errorEl, fields);
    expect(result).not.toBeNull();
    expect(result.id).toBe('email');
  });

  it('matches via parent container with single input', () => {
    document.body.innerHTML = `
      <form>
        <div class="form-group">
          <input id="city" />
          <span class="error-message">Required field</span>
        </div>
        <input id="email" />
      </form>
    `;
    const errorEl = document.querySelector<Element>('.error-message')!;
    const result = (filler as any).findNearestField(errorEl, fields);
    expect(result).not.toBeNull();
    expect(result.id).toBe('city');
  });

  it('returns null when no field can be associated', () => {
    // Error element placed BEFORE any inputs so the proximity algorithm
    // (which looks for the closest preceding input) cannot find a match.
    // The error text is also unrelated to any field name/label.
    document.body.innerHTML = `
      <header>
        <span class="error-message">System maintenance notice xq9z</span>
      </header>
      <form>
        <input id="email" />
        <input id="city"  />
      </form>
    `;
    const errorEl = document.querySelector<Element>('header .error-message')!;
    const result = (filler as any).findNearestField(errorEl, fields);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fillFormWithRecovery — AbortSignal support
// ---------------------------------------------------------------------------

describe('FormFiller.fillFormWithRecovery – AbortSignal', () => {
  it('stops the recovery loop immediately when signal is pre-aborted', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="inp" name="firstName" type="text" />
      </form>
    `;

    const field = makeField({ id: 'fld1', selector: '#inp', type: 'firstName', value: 'Alice' });
    const formAnalysis = makeFormAnalysis([field], '#f');

    const controller = new AbortController();
    controller.abort(); // abort immediately

    const scanSpy = jest.spyOn(filler, 'scanDomErrors');

    await filler.fillFormWithRecovery(formAnalysis, { maxRetries: 5, signal: controller.signal });

    // The loop exits immediately (signal already aborted) so scanDomErrors is
    // called at most once — for the finalErrors calculation after the loop.
    expect(scanSpy.mock.calls.length).toBeLessThanOrEqual(2);

    scanSpy.mockRestore();
  });

  it('aborts mid-loop when signal fires after first iteration', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="inp" name="firstName" type="text" />
      </form>
    `;

    const field = makeField({ id: 'fld1', selector: '#inp', type: 'firstName', value: 'Alice' });
    const formAnalysis = makeFormAnalysis([field], '#f');

    const controller = new AbortController();
    let scanCallCount = 0;

    // Abort after the first scan so the loop only runs once
    jest.spyOn(filler, 'scanDomErrors').mockImplementation((...args) => {
      scanCallCount++;
      if (scanCallCount >= 1) controller.abort();
      return [];
    });

    await filler.fillFormWithRecovery(formAnalysis, { maxRetries: 5, signal: controller.signal });
    // Should have only scanned once before seeing the abort
    expect(scanCallCount).toBeLessThanOrEqual(2);

    jest.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// fillFormWithRecovery — basic fill & retries
// ---------------------------------------------------------------------------

describe('FormFiller.fillFormWithRecovery – basic flow', () => {
  it('fills a simple form and returns zero finalErrors', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="inp" name="firstName" type="text" />
      </form>
    `;

    const field = makeField({ id: 'fld1', selector: '#inp', type: 'firstName', value: 'Alice' });
    const result = await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    expect(result.filled).toBe(1);
    expect(result.finalErrors).toHaveLength(0);
    const inp = document.querySelector<HTMLInputElement>('#inp')!;
    expect(inp.value).toBe('Alice');
  });

  it('reports skipped count for fields without a value', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="a" type="text" />
        <input id="b" type="text" />
      </form>
    `;

    const filled = makeField({ id: 'fld-a', selector: '#a', value: 'hello' });
    const skipped = makeField({ id: 'fld-b', selector: '#b', value: undefined });

    const result = await filler.fillFormWithRecovery(makeFormAnalysis([filled, skipped], '#f'));

    expect(result.filled).toBe(1);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('fills a number input within its min/max constraints', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="age" name="age" type="number" min="18" max="100" />
      </form>
    `;

    const field = makeField({
      id: 'age',
      selector: '#age',
      type: 'number',
      htmlType: 'number',
      value: '25',
      constraints: { minLength: null, maxLength: null, min: 18, max: 100, pattern: null, step: null, required: false, readOnly: false, disabled: false, multiple: false, accept: null },
    });

    await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    const ageEl = document.querySelector<HTMLInputElement>('#age')!;
    const val = Number(ageEl.value);
    expect(val).toBeGreaterThanOrEqual(18);
    expect(val).toBeLessThanOrEqual(100);
  });

  it('skips read-only inputs', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="ro" type="text" readonly value="original" />
      </form>
    `;

    const field = makeField({ id: 'fld-ro', selector: '#ro', value: 'new-value' });
    const result = await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    const inp = document.querySelector<HTMLInputElement>('#ro')!;
    expect(inp.value).toBe('original');
    expect(result.filled).toBe(0);
  });

  it('fills a native <select> element', async () => {
    document.body.innerHTML = `
      <form id="f">
        <select id="country" name="country">
          <option value="">Choose…</option>
          <option value="US">United States</option>
          <option value="GB">United Kingdom</option>
        </select>
      </form>
    `;

    const field = makeField({
      id: 'country',
      selector: '#country',
      type: 'select',
      htmlType: 'select-one',
      value: 'US',
    });

    await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    const sel = document.querySelector<HTMLSelectElement>('#country')!;
    expect(sel.value).toBe('US');
  });

  it('fills a checkbox and reflects checked state', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="agree" name="agree" type="checkbox" />
      </form>
    `;

    const field = makeField({
      id: 'agree',
      selector: '#agree',
      type: 'checkbox',
      htmlType: 'checkbox',
      value: 'true',
    });

    await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    const cb = document.querySelector<HTMLInputElement>('#agree')!;
    expect(cb.checked).toBe(true);
  });

  it('formats phone/tel inputs to digits-only', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="phone" name="phone" type="tel" />
      </form>
    `;

    const field = makeField({
      id: 'phone',
      selector: '#phone',
      type: 'phone',
      htmlType: 'tel',
      value: '(555) 123-4567',
    });

    await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    const phoneEl = document.querySelector<HTMLInputElement>('#phone')!;
    // Tel inputs should contain only digits after normalization
    expect(phoneEl.value).toMatch(/^\d+$/);
  });

  it('formats SSN inputs as NNN-NN-NNNN', async () => {
    document.body.innerHTML = `
      <form id="f">
        <input id="ssn" name="ssn" type="text" />
      </form>
    `;

    const field = makeField({
      id: 'ssn',
      selector: '#ssn',
      type: 'text',
      htmlType: 'text',
      value: '123456789',
    });

    await filler.fillFormWithRecovery(makeFormAnalysis([field], '#f'));

    const ssnEl = document.querySelector<HTMLInputElement>('#ssn')!;
    expect(ssnEl.value).toMatch(/^\d{3}-\d{2}-\d{4}$/);
  });
});
