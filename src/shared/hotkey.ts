// Utilities for canonicalizing and parsing hotkey strings

export interface ParsedHotkey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  key: string | null;
}

export function canonicalizeHotkey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw.split(/[+,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const modifiers: string[] = [];
  let key: string | null = null;
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') modifiers.push('ctrl');
    else if (p === 'shift') modifiers.push('shift');
    else if (p === 'alt' || p === 'option') modifiers.push('alt');
    else if (p === 'meta' || p === 'cmd' || p === 'command') modifiers.push('meta');
    else key = p;
  }
  if (!key) return undefined;
  const ordered = ['ctrl', 'shift', 'alt', 'meta'].filter((m) => modifiers.includes(m));
  return [...ordered, key].join('+');
}

export function parseCanonicalHotkey(h?: string): ParsedHotkey {
  if (!h) return { ctrl: false, shift: false, alt: false, meta: false, key: null };
  const parts = h.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const res: ParsedHotkey = { ctrl: false, shift: false, alt: false, meta: false, key: null };
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') res.ctrl = true;
    else if (p === 'shift') res.shift = true;
    else if (p === 'alt' || p === 'option') res.alt = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command') res.meta = true;
    else res.key = p;
  }
  return res;
}

export default { canonicalizeHotkey, parseCanonicalHotkey };
