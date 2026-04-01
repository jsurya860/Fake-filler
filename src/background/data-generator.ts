import {
  Faker,
  en,
  de,
  fr,
  es,
  it,
  pt_BR,
  ja,
  ko,
  zh_CN,
  ru,
  nl,
  pl,
  sv,
} from '@faker-js/faker';
import type { LocaleDefinition } from '@faker-js/faker';
import type {
  FieldAnalysis,
  GenerationOptions,
  PersonaContext,
  SupportedLocale,
} from '@/shared/types';
import {
  PHONE_FORMATS,
  TEST_CREDIT_CARDS,
  LIMITS,
} from '@/shared/constants';
import {
  replacePlaceholders,
  randomInt,
  pick,
  shuffleInPlace,
  toISODate,
  randomDate,
  isLuhnValid,
  generateId,
} from '@/shared/utils';

// =============================================================
// Locale → Faker locale mapping
// =============================================================

const LOCALE_MAP: Record<SupportedLocale, LocaleDefinition> = {
  'en-US': en,
  'en-GB': en,
  'de-DE': de,
  'fr-FR': fr,
  'es-ES': es,
  'it-IT': it,
  'pt-BR': pt_BR,
  'ja-JP': ja,
  'ko-KR': ko,
  'zh-CN': zh_CN,
  'ru-RU': ru,
  'nl-NL': nl,
  'pl-PL': pl,
  'sv-SE': sv,
};

// =============================================================
// DataGenerator
// =============================================================

export class DataGenerator {
  private faker: Faker;
  private locale: SupportedLocale;
  private emailDomain: string;

  constructor(options: Partial<GenerationOptions> = {}) {
    this.locale = options.locale ?? 'en-US';
    this.emailDomain = options.emailDomain ?? 'testdomain.com';
    this.faker = new Faker({ locale: [LOCALE_MAP[this.locale], en] });
  }

  // -----------------------------------------------------------
  // Public: generate data for the whole form at once
  // -----------------------------------------------------------

  generateForForm(
    fields: FieldAnalysis[],
    consistentPersona = true,
  ): Map<string, string> {
    const results = new Map<string, string>();

    const persona: PersonaContext | null = consistentPersona
      ? this.buildPersona()
      : null;

    const skippedFields: string[] = [];
    const retiredFields: string[] = [];

    // Track a single generated password for the form so password + confirm match
    let formPassword: string | null = null;

    for (const field of fields) {
      if (field.skip) {
        skippedFields.push(field.id || field.name || field.selector);
        continue;
      }
      if (field.constraints.readOnly || field.constraints.disabled) {
        retiredFields.push(field.id || field.name || field.selector);
        continue;
      }

      // Password / confirm handling: ensure confirm fields match the generated password
      const hint = [field.name, field.label, field.placeholder, field.ariaLabel, field.className, field.id].filter(Boolean).join(' ').toLowerCase();
      const isPasswordHint = /\b(password|passwd|pwd|passphrase|new password|current password)\b/.test(hint);
      const isConfirmHint = /\b(confirm|confirmation|verify|re-?enter|repeat)\b/.test(hint) && /password|passwd|pwd/.test(hint);

      if (isConfirmHint) {
        if (!formPassword) formPassword = this.generatePassword(null, null);
        results.set(field.id, formPassword);
        continue;
      }

      if (isPasswordHint) {
        if (!formPassword) formPassword = this.generatePassword(null, null);
        results.set(field.id, formPassword);
        continue;
      }

      const value = this.generateForField(field, persona);
      if (value !== null) {
        results.set(field.id, value);
      }
    }
    
    try {
      // Debug: log a small sample of generated values and skipped/retired fields
      const sample: Record<string, string> = {};
      for (const [k, v] of Array.from(results.entries()).slice(0, 10)) sample[k] = v;
      // Service worker console
      // eslint-disable-next-line no-console
      console.info('[FDF Pro] Generated values sample:', sample,
        { skipped: skippedFields, retired: retiredFields });
    } catch (e) {
      try { console.debug('[FDF Pro] Generated sample logging failed', e); } catch {}
    }

    return results;
  }

