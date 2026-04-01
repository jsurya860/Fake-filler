import { parseApiErrors } from '../../src/content/api-interceptor';
import { DataGenerator } from '../../src/background/data-generator';
import { ErrorRecoveryEngine } from '../../src/background/error-recovery';

describe('parseApiErrors', () => {
  it('parses Laravel-style errors { errors: { field: [...msgs] } }', () => {
    const body = {
      message: 'The given data was invalid.',
      errors: {
        email: ['The email has already been taken.'],
        planCode: ['The plan code field is required.'],
      },
    };
    const result = parseApiErrors(body);
    expect(result.message).toBe('The given data was invalid.');
    expect(result.fieldErrors).toHaveLength(2);
    expect(result.fieldErrors[0]).toEqual({ field: 'email', messages: ['The email has already been taken.'] });
    expect(result.fieldErrors[1]).toEqual({ field: 'planCode', messages: ['The plan code field is required.'] });
  });

  it('parses Spring-style errors { errors: [{ field, defaultMessage }] }', () => {
    const body = {
      errors: [
        { field: 'username', defaultMessage: 'must not be blank' },
        { field: 'age', defaultMessage: 'must be at least 18' },
      ],
    };
    const result = parseApiErrors(body);
    expect(result.fieldErrors).toHaveLength(2);
    expect(result.fieldErrors[0]).toEqual({ field: 'username', messages: ['must not be blank'] });
  });

  it('parses Django DRF top-level field keys', () => {
    const body = {
      email: ['This field is required.'],
      password: ['This field may not be blank.'],
    };
    const result = parseApiErrors(body);
    expect(result.fieldErrors).toHaveLength(2);
    expect(result.fieldErrors.find(e => e.field === 'email')).toBeTruthy();
  });

  it('parses Joi-style { details: [{ path, message }] }', () => {
    const body = {
      details: [
        { path: ['body', 'email'], message: '"email" is not allowed to be empty' },
      ],
    };
    const result = parseApiErrors(body);
    expect(result.fieldErrors).toHaveLength(1);
    expect(result.fieldErrors[0].field).toBe('email');
  });

  it('parses root-level array [{ field, message }]', () => {
    const body = [
      { field: 'planCode', message: 'Invalid plan code format' },
      { field: 'name', message: 'Name is required' },
    ];
    const result = parseApiErrors(body);
    expect(result.fieldErrors).toHaveLength(2);
  });

  it('returns empty for non-error payloads', () => {
    expect(parseApiErrors({ success: true, data: {} })).toEqual({ fieldErrors: [] });
    expect(parseApiErrors(null)).toEqual({ fieldErrors: [] });
    expect(parseApiErrors('not json')).toEqual({ fieldErrors: [] });
  });
});

describe('Code field varchar generation', () => {
  const gen = new DataGenerator({ locale: 'en-US' });

  it('generateVarchar produces letter+digits string', () => {
    for (let i = 0; i < 20; i++) {
      const val = gen.generateVarchar({ maxLength: 6 });
      expect(val).toMatch(/^[A-Z]+\d+$/);
      expect(val.length).toBeLessThanOrEqual(6);
    }
  });

  it('isCodeField detects "plan code" but not "zip code"', () => {
    expect(gen.isCodeField({ name: 'planCode', label: 'Plan Code' } as any)).toBe(true);
    expect(gen.isCodeField({ name: 'code', label: 'Code' } as any)).toBe(true);
    expect(gen.isCodeField({ name: 'areaCode', label: 'Area Code' } as any)).toBe(false);
    expect(gen.isCodeField({ name: 'zipCode', label: 'Zip Code' } as any)).toBe(false);
    expect(gen.isCodeField({ name: 'postalCode', label: 'Postal Code' } as any)).toBe(false);
  });

  it('generateForField produces varchar for "code" fields', () => {
    const field = {
      id: 'f1',
      index: 0,
      type: 'text' as const,
      htmlType: 'text',
      name: 'planCode',
      label: 'Plan Code',
      placeholder: '',
      constraints: { minLength: null, maxLength: 10, min: null, max: null, pattern: null, step: null, required: true, readOnly: false, disabled: false, multiple: false, accept: null },
      required: true,
      selector: '#planCode',
      formIndex: 0,
      confidence: 0.5,
    };
    for (let i = 0; i < 10; i++) {
      const val = gen.generateForField(field);
      expect(val).not.toBeNull();
      expect(val).toMatch(/^[A-Z]+\d+$/);
      expect(val!.length).toBeLessThanOrEqual(10);
    }
  });

  it('generateWithRetry produces varchar for code fields', () => {
    const field = {
      id: 'f2',
      index: 0,
      type: 'text' as const,
      htmlType: 'text',
      name: 'carrierCode',
      label: 'Carrier Code',
      placeholder: '',
      constraints: { minLength: null, maxLength: 8, min: null, max: null, pattern: null, step: null, required: true, readOnly: false, disabled: false, multiple: false, accept: null },
      required: true,
      selector: '#carrierCode',
      formIndex: 0,
      confidence: 0.5,
    };
    const val = gen.generateWithRetry(field, null, 5);
    expect(val).not.toBeNull();
    expect(val!).toMatch(/^[A-Z]+\d+$/);
  });
});

describe('ErrorRecoveryEngine code field recovery', () => {
  it('produces varchar for code fields during recovery', async () => {
    const gen = new DataGenerator({ locale: 'en-US' });
    const engine = new ErrorRecoveryEngine(gen);

    const fields = [
      {
        id: 'planCode-1',
        index: 0,
        type: 'text' as const,
        htmlType: 'text',
        name: 'planCode',
        label: 'Plan Code',
        placeholder: '',
        constraints: { minLength: null, maxLength: 10, min: null, max: null, pattern: null, step: null, required: true, readOnly: false, disabled: false, multiple: false, accept: null },
        required: true,
        selector: '#planCode',
        formIndex: 0,
        confidence: 0.5,
      },
    ];

    const errorInfo = engine.analyzeErrors([
      { selector: '.error', text: 'Plan Code is required', nearFieldName: 'planCode', nearFieldId: 'planCode-1' },
    ]);

    const result = await engine.recover(errorInfo, fields);
    expect(result.updatedFields.length).toBeGreaterThan(0);
    const updated = result.updatedFields.find((u: { field: string; value: string }) => u.field === 'planCode-1');
    expect(updated).toBeTruthy();
    // Must be alphanumeric (varchar), not a lorem word
    expect(updated!.value).toMatch(/^[A-Z]+\d+$/);
  });
});
