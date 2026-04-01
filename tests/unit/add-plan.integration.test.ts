import { FormDetectionEngine } from '@/content/form-detection';
import { FormFiller } from '@/content/form-filler';
import { DataGenerator } from '@/background/data-generator';
import type { FormAnalysis } from '@/shared/types';
import { deepClone } from '@/shared/utils';

// Helper: build a multiselect option <li> with the same structure as the real form
function msOption(id: number, name: string, selected = false): string {
  const cls = selected ? 'multiselect__option multiselect__option--selected' : 'multiselect__option';
  return `<li id="null-${id}" role="option" class="multiselect__element"><span data-select="" data-selected="" data-deselect="" class="${cls}"><div><div class="d-flex align-items-center gap-2"><div class="option-logo-wrap"><img src="logo.svg" class="img-fluid"></div><div style="max-width:60px; margin-left:4px"><span class="" style="word-break: break-all; max-width:60px">${name}</span></div></div></div></span></li>`;
}

const CARRIERS = ['Aetna', 'Aflac', 'CIGNA', 'BlueCross BlueShield', 'United Health Care', 'Humana', 'Guardian', 'Oxford', 'Prudential'];

const FORM_HTML = `<form data-v-04a59150=""><div data-v-2de8c56e="" data-v-04a59150=""><div data-v-2de8c56e="" class="form-group row"><div data-v-2de8c56e="" class="col-xxl-4 col-xl-4 col-lg-4 col-md-6 col-sm-6 col-12 mb-4"><span><label><span data-v-b5b96d8e="" data-v-2de8c56e=""><button data-v-b5b96d8e="" id="plan-name-popover" class="popover-btn"><i data-v-b5b96d8e="" class="fa fa-info" aria-hidden="true"></i></button><!----></span> Plan Name <span class="required-indc"> * </span></label><div class="input-icon"><input id="planName" placeholder="Enter Plan Name" type="text" class="custom-field" state="true"></div><!----></span></div><div data-v-2de8c56e="" class="col-xxl-4 col-xl-4 col-lg-4 col-md-6 col-sm-6 col-12 mb-4"><span><label><span data-v-b5b96d8e="" data-v-2de8c56e=""><button data-v-b5b96d8e="" id="plan-code-popover" class="popover-btn"><i data-v-b5b96d8e="" class="fa fa-info" aria-hidden="true"></i></button><!----></span> Plan Code <span class="required-indc"> * </span></label><div class="input-icon"><input id="planCode" placeholder="Enter Plan Code" type="text" class="custom-field" state="true"></div><!----></span></div><div data-v-2de8c56e="" class="col-xxl-4 col-xl-4 col-lg-4 col-md-6 col-sm-6 col-12 mb-4"><span><label><span data-v-b5b96d8e="" data-v-2de8c56e=""><button data-v-b5b96d8e="" id="plan-group-popover" class="popover-btn"><i data-v-b5b96d8e="" class="fa fa-info" aria-hidden="true"></i></button><!----></span> Plan Group Name <span class="required-indc"> * </span></label><div class="input-icon"><input id="planGroupName" placeholder="Enter Plan Group Name" type="text" class="custom-field error-input"></div><div data-v-706239fa="" class="text-error"><small data-v-706239fa="">This field is required</small></div></span></div><div data-v-2de8c56e="" class="col-xxl-4 col-xl-4 col-lg-4 col-md-6 col-sm-6 col-12 mb-4" use-custom-template="true" id="plan-carrier-dropdown"><span><label><span data-v-b5b96d8e="" data-v-2de8c56e=""><button data-v-b5b96d8e="" id="carrier-popover" class="popover-btn"><i data-v-b5b96d8e="" class="fa fa-info" aria-hidden="true"></i></button><!----></span> Carrier  <span class="required-indc"> * </span></label><div tabindex="-1" role="combobox" aria-owns="listbox-null" class="multiselect multiselect--above" state="true"><div class="multiselect__select"></div>  <div class="multiselect__tags"><div class="multiselect__tags-wrap" style="display: none;"></div> <!----> <div class="multiselect__spinner" style="display: none;"></div> <input name="" type="text" autocomplete="off" spellcheck="false" placeholder="Select Carrier " tabindex="0" aria-controls="listbox-null" class="multiselect__input" style="width: 0px; position: absolute; padding: 0px;" aria-activedescendant="null-0"> <span class="multiselect__single">AFLCIO</span> <!----></div> <div tabindex="-1" class="multiselect__content-wrapper" style="max-height: 300px; display: none;"><ul role="listbox" id="listbox-null" class="multiselect__content" style="display: inline-block;"> <!----> ${CARRIERS.map((c, i) => msOption(i, c, c === 'CIGNA')).join('')} <li style="display: none;"><span class="multiselect__option">No elements found. Consider changing the search query.</span></li> <li style="display: none;"><span class="multiselect__option">List is empty.</span></li> </ul></div></div><!----><!----></span></div><div data-v-2de8c56e="" class="col-xxl-4 col-xl-4 col-lg-4 col-md-12 col-sm-12 col-12 mb-4"><span><label><span data-v-b5b96d8e="" data-v-2de8c56e=""><button data-v-b5b96d8e="" id="carrier-plan-popover" class="popover-btn"><i data-v-b5b96d8e="" class="fa fa-info" aria-hidden="true"></i></button><!----></span> Carrier Plan Name <span class="required-indc"> * </span></label><div class="input-icon"><input id="carrierPlanName" placeholder="Enter Carrier Plan Name" type="text" class="custom-field"></div><!----></span></div><div data-v-2de8c56e="" class="col-xxl-4 col-xl-4 col-lg-4 col-md-12 col-sm-12 col-12 mb-4"><span><label><span data-v-b5b96d8e="" data-v-2de8c56e=""><button data-v-b5b96d8e="" id="carrier-plan-code-popover" class="popover-btn"><i data-v-b5b96d8e="" class="fa fa-info" aria-hidden="true"></i></button><!----></span> Carrier Plan Code <span class="required-indc"> * </span></label><div class="input-icon"><input id="carrierPlanCode" placeholder="Enter Carrier Plan Code" type="text" class="custom-field"></div><!----></span></div></div></div><!----><div data-v-04a59150="" class="plan-form-footer"><div data-v-04a59150="" class="footer-step-indicator"><span data-v-04a59150="" class="step-info"><strong data-v-04a59150="">Steps:</strong> <span data-v-04a59150="" class="current-step">1</span> of 4 </span></div><div data-v-04a59150="" class="footer-button-group"><!----><button data-v-04a59150="" class="btn-action-next"> Continue </button></div></div></form>`;

