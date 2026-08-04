/**
 * Comprehensive recovery tests covering all ErrorType classifications,
 * local fix handlers, and buildRecoveryAction strategies.
 */
import { ErrorRecoveryEngine } from '../../src/background/error-recovery';
import { DataGenerator } from '../../src/background/data-generator';
import { FormFiller } from '../../src/content/form-filler';
import type { FormAnalysis, FieldAnalysis, FieldConstraints } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const generator = new DataGenerator({ locale: 'en-US' });
const engine = new ErrorRecoveryEngine(generator);

function makeField(overrides: Partial<FieldAnalysis> = {}): FieldAnalysis {
  const defaults: FieldConstraints = {
    minLength: null, maxLength: null, min: null, max: null,
    pattern: null, step: null, required: false, readOnly: false,
    disabled: false, multiple: false, accept: null,
  };
  return {
    id: 'field-1',
    index: 0,
    type: 'text',
    htmlType: 'text',
    name: 'testField',
    label: 'Test Field',
    placeholder: '',
    required: false,
    selector: '#testField',
    formIndex: 0,
    value: '',
    confidence: 0.5,
    ...overrides,
    constraints: { ...defaults, ...(overrides.constraints ?? {}) },
  };
}

function makeFormAnalysis(fields: FieldAnalysis[]): FormAnalysis {
  return {
    index: 0,
    type: 'unknown',
    fields,
    selector: '#testForm',
    action: '',
    method: 'POST',
    hasSubmitButton: false,
    isMultiStep: false,
    currentStep: 1,
    totalSteps: 1,
    analyzedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. ERROR CLASSIFICATION – every ErrorType must be reachable
// ---------------------------------------------------------------------------

describe('classifyError covers all ErrorType values', () => {
  const cases: Array<[string, string]> = [
    // exists
    ['The email has already been taken.', 'exists'],
    ['This username is not available', 'exists'],
    ['A user with that email already exists', 'exists'],
    ['Try a different username', 'exists'],
    ['That name is already in use', 'exists'],

    // required
    ['This field is required.', 'required'],
    ['Please enter your name', 'required'],
    ["can't be blank", 'required'],
    ['must fill in this field', 'required'],
    ['This field may not be blank', 'required'],
    ['A value is required', 'required'],

    // length
    ['Must be at least 8 characters', 'length'],
    ['Maximum 255 characters allowed', 'length'],
    ['Must be between 3 and 50 characters', 'length'],
    ['Too short (minimum 6 characters)', 'length'],
    ['Value is too long', 'length'],

    // password
    ['Password must contain at least one uppercase letter', 'password'],
    ['Must include a special character', 'password'],
    ['Password too weak', 'password'],
    ['Must contain a digit', 'password'],

    // email
    ['Enter a valid email address', 'email'],
    ['Invalid email format', 'email'],
    ['The email address is not valid', 'email'],
    ['not a valid email', 'email'],

    // phone
    ['Please enter a valid phone number', 'phone'],
    ['Invalid phone format', 'phone'],
    ['Not a valid telephone number', 'phone'],

    // date
    ['Please enter a valid date', 'date'],
    ['Invalid date format', 'date'],
    ['Date must be in the future', 'date'],
    ['Date cannot be in the past', 'date'],

    // pattern
    ['Value does not match the required pattern', 'pattern'],
    ['Must match the format: XXXX-XXXX', 'pattern'],

    // format
    ['Invalid format', 'format'],
    ['Invalid format — expected alphanumeric characters', 'format'],
    ['The value is not valid', 'format'],
    ['is not a valid value', 'format'],

    // number
    ['Must be a number', 'number'],
    ['Enter a valid number', 'number'],
    ['This field must be numeric', 'number'],
    ['Not a valid number', 'number'],
    ['Please enter a valid integer', 'number'],

    // url
    ['Enter a valid URL', 'url'],
    ['Not a valid URL', 'url'],
    ['Invalid website address', 'url'],

    // username
    ['Invalid username', 'username'],

    // creditCard
    ['Invalid card number', 'creditCard'],
    ['Not a valid credit card', 'creditCard'],
    ['Card number is invalid', 'creditCard'],

    // alphanumeric
    ['Must be alphanumeric', 'alphanumeric'],
    ['Only alphanumeric characters allowed', 'alphanumeric'],
    ['Must only contain letters and numbers', 'alphanumeric'],
    ['The plan code must only contain letters and numbers.', 'alphanumeric'],
    ['Username can only contain letters and numbers', 'alphanumeric'],

    // lettersOnly
    ['Only letters are allowed', 'lettersOnly'],
    ['Must contain only letters', 'lettersOnly'],
    ['Alphabetic characters only', 'lettersOnly'],
    ['Name can only contain letters', 'lettersOnly'],

    // digitsOnly
    ['Must contain only digits', 'digitsOnly'],
    ['Digits only please', 'digitsOnly'],
    ['Only numbers are allowed', 'digitsOnly'],
    // Generic "N digit X" messages that name no specific field type (no
    // zip/postal/phone keyword) must fall through to digitsOnly rather
    // than 'unknown' — and must NOT be misclassified as 'phone' just
    // because they contain "N digit".
    ['Enter 5 digit code', 'digitsOnly'],
    ['Please enter a 6 digit OTP', 'digitsOnly'],
    ['Routing number must be 9 digits', 'digitsOnly'],

    // noSpaces
    ['Spaces are not allowed', 'noSpaces'],
    ['Cannot contain spaces', 'noSpaces'],
    ['No whitespace allowed', 'noSpaces'],

    // name
    ['First name is not valid', 'name'],
    ['Last name is not valid', 'name'],

    // age
    ['Must be at least 18 years old', 'age'],
    ['Age must be between 18 and 120', 'age'],

    // zipcode
    ['Enter a valid zip code', 'zipcode'],
    ['Invalid postal code', 'zipcode'],
    ['ZIP code must be 5 digits', 'zipcode'],
    ['Enter 5 digit zip code', 'zipcode'],

    // range
    ['Value must be greater than 0', 'range'],
    ['Must be less than 100', 'range'],
    ['Value is too small', 'range'],
    ['Number is out of range', 'range'],
  ];

  it.each(cases)('"%s" → %s', (message, expectedType) => {
    expect(engine.classifyError(message)).toBe(expectedType);
  });
});

// ---------------------------------------------------------------------------
// 2. RECOVERY ACTION BUILDER – each ErrorType produces a sensible action
// ---------------------------------------------------------------------------

describe('buildRecoveryAction produces correct strategies', () => {
  it('exists → regenerate email with timestamp', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Email already taken', fieldName: 'email', fieldId: 'email-1', type: 'exists', elementSelector: '' }], affectedFields: ['email'], severity: 'high' },
      [makeField({ id: 'email-1', name: 'email', type: 'email' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields.length).toBe(1);
    expect(result.updatedFields[0].value).toContain('@');
  });

  it('required → regenerate value', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'This field is required', fieldName: 'name', fieldId: 'name-1', type: 'required', elementSelector: '' }], affectedFields: ['name'], severity: 'medium' },
      [makeField({ id: 'name-1', name: 'name', type: 'text' })],
    );
    expect(result.success).toBe(true);
  });

  it('password → regenerate strong password', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Password too weak', fieldName: 'password', fieldId: 'pw-1', type: 'password', elementSelector: '' }], affectedFields: ['password'], severity: 'medium' },
      [makeField({ id: 'pw-1', name: 'password', type: 'password' })],
    );
    expect(result.success).toBe(true);
    const pw = result.updatedFields[0]?.value;
    expect(pw).toBeDefined();
    expect(pw!.length).toBeGreaterThanOrEqual(12);
  });

  it('length → adjusts constraints from error text', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must be between 5 and 20 characters', fieldName: 'code', fieldId: 'code-1', type: 'length', elementSelector: '' }], affectedFields: ['code'], severity: 'low' },
      [makeField({ id: 'code-1', name: 'code', type: 'text' })],
    );
    expect(result.actions[0].constraints).toEqual({ minLength: 5, maxLength: 20 });
  });

  it('phone → generates pattern-aware phone', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Invalid phone number', fieldName: 'phone', fieldId: 'phone-1', type: 'phone', elementSelector: '' }], affectedFields: ['phone'], severity: 'medium' },
      [makeField({ id: 'phone-1', name: 'phone', type: 'phone', constraints: { pattern: '^\\d{3}-\\d{3}-\\d{4}$' } as any })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d{3}-\d{3}-\d{4}$/);
  });

  it('date → generates valid date', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Invalid date', fieldName: 'dob', fieldId: 'dob-1', type: 'date', elementSelector: '' }], affectedFields: ['dob'], severity: 'low' },
      [makeField({ id: 'dob-1', name: 'dob', type: 'date', label: 'Date of Birth' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('number → generates valid number', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must be a number', fieldName: 'qty', fieldId: 'qty-1', type: 'number', elementSelector: '' }], affectedFields: ['qty'], severity: 'low' },
      [makeField({ id: 'qty-1', name: 'qty', type: 'number', constraints: { min: 1, max: 50 } as any })],
    );
    expect(result.success).toBe(true);
    const num = Number(result.updatedFields[0].value);
    expect(num).toBeGreaterThanOrEqual(1);
    expect(num).toBeLessThanOrEqual(50);
  });

  it('range → generates number within range from error text', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must be at least 10', fieldName: 'score', fieldId: 'score-1', type: 'range', elementSelector: '' }], affectedFields: ['score'], severity: 'low' },
      [makeField({ id: 'score-1', name: 'score', type: 'number' })],
    );
    expect(result.success).toBe(true);
    expect(Number(result.updatedFields[0].value)).toBeGreaterThanOrEqual(10);
  });

  it('url → generates valid URL', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Enter a valid URL', fieldName: 'website', fieldId: 'url-1', type: 'url', elementSelector: '' }], affectedFields: ['website'], severity: 'low' },
      [makeField({ id: 'url-1', name: 'website', type: 'url' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^https?:\/\//);
  });

  it('username → generates username', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Invalid username', fieldName: 'user', fieldId: 'user-1', type: 'username', elementSelector: '' }], affectedFields: ['user'], severity: 'low' },
      [makeField({ id: 'user-1', name: 'user', type: 'username' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value.length).toBeGreaterThan(0);
  });

  it('creditCard → generates test card number', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Invalid card number', fieldName: 'cc', fieldId: 'cc-1', type: 'creditCard', elementSelector: '' }], affectedFields: ['cc'], severity: 'high' },
      [makeField({ id: 'cc-1', name: 'cc', type: 'creditCard' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toBe('4111111111111111');
  });

  it('alphanumeric → generates varchar', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must be alphanumeric', fieldName: 'code', fieldId: 'code-1', type: 'alphanumeric', elementSelector: '' }], affectedFields: ['code'], severity: 'low' },
      [makeField({ id: 'code-1', name: 'code', type: 'text' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('lettersOnly → generates letters-only value', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Only letters are allowed', fieldName: 'fname', fieldId: 'fn-1', type: 'lettersOnly', elementSelector: '' }], affectedFields: ['fname'], severity: 'low' },
      [makeField({ id: 'fn-1', name: 'fname', type: 'firstName' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^[a-z]+$/);
  });

  it('digitsOnly → generates digits-only value', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must contain only digits', fieldName: 'pin', fieldId: 'pin-1', type: 'digitsOnly', elementSelector: '' }], affectedFields: ['pin'], severity: 'low' },
      [makeField({ id: 'pin-1', name: 'pin', type: 'text', constraints: { maxLength: 4 } as any })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d+$/);
    expect(result.updatedFields[0].value.length).toBeLessThanOrEqual(4);
  });

  it('noSpaces → generates value without spaces', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Spaces are not allowed', fieldName: 'handle', fieldId: 'h-1', type: 'noSpaces', elementSelector: '' }], affectedFields: ['handle'], severity: 'low' },
      [makeField({ id: 'h-1', name: 'handle', type: 'text' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).not.toContain(' ');
  });

  it('age → generates age >= minimum', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must be at least 18 years old', fieldName: 'age', fieldId: 'age-1', type: 'age', elementSelector: '' }], affectedFields: ['age'], severity: 'low' },
      [makeField({ id: 'age-1', name: 'age', type: 'number' })],
    );
    expect(result.success).toBe(true);
    expect(Number(result.updatedFields[0].value)).toBeGreaterThanOrEqual(18);
  });

  it('zipcode → generates 5-digit zip', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Invalid zip code', fieldName: 'zip', fieldId: 'zip-1', type: 'zipcode', elementSelector: '' }], affectedFields: ['zip'], severity: 'low' },
      [makeField({ id: 'zip-1', name: 'zip', type: 'zipcode' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d{5}$/);
  });

  it('zipcode → honors an explicit digit count stated in the error message', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Enter 6 digit zip code', fieldName: 'zip', fieldId: 'zip-1', type: 'zipcode', elementSelector: '' }], affectedFields: ['zip'], severity: 'low' },
      [makeField({ id: 'zip-1', name: 'zip', type: 'zipcode' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d{6}$/);
  });

  it('digitsOnly → honors an explicit digit count for a generic "N digit code" message', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Enter 5 digit code', fieldName: 'otp', fieldId: 'otp-1', type: 'digitsOnly', elementSelector: '' }], affectedFields: ['otp'], severity: 'low' },
      [makeField({ id: 'otp-1', name: 'otp', type: 'text' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d{5}$/);
  });

  it('a field literally named "code" still gets a pure N-digit value when the message states one', async () => {
    // isCodeField() would otherwise force a generic letter+digit varchar
    // (e.g. "AB0423") for any field named/labeled "code" — but the message
    // explicitly asks for a 5-digit numeric value, which must win.
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Enter 5 digit code', fieldName: 'verificationCode', fieldId: 'vc-1', type: 'digitsOnly', elementSelector: '' }], affectedFields: ['verificationCode'], severity: 'low' },
      [makeField({ id: 'vc-1', name: 'verificationCode', label: 'Verification Code', type: 'text' })],
    );
    expect(result.success).toBe(true);
    expect(result.updatedFields[0].value).toMatch(/^\d{5}$/);
  });
});

// ---------------------------------------------------------------------------
// 3. LOCAL FIX HANDLERS – DOM-based heuristic fixes in fillFormWithRecovery
// ---------------------------------------------------------------------------

describe('Local fix handlers in fillFormWithRecovery', () => {
  let filler: FormFiller;

  beforeEach(() => {
    filler = new FormFiller();
  });

  function buildDom(inputHtml: string, errorHtml: string): void {
    document.body.innerHTML = `
      <form id="testForm">
        <div>
          ${inputHtml}
          <div class="text-error"><small>${errorHtml}</small></div>
        </div>
      </form>
    `;
  }

  function makeFormForLocalFix(fieldOverrides: Partial<FieldAnalysis> = {}): FormAnalysis {
    return makeFormAnalysis([makeField({
      selector: '#testInput',
      ...fieldOverrides,
    })]);
  }

  it('number: coerces non-numeric string to number', async () => {
    buildDom(
      '<input id="testInput" type="number" class="error-input" value="abc123" />',
      'Must be a number',
    );
    const form = makeFormForLocalFix({ type: 'number', htmlType: 'number' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(Number(val)).not.toBeNaN();
  });

  it('number: respects min/max from error text', async () => {
    buildDom(
      '<input id="testInput" type="number" class="error-input" value="5" />',
      'Must be greater than 10',
    );
    const form = makeFormForLocalFix({ type: 'number', htmlType: 'number' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = Number((document.querySelector('#testInput') as HTMLInputElement).value);
    expect(val).toBeGreaterThanOrEqual(10);
  });

  it('url: prepends https:// when missing', async () => {
    buildDom(
      '<input id="testInput" type="url" class="error-input" value="example.com" />',
      'Enter a valid URL',
    );
    const form = makeFormForLocalFix({ type: 'url', htmlType: 'url' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^https:\/\//);
  });

  it('date: generates past date for "cannot be in the future"', async () => {
    buildDom(
      '<input id="testInput" type="date" class="error-input" value="2099-01-01" />',
      'Date cannot be in the future',
    );
    const form = makeFormForLocalFix({ type: 'date', htmlType: 'date', label: 'Start Date' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(new Date(val).getTime()).toBeLessThan(Date.now());
  });

  it('date: generates 18+ birthdate when age restriction mentioned', async () => {
    buildDom(
      '<input id="testInput" type="date" class="error-input" value="2020-01-01" />',
      'Must be at least 18 years old',
    );
    const form = makeFormForLocalFix({ type: 'birthdate', htmlType: 'date', label: 'Date of Birth' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    const age = (Date.now() - new Date(val).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    expect(age).toBeGreaterThanOrEqual(18);
  });

  it('password: strengthens weak password', async () => {
    buildDom(
      '<input id="testInput" type="password" class="error-input" value="abc" />',
      'Password must contain at least one uppercase letter and one digit',
    );
    const form = makeFormForLocalFix({ type: 'password', htmlType: 'password', label: 'Password' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val.length).toBeGreaterThanOrEqual(8);
    expect(/[A-Z]/.test(val)).toBe(true);
    expect(/\d/.test(val)).toBe(true);
  });

  it('email: adds @domain when missing @', async () => {
    buildDom(
      '<input id="testInput" type="email" class="error-input" value="john.doe" />',
      'Enter a valid email address',
    );
    const form = makeFormForLocalFix({ type: 'email', htmlType: 'email', label: 'Email' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toContain('@');
  });

  it('email: regenerates with timestamp for "already taken"', async () => {
    buildDom(
      '<input id="testInput" type="email" class="error-input" value="user@test.com" />',
      'This email has already been taken',
    );
    const form = makeFormForLocalFix({ type: 'email', htmlType: 'email', label: 'Email' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toContain('@');
    expect(val).not.toBe('user@test.com');
  });

  it('username: adds suffix for uniqueness error', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="johndoe" />',
      'Username is not available',
    );
    const form = makeFormForLocalFix({ type: 'username', htmlType: 'text', name: 'username', label: 'Username' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/johndoe\d+/);
  });

  it('zipcode: fixes digit count', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="123" />',
      'ZIP code must be 5 digits',
    );
    const form = makeFormForLocalFix({ type: 'zipcode', htmlType: 'text', name: 'zip', label: 'ZIP Code' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^\d{3,5}/);
  });

  it('a field named "code" gets a pure N-digit value (not letters+digits) when the message states a digit count', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="ab" />',
      'Enter 5 digit code',
    );
    const form = makeFormForLocalFix({ type: 'text', htmlType: 'text', name: 'verificationCode', label: 'Verification Code' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^\d{5}$/);
  });

  it('no spaces: strips all whitespace', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="hello world test" />',
      'Spaces are not allowed',
    );
    const form = makeFormForLocalFix({ type: 'text', htmlType: 'text' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).not.toContain(' ');
  });

  it('letters only: strips digits from name field', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="John123" />',
      'Only letters are allowed',
    );
    const form = makeFormForLocalFix({ type: 'firstName', htmlType: 'text', label: 'First Name' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^[A-Za-z\s'-]+$/);
  });

  it('digits only: strips non-digits', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="abc123def" />',
      'Must contain only digits',
    );
    const form = makeFormForLocalFix({ type: 'text', htmlType: 'text' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^\d+$/);
  });

  it('credit card: strips formatting chars', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="4111-1111-1111-1111" />',
      'Invalid card number',
    );
    const form = makeFormForLocalFix({ type: 'creditCard', htmlType: 'text', name: 'cardNumber', label: 'Card Number' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^\d{12,19}$/);
  });

  it('length too long: trims to max from error text', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="abcdefghijklmnop" />',
      'Maximum 10 characters allowed',
    );
    const form = makeFormForLocalFix({ type: 'text', htmlType: 'text' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val.length).toBeLessThanOrEqual(10);
  });

  it('length too short: pads to minimum', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="ab" />',
      'Must be at least 5 characters',
    );
    const form = makeFormForLocalFix({ type: 'text', htmlType: 'text' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val.length).toBeGreaterThanOrEqual(5);
  });

  it('credit card expiry: generates MM/YY format', async () => {
    buildDom(
      '<input id="testInput" type="text" class="error-input" value="1225" />',
      'Invalid expiry date',
    );
    const form = makeFormForLocalFix({ type: 'creditCardExpiry', htmlType: 'text', label: 'Expiry' });
    await filler.fillFormWithRecovery(form, { maxRetries: 1 });
    const val = (document.querySelector('#testInput') as HTMLInputElement).value;
    expect(val).toMatch(/^\d{2}\/\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// 4. SEVERITY CLASSIFICATION
// ---------------------------------------------------------------------------

describe('calculateSeverity', () => {
  it('exists errors are high severity', () => {
    const info = engine.analyzeErrors([{ selector: '.err', text: 'Email already taken' }]);
    expect(info.severity).toBe('high');
  });

  it('creditCard errors are high severity', () => {
    const info = engine.analyzeErrors([{ selector: '.err', text: 'Invalid card number' }]);
    expect(info.severity).toBe('high');
  });

  it('required errors are medium severity', () => {
    const info = engine.analyzeErrors([{ selector: '.err', text: 'This field is required' }]);
    expect(info.severity).toBe('medium');
  });

  it('length errors are low severity', () => {
    const info = engine.analyzeErrors([{ selector: '.err', text: 'Must be at least 5 characters' }]);
    expect(info.severity).toBe('low');
  });
});

// ---------------------------------------------------------------------------
// 5. PARSE RANGE/LENGTH HINTS
// ---------------------------------------------------------------------------

describe('parseLengthHint and parseRangeHint via recovery', () => {
  it('extracts between X and Y from length error', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Must be between 3 and 50 characters', fieldName: 'f', fieldId: 'f-1', type: 'length', elementSelector: '' }], affectedFields: ['f'], severity: 'low' },
      [makeField({ id: 'f-1' })],
    );
    expect(result.actions[0].constraints).toEqual({ minLength: 3, maxLength: 50 });
  });

  it('extracts at least N from range error', async () => {
    const result = await engine.recover(
      { hasError: true, messages: [{ text: 'Value must be greater than 5', fieldName: 'n', fieldId: 'n-1', type: 'range', elementSelector: '' }], affectedFields: ['n'], severity: 'low' },
      [makeField({ id: 'n-1', type: 'number' })],
    );
    expect(Number(result.updatedFields[0].value)).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 6. INITIAL FILL — leading zeros must survive on digit-string fields
// ---------------------------------------------------------------------------

describe('fillField preserves leading zeros on digit-string fields', () => {
  it('does not strip leading zeros from a ZIP field with inputmode="numeric"', async () => {
    document.body.innerHTML = '<input id="zipInput" name="zip" inputmode="numeric" />';
    const filler = new FormFiller();
    const el = document.querySelector('#zipInput') as HTMLInputElement;
    const field = makeField({ id: 'zip-1', name: 'zip', type: 'zipcode', htmlType: 'text', value: '00034' });

    await filler.fillField(el, field);

    expect(el.value).toBe('00034');
  });

  it('does not strip leading zeros from a phone field with inputmode="numeric"', async () => {
    document.body.innerHTML = '<input id="phoneInput" name="phone" type="tel" inputmode="numeric" />';
    const filler = new FormFiller();
    const el = document.querySelector('#phoneInput') as HTMLInputElement;
    const field = makeField({ id: 'phone-1', name: 'phone', type: 'phone', htmlType: 'tel', value: '0526234601' });

    await filler.fillField(el, field);

    expect(el.value).toBe('0526234601');
  });
});

// ---------------------------------------------------------------------------
// 7. RECOVERY must not trust native HTML5 validity over a visible custom error
// ---------------------------------------------------------------------------

describe('scanDomErrors and recovery trust a visible custom-validated error over HTML5 validity', () => {
  it('scanDomErrors reports an error even when the input has none of the recognized error classes', () => {
    document.body.innerHTML = `
      <div class="grp">
        <input id="zipInput" name="zip" type="text" value="12" />
        <div role="alert">Enter 5 digit zip code</div>
      </div>
    `;
    const filler = new FormFiller();
    const fields = [{ id: 'zip-1', selector: '#zipInput', name: 'zip', label: 'Zip' }];

    const errors = filler.scanDomErrors(fields);

    expect(errors.some((e) => e.nearFieldId === 'zip-1')).toBe(true);
  });

  it('fillFormWithRecovery re-fills a field flagged with an error despite HTML5 validity being true', async () => {
    document.body.innerHTML = `
      <div class="grp">
        <input id="zipInput" name="zip" type="text" value="12" />
        <div role="alert">Enter 5 digit zip code</div>
      </div>
    `;
    (global as any).chrome.runtime.sendMessage = jest.fn(async () => ({ success: false, error: 'no background' }));

    const filler = new FormFiller();
    const field = makeField({
      id: 'zip-1', name: 'zip', label: 'Zip', type: 'zipcode', htmlType: 'text',
      selector: '#zipInput', value: '12',
    });
    const form = makeFormAnalysis([field]);

    await filler.fillFormWithRecovery(form, { maxRetries: 2 });

    const finalValue = (document.querySelector('#zipInput') as HTMLInputElement).value;
    expect(finalValue).toMatch(/^\d{5}$/);
  });
});

// ---------------------------------------------------------------------------
// 8. RECOVERY must not let one background-resolved field starve the others
// ---------------------------------------------------------------------------

describe('fillFormWithRecovery merges local fixes with a partial background recovery', () => {
  it('still applies a local fix to a field the background did not resolve this round', async () => {
    document.body.innerHTML = `
      <form id="f">
        <div class="grp">
          <input id="ssnInput" name="ssn" type="text" value="123456789" />
          <div role="alert">SSN must be in format NNN-NN-NNNN</div>
        </div>
        <div class="grp">
          <input id="zipInput" name="zip" type="text" value="12" />
          <div role="alert">Enter 5 digit zip code</div>
        </div>
      </form>
    `;

    // Simulate the background resolving ONLY the zip field this round —
    // the SSN field's error is left for local heuristics to fix.
    (global as any).chrome.runtime.sendMessage = jest.fn(async (msg: { action: string }) => {
      if (msg.action === 'DETECT_ERRORS') {
        return {
          success: true,
          data: {
            errorInfo: { hasError: true, messages: [], affectedFields: [], severity: 'low' },
            recovery: {
              success: true,
              actions: [],
              updatedFields: [{ field: 'zip-1', value: '54321' }],
              requiresManualIntervention: false,
            },
          },
        };
      }
      return { success: false, error: 'unhandled' };
    });

    const fields = [
      makeField({ id: 'ssn-1', name: 'ssn', label: 'SSN', type: 'text', htmlType: 'text', selector: '#ssnInput', value: '123456789' }),
      makeField({ id: 'zip-1', name: 'zip', label: 'Zip', type: 'zipcode', htmlType: 'text', selector: '#zipInput', value: '12' }),
    ];
    const form = makeFormAnalysis(fields);

    const filler = new FormFiller();
    await filler.fillFormWithRecovery(form, { maxRetries: 2 });

    const ssnVal = (document.querySelector('#ssnInput') as HTMLInputElement).value;
    const zipVal = (document.querySelector('#zipInput') as HTMLInputElement).value;

    // Background-resolved field applied as-is.
    expect(zipVal).toBe('54321');
    // Local-fix-only field must ALSO be applied even though the background
    // resolved a different field this round — this is the fix: a per-round
    // all-or-nothing gate previously skipped local fixes entirely whenever
    // ANY field got a background-provided value.
    expect(ssnVal).toBe('123-45-6789');
  });
});
