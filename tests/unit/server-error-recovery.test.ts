/**
 * Tests the server-side error recovery flow:
 * 1. Field is filled with a value the server rejects
 * 2. Server returns error → DOM shows .text-error + input gets error-input class
 * 3. Recovery loop detects the error despite HTML5 validity.valid being true
 * 4. Local fix generates alphanumeric value for "code" fields
 */
import { FormFiller } from '../../src/content/form-filler';
import { ErrorRecoveryEngine } from '../../src/background/error-recovery';
import { DataGenerator } from '../../src/background/data-generator';
import type { FormAnalysis } from '../../src/shared/types';

describe('Server-side error recovery for plan code', () => {
  let filler: FormFiller;

  beforeEach(() => {
    filler = new FormFiller();
    // Set up the exact DOM structure from the user's app
    document.body.innerHTML = `
      <form id="planForm">
        <div class="col-xxl-4 col-xl-4 col-lg-4 col-md-6 col-sm-6 col-12 mb-4">
          <span>
            <label>Plan Code <span class="required-indc"> * </span></label>
            <div class="input-icon">
              <input id="planCode" name="planCode" placeholder="Enter Plan Code"
                     type="text" class="custom-field error-input" />
            </div>
            <div class="text-error">
              <small>The plan code must only contain letters and numbers.</small>
            </div>
          </span>
        </div>
      </form>
    `;
  });

  it('scanDomErrors detects .text-error errors even when input.validity.valid is true', () => {
    const fields = [{
      id: 'planCode-1',
      selector: '#planCode',
      name: 'planCode',
      label: 'Plan Code',
    }];

    const errors = filler.scanDomErrors(fields);
    // Must find the error despite the input passing HTML5 validity
    expect(errors.length).toBeGreaterThan(0);
    const planCodeError = errors.find(e => e.nearFieldName === 'planCode' || e.nearFieldId === 'planCode-1');
    expect(planCodeError).toBeTruthy();
    expect(planCodeError!.text).toContain('must only contain letters and numbers');
  });

  it('fillFormWithRecovery applies local fix for alphanumeric error', async () => {
    // Pre-fill the field with a value that has special chars
    const input = document.querySelector<HTMLInputElement>('#planCode')!;
    input.value = 'Incredible-Granite_Fish!';

    const formAnalysis: FormAnalysis = {
      index: 0,
      type: 'unknown',
      fields: [{
        id: 'planCode-1',
        index: 0,
        type: 'text',
        htmlType: 'text',
        name: 'planCode',
        label: 'Plan Code',
        placeholder: 'Enter Plan Code',
        constraints: {
          minLength: null, maxLength: 10, min: null, max: null,
          pattern: null, step: null, required: true, readOnly: false,
          disabled: false, multiple: false, accept: null,
        },
        required: true,
        selector: '#planCode',
        formIndex: 0,
        value: 'Incredible-Granite_Fish!',
        confidence: 0.5,
      }],
      selector: '#planForm',
      action: '',
      method: 'POST',
      hasSubmitButton: false,
      isMultiStep: false,
      currentStep: 1,
      totalSteps: 1,
      analyzedAt: new Date().toISOString(),
    };

    const result = await filler.fillFormWithRecovery(formAnalysis, { maxRetries: 2 });

    // After recovery, the input should have an alphanumeric value
    const finalValue = input.value;
    expect(finalValue).toMatch(/^[A-Za-z0-9]+$/);
    expect(result.retries).toBeGreaterThan(0);
  });
});

describe('ERROR_PATTERNS classifies alphanumeric / letters-only errors', () => {
  it('classifies correctly', () => {
    const engine = new ErrorRecoveryEngine(new DataGenerator({ locale: 'en-US' }));
    expect(engine.classifyError('The plan code must only contain letters and numbers.')).toBe('alphanumeric');
    expect(engine.classifyError('This field can only contain alphanumeric characters')).toBe('alphanumeric');
    expect(engine.classifyError('Field should only contain letters')).toBe('lettersOnly');
  });
});