describe('Add-plan form detection fixture', () => {
  beforeEach(() => {
    document.body.innerHTML = FORM_HTML;
  });

  test('detects six input fields on the add-plan form', () => {
    const engine = new FormDetectionEngine();
    const forms = engine.detectForms();
    expect(forms.length).toBeGreaterThanOrEqual(1);
    const f = forms[0];
    // Expect six logical fields
    expect(f.fields.length).toBe(6);
    // Ensure carrier multiselect produced an entry (label should include 'Carrier')
    const carrierField = f.fields.find((fld) => /carrier/i.test(fld.label) && fld.type === 'select');
    expect(carrierField).toBeTruthy();
    expect(carrierField!.type).toBe('select');
    // Should have extracted real carrier options (not placeholder text)
    expect(carrierField!.constraints.options).toBeDefined();
    expect(carrierField!.constraints.options!.length).toBeGreaterThanOrEqual(CARRIERS.length);
    // Placeholder messages should be filtered out
    const hasPlaceholder = carrierField!.constraints.options!.some(
      (o) => /no elements found|list is empty/i.test(o.value),
    );
    expect(hasPlaceholder).toBe(false);
  });

  test('detects correct labels for all fields', () => {
    const engine = new FormDetectionEngine();
    const forms = engine.detectForms();
    const f = forms[0];
    const labels = f.fields.map((fld) => fld.label);
    // Each label should be clean (no * or popover button text)
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringMatching(/Plan Name/),
      expect.stringMatching(/Plan Code/),
      expect.stringMatching(/Plan Group Name/),
      expect.stringMatching(/Carrier/),
      expect.stringMatching(/Carrier Plan Name/),
      expect.stringMatching(/Carrier Plan Code/),
    ]));
  });

  test('data generator produces values for all six fields', () => {
    const engine = new FormDetectionEngine();
    const forms = engine.detectForms();
    const f = forms[0];
    const gen = new DataGenerator({ locale: 'en-US' });
    const map = gen.generateForForm(f.fields, false);
    expect(map.size).toBe(6);

    // Validate each field gets a contextually appropriate value
    for (const field of f.fields) {
      const value = map.get(field.id);
      expect(value).toBeDefined();
      expect(value!.length).toBeGreaterThan(0);

      const label = (field.label || '').toLowerCase();
      if (/plan code|carrier plan code/.test(label)) {
        // Should be alphanumeric varchar (e.g., "AB0042")
        expect(value).toMatch(/^[A-Z]+\d+$/);
      } else if (/plan group/i.test(label)) {
        // Should be a group label
        expect(['Individual', 'Family', 'Employee Only', 'Employee + Spouse',
          'Corporate', 'Small Business', 'Association', 'Medicare', 'Senior', 'Young Adult',
        ]).toContain(value);
      } else if (/carrier\s*$/i.test(label.replace(/\s*\*\s*$/, '').trim())) {
        // Carrier dropdown — should be one of the actual carrier names
        expect(CARRIERS).toContain(value);
      } else if (/carrier plan name/i.test(label)) {
        // Should be a carrier-plan name like "BlueCross Gold PPO"
        expect(value!.split(' ').length).toBeGreaterThanOrEqual(2);
      } else if (/plan name/i.test(label)) {
        // Should be a plan name like "Premium Health Plan"
        expect(value!.split(' ').length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test('filler sets values for all six fields in the DOM', async () => {
    const engine = new FormDetectionEngine();
    const forms = engine.detectForms();
    const f = forms[0];
    const gen = new DataGenerator({ locale: 'en-US' });
    const fieldValues = gen.generateForForm(f.fields, false);

    // Merge generated values into form analysis (same as message-handler does)
    const enriched: FormAnalysis = deepClone(f);
    for (const field of enriched.fields) {
      const generated = fieldValues.get(field.id);
      if (generated !== undefined) field.value = generated;
    }

    const filler = new FormFiller();
    const result = await filler.fillForm(enriched);

    // All 6 should be filled (none skipped due to missing values or selectors)
    expect(result.filled).toBe(6);
    expect(result.skipped).toBe(0);

    // Verify text inputs actually have values in the DOM
    const planName = document.querySelector<HTMLInputElement>('#planName');
    expect(planName?.value).toBeTruthy();

    const planCode = document.querySelector<HTMLInputElement>('#planCode');
    expect(planCode?.value).toBeTruthy();
    expect(planCode!.value).toMatch(/^[A-Z]+\d+$/);

    const planGroupName = document.querySelector<HTMLInputElement>('#planGroupName');
    expect(planGroupName?.value).toBeTruthy();

    const carrierPlanName = document.querySelector<HTMLInputElement>('#carrierPlanName');
    expect(carrierPlanName?.value).toBeTruthy();

    const carrierPlanCode = document.querySelector<HTMLInputElement>('#carrierPlanCode');
    expect(carrierPlanCode?.value).toBeTruthy();
    expect(carrierPlanCode!.value).toMatch(/^[A-Z]+\d+$/);
  });

  test('fillTextInput fires compositionend, InputEvent with data, and direct assignment', async () => {
    const engine = new FormDetectionEngine();
    const forms = engine.detectForms();
    const f = forms[0];
    const gen = new DataGenerator({ locale: 'en-US' });
    const fieldValues = gen.generateForForm(f.fields, false);

    const enriched: FormAnalysis = deepClone(f);
    for (const field of enriched.fields) {
      const generated = fieldValues.get(field.id);
      if (generated !== undefined) field.value = generated;
    }

    // Track events fired on the planName input
    const planNameEl = document.querySelector<HTMLInputElement>('#planName')!;
    const events: Array<{ type: string; data?: string | null; inputType?: string }> = [];
    planNameEl.addEventListener('compositionend', (e) => {
      events.push({ type: 'compositionend', data: (e as CompositionEvent).data });
    });
    planNameEl.addEventListener('input', (e) => {
      events.push({ type: 'input', data: (e as InputEvent).data, inputType: (e as InputEvent).inputType });
    });
    planNameEl.addEventListener('change', () => events.push({ type: 'change' }));
    planNameEl.addEventListener('blur', () => events.push({ type: 'blur' }));

    // Spy on direct value assignment (Vue/Angular reactivity path)
    let directAssignmentValue: string | null = null;
    const origDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    const origSet = origDescriptor.set!;
    Object.defineProperty(planNameEl, 'value', {
      get() { return origDescriptor.get!.call(this); },
      set(v: string) {
        directAssignmentValue = v;
        origSet.call(this, v);
      },
      configurable: true,
    });

    const filler = new FormFiller();
    await filler.fillForm(enriched);

    // Verify direct assignment happened (critical for Vue/Angular)
    expect(directAssignmentValue).toBeTruthy();
    expect(planNameEl.value).toBe(directAssignmentValue);

    // Verify compositionend was fired (critical for Vue 2 IME handling)
    expect(events.some((e) => e.type === 'compositionend')).toBe(true);

    // Verify InputEvent had data and inputType (critical for Vue 3)
    const inputEvt = events.find((e) => e.type === 'input');
    expect(inputEvt).toBeDefined();
    expect(inputEvt!.data).toBeTruthy();
    expect(inputEvt!.inputType).toBe('insertText');

    // Verify correct event order: compositionend → input → change → blur
    const ordered = events.map((e) => e.type);
    const compIdx = ordered.indexOf('compositionend');
    const inputIdx = ordered.indexOf('input');
    const changeIdx = ordered.indexOf('change');
    const blurIdx = ordered.indexOf('blur');
    expect(compIdx).toBeLessThan(inputIdx);
    expect(inputIdx).toBeLessThan(changeIdx);
    expect(changeIdx).toBeLessThan(blurIdx);
  });
});
