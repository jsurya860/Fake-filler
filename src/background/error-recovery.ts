import browser from 'webextension-polyfill';
import type {
  ErrorInfo,
  ErrorMessage,
  ErrorType,
  FieldAnalysis,
  RecoveryAction,
  RecoveryResult,
  ErrorLearningEntry,
  FieldType,
} from '@/shared/types';
import { ERROR_PATTERNS, ERROR_SELECTORS, STORAGE_KEYS } from '@/shared/constants';
import type { DataGenerator } from './data-generator';
import { logSwallowed } from '@/shared/messaging';

// =============================================================
// ErrorRecoveryEngine
// =============================================================

export class ErrorRecoveryEngine {
  private learningDb: ErrorLearningEntry[] = [];
  private generator: DataGenerator;

  constructor(generator: DataGenerator) {
    this.generator = generator;
    void this.loadLearningDb();
  }

  // -----------------------------------------------------------
  // Detect errors on the active page (serialised selectors)
  // -----------------------------------------------------------

  /**
   * Scans the document for validation error indicators.
   * Runs inside the content-script context via message passing.
   * Here we accept a serialised list of { selector, text } pairs
   * collected on the content-script side.
   */
  analyzeErrors(
    errorElements: Array<{ selector: string; text: string; nearFieldName?: string; nearFieldId?: string }>,
  ): ErrorInfo {
    if (errorElements.length === 0) {
      return { hasError: false, messages: [], affectedFields: [], severity: 'low' };
    }

    const messages: ErrorMessage[] = errorElements
      .map(({ selector, text, nearFieldName, nearFieldId }) => ({
        text: text.trim(),
        fieldName: nearFieldName ?? null,
        fieldId: nearFieldId ?? null,
        type: this.classifyError(text),
        elementSelector: selector,
      }))
      .filter((m) => m.text.length >= 3);

    const affectedFields = [
      ...new Set(messages.map((m) => m.fieldName).filter((n): n is string => !!n)),
    ];

    return {
      hasError: messages.length > 0,
      messages,
      affectedFields,
      severity: this.calculateSeverity(messages),
    };
  }

  // -----------------------------------------------------------
  // Produce recovery actions for a detected error set
  // -----------------------------------------------------------

  async recover(
    errorInfo: ErrorInfo,
    fields: FieldAnalysis[],
    retryCount = 0,
  ): Promise<RecoveryResult> {
    const actions: RecoveryAction[] = [];
    const updatedFields: Array<{ field: string; value: string }> = [];

    for (const msg of errorInfo.messages) {
      // Match by field ID first (most accurate), then by name/label
      const targetField = msg.fieldId
        ? fields.find((f) => f.id === msg.fieldId)
        : msg.fieldName
          ? fields.find((f) => f.name === msg.fieldName || f.label === msg.fieldName)
          : null;

      const action = this.buildRecoveryAction(msg, targetField, retryCount);
      actions.push(action);

      if (action.action !== 'manual' && action.action !== 'skip' && targetField) {
        // A message-driven value the classifier already computed (e.g. a
        // digit-count-aware "5 digit code" fix, or a parsed length hint) is
        // authoritative — it must win over the generic "code fields produce
        // varchar" fallback below, which knows nothing about what the
        // specific error message actually asked for.
        let newValue: string | undefined | null;
        if (action.newValue) {
          newValue = action.newValue;
        } else if (this.generator.isCodeField(targetField)) {
          // "Code" fields must always produce varchar (alphanumeric), never names/words
          newValue = this.generator.generateVarchar(targetField.constraints);
        } else {
          // Use generateWithRetry to produce a value that respects field constraints + pattern
          newValue = this.generator.generateWithRetry(targetField, null, 5);
        }
        if (newValue) {
          updatedFields.push({ field: targetField.id, value: newValue });
          await this.recordLearning(targetField.type, msg.type, action.newValue ?? '', 'apply');
        }
      }
    }

    const requiresManualIntervention =
      actions.some((a) => a.action === 'manual') || retryCount >= 2;

    // Record lightweight telemetry about this recovery attempt
    void this.recordTelemetry({
      attempted: 1,
      successful: updatedFields.length,
      manual: requiresManualIntervention ? 1 : 0,
      timestamp: new Date().toISOString(),
    }).catch(() => undefined);

    return {
      success: updatedFields.length > 0,
      actions,
      updatedFields,
      requiresManualIntervention,
      message: requiresManualIntervention
        ? 'Some fields could not be auto-recovered.'
        : undefined,
    };
  }