  // -----------------------------------------------------------
  // Public: generate a single value for one field
  // -----------------------------------------------------------

  generateForField(field: FieldAnalysis, persona: PersonaContext | null = null): string | null {
    const constraints = field.constraints;
    // Quick hint-based inference: if a field is generic `text`/`textarea`,
    // try to infer a more specific intent from the field's `name`, `label`,
    // or `placeholder` to avoid producing lorem for obvious name/phone fields.
    let effectiveType = field.type;
    const hint = [field.name, field.label, field.placeholder, field.ariaLabel, field.className, field.id].filter(Boolean).join(' ').toLowerCase();
    try {
      if (effectiveType === 'text' || effectiveType === 'textarea') {
        if (/\b(firstname|first name|given name|nombre|prenom)\b/.test(hint)) effectiveType = 'firstName';
        else if (/\b(lastname|last name|surname|apellido|nom de famille)\b/.test(hint)) effectiveType = 'lastName';
        else if (/\b(full ?name|nombre completo|nom complet)\b/.test(hint)) effectiveType = 'fullName';
        else if (/\b(email|e-?mail|correo)\b/.test(hint)) effectiveType = 'email';
        else if (/\b(phone|tel|telephone|mobile|telefono|movil)\b/.test(hint)) effectiveType = 'phone';
        else if (/\b(company|organisation|empresa|compañía)\b/.test(hint)) effectiveType = 'company';
        else if (/\b(city|town|locality|ciudad)\b/.test(hint)) effectiveType = 'city';
        else if (/\b(address|direccion|adresse)\b/.test(hint)) effectiveType = 'address';
      }
    } catch {
      // ignore inference errors
    }

    // Additional hint-driven short-circuit generators for common patterns
    // that don't map cleanly to a FieldType but should not be lorem text.
    // Skip for date-like HTML types — they must produce proper date/time values
    // regardless of what the field name implies (e.g. passportExpiry, licenseExpiry).
    const isDateLikeHtml = ['date', 'time', 'datetime-local', 'month', 'week'].includes(field.htmlType ?? '');
    if (!isDateLikeHtml) {
    try {
      // hint already computed above

      // Plain "code" fields (e.g., "plan code", "carrier code", "code") → varchar: letter + numbers like `M100`
      // Must be checked BEFORE plan/product hint to avoid generating names for "Plan Code"
      // Exclude postal/zip/pin codes, IFSC, SWIFT, and other specific code types
      if ((/\bcode\b/.test(hint) || /code$/.test((field.name || '').toLowerCase()) || /code$/.test((field.label || '').toLowerCase()))
          && !/postal|zip|pin|area|ifsc|swift|bic|routing|sort|promo|coupon|voucher|token|discount/i.test(hint)) {
        return this.generateVarchar(constraints);
      }

      // Plan group / group name → short descriptive group label
      if (/\bplan\s*group|group\s*name\b/.test(hint)) {
        const groups = ['Individual', 'Family', 'Employee Only', 'Employee + Spouse',
          'Corporate', 'Small Business', 'Association', 'Medicare', 'Senior', 'Young Adult'];
        return pick(groups);
      }

      // Carrier plan name → insurance-style carrier plan name
      if (/\bcarrier\s*plan\s*name\b/.test(hint)) {
        const carriers = ['BlueCross', 'Aetna', 'Cigna', 'United', 'Humana', 'Kaiser', 'Anthem'];
        const types = ['PPO', 'HMO', 'EPO', 'POS', 'HDHP', 'Indemnity'];
        const tiers = ['Basic', 'Standard', 'Premium', 'Gold', 'Silver', 'Bronze', 'Platinum'];
        return `${pick(carriers)} ${pick(tiers)} ${pick(types)}`;
      }

      // Plan / product name → contextual insurance-style plan names
      if (/\b(plan\s*name|plan|product|package)\b/.test(hint)) {
        const planTypes = ['Premium', 'Standard', 'Basic', 'Gold', 'Silver',
          'Bronze', 'Platinum', 'Essential', 'Select', 'Advantage'];
        const planCats = ['Health', 'Dental', 'Vision', 'Life', 'Wellness',
          'Care', 'Shield', 'Guard', 'Cover', 'Plus'];
        const planSuffix = ['Plan', 'Package', 'Program', 'Benefits'];
        return `${pick(planTypes)} ${pick(planCats)} ${pick(planSuffix)}`;
      }

      // Promo / coupon-like fields → hyphenated alphanumeric
      if (/\b(?:coupon|promo|voucher|token)\b/.test(hint)) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const parts = [8, 4].map((len) =>
          Array.from({ length: len }, () => chars[randomInt(0, chars.length - 1)]).join(''),
        );
        return parts.join('-');
      }

      // ---- Banking / financial document fields ----
      // Bank account numbers: 10-20 digits
      if (/\b(bank\s*account|account\s*number|acct\s*no|acct\s*number)\b/.test(hint)) {
        const len = randomInt(10, 16);
        return Array.from({ length: len }, () => String(randomInt(0, 9))).join('');
      }

      // Routing / ABA / sort code: exactly 9 digits
      if (/\b(routing|aba|sort\s*code)\b/.test(hint)) {
        return Array.from({ length: 9 }, () => String(randomInt(0, 9))).join('');
      }

      // IFSC code: 11 uppercase alphanumeric (typically 4 letters + 0 + 6 digits)
      if (/\bifsc\b/.test(hint)) {
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const prefix = Array.from({ length: 4 }, () => letters[randomInt(0, 25)]).join('');
        const suffix = Array.from({ length: 6 }, () => String(randomInt(0, 9))).join('');
        return `${prefix}0${suffix}`;
      }

      // SWIFT / BIC code: 8-11 uppercase alphanumeric
      if (/\b(swift|bic)\b/.test(hint)) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const len = randomInt(8, 11);
        return Array.from({ length: len }, () => chars[randomInt(0, chars.length - 1)]).join('');
      }

      // Tax ID / PAN / TIN / EIN: 10-12 uppercase alphanumeric
      if (/\b(tax\s*id|pan\b|tin\b|ein\b)\b/.test(hint)) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const len = randomInt(10, 12);
        return Array.from({ length: len }, () => chars[randomInt(0, chars.length - 1)]).join('');
      }

