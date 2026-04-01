import React, { useState, useEffect } from 'react';
import type { Settings, SupportedLocale, FillSensitivity } from '@/shared/types';
import { sendToBackground } from '../api';
import { LOCALES } from '@/shared/constants';

interface SettingsPanelProps {
  settings: Settings;
  onChange: (updated: Settings) => void;
}

export function SettingsPanel({ settings, onChange }: SettingsPanelProps): JSX.Element {
  function update<K extends keyof Settings>(key: K, value: Settings[K]): void {
    onChange({ ...settings, [key]: value });
  }

  function updateList(key: 'domainWhitelist' | 'domainBlacklist', raw: string): void {
    const list = raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    update(key, list);
  }

  return (
    <section className="settings-section">
      <h2 className="section-title">Settings</h2>

      {/* Locale */}
      <SettingRow label="Locale" hint="Affects phone, date, and address formats.">
        <select
          className="field-select"
          value={settings.locale}
          onChange={(e) => update('locale', e.target.value as SupportedLocale)}
        >
          {LOCALES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </SettingRow>

      {/* Email domain */}
      <SettingRow label="Email domain" hint="Domain appended to generated email addresses.">
        <input
          className="field-input"
          type="text"
          value={settings.defaultEmailDomain}
          onChange={(e) => update('defaultEmailDomain', e.target.value)}
          placeholder="testdomain.com"
        />
      </SettingRow>

      {/* Fill sensitivity */}
      <SettingRow label="Fill sensitivity" hint="How aggressively fields are detected and filled.">
        <select
          className="field-select"
          value={settings.fillSensitivity}
          onChange={(e) => update('fillSensitivity', e.target.value as FillSensitivity)}
        >
          <option value="conservative">Conservative (required only)</option>
          <option value="balanced">Balanced (recommended)</option>
          <option value="aggressive">Aggressive (fill all)</option>
        </select>
      </SettingRow>

      {/* Toggles */}
      <Toggle
        label="Error recovery"
        hint="Auto-fix validation errors and retry failed fields."
        checked={settings.errorRecoveryEnabled}
        onChange={(v) => update('errorRecoveryEnabled', v)}
      />
      <Toggle
        label="Consistent persona"
        hint="Generate a coherent name + email + username set."
        checked={settings.consistentPersona}
        onChange={(v) => update('consistentPersona', v)}
      />
      <Toggle
        label="Skip login forms"
        hint="Never fill forms that look like login pages."
        checked={settings.skipLoginForms}
        onChange={(v) => update('skipLoginForms', v)}
      />
      <Toggle
        label="Preview before fill"
        hint="Show generated data before inserting it."
        checked={settings.showPreviewBeforeFill}
        onChange={(v) => update('showPreviewBeforeFill', v)}
      />
      <Toggle
        label="Privacy mode"
        hint="Clear all generated data when the popup closes."
        checked={settings.privacyMode}
        onChange={(v) => update('privacyMode', v)}
      />
      <Toggle
        label="Auto-clear on close"
        hint="Delete all profiles when the browser closes."
        checked={settings.autoClearOnClose}
        onChange={(v) => update('autoClearOnClose', v)}
      />
      <Toggle
        label="Auto-fill chained forms"
        hint="Automatically fills new forms after clicking Next/Continue."
        checked={settings.chainingEnabled}
        onChange={(v) => update('chainingEnabled', v)}
      />
      <Toggle
        label="Auto-submit during chaining"
        hint="Click submit/next button after filling each form in a chain."
        checked={settings.autoSubmitOnChaining}
        onChange={(v) => update('autoSubmitOnChaining', v)}
      />
      <Toggle
        label="Auto-fill modal forms"
        hint="When a dialog or modal opens on the page, automatically fill any forms inside it."
        checked={settings.autoFillModals ?? true}
        onChange={(v) => update('autoFillModals', v)}
      />

      {/* Chaining delay */}
      <SettingRow label="Chain step delay (ms)" hint="Wait time between chain steps to let pages settle.">
        <input
          className="field-input"
          type="number"
          min={500}
          max={10000}
          step={100}
          value={settings.chainingDelayMs}
          onChange={(e) => update('chainingDelayMs', Math.max(500, Number(e.target.value) || 500))}
        />
      </SettingRow>

      {/* Domain lists */}
      <SettingRow label="Domain whitelist" hint="Only activate on these domains (one per line).">
        <textarea
          className="field-textarea"
          rows={3}
          value={settings.domainWhitelist.join('\n')}
          onChange={(e) => updateList('domainWhitelist', e.target.value)}
          placeholder="example.com&#10;staging.myapp.io"
        />
      </SettingRow>

      <SettingRow label="Domain blocklist" hint="Never activate on these domains.">
        <textarea
          className="field-textarea"
          rows={3}
          value={settings.domainBlacklist.join('\n')}
          onChange={(e) => updateList('domainBlacklist', e.target.value)}
          placeholder="paypal.com&#10;chase.com"
        />
      </SettingRow>
      <div style={{ marginTop: 12 }}>
        <button
          className="btn btn--link"
          onClick={async () => {
            try {
              await sendToBackground({ action: 'DISABLE_CHAINING' });
              // noop — popup will poll and update state
            } catch {}
          }}
        >
          ⛔ Stop chaining now
        </button>
      </div>
      {/* One-time hotkey setup */}
      <SettingRow label="One-click hotkey" hint="Set a single key combo to trigger autofill on pages where content scripts run.">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--clr-text-muted)' }}>
            {settings.oneClickHotkey ? <strong>{settings.oneClickHotkey}</strong> : <em>Not set</em>}
          </div>
          <HotkeySetter
            onSave={(k) => update('oneClickHotkey', k)}
            onClear={() => update('oneClickHotkey', '')}
          />
        </div>
      </SettingRow>
    </section>
  );
}

