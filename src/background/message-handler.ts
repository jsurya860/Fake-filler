import browser from 'webextension-polyfill';
import type { Runtime } from 'webextension-polyfill';
import type {
  ExtensionMessage,
  ExtensionResponse,
  ErrorInfo,
  ErrorType,
  FieldType,
  FormAnalysis,
  GenerationOptions,
  Profile,
  ProfileData,
  RecoveryResult,
  Settings,
  SupportedLocale,
} from '@/shared/types';
import { DEFAULT_SETTINGS } from '@/shared/constants';
import { DataGenerator } from './data-generator';
import { ProfileManager } from './profile-manager';
import { ErrorRecoveryEngine } from './error-recovery';
import { deepClone, isLoopbackOrPrivateHostname } from '@/shared/utils';
import { logSwallowed } from '@/shared/messaging';

// =============================================================
// MessageHandler – routes all runtime messages (browser.runtime, works
// across Chrome/Firefox/Safari via the webextension-polyfill)
// =============================================================

export class MessageHandler {
  private profileManager: ProfileManager;
  private errorRecovery: ErrorRecoveryEngine;
  private settings: Settings = deepClone(DEFAULT_SETTINGS);
  private generatorCache = new Map<string, DataGenerator>();

  constructor() {
    this.profileManager = new ProfileManager();
    // Initialise with default generator; loadSettings will re-create after settings are loaded
    this.errorRecovery = new ErrorRecoveryEngine(this.getGenerator());
    void this.loadSettings().then(() => {
      this.errorRecovery = new ErrorRecoveryEngine(this.getGenerator());
    });
  }

