import {
  replacePlaceholders,
  randomInt,
  pick,
  shuffleInPlace,
  luhnChecksum,
  isLuhnValid,
  toISODate,
  randomDate,
  generateId,
  hostnameFromUrl,
  matchesHostnameList,
  truncate,
  padStart,
  deepClone,
} from '../../src/shared/utils';

describe('replacePlaceholders()', () => {
  it('replaces all # with a single digit 0–9', () => {
    const result = replacePlaceholders('###-####');
    expect(result).toMatch(/^\d{3}-\d{4}$/);
  });

  it('leaves non-# characters unchanged', () => {
    const result = replacePlaceholders('(555) #  #');
    expect(result).toMatch(/^\(555\) \d  \d$/);
  });
});

describe('randomInt()', () => {
  it('returns an integer in [min, max]', () => {
    for (let i = 0; i < 100; i++) {
      const n = randomInt(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  it('returns min when min === max', () => {
    expect(randomInt(7, 7)).toBe(7);
  });
});

describe('pick()', () => {
  it('returns an element from the array', () => {
    const arr = [1, 2, 3, 4, 5];
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(pick(arr));
    }
  });
});

describe('shuffleInPlace()', () => {
  it('returns the same elements', () => {
    const arr = [1, 2, 3, 4, 5];
    const shuffled = shuffleInPlace([...arr]);
    expect(shuffled.sort()).toEqual(arr.sort());
  });

  it('modifies and returns the same array reference', () => {
    const arr = [1, 2, 3];
    const ref = arr;
    shuffleInPlace(arr);
    expect(arr).toBe(ref);
  });
});

describe('Luhn algorithm', () => {
  const VALID_VISA = '4111111111111111';
  const VALID_MC = '5555555555554444';
  const INVALID = '1234567890123456';

  it('isLuhnValid returns true for known valid card (Visa)', () => {
    expect(isLuhnValid(VALID_VISA)).toBe(true);
  });

  it('isLuhnValid returns true for known valid card (MC)', () => {
    expect(isLuhnValid(VALID_MC)).toBe(true);
  });

  it('isLuhnValid returns false for an invalid card number', () => {
    expect(isLuhnValid(INVALID)).toBe(false);
  });

  it('isLuhnValid ignores non-digit characters', () => {
    expect(isLuhnValid('4111-1111-1111-1111')).toBe(true);
  });

  it('luhnChecksum returns 0 for a valid number', () => {
    expect(luhnChecksum(VALID_VISA)).toBe(0);
  });
});

describe('toISODate()', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    expect(toISODate(d)).toBe('2024-06-15');
  });
});

describe('randomDate()', () => {
  it('returns a Date between from and to', () => {
    const from = new Date('2000-01-01');
    const to = new Date('2005-01-01');
    for (let i = 0; i < 10; i++) {
      const d = randomDate(from, to);
      expect(d.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(d.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });
});

describe('generateId()', () => {
  it('returns a non-empty string', () => {
    expect(generateId().length).toBeGreaterThan(0);
  });

  it('includes the prefix when given', () => {
    expect(generateId('fld')).toMatch(/^fld_/);
  });

  it('generates unique IDs', () => {
    const ids = Array.from({ length: 100 }, () => generateId());
    expect(new Set(ids).size).toBe(100);
  });
});

describe('hostnameFromUrl()', () => {
  it('extracts hostname from a valid URL', () => {
    expect(hostnameFromUrl('https://www.example.com/path')).toBe('www.example.com');
  });

  it('returns empty string for an invalid URL', () => {
    expect(hostnameFromUrl('not-a-url')).toBe('');
  });
});

describe('matchesHostnameList()', () => {
  it('matches an exact hostname', () => {
    expect(matchesHostnameList('example.com', ['example.com'])).toBe(true);
  });

  it('matches a subdomain when entry has no wildcard', () => {
    expect(matchesHostnameList('sub.example.com', ['example.com'])).toBe(true);
  });

  it('matches wildcard entries', () => {
    expect(matchesHostnameList('foo.bar.com', ['*.bar.com'])).toBe(true);
  });

  it('does not match unrelated hostnames', () => {
    expect(matchesHostnameList('other.com', ['example.com'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(matchesHostnameList('example.com', [])).toBe(false);
  });
});

describe('truncate()', () => {
  it('truncates long strings with ellipsis', () => {
    const result = truncate('hello world', 8);
    expect(result.length).toBeLessThanOrEqual(8);
    expect(result).toMatch(/…$/);
  });

  it('returns the string unchanged when within limit', () => {
    expect(truncate('short', 20)).toBe('short');
  });
});

describe('padStart()', () => {
  it('pads a single digit to two characters', () => {
    expect(padStart(5, 2)).toBe('05');
  });

  it('does not pad when already at width', () => {
    expect(padStart(12, 2)).toBe('12');
  });
});

describe('deepClone()', () => {
  it('produces a deep copy of an object', () => {
    const orig = { a: { b: 1 } };
    const clone = deepClone(orig);
    clone.a.b = 99;
    expect(orig.a.b).toBe(1);
  });
});
