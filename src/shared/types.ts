// =============================================================
// Field & Form Enumerations
// =============================================================

export type FieldType =
  | 'email'
  | 'phone'
  | 'firstName'
  | 'lastName'
  | 'fullName'
  | 'username'
  | 'password'
  | 'date'
  | 'birthdate'
  | 'address'
  | 'street'
  | 'city'
  | 'state'
  | 'zipcode'
  | 'country'
  | 'company'
  | 'jobTitle'
  | 'url'
  | 'creditCard'
  | 'creditCardExpiry'
  | 'creditCardCvv'
  | 'number'
  | 'currency'
  | 'color'
  | 'range'
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'hidden'
  | 'unknown';

export type FormType =
  | 'signup'
  | 'login'
  | 'payment'
  | 'contact'
  | 'search'
  | 'filter'
  | 'profile'
  | 'checkout'
  | 'multistep'
  | 'unknown';

export type SupportedLocale =
  | 'en-US'
  | 'en-GB'
  | 'de-DE'
  | 'fr-FR'
  | 'es-ES'
  | 'it-IT'
  | 'pt-BR'
  | 'ja-JP'
  | 'ko-KR'
  | 'zh-CN'
  | 'ru-RU'
  | 'nl-NL'
  | 'pl-PL'
  | 'sv-SE';

export type FillSensitivity = 'aggressive' | 'balanced' | 'conservative';

export type AppStatus = 'idle' | 'analyzing' | 'generating' | 'filling' | 'success' | 'error' | 'no-form';

export type ErrorType =
  | 'format'
  | 'required'
  | 'exists'
  | 'length'
  | 'pattern'
  | 'range'
  | 'email'
  | 'phone'
  | 'password'
  | 'date'
  | 'number'
  | 'url'
  | 'username'
  | 'creditCard'
  | 'alphanumeric'
  | 'lettersOnly'
  | 'digitsOnly'
  | 'noSpaces'
  | 'name'
  | 'age'
  | 'zipcode'
  | 'unknown';

// =============================================================
// Field Analysis
// =============================================================

export interface FieldConstraints {
  minLength: number | null;
  maxLength: number | null;
  min: string | number | null;
  max: string | number | null;
  pattern: string | null;
  step: string | number | null;
  required: boolean;
  readOnly: boolean;
  disabled: boolean;
  multiple: boolean;
  accept: string | null;
  /** Available choices for <select>, radio, and checkbox groups */
  options?: SelectOption[];
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface FieldAnalysis {
  /** Stable internal ID for this field */
  id: string;
  index: number;
  type: FieldType;
  /** The raw HTML input type attribute */
  htmlType: string;
  name: string;
  label: string;
  placeholder: string;
  /** The aria-label attribute value (if present) */
  ariaLabel?: string;
  /** CSS class attribute value (if present) */
  className?: string;
  constraints: FieldConstraints;
  required: boolean;
  /** Unique CSS selector to locate this element */
  selector: string;
  /** Index of the parent form */
  formIndex: number;
  /** The generated value to be filled */
  value?: string;
  /** User has opted to skip this field */
  skip?: boolean;
  /** Confidence score (0–1) for the detected type */
  confidence: number;
}

export interface FormAnalysis {
  index: number;
  type: FormType;
  fields: FieldAnalysis[];
  selector: string;
  action: string;
  method: string;
  hasSubmitButton: boolean;
  isMultiStep: boolean;
  currentStep: number;
  totalSteps: number;
  /** ISO timestamp of when the analysis was run */
  analyzedAt: string;
}

// =============================================================
// Data Generation
// =============================================================

export interface GenerationOptions {
  locale: SupportedLocale;
  emailDomain?: string;
  /** When true, related fields (name, email) are derived from the same persona */
  consistentPersona?: boolean;
}

export interface PersonaContext {
  firstName: string;
  lastName: string;
  email?: string;
  username?: string;
}

// =============================================================
// Profiles
// =============================================================

export interface ProfileData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  username?: string;
  password?: string;
  birthdate?: string;
  street?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  country?: string;
  company?: string;
  jobTitle?: string;
  url?: string;
  [key: string]: string | undefined;
}

export interface Profile {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  data: ProfileData;
  locale: SupportedLocale;
  createdAt: string;
  updatedAt: string;
  usageCount: number;
  /** If true, treat as a reusable template */
  template: boolean;
}

// =============================================================
// Settings
// =============================================================

