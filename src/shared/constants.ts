import type { Settings, SupportedLocale, FieldType } from './types';

// =============================================================
// Default Settings
// =============================================================

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  locale: 'en-US',
  defaultEmailDomain: 'testdomain.com',
  fillSensitivity: 'balanced',
  errorRecoveryEnabled: false,
  privacyMode: false,
  domainWhitelist: [],
  domainBlacklist: ['paypal.com', 'bankofamerica.com', 'chase.com', 'wellsfargo.com'],
  autoClearOnClose: false,
  skipLoginForms: true,
  skipPaymentForms: false,
  showPreviewBeforeFill: true,
  consistentPersona: true,
  autoFillOnAction: true,
  oneClickHotkey: 'ctrl+shift+f',
  telemetryEnabled: false,
  telemetryEndpoint: '',
  maxRetryAttempts: 5,
  chainingEnabled: false,
  chainingTimeoutMs: 600_000,
  maxChainSteps: 10,
  chainingDelayMs: 500,
  autoSubmitOnChaining: false,
  radioDiagnostics: false,
  autoFillModals: false,
};

// =============================================================
// Supported Locale Runtime Array
// Mirrors the SupportedLocale union type for runtime validation.
// =============================================================

export const SUPPORTED_LOCALES: readonly SupportedLocale[] = [
  'en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT',
  'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN', 'ru-RU', 'nl-NL', 'pl-PL', 'sv-SE',
] as const;

// =============================================================
// Locale → Phone Format Map
// =============================================================

export const PHONE_FORMATS: Record<SupportedLocale, string> = {
  'en-US': '###-###-####',
  'en-GB': '020 #### ####',
  'de-DE': '+49 30 ########',
  'fr-FR': '+33 1 ## ## ## ##',
  'es-ES': '+34 ### ### ###',
  'it-IT': '+39 02 #### ####',
  'pt-BR': '+55 11 9####-####',
  'ja-JP': '090-####-####',
  'ko-KR': '010-####-####',
  'zh-CN': '139 #### ####',
  'ru-RU': '+7 (###) ###-##-##',
  'nl-NL': '06 ## ## ## ##',
  'pl-PL': '+48 ### ### ###',
  'sv-SE': '070-### ## ##',
};

// =============================================================
// Test Card Numbers (safe to generate, will not charge)
// =============================================================

export const TEST_CREDIT_CARDS: Record<string, string> = {
  visa: '4111111111111111',
  visaDebit: '4000056655665556',
  mastercard: '5555555555554444',
  mastercardDebit: '5200828282828210',
  amex: '378282246310005',
  discover: '6011111111111117',
  dinersClub: '3056930009020004',
  jcb: '3566002020360505',
  unionpay: '6200000000000005',
};

// =============================================================
// Field-Type Detection Patterns
// (ordered by priority—most specific first)
// =============================================================

export const FIELD_PATTERNS: Record<FieldType, RegExp> = {
  email: /\bemail\b|e-mail|mail(?!box)|inbox|address.*mail/i,
  phone:
    /\bphone\b|\btel(?:ephone)?\b|\bmobile\b|\bcell\b|\bcontact.?number\b|\bsms\b/i,
  password: /password|passwd|passwrd|pwd|secret|passphrase/i,
  firstName: /first.?name|given.?name|forename|fname/i,
  lastName: /last.?name|surname|family.?name|lname/i,
  fullName: /full.?name|your.?name|display.?name/i,
  username: /username|user.?name|user.?id|login|handle|nick/i,
  birthdate: /birth|dob|born|date.?of.?birth/i,
  date: /\bdate\b|datetime|when|due.?date|expire|expir/i,
  creditCard: /card.?number|credit.?card|cc.?number|pan\b|card.?num/i,
  creditCardExpiry: /expir|exp.?date|mm\s*\/\s*yy|validity/i,
  creditCardCvv: /\bcvv\b|\bcvc\b|\bcsc\b|\bsecurity.?code\b|card.?code/i,
  address: /^address$|billing.?address|shipping.?address|home.?address/i,
  street: /street|address.?line|addr\d?|house.?no|building/i,
  city: /\bcity\b|\btown\b|\blocality\b|\bsuburb\b/i,
  state:
    /\bstate\b|\bprovince\b|\bregion\b|\bcounty\b|\bprefecture\b/i,
  zipcode: /zip\b|postal|postcode|pin.?code/i,
  country: /\bcountry\b|\bnation\b/i,
  company: /company|organisation|organization|employer|firm|business/i,
  jobTitle: /job.?title|\bposition\b|\bdesignation\b|\boccupation\b/i,
  url: /\burl\b|\bwebsite\b|\bweb.?page\b|\blink\b|\bhomepage\b/i,
  currency: /price|amount|cost|total|fee|rate|salary|wage|budget/i,
  number: /number|quantity|count|age\b|size\b|score\b/i,
  text: /comment|remark|note|bio|about|description|message/i,
  textarea: /comment|remark|note|bio|about|description|message/i,
  select: /\bselect\s+(a|an|one|your)\b|\bchoose\s+(a|an|one|your)\b/i,
  checkbox: /agree|accept|consent|subscribe|newsletter/i,
  radio: /gender|sex\b|\bradio\b/i,
  color: /colou?r/i,
  range: /range|level|rating|slider/i,
  file: /file|attachment|upload|document/i,
  hidden: /hidden/i,
  unknown: /./,
};

