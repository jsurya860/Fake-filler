/**
 * Shared utility functions used across background, content, and popup modules.
 * No DOM-specific APIs – safe to import anywhere.
 */

// =============================================================
// String Helpers
// =============================================================

/** Replace all `#` placeholders with a random digit 0–9 */
export function replacePlaceholders(template: string): string {
  return template.replace(/#/g, () => String(Math.floor(Math.random() * 10)));
}

/** Truncate a string to a maximum length, appending ellipsis if needed */
export function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

/** Pad a number to a fixed width with leading zeros */
export function padStart(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

// =============================================================
// Randomness Helpers
// =============================================================

/** Cryptographically random integer in [min, max] inclusive */
export function randomInt(min: number, max: number): number {
  const range = max - min + 1;
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + (bytes[0] % range);
}

/** Pick a random element from an array */
export function pick<T>(arr: T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

/** Shuffle an array in place using Fisher-Yates (crypto random) */
export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// =============================================================
// Luhn Algorithm (credit card validation)
// =============================================================

/** Verify or generate a Luhn-valid card number string */
export function luhnChecksum(digits: string): number {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10;
}

/** Return true if the card number passes the Luhn check */
export function isLuhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  return digits.length >= 13 && luhnChecksum(digits) === 0;
}

// =============================================================
// Date Utilities
// =============================================================

/** Format a Date to YYYY-MM-DD */
export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Return a random Date between two dates */
export function randomDate(from: Date, to: Date): Date {
  const start = from.getTime();
  const end = to.getTime();
  return new Date(start + Math.random() * (end - start));
}

// =============================================================
// Unique ID
// =============================================================

/** Generate a short random ID, e.g. "a3f2b9" */
export function generateId(prefix = ''): string {
  const rand = crypto.getRandomValues(new Uint8Array(9));
  const hex = Array.from(rand, (b) => b.toString(16).padStart(2, '0')).join('');
  return prefix ? `${prefix}_${hex}` : hex;
}

// =============================================================
// URL / Domain
// =============================================================

/** Extract the hostname from a full URL, returning empty string on error */
export function hostnameFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch (e) {
    try { console.debug('[FDF Pro] hostnameFromUrl parse failed', e); } catch {}
    return '';
  }
}

/** Check whether a given hostname matches a whitelist/blacklist entry.
 *  Supports exact matches and wildcard prefix, e.g. "*.example.com" */
export function matchesHostnameList(hostname: string, list: string[]): boolean {
  return list.some((entry) => {
    if (entry.startsWith('*.')) {
      return hostname.endsWith(entry.slice(1));
    }
    return hostname === entry || hostname.endsWith(`.${entry}`);
  });
}

// =============================================================
// Deep Clone (no circular refs)
// =============================================================

export function deepClone<T>(obj: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj)) as T;
}