      // Passport number: 6-9 uppercase alphanumeric (letter prefix + digits)
      if (/\bpassport\b/.test(hint)) {
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const prefix = Array.from({ length: 2 }, () => letters[randomInt(0, 25)]).join('');
        const digits = Array.from({ length: randomInt(6, 8) }, () => String(randomInt(0, 9))).join('');
        return `${prefix}${digits}`;
      }

      // National ID / citizen ID / NIC: 11-15 digits with optional hyphens
      if (/\b(national\s*id|citizen|nic\b)\b/.test(hint)) {
        const totalDigits = randomInt(11, 15);
        const digits = Array.from({ length: totalDigits }, () => String(randomInt(0, 9))).join('');
        // Insert hyphens every 4-5 chars for readability
        const parts: string[] = [];
        for (let i = 0; i < digits.length; i += 4) {
          parts.push(digits.slice(i, i + 4));
        }
        return parts.join('-');
      }

      // Visa number (document, not credit card): 5-10 uppercase alphanumeric
      if (/\bvisa\s*(number|no)\b/.test(hint) || (hint.includes('visa') && !hint.includes('card'))) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const len = randomInt(8, 12);
        return Array.from({ length: len }, () => chars[randomInt(0, chars.length - 1)]).join('');
      }

      // Driving license: 5-15 uppercase alphanumeric
      if (/\b(driving|license|licence|dl\b)\b/.test(hint)) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const len = randomInt(8, 15);
        return Array.from({ length: len }, () => chars[randomInt(0, chars.length - 1)]).join('');
      }

      // Numeric IDs / reference numbers
      if (/\b(id|ref(?:erence)?\s*no|order\s*no|order\s*number|account\s*no|acct)\b/.test(hint)) {
        return String(randomInt(100000, 9999999));
      }

      // Price / amount-like fields
      if (/\b(price|amount|cost|total|fee)\b/.test(hint)) {
        return this.generateCurrency(constraints.min, constraints.max);
      }

      // Quantity fields
      if (/\b(qty|quantity|count)\b/.test(hint)) {
        return String(randomInt(1, 100));
      }

      // SSN-like fields
      if (/\b(ssn|social\s*security)\b/.test(hint)) {
        const a = String(randomInt(100, 899)).padStart(3, '0');
        const b = String(randomInt(10, 99)).padStart(2, '0');
        const c = String(randomInt(1000, 9999)).padStart(4, '0');
        return `${a}-${b}-${c}`;
      }
      // IP address fields
      if (/\b(ip|ip address|ipv4|ipv6|ipaddr)\b/.test(hint)) {
        return this.generateIp();
      }
    } catch {
      // swallow hint-gen failures
    }
    } // end !isDateLikeHtml

    // For non-checkbox fields with options (radios, selects), pick one value.
    // Checkboxes are handled separately in the switch below.
    if (constraints.options && constraints.options.length > 0 && effectiveType !== 'checkbox') {
      const choice = pick(constraints.options);
      return choice.value;
    }

    let value: string | null = null;

    switch (effectiveType) {
      case 'email':
        value = this.generateEmail(persona);
        break;
      case 'phone': {
        let phone = this.generatePhoneFromHint(hint);
        // If field has a pattern constraint, verify the generated phone matches it
        if (constraints.pattern && constraints.pattern.length <= 200 && phone) {
          try {
            const re = new RegExp(constraints.pattern);
            if (!re.test(phone)) {
              // Try alternate formats
              const digits = phone.replace(/\D/g, '').slice(-10);
              if (digits.length >= 10) {
                const candidates = [
                  `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6, 10)}`,
                  `${digits.slice(0, 3)}${digits.slice(3, 6)}${digits.slice(6, 10)}`,
                  `(${digits.slice(0, 3)})${digits.slice(3, 6)}-${digits.slice(6, 10)}`,
                  `+1${digits}`,
                ];
                for (const c of candidates) {
                  if (re.test(c)) { phone = c; break; }
                }
              }
            }
          } catch {}
        }
        value = phone;
        break;
      }
      case 'firstName':
        value = persona?.firstName ?? this.faker.person.firstName();
        break;
      case 'lastName':
        value = persona?.lastName ?? this.faker.person.lastName();
        break;
      case 'fullName':
        value = persona
          ? `${persona.firstName} ${persona.lastName}`
          : this.faker.person.fullName();
        break;
      case 'username':
        value = persona?.username ?? this.generateUsername(persona);
        break;
      case 'password':
        value = this.generatePassword(constraints.minLength, constraints.pattern);
        break;
      case 'birthdate':
        value = this.generateBirthdate();
        break;
      case 'date':
        // Use htmlType to determine the right format for date-like inputs
        if (field.htmlType === 'time') {
          value = this.generateTime();
        } else if (field.htmlType === 'datetime-local') {
          value = this.generateDatetimeLocal(hint);
        } else if (field.htmlType === 'month') {
          value = this.generateMonth();
        } else if (field.htmlType === 'week') {
          value = this.generateWeek();
        } else {
          value = this.generateDate(constraints.min, constraints.max, hint);
        }
        break;
      case 'street':
        value = this.faker.location.streetAddress();
        break;
      case 'address':
        // Build a single-line address combining street, city, state, and zipcode
        try {
          const street = this.faker.location.streetAddress(true);
          const city = this.faker.location.city();
          const state = this.faker.location.state();
          const zip = this.faker.location.zipCode();
          const country = this.faker.location.country();
          value = `${street}, ${city}${state ? ', ' + state : ''} ${zip}, ${country}`;
        } catch {
          value = this.faker.location.streetAddress(true);
        }
        break;
      case 'city':
        value = this.faker.location.city();
        break;
      case 'state':
        value = this.faker.location.state();
        break;
      case 'zipcode': {
        // Generate numeric-only zip code to satisfy common patterns like ^[0-9]{5,10}$
        const zipMatch = constraints.pattern ? /\{(\d+)/.exec(constraints.pattern) : null;
        const zipLen = zipMatch ? parseInt(zipMatch[1], 10) : 5;
        value = Array.from({ length: zipLen }, () => String(randomInt(0, 9))).join('');
        break;
      }
      case 'country':
        value = this.faker.location.country();
        break;
      case 'company':
        value = this.faker.company.name();
        break;
      case 'jobTitle':
        value = this.faker.person.jobTitle();
        break;
      case 'url':
        value = this.faker.internet.url();
        break;
      case 'creditCard':
        value = pick(Object.values(TEST_CREDIT_CARDS));
        break;
      case 'creditCardExpiry':
        value = this.generateCardExpiry();
        break;
      case 'creditCardCvv':
        value = String(randomInt(100, 999));
        break;
      case 'currency':
        value = this.generateCurrency(constraints.min, constraints.max);
        break;
      case 'number':
        value = this.generateNumber(constraints);
        break;
      case 'range':
        value = this.generateNumber(constraints);
        break;
      case 'color':
        value = this.faker.color.rgb({ format: 'hex', prefix: '#' });
        break;
      case 'textarea':
      case 'text':
        value = this.generateText(constraints.minLength, constraints.maxLength);
        break;
      case 'checkbox':
        // Required checkboxes (e.g., terms & conditions) are always checked.
        // Non-required checkboxes are randomly checked (~50% chance).
        value = constraints.required ? 'true' : (Math.random() < 0.5 ? 'true' : 'false');
        break;
      case 'radio':
        value = constraints.options ? pick(constraints.options).value : 'option1';
        break;
      case 'hidden':
      case 'file':
        return null;
      default:
        value = this.generateText(constraints.minLength, constraints.maxLength);
    }

    // Safety net: if the htmlType requires a specific format but the type
    // detection missed it, override with the correct generator.
    if (value && field.htmlType) {
      const ht = field.htmlType;
      if (ht === 'time' && !/^\d{2}:\d{2}/.test(value)) {
        value = this.generateTime();
      } else if (ht === 'datetime-local' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
        value = this.generateDatetimeLocal(hint);
      } else if (ht === 'month' && !/^\d{4}-\d{2}$/.test(value)) {
        value = this.generateMonth();
      } else if (ht === 'week' && !/^\d{4}-W\d{2}$/.test(value)) {
        value = this.generateWeek();
      }
    }

    // Apply maxLength trimming if needed
    if (value && constraints.maxLength && value.length > constraints.maxLength) {
      value = value.slice(0, constraints.maxLength);
    }

    return value;
  }

  // -----------------------------------------------------------
  // Individual generators
  // -----------------------------------------------------------

  generateEmail(persona: PersonaContext | null = null): string {
    // Short email format. If a persona with lastName is provided include it
    // Prefer the configured `emailDomain` when present to satisfy deterministic tests
    const first = (persona?.firstName ?? this.faker.person.firstName())
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 5);
    const last = (persona?.lastName ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);

    // Use timestamp-derived suffix for uniqueness when no persona is provided;
    // otherwise use a short random 2-3 digit suffix for readability.
    let suffix: string;
    if (!persona) {
      const ts = Date.now();
      suffix = String(ts % 10000).padStart(4, '0');
    } else {
      const digitCount = Math.random() < 0.6 ? 2 : 3;
      suffix = String(randomInt(Math.pow(10, digitCount - 1), Math.pow(10, digitCount) - 1));
    }

    // Domain: prefer configured domain when available, otherwise pick a common one
    const commonDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'example.com'];
    const domain = this.emailDomain && this.emailDomain.trim().length > 0
      ? this.emailDomain
      : pick(commonDomains);

    // Build local part. If persona.lastName provided, include both names but
    // keep the address short/readable by using a small numeric suffix and
    // truncating the first name if absolutely necessary (preserve last name).
    const MAX_TOTAL = 30; // allow a bit more room but keep addresses concise
    const maxLocal = Math.max(1, MAX_TOTAL - 1 - domain.length);

    if (last) {
      const base = `${first}.${last}`;
      // Try with chosen suffix first
      let local = `${base}${suffix}`;
      if (local.length > maxLocal) {
        // Reduce suffix length if possible (try 2 -> 1)
        if (suffix.length > 1) {
          suffix = suffix.slice(0, 2);
          local = `${base}${suffix}`;
        }
      }
      if (local.length > maxLocal) {
        // As a last resort, truncate the first name portion but keep last name intact
        const reservedForLast = last.length + 1 + suffix.length; // dot + last + suffix
        const allowedFirst = Math.max(1, maxLocal - reservedForLast);
        const truncatedFirst = first.slice(0, allowedFirst);
        local = `${truncatedFirst}.${last}${suffix}`;
      }
      return `${local}@${domain}`;
    }

    // No last name: simple local part and enforce max length
    let local = `${first}${suffix}`;
    if (local.length > maxLocal) {
      local = local.slice(0, maxLocal);
    }
    return `${local}@${domain}`;
  }

  generatePhone(): string {
    const format = PHONE_FORMATS[this.locale];
    if (format) return replacePlaceholders(format);
    // Fallback: use faker's phone number formatting for the locale
    try {
      return this.faker.phone.number();
    } catch {
      return replacePlaceholders(PHONE_FORMATS['en-US']);
    }
  }

  generatePhoneFromHint(hint: string): string {
    try {
      const h = (hint || '').toLowerCase();
      // Quick mapping of country keywords to supported locales
      const mapping: Array<{ re: RegExp; locale: SupportedLocale }> = [
        { re: /\b(us|usa|united states|america)\b/, locale: 'en-US' },
        { re: /\b(uk|gb|united kingdom|britain)\b/, locale: 'en-GB' },
        { re: /\b(germany|deutschland|de)\b/, locale: 'de-DE' },
        { re: /\b(france|fr)\b/, locale: 'fr-FR' },
        { re: /\b(spain|españa|es)\b/, locale: 'es-ES' },
        { re: /\b(italy|italia|it)\b/, locale: 'it-IT' },
        { re: /\b(brazil|brasil|br)\b/, locale: 'pt-BR' },
        { re: /\b(japan|jp)\b/, locale: 'ja-JP' },
        { re: /\b(korea|kr|south korea)\b/, locale: 'ko-KR' },
        { re: /\b(china|cn)\b/, locale: 'zh-CN' },
        { re: /\b(russia|ru)\b/, locale: 'ru-RU' },
        { re: /\b(netherlands|holland|nl)\b/, locale: 'nl-NL' },
        { re: /\b(poland|pl)\b/, locale: 'pl-PL' },
        { re: /\b(sweden|se)\b/, locale: 'sv-SE' },
      ];

      for (const m of mapping) {
        if (m.re.test(h)) {
          const fmt = PHONE_FORMATS[m.locale];
          if (fmt) return replacePlaceholders(fmt);
        }
      }

      // Country code detection like +44
      const cc = h.match(/\+\d{1,3}/);
      if (cc) {
        const code = cc[0];
        if (code === '+44') return replacePlaceholders(PHONE_FORMATS['en-GB']);
        if (code === '+49') return replacePlaceholders(PHONE_FORMATS['de-DE']);
        if (code === '+33') return replacePlaceholders(PHONE_FORMATS['fr-FR']);
        if (code === '+34') return replacePlaceholders(PHONE_FORMATS['es-ES']);
        if (code === '+39') return replacePlaceholders(PHONE_FORMATS['it-IT']);
        if (code === '+55') return replacePlaceholders(PHONE_FORMATS['pt-BR']);
        if (code === '+81') return replacePlaceholders(PHONE_FORMATS['ja-JP']);
        if (code === '+86') return replacePlaceholders(PHONE_FORMATS['zh-CN']);
      }
    } catch {}

    // Fallback to generator locale
    return this.generatePhone();
  }

  generateIp(): string {
    // Randomly produce IPv4 most of the time, occasionally IPv6
    if (Math.random() < 0.85) {
      return Array.from({ length: 4 }, () => String(randomInt(1, 254))).join('.');
    }
    // Simple IPv6 (short form)
    const parts = Array.from({ length: 8 }, () => randomInt(0, 0xffff).toString(16));
    return parts.join(':');
  }

  generateUsername(persona: PersonaContext | null = null): string {
    if (persona) {
      const base = `${persona.firstName.toLowerCase()}${persona.lastName.toLowerCase()}`;
      return `${base.replace(/[^a-z0-9]/g, '')}${randomInt(10, 99)}`;
    }
    return this.faker.internet.username();
  }

  generatePassword(minLength: number | null = null, pattern: string | null = null): string {
    const length = Math.max(minLength ?? LIMITS.PASSWORD_DEFAULT_LENGTH, 8);
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const special = '@$!%*?&';

    // Whether pattern demands specific character classes
    const needsUpper = !pattern || /[A-Z]/.test(pattern);
    const needsSpecial = !pattern || /[^a-zA-Z0-9]/.test(pattern);

    const chars =
      upper +
      lower +
      digits +
      (needsSpecial ? special : '');

    // Guarantee at least one of each required class
    const required: string[] = [
      pick([...upper]),
      pick([...lower]),
      pick([...digits]),
    ];
    if (needsUpper) required.push(pick([...upper]));
    if (needsSpecial) required.push(pick([...special]));

    const extra = Array.from(
      { length: Math.max(0, length - required.length) },
      () => chars[randomInt(0, chars.length - 1)],
    );

    return shuffleInPlace([...required, ...extra]).join('');
  }

  generateBirthdate(): string {
    const from = new Date();
    from.setFullYear(from.getFullYear() - 60);
    const to = new Date();
    to.setFullYear(to.getFullYear() - 18);
    return toISODate(randomDate(from, to));
  }

  generateDate(
    min: string | number | null = null,
    max: string | number | null = null,
    hint = '',
  ): string {
    // If the hint suggests a future date (interview, start, available, hire, expiry),
    // generate a date within the next 1-2 years
    const isFuture = /\b(interview|start\s*date|start|available|hire|expiry|expiration|renewal)\b/.test(hint);
    const from = min ? new Date(min) : (isFuture ? new Date() : new Date('1990-01-01'));
    const to = max ? new Date(max) : (isFuture ? (() => { const d = new Date(); d.setFullYear(d.getFullYear() + 2); return d; })() : new Date());
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
      return toISODate(new Date());
    }
    return toISODate(randomDate(from, to));
  }

  generateTime(): string {
    const hour = String(randomInt(8, 18)).padStart(2, '0');
    const minute = String(randomInt(0, 59)).padStart(2, '0');
    return `${hour}:${minute}`;
  }

  generateDatetimeLocal(hint = ''): string {
    const date = this.generateDate(null, null, hint);
    const time = this.generateTime();
    return `${date}T${time}`;
  }

  generateMonth(): string {
    const now = new Date();
    const year = now.getFullYear() + randomInt(0, 2);
    const month = String(randomInt(1, 12)).padStart(2, '0');
    return `${year}-${month}`;
  }

  generateWeek(): string {
    const now = new Date();
    const year = now.getFullYear() + randomInt(0, 1);
    const week = String(randomInt(1, 52)).padStart(2, '0');
    return `${year}-W${week}`;
  }

  generateCardExpiry(): string {
    const now = new Date();
    const month = randomInt(1, 12);
    const year = now.getFullYear() + randomInt(1, 5);
    return `${String(month).padStart(2, '0')}/${String(year).slice(-2)}`;
  }

  generateNumber(
    constraints: { min?: string | number | null; max?: string | number | null; step?: string | number | null },
  ): string {
    const min = constraints.min !== null && constraints.min !== undefined
      ? Number(constraints.min)
      : 1;
    const max = constraints.max !== null && constraints.max !== undefined
      ? Number(constraints.max)
      : 99;
    if (isNaN(min) || isNaN(max) || min > max) return '1';

    const step = constraints.step !== null && constraints.step !== undefined
      ? Number(constraints.step)
      : null;

    if (step && step > 0 && !isNaN(step)) {
      // Generate a value that is a valid step multiple from min
      const range = max - min;
      const steps = Math.floor(range / step);
      if (steps <= 0) return String(min);
      const randomSteps = randomInt(0, steps);
      const value = min + randomSteps * step;
      // Handle floating point precision
      if (step % 1 !== 0) {
        const decimals = String(step).split('.')[1]?.length ?? 2;
        return value.toFixed(decimals);
      }
      return String(value);
    }

    return String(randomInt(min, max));
  }

  generateCurrency(
    min: string | number | null,
    max: string | number | null,
  ): string {
    const lo = min !== null ? Number(min) : 1;
    const hi = max !== null ? Number(max) : 999;
    const amount = (Math.random() * (hi - lo) + lo).toFixed(2);
    return amount;
  }

  generateText(minLength: number | null, maxLength: number | null): string {
    const min = minLength ?? 10;
    const max = maxLength ?? 100;
    const words = this.faker.lorem.words(
      randomInt(Math.max(1, Math.floor(min / 6)), Math.max(2, Math.floor(max / 5))),
    );
    return words.slice(0, max);
  }

  // -----------------------------------------------------------
  // Persona – ensures related fields (name, email) are coherent
  // -----------------------------------------------------------

  buildPersona(): PersonaContext {
    const firstName = this.faker.person.firstName();
    const lastName = this.faker.person.lastName();
    const username = `${firstName.toLowerCase()}${lastName.toLowerCase()}${randomInt(10, 99)}`;
    return { firstName, lastName, username };
  }

  // -----------------------------------------------------------
  // Validate that a generated value satisfies field constraints
  // -----------------------------------------------------------

  validate(value: string, field: FieldAnalysis): boolean {
    const { constraints } = field;

    if (constraints.required && !value) return false;
    if (!value) return true; // optional and empty is fine

    if (constraints.minLength !== null && value.length < constraints.minLength) return false;
    if (constraints.maxLength !== null && value.length > constraints.maxLength) return false;

    if (constraints.pattern) {
      try {
        if (!new RegExp(constraints.pattern).test(value)) return false;
      } catch {
        // Invalid regex from page – skip validation
      }
    }

    if (constraints.min !== null && constraints.max !== null) {
      const num = Number(value);
      if (!isNaN(num)) {
        if (Number(constraints.min) > num || num > Number(constraints.max)) return false;
      }
    }

    if (field.type === 'creditCard') return isLuhnValid(value);

    return true;
  }

  // -----------------------------------------------------------
  // Regenerate with validation retry
  // -----------------------------------------------------------

  generateWithRetry(
    field: FieldAnalysis,
    persona: PersonaContext | null,
    maxRetries = 3,
  ): string | null {
    // "Code" fields must always produce varchar (alphanumeric), never names/words
    if (this.isCodeField(field)) {
      return this.generateVarchar(field.constraints);
    }
    for (let i = 0; i < maxRetries; i++) {
      const value = this.generateForField(field, persona);
      if (value === null) return null;
      if (this.validate(value, field)) return value;
    }
    // Fallback: return a short safe string
    return generateId('val');
  }

  // -----------------------------------------------------------
  // Varchar generator for "code" fields
  // Produces alphanumeric strings like "M100", "AB0042", never words.
  // -----------------------------------------------------------

  generateVarchar(constraints?: { minLength?: number | null; maxLength?: number | null } | null): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const maxLen = constraints?.maxLength ?? 10;
    // Prefix: 1-2 letters
    const prefixLen = Math.min(2, Math.max(1, maxLen - 2));
    const prefix = Array.from({ length: prefixLen }, () => letters[randomInt(0, letters.length - 1)]).join('');
    // Suffix: remaining chars are digits
    const digitLen = Math.max(1, Math.min(8, maxLen - prefixLen));
    const maxN = Math.pow(10, digitLen) - 1;
    const num = String(randomInt(0, maxN)).padStart(digitLen, '0');
    return `${prefix}${num}`;
  }

  // -----------------------------------------------------------
  // Check if a field is a "code" field based on name/label
  // -----------------------------------------------------------

  isCodeField(field: FieldAnalysis): boolean {
    const hint = [field.name, field.label, field.ariaLabel, field.className, field.id].filter(Boolean).join(' ').toLowerCase();
    // "code" in label/name but not postal/zip/pin/promo etc.
    return (/\bcode\b/.test(hint) || /code$/i.test(field.name || '') || /code$/i.test(field.label || ''))
      && !/postal|zip|pin|area|ifsc|swift|bic|routing|sort|promo|coupon|voucher|token|discount/i.test(hint);
  }
}