// =============================================================
// Error Pattern Classifiers
// =============================================================

// Note: Order matters – more specific patterns must come before generic ones.
export const ERROR_PATTERNS: Record<string, RegExp> = {
  // --- Uniqueness / duplication ---
  exists: /already exists|already registered|already.*(?:in use|taken)|duplicate|not available|try (a )?different|is taken|in use by another|choose another/i,

  // --- Length ---
  length: /too short|too long|at least \d+\s*char|maximum \d+\s*char|must be \d+ char|minimum \d+\s*char|\d+\s*characters? or (less|fewer|more)|\d+\s*to\s*\d+\s*char|must not exceed \d+|no more than \d+\s*char|no fewer than \d+|at most \d+\s*char|between \d+ and \d+ characters?/i,

  // --- Credit card (before number to prevent "card number" matching number) ---
  creditCard: /invalid (card|credit)|card number.*(invalid|not valid)|not a valid (card|credit)|luhn|card is (invalid|declined|expired)|invalid (cvv|cvc|security code)|card.*(rejected|failed)|card number is invalid/i,

  // --- Age / DOB (before range to prevent "must be at least 18 years" matching range) ---
  age: /must be (at least )?\d+ years?|under ?age|age restriction|age requirement|\d+\s*years? (old|of age)|not old enough|too young|age must/i,

  // --- Zipcode / postal (before phone to prevent "5 digits" matching phone) ---
  zipcode: /invalid (zip|postal)|zip\s*code.*(invalid|format|must|\d+ digit)|postal\s*code.*(invalid|format)|enter.*valid (zip|postal)|not a valid (zip|postal)|\d+\s*-?\s*digit.*(zip|postal)/i,

  // --- Numeric range ---
  range: /must be between \d|out of range|minimum.*maximum|value.*\d.*and.*\d|greater than|less than|minimum value|maximum value|cannot exceed|too small|too large|must be at least \d|must be no more|must not be (less|greater|more)|below (\d|the min)|above (\d|the max)|lower\s*than|higher\s*than/i,

  // --- Number / numeric ---
  number: /must be a number|not a (valid )?number|numeric (value|only)|enter a (valid )?(number|integer)|is not a number|expected.*number|should be (a )?number|integer only|whole number|must be numeric|invalid number|number is invalid|not an? (integer|number)|valid integer/i,

  // --- Password ---
  password: /weak password|password must|password does not|at least one (uppercase|lowercase|digit|number|special)|special character|password.*(short|weak|strong|complexity|requirements?)|must include.*[A-Z]|must include.*\d|must include.*[a-z]|password too|must contain (a |at least (one )?)?(digit|number|uppercase|lowercase|special)/i,

  // --- Email ---
  email: /invalid email|email already|email is (invalid|not valid)|valid email|not a valid email|email (address|format)|enter.*email|provide.*email|email.*incorrect/i,

  // --- Phone ---
  // Deliberately anchors the "N digit" phrasing to actual phone context —
  // an unanchored `must be \d+ digit` also matches unrelated fields like
  // "Routing number must be 9 digits" or "Enter 5 digit code", silently
  // misclassifying them as phone numbers.
  phone: /invalid phone|phone number|phone.*must be \d+ digit|must be \d+ digit.*phone|valid phone|not a valid phone|phone.*format|contact number|telephone.*invalid|mobile.*invalid|enter.*phone/i,

  // --- Date ---
  date: /invalid date|date format|must be a (valid )?date|date must|valid date|not a valid date|date is (invalid|not valid)|before today|after today|future date|past date|date.*required|date cannot be (in the past|in the future|before|after)/i,

  // --- URL ---
  url: /invalid url|valid url|not a valid url|url format|must (be|start with) https?|enter.*url|valid link|invalid link|url is (invalid|not valid)|web\s*site.*address|invalid.*web\s*site|web address/i,

  // --- Username ---
  username: /username.*(taken|not available|invalid|already|exists|in use)|invalid username|choose.*(a different|another) username|username.*format|username must|user.?name.*not available/i,

  // --- Alphanumeric only ---
  alphanumeric: /must only contain letters and numbers|only.*alphanumeric|must be alphanumeric|letters.*numbers only|alphanumeric only|can only contain.*letters.*numbers|should only contain.*alphanumeric/i,

  // --- Letters only ---
  lettersOnly: /only.*letters|letters only|alphabetic (only|characters)|must contain only letters|must be alphabetic|no numbers|cannot contain (numbers|digits)|only alphabetical|only contain.*alpha/i,

  // --- Digits only ---
  // The trailing `\d+\s*-?\s*digit` alternative is a generic catch-all for
  // "Enter N digit code/OTP/PIN" style messages that name no specific field
  // type (no zip/postal/phone keyword) — by the time classification reaches
  // here, more specific digit-count patterns (zipcode, phone, age, range)
  // have already matched and consumed those cases.
  digitsOnly: /only.*digits|digits only|numbers only|numeric only|must contain only (digits|numbers)|only numbers|only numeric|numeric characters only|\d+\s*-?\s*digit/i,

  // --- No spaces ---
  noSpaces: /no spaces|cannot contain spaces|spaces\s*(not|aren't|are not)\s*allowed|must not contain spaces|without spaces|remove spaces|whitespace\s*(not|are not)\s*allowed|no whitespace/i,

  // --- Pattern (general) ---
  pattern: /does not match|match the (pattern|format)|allowed characters|must only contain|only contain|can only contain|should only contain|may only contain|must contain only|no special characters?|special characters? (not |are not |aren't )allowed|characters? not (allowed|permitted)|invalid characters?|does not contain/i,

  // --- Name ---
  name: /invalid name|name.*(invalid|not valid)|not a valid name|name cannot contain|name must|enter.*valid name|first name.*(invalid|not valid)|last name.*(invalid|not valid)|full name.*(invalid|not valid)/i,

  // --- Required ---
  required: /required|mandatory|must fill|cannot be empty|missing|blank|obligatory|can'?t be (blank|empty)|please (enter|fill|provide|select|choose)|this field is|must not be empty|field is empty|value is required|is a required/i,

  // --- Format (general) ---
  format: /invalid format|wrong format|must be in .+ format|not (in )?the (correct|right|proper|expected) format|format is (invalid|wrong|incorrect)|incorrect format|improper format|value.*(is not|not)\s*valid|not a valid (value|input|entry)/i,
};

// =============================================================
// Error Element Selectors
// =============================================================

export const ERROR_SELECTORS = [
  '[role="alert"]',
  '.error-message',
  '.error',
  '.text-error',
  '.invalid-feedback',
  '.field-error',
  '.form-error',
  '.alert-danger',
  '.alert-error',
  '[class*="error"]',
  '[class*="invalid"]',
  'span[style*="color: red"]',
  'div.ng-invalid ~ div',
  '[aria-invalid="true"] + *',
  '.help-block',
  '.form-text.text-danger',
  // Server-side error markers on the input itself
  'input.error-input + *',
  'input.error-input ~ div',
  // Bootstrap 5: .is-invalid sibling feedback
  'input.is-invalid ~ .invalid-feedback',
  'select.is-invalid ~ .invalid-feedback',
  'textarea.is-invalid ~ .invalid-feedback',
  'input.is-invalid + .invalid-feedback',
  // Angular Material
  'mat-error',
  '.mat-mdc-form-field-error',
  '.mat-error',
  // Vuetify
  '.v-messages__message',
  '.v-input--error .v-messages__message',
  // Element UI / Element Plus
  '.el-form-item__error',
  // Ant Design
  '.ant-form-item-explain-error',
  '.ant-form-item-explain .ant-form-item-explain-error',
  // Chakra UI
  '.chakra-form__error-message',
  // Tailwind / Headless UI patterns
  '[class*="text-red"]',
  '[class*="text-danger"]',
  // PrimeNG / PrimeVue
  '.p-error',
  '.p-invalid + small',
  // React Hook Form / Formik
  '[id$="-error"]',
  '[id$="-helper-text"].Mui-error',
  // MUI (Material UI)
  '.Mui-error',
  '.MuiFormHelperText-root.Mui-error',
  // General  – aria-errormessage reference
  '[aria-errormessage]',
];

// =============================================================
// Storage Keys
// =============================================================

export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  PROFILE_IDS: 'profileIds',
  ENCRYPTION_KEY: 'encryptionKeyMaterial',
  ERROR_LEARNING: 'errorLearning',
  TELEMETRY: 'telemetry',
  profileKey: (id: string) => `profile_${id}` as const,
} as const;

// =============================================================
// Extension Internal Limits
// =============================================================

export const LIMITS = {
  MAX_PROFILES: 100,
  MAX_RETRY_ATTEMPTS: 5,
  MAX_FORM_FIELDS: 200,
  PASSWORD_DEFAULT_LENGTH: 14,
  ANALYSIS_DEBOUNCE_MS: 300,
  ERROR_OBSERVER_DEBOUNCE_MS: 500,
} as const;

// =============================================================
// UI Locale Labels
// =============================================================

export const LOCALES: [SupportedLocale, string][] = [
  ['en-US', '🇺🇸 English (US)'],
  ['en-GB', '🇬🇧 English (UK)'],
  ['de-DE', '🇩🇪 German'],
  ['fr-FR', '🇫🇷 French'],
  ['es-ES', '🇪🇸 Spanish'],
  ['it-IT', '🇮🇹 Italian'],
  ['pt-BR', '🇧🇷 Portuguese (BR)'],
  ['ja-JP', '🇯🇵 Japanese'],
  ['ko-KR', '🇰🇷 Korean'],
  ['zh-CN', '🇨🇳 Chinese (Simplified)'],
  ['ru-RU', '🇷🇺 Russian'],
  ['nl-NL', '🇳🇱 Dutch'],
  ['pl-PL', '🇵🇱 Polish'],
  ['sv-SE', '🇸🇪 Swedish'],
];

// =============================================================
// Layer 4: inputmode attribute → FieldType mapping
// =============================================================

export const INPUTMODE_FIELD_MAP: Readonly<Partial<Record<string, FieldType>>> = {
  numeric: 'number',
  decimal: 'number',
  email: 'email',
  tel: 'phone',
  url: 'url',
};

// data-* attribute names to scan for FieldType hints
export const DATA_ATTRIBUTE_NAMES: readonly string[] = [
  'data-type',
  'data-field',
  'data-field-type',
  'data-format',
  'data-validate',
  'data-input-type',
];

// =============================================================
// Context-chain inference rules (second pass after field detection)
// When a high-confidence neighbor is seen, an adjacent low-confidence
// fallback field can be promoted to a specific FieldType.
// =============================================================

export const FIELD_CONTEXT_CHAINS: ReadonlyArray<{
  /** Neighboring field type(s) that trigger the rule */
  anchor: FieldType[];
  /** Where the low-confidence field sits relative to the anchor */
  position: 'after' | 'before';
  /** Type to assign to the low-confidence field */
  infer: FieldType;
}> = [
  { anchor: ['firstName'], position: 'after', infer: 'lastName' },
  { anchor: ['lastName'], position: 'before', infer: 'firstName' },
  { anchor: ['creditCard'], position: 'after', infer: 'creditCardExpiry' },
  { anchor: ['creditCardExpiry'], position: 'after', infer: 'creditCardCvv' },
  { anchor: ['address', 'street'], position: 'after', infer: 'city' },
  { anchor: ['city'], position: 'after', infer: 'state' },
  { anchor: ['state'], position: 'after', infer: 'zipcode' },
  { anchor: ['zipcode'], position: 'after', infer: 'country' },
];

// =============================================================
// Layer 5: Section heading keywords → expected field types nearby
// =============================================================

export const SECTION_HEADING_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  types: FieldType[];
}> = [
  { pattern: /payment|credit.?card/i, types: ['creditCard', 'creditCardExpiry', 'creditCardCvv'] },
  { pattern: /billing/i, types: ['street', 'city', 'state', 'zipcode', 'country'] },
  { pattern: /shipping|delivery/i, types: ['street', 'city', 'state', 'zipcode', 'country'] },
  { pattern: /personal|profile/i, types: ['firstName', 'lastName', 'fullName', 'birthdate'] },
  { pattern: /contact/i, types: ['email', 'phone'] },
  { pattern: /company|work|employer/i, types: ['company', 'jobTitle'] },
];