  private async recordTelemetry(payload: { attempted: number; successful: number; manual: number; timestamp: string }): Promise<void> {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEYS.TELEMETRY);
      const current = (stored[STORAGE_KEYS.TELEMETRY] as
        | { recoveries: number; successes: number; manual: number; lastRun: string | null }
        | undefined) ?? { recoveries: 0, successes: 0, manual: 0, lastRun: null };
      const updated = {
        recoveries: (current.recoveries ?? 0) + (payload.attempted ?? 0),
        successes: (current.successes ?? 0) + (payload.successful ?? 0),
        manual: (current.manual ?? 0) + (payload.manual ?? 0),
        lastRun: payload.timestamp,
      };
      await browser.storage.local.set({ [STORAGE_KEYS.TELEMETRY]: updated });
      try { console.info('[FDF Telemetry] recovery', updated); } catch (e) { try { console.debug('[FDF Pro] telemetry info log failed', e); } catch (e) { logSwallowed('src/background/error-recovery.ts', e); } }
    } catch (err) {
      try { console.warn('[FDF Telemetry] failed to record', err); } catch (e) { try { console.debug('[FDF Pro] telemetry warn log failed', e); } catch (e) { logSwallowed('src/background/error-recovery.ts', e); } }
    }
  }

  // -----------------------------------------------------------
  // Error classification
  // -----------------------------------------------------------

  classifyError(message: string): ErrorType {
    for (const [type, regex] of Object.entries(ERROR_PATTERNS)) {
      if (regex.test(message)) return type as ErrorType;
    }
    return 'unknown';
  }

  // -----------------------------------------------------------
  // Recovery action builder
  // -----------------------------------------------------------

  private buildRecoveryAction(
    msg: ErrorMessage,
    field: FieldAnalysis | null | undefined,
    retryCount: number,
  ): RecoveryAction {
    const fieldId = field?.id ?? msg.fieldName ?? 'unknown';

    // Check the learning DB first – if we previously found a working value, reuse it
    if (field) {
      const learned = this.lookupLearning(field.type, msg.type);
      if (learned) {
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: `Reusing previously successful value from learning DB`,
          newValue: learned,
          retryCount,
        };
      }
    }

    switch (msg.type) {
      case 'exists':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Email/username already taken – regenerate with timestamp suffix',
          newValue: field ? this.generator.generateEmail(null) : undefined,
          retryCount,
        };

      case 'required':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Field was empty – fill with generated value',
          retryCount,
        };

      case 'format': {
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate with constraint validation',
          retryCount,
        };
      }

      case 'length': {
        const lengthHint = this.parseLengthHint(msg.text);
        // The error message's stated length is more authoritative than the
        // DOM's minLength/maxLength (which may be absent or simply not what
        // the site's own JS validator is actually enforcing) — build the
        // fresh value against the message-derived bounds directly, rather
        // than returning only `constraints` and letting the caller fall back
        // to generateWithRetry() against the (possibly unrelated) DOM
        // constraints, which can silently regenerate a value that still
        // doesn't satisfy what the message asked for.
        let newValue: string | undefined;
        if (field && (lengthHint.minLength != null || lengthHint.maxLength != null)) {
          const mergedField: FieldAnalysis = {
            ...field,
            constraints: {
              ...field.constraints,
              minLength: lengthHint.minLength ?? field.constraints?.minLength ?? null,
              maxLength: lengthHint.maxLength ?? field.constraints?.maxLength ?? null,
            },
          };
          newValue = this.generator.generateWithRetry(mergedField, null, 5) ?? undefined;
        }
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: `Adjust length to ${lengthHint.minLength ?? '?'}–${lengthHint.maxLength ?? '?'} chars`,
          constraints: lengthHint,
          newValue,
          retryCount,
        };
      }

      case 'password':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate password with stronger complexity',
          newValue: this.generator.generatePassword(12, null),
          retryCount,
        };

      case 'email':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate email address',
          newValue: this.generator.generateEmail(null),
          retryCount,
        };

      case 'phone': {
        // Generate a simple digits-only phone that matches most validation patterns
        const digits = Array.from({ length: 10 }, (_, i) =>
          i === 0 ? String(Math.floor(Math.random() * 8) + 2) : String(Math.floor(Math.random() * 10)),
        ).join('');
        // Format as NNN-NNN-NNNN which satisfies most phone patterns
        const simplePhone = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate phone number in simple format',
          newValue: field?.constraints?.pattern
            ? this.generatePatternAwarePhone(field.constraints.pattern)
            : simplePhone,
          retryCount,
        };
      }

      case 'date':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate date in valid format',
          newValue: field
            ? this.generator.generateDate(
                field.constraints?.min ?? null,
                field.constraints?.max ?? null,
                field.label ?? '',
              )
            : undefined,
          retryCount,
        };

      case 'number': {
        const constraints = field?.constraints;
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate valid number within constraints',
          newValue: this.generator.generateNumber({
            min: constraints?.min ?? null,
            max: constraints?.max ?? null,
            step: constraints?.step ?? null,
          }),
          retryCount,
        };
      }

      case 'range': {
        // Parse min/max from error text if not on the field
        const rangeHint = this.parseRangeHint(msg.text);
        const constraints = field?.constraints;
        const min = rangeHint.min ?? constraints?.min ?? 1;
        const max = rangeHint.max ?? constraints?.max ?? 100;
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: `Regenerate number in range ${min}–${max}`,
          newValue: this.generator.generateNumber({ min, max, step: constraints?.step ?? null }),
          retryCount,
        };
      }

      case 'url':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate valid URL',
          newValue: 'https://www.example.com',
          retryCount,
        };

      case 'username':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate username',
          newValue: this.generator.generateUsername(null),
          retryCount,
        };

      case 'creditCard':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate credit card number (test card)',
          newValue: '4111111111111111',
          retryCount,
        };

      case 'alphanumeric':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate alphanumeric value',
          newValue: this.generator.generateVarchar(field?.constraints ?? null),
          retryCount,
        };

      case 'lettersOnly': {
        // Generate letters-only value (no digits or special chars)
        const len = field?.constraints?.maxLength ?? 8;
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        const value = Array.from({ length: Math.min(len, 20) }, () => letters[Math.floor(Math.random() * 26)]).join('');
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate letters-only value',
          newValue: value,
          retryCount,
        };
      }

      case 'digitsOnly': {
        // Prefer the count the error message itself states (e.g. "Enter 5
        // digit code", "6 digit OTP") over the DOM's maxLength, which is
        // frequently absent for fields validated purely in JS (OTP/PIN/code
        // inputs rarely carry a maxlength attribute at all).
        const msgLenHint = msg.text.match(/(\d+)\s*-?\s*digit/i);
        const len = msgLenHint ? parseInt(msgLenHint[1], 10) : (field?.constraints?.maxLength ?? 6);
        const value = Array.from({ length: Math.min(len, 20) }, () => String(Math.floor(Math.random() * 10))).join('');
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: `Regenerate ${len}-digit value`,
          newValue: value,
          retryCount,
        };
      }

      case 'noSpaces': {
        // Regenerate without spaces using varchar generator
        const raw = this.generator.generateVarchar(field?.constraints ?? null);
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate value without spaces',
          newValue: raw.replace(/\s+/g, ''),
          retryCount,
        };
      }

      case 'name':
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate valid name (letters only)',
          retryCount,
        };

      case 'age': {
        const ageHint = msg.text.match(/(\d+)/);
        const minAge = ageHint ? parseInt(ageHint[1], 10) : 18;
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: `Regenerate age ≥ ${minAge}`,
          newValue: String(Math.max(minAge, 25)),
          retryCount,
        };
      }

      case 'zipcode': {
        // Prefer the length the error message itself states (e.g. "Enter 5
        // digit zip code") over an assumed 5 — some locales require 6
        // (India, Canada without letters) or other lengths.
        const zipLenHint = msg.text.match(/(\d+)\s*-?\s*digit/i);
        const zipLen = zipLenHint ? parseInt(zipLenHint[1], 10) : 5;
        const zipValue = Array.from({ length: zipLen }, () => String(Math.floor(Math.random() * 10))).join('');
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: `Regenerate valid ${zipLen}-digit ZIP code`,
          newValue: zipValue,
          retryCount,
        };
      }

      case 'pattern': {
        // Pattern mismatch – regenerate with constraints; the content-script local fix
        // will try pattern-specific rewriting
        return {
          action: 'regenerate',
          field: fieldId,
          strategy: 'Regenerate to match field pattern',
          retryCount,
        };
      }

      default:
        if (retryCount >= 2) {
          return { action: 'manual', field: fieldId, strategy: 'Manual intervention needed', retryCount };
        }
        return { action: 'regenerate', field: fieldId, strategy: 'Regenerate and retry', retryCount };
    }
  }

  // -----------------------------------------------------------
  // Pattern-aware phone generator for recovery
  // -----------------------------------------------------------

  private generatePatternAwarePhone(pattern: string): string {
    // Try various common formats and test against the pattern
    const digits10 = Array.from({ length: 10 }, (_, i) =>
      i === 0 ? String(Math.floor(Math.random() * 8) + 2) : String(Math.floor(Math.random() * 10)),
    ).join('');
    const candidates = [
      `${digits10.slice(0, 3)}-${digits10.slice(3, 6)}-${digits10.slice(6)}`,      // 555-123-4567
      `${digits10.slice(0, 3)}${digits10.slice(3, 6)}${digits10.slice(6)}`,         // 5551234567
      `(${digits10.slice(0, 3)})${digits10.slice(3, 6)}-${digits10.slice(6)}`,      // (555)123-4567
      `+1${digits10}`,                                                                // +15551234567
      `+1-${digits10.slice(0, 3)}-${digits10.slice(3, 6)}-${digits10.slice(6)}`,    // +1-555-123-4567
    ];
    try {
      // Guard against ReDoS: reject overly long patterns from untrusted HTML
      if (pattern.length > 200) return candidates[0];
      const re = new RegExp(pattern);
      for (const c of candidates) {
        if (re.test(c)) return c;
      }
    } catch (e) { logSwallowed('src/background/error-recovery.ts', e); }
    return candidates[0];
  }

  // -----------------------------------------------------------
  // Heuristics for hints inside error messages
  // -----------------------------------------------------------

  private parseLengthHint(text: string): { minLength: number | null; maxLength: number | null } {
    const atLeastMatch = /at least (\d+)/i.exec(text);
    const maxMatch = /(?:maximum|max|at most|no more than) (\d+)/i.exec(text);
    const betweenMatch = /between (\d+) and (\d+)/i.exec(text);

    if (betweenMatch) {
      return {
        minLength: parseInt(betweenMatch[1], 10),
        maxLength: parseInt(betweenMatch[2], 10),
      };
    }
    return {
      minLength: atLeastMatch ? parseInt(atLeastMatch[1], 10) : null,
      maxLength: maxMatch ? parseInt(maxMatch[1], 10) : null,
    };
  }

  private parseRangeHint(text: string): { min: number | null; max: number | null } {
    const atLeastMatch = /(?:at least|greater than|minimum|more than)\s+(\d+)/i.exec(text);
    const atMostMatch = /(?:at most|less than|maximum|no more than|cannot exceed)\s+(\d+)/i.exec(text);
    const betweenMatch = /between\s+(\d+)\s+and\s+(\d+)/i.exec(text);

    if (betweenMatch) {
      return { min: parseInt(betweenMatch[1], 10), max: parseInt(betweenMatch[2], 10) };
    }
    return {
      min: atLeastMatch ? parseInt(atLeastMatch[1], 10) : null,
      max: atMostMatch ? parseInt(atMostMatch[1], 10) : null,
    };
  }

  private calculateSeverity(messages: ErrorMessage[]): 'low' | 'medium' | 'high' {
    if (messages.some((m) => m.type === 'exists' || m.type === 'pattern' || m.type === 'creditCard')) return 'high';
    if (messages.some((m) => m.type === 'required' || m.type === 'format' || m.type === 'password' || m.type === 'email' || m.type === 'phone')) return 'medium';
    return 'low';
  }

  // -----------------------------------------------------------
  // Error learning DB
  // -----------------------------------------------------------

  /**
   * Find the most recent learning entry where a successful solution was
   * recorded for the given fieldType + errorType combination.
   */
  private lookupLearning(fieldType: FieldType, errorType: ErrorType): string | null {
    // Iterate in reverse to prefer most recent entries
    for (let i = this.learningDb.length - 1; i >= 0; i--) {
      const entry = this.learningDb[i];
      if (
        entry.fieldType === fieldType &&
        entry.errorType === errorType &&
        entry.solution &&
        entry.solution !== 'apply' // exclude placeholder markers
      ) {
        return entry.solution;
      }
    }
    return null;
  }

  /**
   * Called when a recovery attempt succeeds.  Persists the winning value so
   * future fills for this field/error combination can reuse it.
   */
  async markSuccess(
    fieldType: FieldType,
    errorType: ErrorType,
    successValue: string,
  ): Promise<void> {
    // Update any existing entry for this combination, or add a new one
    const existing = this.learningDb
      .slice()
      .reverse()
      .find((e) => e.fieldType === fieldType && e.errorType === errorType);

    if (existing) {
      existing.solution = successValue;
    } else {
      this.learningDb.push({
        fieldType,
        errorType,
        attemptedValue: successValue,
        failedAt: new Date().toISOString(),
        solution: successValue,
      });
    }

    if (this.learningDb.length > 500) {
      this.learningDb = this.learningDb.slice(-500);
    }

    await browser.storage.local.set({ [STORAGE_KEYS.ERROR_LEARNING]: this.learningDb });
 }

  private async recordLearning(
    fieldType: FieldType,
    errorType: ErrorType,
    attemptedValue: string,
    solution: string,
  ): Promise<void> {
    this.learningDb.push({
      fieldType,
      errorType,
      attemptedValue,
      failedAt: new Date().toISOString(),
      solution,
    });

    // Keep only last 500 entries to avoid bloat
    if (this.learningDb.length > 500) {
      this.learningDb = this.learningDb.slice(-500);
    }

    await browser.storage.local.set({ [STORAGE_KEYS.ERROR_LEARNING]: this.learningDb });
  }

  private async loadLearningDb(): Promise<void> {
    const stored = await browser.storage.local.get(STORAGE_KEYS.ERROR_LEARNING);
    this.learningDb =
      (stored[STORAGE_KEYS.ERROR_LEARNING] as ErrorLearningEntry[] | undefined) ?? [];
  }

  /** Expose the selectors list so the content-script can query the DOM */
  static get errorSelectors(): string[] {
    return ERROR_SELECTORS;
  }
}