export interface Settings {
  locale: SupportedLocale;
  defaultEmailDomain: string;
  fillSensitivity: FillSensitivity;
  errorRecoveryEnabled: boolean;
  privacyMode: boolean;
  domainWhitelist: string[];
  domainBlacklist: string[];
  autoClearOnClose: boolean;
  skipLoginForms: boolean;
  skipPaymentForms: boolean;
  showPreviewBeforeFill: boolean;
  consistentPersona: boolean;
  /** When true, clicking the extension action will auto-fill forms (opt-out) */
  autoFillOnAction: boolean;
  /** Optional one-time hotkey (canonical string, e.g. "ctrl+shift+f") set from the popup */
  oneClickHotkey?: string;
  /** Enable lightweight telemetry (counts) for fills; anonymous and local-only */
  telemetryEnabled: boolean;
  /** Optional URL to POST anonymised telemetry payloads when `telemetryEnabled` is true */
  telemetryEndpoint?: string;
  maxRetryAttempts: number;
  /** When true, auto-fill new forms after navigation or SPA step changes */
  chainingEnabled: boolean;
  /** Max time (ms) chaining stays active before auto-disabling */
  chainingTimeoutMs: number;
  /** Max number of chained form fills before auto-disabling */
  maxChainSteps: number;
  /** Delay (ms) between chain steps to let pages settle */
  chainingDelayMs: number;
  /** When true, auto-click the submit/next button after filling during chaining */
  autoSubmitOnChaining: boolean;
  /** When true, collect and report radio candidate diagnostics to the background (for debugging) */
  radioDiagnostics: boolean;
  /** When true, auto-fill forms found inside modals/dialogs when they open */
  autoFillModals: boolean;
}

// =============================================================
// Error Recovery
// =============================================================

export interface ErrorMessage {
  text: string;
  fieldName: string | null;
  /** The stable field ID from form analysis (most accurate for matching) */
  fieldId?: string | null;
  type: ErrorType;
  /** CSS selector pointing to the error element */
  elementSelector?: string;
}

export interface ErrorInfo {
  hasError: boolean;
  messages: ErrorMessage[];
  affectedFields: string[];
  severity: 'low' | 'medium' | 'high';
}

export interface RecoveryAction {
  action: 'regenerate' | 'reformat' | 'skip' | 'manual';
  field: string;
  strategy: string;
  newValue?: string;
  constraints?: Partial<FieldConstraints>;
  retryCount: number;
}

export interface RecoveryResult {
  success: boolean;
  actions: RecoveryAction[];
  updatedFields: Array<{ field: string; value: string }>;
  requiresManualIntervention: boolean;
  message?: string;
}

// =============================================================
// Extension Message Passing
// =============================================================

export type MessageAction =
  | 'ANALYZE_FORMS'
  | 'FILL_FORM'
  | 'GET_FORM_DATA'
  | 'UPDATE_FIELD_VALUE'
  | 'DETECT_ERRORS'
  | 'MARK_RECOVERY_SUCCESS'
  | 'GENERATE_DATA_FOR_FORM'
  | 'LIST_PROFILES'
  | 'GET_PROFILE'
  | 'CREATE_PROFILE'
  | 'UPDATE_PROFILE'
  | 'DELETE_PROFILE'
  | 'IMPORT_PROFILE'
  | 'EXPORT_PROFILE'
  | 'GET_SETTINGS'
  | 'UPDATE_SETTINGS'
  | 'RESET_SETTINGS'
  | 'REPORT_FILLED'
  | 'ENABLE_CHAINING'
  | 'DISABLE_CHAINING'
  | 'CHAIN_FILL_REQUEST'
  | 'GET_CHAINING_STATE'
  | 'START_CHAINING'
  | 'GET_CHAIN_LOG'
  | 'AUTO_SUBMIT'
  | 'REPORT_RADIO_DIAGNOSTIC'
  | 'GET_RADIO_DIAGNOSTIC'
  | 'PERFORM_FILL'
  | 'REPORT_DEBUG_LOG'
  | 'GET_DEBUG_LOGS'
  | 'CLEAR_DEBUG_LOGS'
  | 'PING';

// Debug logging messages
export interface DebugLogEntry {
  ts: number;
  source: 'background' | 'content' | 'popup' | string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'log';
  message: string;
  args?: unknown[];
}

export interface RadioDiagnostic {
  /** Approx selector of the chosen element (best-effort) */
  chosenSelector?: string;
  chosenText?: string | null;
  chosenAria?: string | null;
  chosenDataValue?: string | null;
  /** 'native' | 'custom' | 'fallback' */
  kind: string;
  /** Requested/generated value that triggered the pick */
  requestedValue?: string;
  /** Index chosen when index-fallback was used */
  chosenIndex?: number | null;
  candidatesCount?: number | null;
  ts: string;
}

export type MessageActionExtra = 'REPORT_RADIO_DIAGNOSTIC' | 'GET_RADIO_DIAGNOSTIC';

export interface ExtensionMessage<T = unknown> {
  action: MessageAction;
  payload?: T;
}

export interface ExtensionResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// =============================================================
// Storage Schema
// =============================================================

export interface EncryptedBlob {
  iv: number[];
  ciphertext: number[];
}

export interface ErrorLearningEntry {
  fieldType: FieldType;
  errorType: ErrorType;
  attemptedValue: string;
  failedAt: string;
  solution: string;
}
