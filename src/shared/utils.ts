import { logSwallowed } from '@/shared/messaging';
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
  if (arr.length === 0) throw new RangeError('pick() called with an empty array');
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

/** Return a random Date between two dates using a cryptographically random offset */
export function randomDate(from: Date, to: Date): Date {
  const start = from.getTime();
  const end = to.getTime();
  const range = end - start;
  if (range <= 0) return new Date(start);
  // Distribute over 1 000 000 discrete points for a crypto-random result
  const slots = 1_000_000;
  return new Date(start + Math.floor((randomInt(0, slots) / slots) * range));
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
    try { console.debug('[FDF Pro] hostnameFromUrl parse failed', e); } catch (e) { logSwallowed('src/shared/utils.ts', e); }
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

/**
 * True if a hostname is loopback or a private-network address (RFC 1918 /
 * link-local / unique-local IPv6). Used to catch an almost-certainly-wrong
 * user-configured outbound endpoint (e.g. a telemetry URL), not as a general
 * security boundary — a determined attacker with control of the value has
 * far more direct options than this check would meaningfully block.
 */
export function isLoopbackOrPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 unique-local
  if (h.startsWith('fe80:')) return true; // IPv6 link-local
  return false;
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