  // -----------------------------------------------------------
  // Upload anonymised telemetry payload to a configured endpoint
  // -----------------------------------------------------------
  private async uploadTelemetry(payload: unknown, endpoint: string): Promise<void> {
    try {
      // Validate endpoint is a safe HTTPS URL. This is a user-chosen,
      // opt-in destination (there's no fixed vendor to allowlist), so we
      // can't restrict it to known hosts — instead, guard against the most
      // likely misconfiguration: accidentally pointing it at a loopback or
      // private-network address, which almost never makes sense for a
      // telemetry endpoint and could otherwise probe internal infrastructure.
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') return;
      if (isLoopbackOrPrivateHostname(url.hostname)) {
        try { console.warn('[FDF Telemetry] refusing to upload to loopback/private-network endpoint', url.hostname); } catch (e) { logSwallowed('src/background/message-handler.ts', e); }
        return;
      }

      // Respect environments where fetch may not be available
      if (typeof fetch === 'undefined') return;
      await fetch(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      try { console.info('[FDF Telemetry] uploaded failure payload'); } catch (e) { try { console.debug('[FDF Pro] telemetry info log failed', e); } catch (e) { logSwallowed('src/background/message-handler.ts', e); } }
    } catch (err) {
      try { console.warn('[FDF Telemetry] upload failed', err); } catch (e) { try { console.debug('[FDF Pro] telemetry warn log failed', e); } catch (e) { logSwallowed('src/background/message-handler.ts', e); } }
    }
  }

  /**
   * Build a scrubbed telemetry payload that contains no field values,
   * user selectors, or PII — only statistical counts and error categories.
   */
  private buildTelemetryPayload(
    errorInfo: ErrorInfo,
    fields: FormAnalysis['fields'],
    recovery: RecoveryResult,
  ): Record<string, unknown> {
    return {
      timestamp: new Date().toISOString(),
      errorCount: errorInfo.messages.length,
      severity: errorInfo.severity,
      errorTypes: [...new Set(errorInfo.messages.map((m) => m.type))],
      fieldCount: fields.length,
      fieldTypes: [...new Set(fields.map((f) => f.type))],
      recoveredCount: recovery.updatedFields.length,
      requiresManual: recovery.requiresManualIntervention,
    };
  }

  // -----------------------------------------------------------
  // Entry point
  // -----------------------------------------------------------

  async handle(
    message: ExtensionMessage,
    sender: Runtime.MessageSender,
  ): Promise<ExtensionResponse> {
    // Defense-in-depth: reject messages that didn't come from this
    // extension's own content scripts/popup. No `externally_connectable` or
    // `onMessageExternal` listener exists today, so this isn't reachable by
    // a malicious page yet — but it's a cheap guard against that ever
    // becoming true by accident in a future change.
    if (sender.id !== browser.runtime.id) {
      return { success: false, error: 'Untrusted sender' };
    }
    try {
      const data = await this.dispatch(message);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  // -----------------------------------------------------------
  // Dispatcher
  // -----------------------------------------------------------

  private async dispatch(msg: ExtensionMessage): Promise<unknown> {
    switch (msg.action) {
      // ---- Data generation ----
      case 'GENERATE_DATA_FOR_FORM': {
        const { formAnalysis, profileId, options } = msg.payload as {
          formAnalysis: FormAnalysis;
          profileId?: string;
          options?: Partial<GenerationOptions>;
        };
        return this.generateDataForForm(formAnalysis, profileId, options);
      }

      // ---- Profiles ----
      case 'LIST_PROFILES':
        return this.profileManager.getAll();

      case 'GET_PROFILE': {
        const { id } = msg.payload as { id: string };
        return this.profileManager.getById(id);
      }

      case 'CREATE_PROFILE': {
        const { name, data, locale } = msg.payload as {
          name: string;
          data: ProfileData;
          locale?: SupportedLocale;
        };
        return this.profileManager.create(name, data, { locale });
      }

      case 'UPDATE_PROFILE': {
        const { id, updates } = msg.payload as { id: string; updates: Partial<Profile> };
        return this.profileManager.update(id, updates);
      }

      case 'DELETE_PROFILE': {
        const { id } = msg.payload as { id: string };
        await this.profileManager.delete(id);
        return null;
      }

      case 'EXPORT_PROFILE': {
        const { id } = msg.payload as { id: string };
        return this.profileManager.exportProfile(id);
      }

      case 'IMPORT_PROFILE': {
        const { json } = msg.payload as { json: string };
        return this.profileManager.importProfile(json);
      }

      // ---- Settings ----
      case 'GET_SETTINGS':
        return deepClone(this.settings);

      case 'UPDATE_SETTINGS': {
        const updates = msg.payload as Partial<Settings>;
        // Validate allowed keys — only merge known setting keys
        const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
        const sanitised: Partial<Settings> = {};
        for (const [k, v] of Object.entries(updates)) {
          if (allowed.has(k)) (sanitised as Record<string, unknown>)[k] = v;
        }
        this.settings = { ...this.settings, ...sanitised };
        await this.persistSettings();
        this.generatorCache.clear(); // Invalidate cached generators
        return deepClone(this.settings);
      }

      case 'RESET_SETTINGS':
        this.settings = deepClone(DEFAULT_SETTINGS);
        await this.persistSettings();
        this.generatorCache.clear();
        return deepClone(this.settings);

      // ---- Error recovery ----
      case 'DETECT_ERRORS': {
        const { errorElements, fields } = msg.payload as {
          errorElements: Array<{ selector: string; text: string; nearFieldName?: string; nearFieldId?: string; elementHtml?: string }>;
          fields: FormAnalysis['fields'];
        };

        const errorInfo = this.errorRecovery.analyzeErrors(errorElements);
        if (!errorInfo.hasError) return { errorInfo, recovery: null };

        const recovery = await this.errorRecovery.recover(errorInfo, fields);

        // Optional automatic upload: send a scrubbed (no PII) statistical payload
        // if telemetry is explicitly enabled by the user.
        try {
          if (this.settings.telemetryEnabled && this.settings.telemetryEndpoint) {
            const payload = this.buildTelemetryPayload(errorInfo, fields, recovery);
            void this.uploadTelemetry(payload, this.settings.telemetryEndpoint).catch(() => undefined);
          }
        } catch (e) { try { console.debug('[FDF Pro] telemetry upload try failed', e); } catch (e) { logSwallowed('src/background/message-handler.ts', e); } }

        return { errorInfo, recovery };
      }

      case 'REPORT_FILLED': {
        const { filled } = msg.payload as { filled: Array<{ fieldId: string; selector: string; value: string }> };
        try {
          console.info('[FDF Pro] page reported filled values:', filled.slice(0, 20));
        } catch (e) { try { console.debug('[FDF Pro] report filled log failed', e); } catch (e) { logSwallowed('src/background/message-handler.ts', e); } }
        return null;
      }

      case 'MARK_RECOVERY_SUCCESS': {
        const { fieldType, errorType, successValue } = msg.payload as {
          fieldType: FieldType;
          errorType: ErrorType;
          successValue: string;
        };
        await this.errorRecovery.markSuccess(fieldType, errorType, successValue);
        return null;
      }

      default:
        throw new Error(`Unknown action: ${(msg).action}`);
    }
  }

  // -----------------------------------------------------------
  // Data generation
  // -----------------------------------------------------------

  private async generateDataForForm(
    formAnalysis: FormAnalysis,
    profileId: string | undefined,
    options: Partial<GenerationOptions> | undefined,
  ): Promise<FormAnalysis> {
    const generator = this.getGenerator(options);

    let persona = this.settings.consistentPersona ? generator.buildPersona() : null;

    // If a profile is selected, seed persona from it
    if (profileId) {
      const profile = await this.profileManager.getById(profileId);
      if (profile) {
        await this.profileManager.incrementUsage(profileId);
        persona = {
          firstName: profile.data.firstName ?? persona?.firstName ?? '',
          lastName: profile.data.lastName ?? persona?.lastName ?? '',
          username: profile.data.username,
        };
      }
    }

    const fieldValues = generator.generateForForm(formAnalysis.fields, !!persona);

    // Merge values back into the form analysis clone
    const enriched: FormAnalysis = deepClone(formAnalysis);
    for (const field of enriched.fields) {
      const generated = fieldValues.get(field.id);
      if (generated !== undefined) {
        field.value = generated;
      }
    }

    return enriched;
  }

  // Public helper to allow direct calls from the background service worker
  // without going through runtime messaging. Returns the enriched form.
  async generateDataForFormDirect(
    formAnalysis: FormAnalysis,
    profileId?: string,
    options?: Partial<GenerationOptions>,
  ): Promise<FormAnalysis> {
    return this.generateDataForForm(formAnalysis, profileId ?? undefined, options ?? undefined);
  }

  // -----------------------------------------------------------
  // Settings persistence
  // -----------------------------------------------------------

  private async loadSettings(): Promise<void> {
    const stored = await browser.storage.local.get('settings');
    if (stored.settings && typeof stored.settings === 'object') {
      // Only merge known setting keys with expected types to prevent
      // tampered or outdated storage entries from injecting arbitrary values.
      const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
      const validated: Partial<Settings> = {};
      for (const [k, v] of Object.entries(stored.settings as Record<string, unknown>)) {
        if (!allowed.has(k)) continue;
        const defaultVal = (DEFAULT_SETTINGS as Record<string, unknown>)[k];
        // Accept only values whose typeof matches the default
        if (typeof v === typeof defaultVal || Array.isArray(v) === Array.isArray(defaultVal)) {
          (validated as Record<string, unknown>)[k] = v;
        }
      }
      this.settings = { ...DEFAULT_SETTINGS, ...validated };
    }
  }

  private async persistSettings(): Promise<void> {
    await browser.storage.local.set({ settings: this.settings });
  }

  // -----------------------------------------------------------
  // Generator factory (cached per locale+domain)
  // -----------------------------------------------------------

  private getGenerator(options?: Partial<GenerationOptions>): DataGenerator {
    const locale = options?.locale ?? this.settings.locale;
    const domain = options?.emailDomain ?? this.settings.defaultEmailDomain;
    const cacheKey = `${locale}|${domain}`;

    const cached = this.generatorCache.get(cacheKey);
    if (cached) return cached;

    // Evict the oldest entry when the cache grows beyond 5 to prevent
    // unbounded memory growth during long service-worker lifetimes.
    if (this.generatorCache.size >= 5) {
      const firstKey = this.generatorCache.keys().next().value;
      if (firstKey !== undefined) this.generatorCache.delete(firstKey);
    }
    const generator = new DataGenerator({ locale, emailDomain: domain });
    this.generatorCache.set(cacheKey, generator);
    return generator;
  }
}
