import { ErrorRecoveryEngine } from '../../src/background/error-recovery';
import { DataGenerator } from '../../src/background/data-generator';
import type { FieldAnalysis } from '../../src/shared/types';

// Mock chrome.storage.local for learning DB persistence
const storedData: Record<string, unknown> = {};
(global as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: jest.fn(async (key: string) => ({ [key]: storedData[key] })),
      set: jest.fn(async (items: Record<string, unknown>) =>
        Object.assign(storedData, items),
      ),
    },
  },
};

describe('ErrorRecoveryEngine', () => {
  let engine: ErrorRecoveryEngine;
  let generator: DataGenerator;

  beforeEach(() => {
    generator = new DataGenerator({ locale: 'en-US' });
    engine = new ErrorRecoveryEngine(generator);
  });

  // =============================================================
  // classifyError
  // =============================================================

  describe('classifyError()', () => {
    it.each([
      ['Email already exists', 'exists'],
      ['already registered', 'exists'],
      ['This field is required', 'required'],
      ['Cannot be empty', 'required'],
      ['Invalid format', 'format'],
      ['Must be at least 8 characters', 'length'],
      ['Too long', 'length'],
      ['Must be between 18 and 65', 'range'],
      ['Invalid email address', 'email'],
      ['Phone number must be 10 digits', 'phone'],
      ['Password must contain uppercase', 'password'],
      ['Some other message', 'unknown'],
    ])('classifies "%s" as %s', (msg, expected) => {
      expect(engine.classifyError(msg)).toBe(expected);
    });
  });

  // =============================================================
  // analyzeErrors
  // =============================================================

  describe('analyzeErrors()', () => {
    it('returns no error when input is empty', () => {
      const result = engine.analyzeErrors([]);
      expect(result.hasError).toBe(false);
      expect(result.messages).toHaveLength(0);
    });

    it('detects a single error message', () => {
      const result = engine.analyzeErrors([
        { selector: '.error', text: 'Email already exists' },
      ]);
      expect(result.hasError).toBe(true);
      expect(result.messages[0].type).toBe('exists');
    });

    it('deduplicates affected fields', () => {
      const result = engine.analyzeErrors([
        { selector: '.e1', text: 'Email already exists', nearFieldName: 'email' },
        { selector: '.e2', text: 'Invalid email', nearFieldName: 'email' },
      ]);
      expect(result.affectedFields).toEqual(['email']);
    });

    it('assigns high severity for "exists" errors', () => {
      const result = engine.analyzeErrors([
        { selector: '.e', text: 'Username already taken' },
      ]);
      expect(result.severity).toBe('high');
    });

    it('assigns medium severity for "required" errors', () => {
      const result = engine.analyzeErrors([
        { selector: '.e', text: 'This field is required' },
      ]);
      expect(result.severity).toBe('medium');
    });

    it('filters out very short error texts', () => {
      const result = engine.analyzeErrors([
        { selector: '.e', text: 'OK' }, // only 2 chars
      ]);
      expect(result.hasError).toBe(false);
    });
  });

  // =============================================================
  // recover
  // =============================================================

  describe('recover()', () => {
    it('produces a regenerate action for "exists" error', async () => {
      const errorInfo = engine.analyzeErrors([
        { selector: '.e', text: 'Email already exists', nearFieldName: 'email' },
      ]);
      const fields = [makeField('email', 'email')];
      const result = await engine.recover(errorInfo, fields);

      expect(result.actions[0].action).toBe('regenerate');
    });

    it('fills updatedFields when a match is found', async () => {
      const errorInfo = engine.analyzeErrors([
        { selector: '.e', text: 'Email already exists', nearFieldName: 'email' },
      ]);
      const fields = [makeField('email', 'email')];
      const result = await engine.recover(errorInfo, fields);

      expect(result.updatedFields.length).toBeGreaterThan(0);
      expect(result.updatedFields[0].field).toBe('test-email');
    });

    it('marks as requiring manual intervention at retryCount >= 2 for unknown', async () => {
      const errorInfo = engine.analyzeErrors([
        { selector: '.e', text: 'Something unexpected happened' },
      ]);
      const fields: FieldAnalysis[] = [];
      const result = await engine.recover(errorInfo, fields, 2);

      expect(result.requiresManualIntervention).toBe(true);
    });
  });
});

// =============================================================
// Helpers
// =============================================================

function makeField(type: string, name: string): FieldAnalysis {
  return {
    id: `test-${name}`,
    index: 0,
    type: type as never,
    htmlType: 'text',
    name,
    label: name,
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
    selector: `#${name}`,
    formIndex: 0,
    confidence: 1,
  };
}
