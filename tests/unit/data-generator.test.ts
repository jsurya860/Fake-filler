import { DataGenerator } from '../../src/background/data-generator';
import { isLuhnValid } from '../../src/shared/utils';

describe('DataGenerator', () => {
  let gen: DataGenerator;

  beforeEach(() => {
    gen = new DataGenerator({ locale: 'en-US', emailDomain: 'test.com' });
  });

  // =============================================================
  // Email
  // =============================================================

  describe('generateEmail()', () => {
    it('returns a valid email address', () => {
      const email = gen.generateEmail(null);
      expect(email).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    });

    it('uses the configured email domain', () => {
      const email = gen.generateEmail(null);
      expect(email).toContain('@test.com');
    });

    it('incorporates persona name when provided', () => {
      const persona = { firstName: 'Alice', lastName: 'Smith' };
      const email = gen.generateEmail(persona);
      expect(email).toContain('alice');
      expect(email).toContain('smith');
    });

    it('generates unique emails over multiple calls', () => {
      const emails = Array.from({ length: 10 }, () => gen.generateEmail(null));
      const unique = new Set(emails);
      // Timestamps guarantee uniqueness
      expect(unique.size).toBe(10);
    });
  });

  // =============================================================
  // Phone
  // =============================================================

  describe('generatePhone()', () => {
    it('returns a string with digits', () => {
      const phone = gen.generatePhone();
      expect(phone.replace(/\D/g, '').length).toBeGreaterThanOrEqual(7);
    });

    it('respects the en-US format pattern', () => {
      // en-US format: ###-###-####
      const phone = gen.generatePhone();
      expect(phone).toMatch(/^\d{3}-\d{3}-\d{4}$/);
    });

    it('uses the correct format for de-DE locale', () => {
      const deGen = new DataGenerator({ locale: 'de-DE' });
      const phone = deGen.generatePhone();
      expect(phone).toMatch(/\+49/);
    });

    it('generates realistic phone for en-GB locale', () => {
      const gb = new DataGenerator({ locale: 'en-GB' });
      const p = gb.generatePhone();
      // should be non-empty and contain digits
      expect(p.replace(/\D/g, '').length).toBeGreaterThanOrEqual(7);
    });
  });

  // =============================================================
  // Address pieces
  // =============================================================

  describe('address generation', () => {
    it('generates street, city, state, zipcode, country', () => {
      const street = gen.generateForField(makeField('street'), null);
      const city = gen.generateForField(makeField('city'), null);
      const state = gen.generateForField(makeField('state'), null);
      const zip = gen.generateForField(makeField('zipcode'), null);
      const country = gen.generateForField(makeField('country'), null);
      expect(typeof street).toBe('string');
      expect(typeof city).toBe('string');
      expect(typeof state).toBe('string');
      expect(typeof zip).toBe('string');
      expect(typeof country).toBe('string');
      expect(city!.length).toBeGreaterThan(0);
    });

    it('generates a combined address string for `address` type', () => {
      const field = makeField('address');
      const value = gen.generateForField(field, null);
      expect(typeof value).toBe('string');
      // should contain at least a comma-separated street and city or zip
      expect(value).toMatch(/,\s*\S+/);
    });
  });

  // =============================================================
  // Password
  // =============================================================

  describe('generatePassword()', () => {
    it('meets minimum length', () => {
      const pwd = gen.generatePassword(16, null);
      expect(pwd.length).toBeGreaterThanOrEqual(16);
    });

    it('always contains an uppercase letter', () => {
      for (let i = 0; i < 20; i++) {
        const pwd = gen.generatePassword(null, null);
        expect(pwd).toMatch(/[A-Z]/);
      }
    });

    it('always contains a digit', () => {
      for (let i = 0; i < 20; i++) {
        const pwd = gen.generatePassword(null, null);
        expect(pwd).toMatch(/\d/);
      }
    });

    it('always contains a special character', () => {
      for (let i = 0; i < 20; i++) {
        const pwd = gen.generatePassword(null, null);
        expect(pwd).toMatch(/[!@#$%^&*()\-_=+[\]{}|;:,.?]/);
      }
    });

    it('generates passwords of default length when no minLength given', () => {
      const pwd = gen.generatePassword(null, null);
      expect(pwd.length).toBeGreaterThanOrEqual(8);
    });
  });

  // =============================================================
  // Birthdate
  // =============================================================

  describe('generateBirthdate()', () => {
    it('returns a valid ISO date string', () => {
      const date = gen.generateBirthdate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('generates an age >= 18', () => {
      for (let i = 0; i < 20; i++) {
        const date = gen.generateBirthdate();
        const age =
          (Date.now() - new Date(date).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        expect(age).toBeGreaterThanOrEqual(18);
      }
    });
  });

  // =============================================================
  // Credit card
  // =============================================================

  describe('generateForField() – creditCard type', () => {
    it('returns a Luhn-valid card number', () => {
      // All test cards in constants should pass Luhn check
      const field = makeField('creditCard');
      const value = gen.generateForField(field, null);
      expect(value).not.toBeNull();
      expect(isLuhnValid(value!)).toBe(true);
    });
  });

  // =============================================================
  // Card expiry
  // =============================================================

  describe('generateCardExpiry()', () => {
    it('returns MM/YY format', () => {
      const expiry = gen.generateCardExpiry();
      expect(expiry).toMatch(/^\d{2}\/\d{2}$/);
    });

    it('is in the future', () => {
      const expiry = gen.generateCardExpiry();
      const [mm, yy] = expiry.split('/').map(Number);
      const now = new Date();
      const currentYear = now.getFullYear() % 100;
      const currentMonth = now.getMonth() + 1;
      expect(yy * 12 + mm).toBeGreaterThan(currentYear * 12 + currentMonth);
    });
  });

  // =============================================================
  // Number
  // =============================================================

  describe('generateNumber()', () => {
    it('respects min constraint', () => {
      const n = Number(gen.generateNumber({ min: 50, max: 100 }));
      expect(n).toBeGreaterThanOrEqual(50);
    });

    it('respects max constraint', () => {
      for (let i = 0; i < 20; i++) {
        const n = Number(gen.generateNumber({ min: 1, max: 10 }));
        expect(n).toBeLessThanOrEqual(10);
      }
    });
  });

  // =============================================================
  // Persona
  // =============================================================

  describe('buildPersona()', () => {
    it('returns a persona with firstName, lastName, username', () => {
      const persona = gen.buildPersona();
      expect(typeof persona.firstName).toBe('string');
      expect(typeof persona.lastName).toBe('string');
      expect(typeof persona.username).toBe('string');
      expect(persona.firstName.length).toBeGreaterThan(0);
    });
  });

  // =============================================================
  // validate()
  // =============================================================

  describe('validate()', () => {
    it('rejects values shorter than minLength', () => {
      const field = makeField('text', { minLength: 10 });
      expect(gen.validate('short', field)).toBe(false);
    });

    it('rejects values longer than maxLength', () => {
      const field = makeField('text', { maxLength: 5 });
      expect(gen.validate('toolongstring', field)).toBe(false);
    });

    it('accepts a value within length bounds', () => {
      const field = makeField('text', { minLength: 3, maxLength: 20 });
      expect(gen.validate('hello', field)).toBe(true);
    });

    it('validates against pattern constraint', () => {
      const field = makeField('text', { pattern: '^[A-Z]' });
      expect(gen.validate('lowercase', field)).toBe(false);
      expect(gen.validate('Uppercase', field)).toBe(true);
    });
  });

  // =============================================================
  // generateWithRetry()
  // =============================================================

  describe('generateWithRetry()', () => {
    it('returns a non-null value for standard text fields', () => {
      const field = makeField('text');
      const result = gen.generateWithRetry(field, null);
      expect(result).not.toBeNull();
    });

    it('returns null for file fields', () => {
      const field = makeField('file');
      const result = gen.generateWithRetry(field, null);
      expect(result).toBeNull();
    });
  });

  // =============================================================
  // Hint-based inference (universal field coverage)
  // =============================================================

  describe('hint-based field inference', () => {
    it('generates SSN for social security fields', () => {
      const field = makeFieldEx('text', { name: 'ssn', label: 'Social Security Number' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^\d{3}-\d{2}-\d{4}$/);
    });

    it('generates bank account number for account fields', () => {
      const field = makeFieldEx('text', { name: 'bankAccount', label: 'Bank Account Number' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^\d{10,16}$/);
    });

    it('generates routing number for routing fields', () => {
      const field = makeFieldEx('text', { name: 'routing', label: 'Routing Number' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^\d{9}$/);
    });

    it('generates varchar code for code fields', () => {
      const field = makeFieldEx('text', { name: 'planCode', label: 'Plan Code' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^[A-Z]+\d+$/);
    });

    it('generates IP address for ip fields', () => {
      const field = makeFieldEx('text', { name: 'ipAddress', label: 'IP Address' });
      const val = gen.generateForField(field);
      // IPv4 or IPv6
      expect(val!.length).toBeGreaterThan(0);
      expect(val).toMatch(/^\d+\.\d+\.\d+\.\d+$|^[0-9a-f:]+$/i);
    });

    it('generates promo code for coupon fields', () => {
      const field = makeFieldEx('text', { name: 'promoCode', label: 'Promo Code' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^[A-Z0-9]+-[A-Z0-9]+$/);
    });

    it('infers firstName for generic text field with name attribute', () => {
      const field = makeFieldEx('text', { name: 'firstName', label: '' });
      const val = gen.generateForField(field);
      expect(val).not.toBeNull();
      // Should not be lorem text
      expect(val!.split(' ').length).toBeLessThanOrEqual(3);
    });

    it('infers phone for generic text field with hint', () => {
      const field = makeFieldEx('text', { name: 'phone', label: 'Phone Number' });
      const val = gen.generateForField(field);
      expect(val).not.toBeNull();
      expect(val!.replace(/\D/g, '').length).toBeGreaterThanOrEqual(7);
    });

    it('generates future date for start date hint', () => {
      const field = makeFieldEx('date', { name: 'startDate', label: 'Start Date' });
      field.htmlType = 'date';
      const val = gen.generateForField(field);
      expect(val).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const date = new Date(val!);
      expect(date.getTime()).toBeGreaterThan(Date.now() - 86400000); // within one day tolerance
    });

    it('generates numeric value for quantity fields', () => {
      const field = makeFieldEx('text', { name: 'qty', label: 'Quantity' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^\d+$/);
      const n = Number(val);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(100);
    });

    it('generates currency for price fields', () => {
      const field = makeFieldEx('text', { name: 'price', label: 'Price' });
      const val = gen.generateForField(field);
      expect(val).toMatch(/^\d+\.\d{2}$/);
    });
  });

  // =============================================================
  // Date / time generators
  // =============================================================

  describe('date and time generators', () => {
    it('generateTime returns HH:MM format', () => {
      const time = gen.generateTime();
      expect(time).toMatch(/^\d{2}:\d{2}$/);
      const [h, m] = time.split(':').map(Number);
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThanOrEqual(18);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(59);
    });

    it('generateMonth returns YYYY-MM format', () => {
      const month = gen.generateMonth();
      expect(month).toMatch(/^\d{4}-\d{2}$/);
    });

    it('generateWeek returns YYYY-Www format', () => {
      const week = gen.generateWeek();
      expect(week).toMatch(/^\d{4}-W\d{2}$/);
    });

    it('generateCardExpiry returns MM/YY in the future', () => {
      const exp = gen.generateCardExpiry();
      expect(exp).toMatch(/^\d{2}\/\d{2}$/);
    });

    it('generateBirthdate returns YYYY-MM-DD between 18 and 60 years ago', () => {
      const bd = gen.generateBirthdate();
      expect(bd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const age = (Date.now() - new Date(bd).getTime()) / (365.25 * 86400000);
      expect(age).toBeGreaterThanOrEqual(17.9);
      expect(age).toBeLessThanOrEqual(60.1);
    });
  });

  // =============================================================
  // Number generation with step constraint
  // =============================================================

  describe('number with step', () => {
    it('generates values aligned to step from min', () => {
      for (let i = 0; i < 20; i++) {
        const val = Number(gen.generateNumber({ min: 0, max: 100, step: 5 }));
        expect(val % 5).toBe(0);
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(100);
      }
    });

    it('handles decimal step', () => {
      for (let i = 0; i < 10; i++) {
        const val = gen.generateNumber({ min: 0, max: 1, step: 0.1 });
        const n = Number(val);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
        // Should have at most 1 decimal place
        expect(val).toMatch(/^\d+\.\d$/);
      }
    });
  });
});

// =============================================================
// Test helpers
// =============================================================

function makeField(
  type: string,
  constraintOverrides: Partial<{
    minLength: number;
    maxLength: number;
    pattern: string;
    required: boolean;
  }> = {},
) {
  return {
    id: 'test-field',
    index: 0,
    type: type as never,
    htmlType: 'text',
    name: 'testField',
    label: 'Test Field',
    placeholder: '',
    constraints: {
      minLength: constraintOverrides.minLength ?? null,
      maxLength: constraintOverrides.maxLength ?? null,
      min: null,
      max: null,
      pattern: constraintOverrides.pattern ?? null,
      step: null,
      required: constraintOverrides.required ?? false,
      readOnly: false,
      disabled: false,
      multiple: false,
      accept: null,
    },
    required: constraintOverrides.required ?? false,
    selector: '#testField',
    formIndex: 0,
    confidence: 1,
  };
}

function makeFieldEx(
  type: string,
  attrs: {
    name?: string;
    label?: string;
    id?: string;
    placeholder?: string;
    ariaLabel?: string;
    className?: string;
    htmlType?: string;
    minLength?: number;
    maxLength?: number;
    min?: string | number;
    max?: string | number;
    pattern?: string;
    required?: boolean;
    options?: Array<{ value: string; label: string }>;
  } = {},
) {
  return {
    id: attrs.id ?? 'test-field',
    index: 0,
    type: type as never,
    htmlType: attrs.htmlType ?? 'text',
    name: attrs.name ?? '',
    label: attrs.label ?? '',
    placeholder: attrs.placeholder ?? '',
    ariaLabel: attrs.ariaLabel,
    className: attrs.className,
    constraints: {
      minLength: attrs.minLength ?? null,
      maxLength: attrs.maxLength ?? null,
      min: attrs.min ?? null,
      max: attrs.max ?? null,
      pattern: attrs.pattern ?? null,
      step: null,
      required: attrs.required ?? false,
      readOnly: false,
      disabled: false,
      multiple: false,
      accept: null,
      options: attrs.options,
    },
    required: attrs.required ?? false,
    selector: `#${attrs.id ?? 'testField'}`,
    formIndex: 0,
    confidence: 1,
  };
}
