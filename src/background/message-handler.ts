import type {
  ExtensionMessage,
  ExtensionResponse,
  FormAnalysis,
  GenerationOptions,
  Profile,
  ProfileData,
  Settings,
  SupportedLocale,
} from '@/shared/types';
import { DEFAULT_SETTINGS } from '@/shared/constants';
import { DataGenerator } from './data-generator';
import { ProfileManager } from './profile-manager';
import { ErrorRecoveryEngine } from './error-recovery';
import { deepClone } from '@/shared/utils';

// =============================================================
// MessageHandler – routes all chrome.runtime messages
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
      // Validate endpoint is a safe HTTPS URL
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') return;

      // Respect environments where fetch may not be available
      if (typeof fetch === 'undefined') return;
      await fetch(url.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
      try { console.info('[FDF Telemetry] uploaded failure payload'); } catch (e) { try { console.debug('[FDF Pro] telemetry info log failed', e); } catch {} }
    } catch (err) {
      try { console.warn('[FDF Telemetry] upload failed', err); } catch (e) { try { console.debug('[FDF Pro] telemetry warn log failed', e); } catch {} }
    }
  }

  // -----------------------------------------------------------
  // Entry point
  // -----------------------------------------------------------

  handle(
    message: ExtensionMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: ExtensionResponse) => void,
  ): true {
    this.dispatch(message)
      .then((data) => sendResponse({ success: true, data }))
      .catch((err: Error) => sendResponse({ success: false, error: err.message }));
    // Return true to keep the message channel open for async responses
    return true;
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

        // Optional automatic upload: send anonymised failure payload if telemetry is enabled
        try {
          if (this.settings.telemetryEnabled && this.settings.telemetryEndpoint) {
            const payload = {
              timestamp: new Date().toISOString(),
              errorInfo,
              errorElements: errorElements.map((e) => ({ selector: e.selector, text: e.text })),
              fields: fields.map((f) => ({ id: f.id, type: f.type, name: f.name })),
              recovery,
            };
            void this.uploadTelemetry(payload, this.settings.telemetryEndpoint).catch(() => undefined);
          }
        } catch (e) { try { console.debug('[FDF Pro] telemetry upload try failed', e); } catch {} }

        return { errorInfo, recovery };
      }

      case 'REPORT_FILLED': {
        const { filled } = msg.payload as { filled: Array<{ fieldId: string; selector: string; value: string }> };
        try {
          console.info('[FDF Pro] page reported filled values:', filled.slice(0, 20));
        } catch (e) { try { console.debug('[FDF Pro] report filled log failed', e); } catch {} }
        return null;
      }

      case 'MARK_RECOVERY_SUCCESS': {
        const { fieldType, errorType, successValue } = msg.payload as {
          fieldType: import('@/shared/types').FieldType;
          errorType: import('@/shared/types').ErrorType;
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
  // without going through chrome.runtime messaging. Returns the enriched form.
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
    const stored = await chrome.storage.local.get('settings');
    if (stored.settings) {
      // Merge stored settings with defaults to handle new keys added in updates
      this.settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings>) };
    }
  }

  private async persistSettings(): Promise<void> {
    await chrome.storage.local.set({ settings: this.settings });
  }

  // -----------------------------------------------------------
  // Generator factory (cached per locale+domain)
  // -----------------------------------------------------------

  private getGenerator(options?: Partial<GenerationOptions>): DataGenerator {
    const locale = options?.locale ?? this.settings.locale;
    const domain = options?.emailDomain ?? this.settings.defaultEmailDomain;
    const cacheKey = `${locale}|${domain}`;

    if (!this.generatorCache.has(cacheKey)) {
      this.generatorCache.set(cacheKey, new DataGenerator({ locale, emailDomain: domain }));
    }

    return this.generatorCache.get(cacheKey)!;
  }
}