// =============================================================
// Helper components
// =============================================================

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="setting-row">
      <div className="setting-row__label">
        <span>{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </div>
      <div className="setting-row__control">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  const id = `toggle-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="setting-row setting-row--toggle">
      <label htmlFor={id} className="setting-row__label">
        <span>{label}</span>
        {hint && <span className="setting-hint">{hint}</span>}
      </label>
      <span className="toggle-switch">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-slider" />
      </span>
    </div>
  );
}

function HotkeySetter({ onSave, onClear }: { onSave: (k: string) => void; onClear: () => void }): JSX.Element {
  const [capturing, setCapturing] = useState(false);
  const [hint, setHint] = useState('');

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      // Allow Escape to cancel capture
      if (e.key === 'Escape') {
        setCapturing(false);
        setHint('');
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push('ctrl');
      if (e.shiftKey) parts.push('shift');
      if (e.altKey) parts.push('alt');
      if (e.metaKey) parts.push('meta');
      const key = (e.key || '').toLowerCase();
      // ignore lone modifiers
      if (key === 'control' || key === 'shift' || key === 'meta' || key === 'alt') return;
      if (key && key.length > 0) parts.push(key);
      const canonical = parts.join('+');
      if (canonical) {
        onSave(canonical);
      }
      setCapturing(false);
    }

    if (capturing) {
      window.addEventListener('keydown', onKey, { capture: true });
      setHint('Press the key combination now...');
      timeout = setTimeout(() => {
        setCapturing(false);
        setHint('Capture timed out');
      }, 10000);
    }

    return () => {
      if (timeout) clearTimeout(timeout);
      window.removeEventListener('keydown', onKey, { capture: true } as any);
    };
  }, [capturing]);

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {!capturing ? (
        <>
          <button className="btn btn--secondary" onClick={() => setCapturing(true)}>
            Set hotkey
          </button>
          <button
            className="btn btn--link"
            onClick={() => {
              onClear();
            }}
          >
            Clear
          </button>
          {hint && <div style={{ fontSize: 12, color: 'var(--clr-text-muted)' }}>{hint}</div>}
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--clr-text-muted)' }}>{hint}</div>
          <button className="btn btn--tiny" onClick={() => { setCapturing(false); setHint(''); }}>Cancel</button>
        </div>
      )}
    </div>
  );
}

