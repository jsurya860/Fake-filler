import { canonicalizeHotkey, parseCanonicalHotkey } from '../../src/shared/hotkey';

describe('Hotkey utilities', () => {
  it('canonicalizes common variants', () => {
    expect(canonicalizeHotkey('Ctrl+Shift+F')).toBe('ctrl+shift+f');
    expect(canonicalizeHotkey('shift + ctrl + F')).toBe('ctrl+shift+f');
    expect(canonicalizeHotkey('Command+Option+K')).toBe('alt+meta+k');
    expect(canonicalizeHotkey('ctrl f')).toBe('ctrl+f');
    expect(canonicalizeHotkey('  ')).toBeUndefined();
  });

  it('parses canonical hotkey into flags', () => {
    const p = parseCanonicalHotkey('ctrl+shift+f');
    expect(p.ctrl).toBe(true);
    expect(p.shift).toBe(true);
    expect(p.alt).toBe(false);
    expect(p.meta).toBe(false);
    expect(p.key).toBe('f');
  });
});
