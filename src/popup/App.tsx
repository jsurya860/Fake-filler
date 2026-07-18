import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus, FormAnalysis, Profile, Settings } from '@/shared/types';
import { sendToActiveTab, sendToBackground } from './api';
import { FormPreview } from './components/FormPreview';
import { ProfileSelector } from './components/ProfileSelector';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBadge } from './components/StatusBadge';
import { DebugPanel } from './components/DebugPanel';
import { logSwallowed } from '@/shared/messaging';

// =============================================================
// Error Boundary
// =============================================================

interface ErrorBoundaryState { hasError: boolean; error: Error | null }

class ErrorBoundary extends Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <h2>Something went wrong</h2>
          <p>{this.state.error?.message ?? 'An unexpected error occurred.'}</p>
          <button className="btn btn--secondary" onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// =============================================================
// Types
// =============================================================

type ActiveTab = 'fill' | 'profiles' | 'settings' | 'debug';

interface RadioDiagnostic {
  kind: string;
  chosenText?: string;
}

function AppContent(): JSX.Element {
  const [activeTab, setActiveTab] = useState<ActiveTab>('fill');
  const [status, setStatus] = useState<AppStatus>('analyzing');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [forms, setForms] = useState<FormAnalysis[]>([]);
  const [selectedFormIndex, setSelectedFormIndex] = useState(0);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [chainingState, setChainingState] = useState<{ active: boolean; fillCount: number }>({ active: false, fillCount: 0 });
  const [radioDiag, setRadioDiag] = useState<RadioDiagnostic | null>(null);
  const [chainLog, setChainLog] = useState<Array<{ step: number; url: string; fieldsCount: number; ts: number }>>([]);

  // The form currently being previewed (after data generation)
  const [previewForm, setPreviewForm] = useState<FormAnalysis | null>(null);

  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isGeneratingRef = useRef(false);

  // -----------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------

  useEffect(() => {
    void init();
  }, []);

  // Poll chaining state while the popup is open so UI stays in sync with background
  useEffect(() => {
    let mounted = true;
    async function refresh() {
      try {
        const resp = await sendToBackground<{ active: boolean; fillCount: number }>({ action: 'GET_CHAINING_STATE' });
        if (!mounted) return;
        if (resp.success && resp.data) setChainingState({ active: !!resp.data.active, fillCount: resp.data.fillCount ?? 0 });
        // fetch latest radio diagnostic
        try {
          const d = await sendToBackground<RadioDiagnostic>({ action: 'GET_RADIO_DIAGNOSTIC' });
          if (d.success) setRadioDiag(d.data ?? null);
        } catch (e) { logSwallowed('src/popup/App.tsx', e); }
        // fetch chain log
        try {
          const logResp = await sendToBackground<Array<{ step: number; url: string; fieldsCount: number; ts: number }>>({ action: 'GET_CHAIN_LOG' });
          if (logResp.success && logResp.data) setChainLog(logResp.data);
        } catch (e) { logSwallowed('src/popup/App.tsx', e); }
      } catch (e) { logSwallowed('src/popup/App.tsx', e); }
    }
    // Initial refresh + interval
    void refresh();
    const id = setInterval(() => void refresh(), 1500);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Clear stale timer on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  // Clear preview whenever the user selects a different form
  useEffect(() => {
    setPreviewForm(null);
  }, [selectedFormIndex]);

  async function init(): Promise<void> {
    try {
      const [formsResp, profilesResp, settingsResp] = await Promise.all([
        sendToActiveTab<FormAnalysis[]>({ action: 'GET_FORM_DATA' }),
        sendToBackground<Profile[]>({ action: 'LIST_PROFILES' }),
        sendToBackground<Settings>({ action: 'GET_SETTINGS' }),
      ]);

      // Query chaining state for the active tab
      try {
        const chainResp = await sendToBackground<{ active: boolean; fillCount: number }>({ action: 'GET_CHAINING_STATE' });
        if (chainResp.success && chainResp.data) {
          setChainingState({ active: !!chainResp.data.active, fillCount: chainResp.data.fillCount ?? 0 });
        }
      } catch (e) { logSwallowed('src/popup/App.tsx', e); }

      if (!formsResp.success || !formsResp.data?.length) {
        setStatus('no-form');
        return;
      }

      setForms(formsResp.data);
      setProfiles(profilesResp.data ?? []);
      setSettings(settingsResp.data ?? null);
      setStatus('idle');
    } catch (err) {
      setStatus('error');
      setErrorMessage((err as Error).message);
    }
  }

  // -----------------------------------------------------------
  // Generate data (preview)
  // -----------------------------------------------------------

  // Core generation logic — returns the generated form so handleFill can use it directly.
  const doGenerate = useCallback(async (): Promise<FormAnalysis | null> => {
    if (isGeneratingRef.current) return null;
    isGeneratingRef.current = true;
    setStatus('generating');
    setErrorMessage('');

    const form = forms[selectedFormIndex];
    if (!form) {
      setStatus('idle');
      isGeneratingRef.current = false;
      return null;
    }

    try {
      const resp = await sendToBackground<FormAnalysis>({
        action: 'GENERATE_DATA_FOR_FORM',
        payload: {
          formAnalysis: form,
          profileId: selectedProfileId || undefined,
          options: settings
            ? {
                locale: settings.locale,
                emailDomain: settings.defaultEmailDomain,
                consistentPersona: settings.consistentPersona,
              }
            : undefined,
        },
      });

      if (!resp.success || !resp.data) {
        throw new Error(resp.error ?? 'Data generation failed.');
      }

      setPreviewForm(resp.data);
      setStatus('idle');
      return resp.data;
    } catch (err) {
      setStatus('error');
      setErrorMessage((err as Error).message);
      return null;
    } finally {
      isGeneratingRef.current = false;
    }
  }, [forms, selectedFormIndex, selectedProfileId, settings]);

  // UI-facing wrapper — always resolves to void for use as a click handler.
  const handleGenerate = useCallback((): Promise<void> => {
    return doGenerate().then(() => undefined);
  }, [doGenerate]);

  // -----------------------------------------------------------
  // Fill form
  // -----------------------------------------------------------

  const handleFill = useCallback(async (): Promise<void> => {
    let formToFill = previewForm;

    if (!formToFill) {
      formToFill = await doGenerate();
      if (!formToFill) return;
      // When showPreviewBeforeFill is on, pause so the user can review the preview.
      if (settings?.showPreviewBeforeFill) return;
    }

    setStatus('filling');

    try {
      const resp = await sendToActiveTab<Record<string, unknown>>({
        action: 'FILL_FORM',
        payload: { formAnalysis: formToFill },
      });

      if (!resp.success) throw new Error(resp.error ?? 'Fill failed.');
      // Content script may return success:true but with skipped:true when
      // a modal overlay blocked the fill — treat as a warning, not success.
      if (resp.data && resp.data.skipped === true) {
        const reason = typeof resp.data.reason === 'string' ? resp.data.reason : 'Fill was skipped';
        throw new Error(`Fill skipped: ${reason}. Close any open overlays and try again.`);
      }
      setStatus('success');
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setStatus('idle'), 2500);
    } catch (err) {
      setStatus('error');
      setErrorMessage((err as Error).message);
    }
  }, [previewForm, doGenerate, settings]);

  // -----------------------------------------------------------
  // Update single field value in preview
  // -----------------------------------------------------------

  const handleFieldChange = useCallback((fieldId: string, newValue: string) => {
    setPreviewForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        fields: prev.fields.map((f) =>
          f.id === fieldId ? { ...f, value: newValue } : f,
        ),
      };
    });
  }, []);

  const handleSkipField = useCallback((fieldId: string, skip: boolean) => {
    setPreviewForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        fields: prev.fields.map((f) =>
          f.id === fieldId ? { ...f, skip } : f,
        ),
      };
    });
  }, []);

  // -----------------------------------------------------------
  // Render
  // -----------------------------------------------------------

  if (status === 'no-form') {
    return (
      <div className="app">
        <header className="app-header">
          <span className="app-logo">⚡</span>
          <h1 className="app-title">Fake Data Filler</h1>
        </header>
        <div className="empty-state">
          <p className="empty-icon">📋</p>
          <p>No form detected on this page.</p>
          <p className="empty-sub">Navigate to a page with a form and click the extension again.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {/* Header */}
      <header className="app-header">
        <span className="app-logo">⚡</span>
        <h1 className="app-title">Fake Data Filler</h1>
        <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
          <StatusBadge status={status} />
            {chainingState.active && (
            <button
              className="btn btn--link"
              title="Stop chaining"
              onClick={() => {
                void (async () => {
                  try {
                    await sendToBackground({ action: 'DISABLE_CHAINING' });
                    setChainingState({ active: false, fillCount: 0 });
                  } catch (e) { logSwallowed('src/popup/App.tsx', e); }
                })();
              }}
            >
              ⛔ Stop chaining
            </button>
            )}
            {radioDiag && (
              <div style={{fontSize: 12, color: 'var(--clr-text-muted)', marginLeft: 8}} title={JSON.stringify(radioDiag)}>
                🛈 Radio: {radioDiag.kind} {radioDiag.chosenText ? `— "${String(radioDiag.chosenText).slice(0,20)}"` : ''}
              </div>
            )}
        </div>
      </header>

      {/* Tab bar */}
      <nav className="tab-bar" role="tablist">
        {(['fill', 'profiles', 'settings', 'debug'] as ActiveTab[]).map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab(tab)}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`panel-${tab}`}
          >
            {tab === 'fill' ? '✏️ Fill' : tab === 'profiles' ? '👤 Profiles' : tab === 'settings' ? '⚙️ Settings' : '🐞 Debug'}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      <main className="tab-content" role="tabpanel" id={`panel-${activeTab}`}>
        {activeTab === 'fill' && (
          <FillTab
            forms={forms}
            selectedFormIndex={selectedFormIndex}
            onSelectForm={setSelectedFormIndex}
            profiles={profiles}
            selectedProfileId={selectedProfileId}
            onSelectProfile={setSelectedProfileId}
            previewForm={previewForm}
            onFieldChange={handleFieldChange}
            onSkipField={handleSkipField}
            onGenerate={handleGenerate}
            onFill={handleFill}
            status={status}
            errorMessage={errorMessage}
            chainingState={chainingState}
            onStartChaining={async () => {
              try {
                await sendToBackground({ action: 'START_CHAINING' });
                setChainingState({ active: true, fillCount: 0 });
              } catch (e) { logSwallowed('src/popup/App.tsx', e); }
            }}
            onStopChaining={async () => {
              try {
                await sendToBackground({ action: 'DISABLE_CHAINING' });
                setChainingState({ active: false, fillCount: 0 });
                setChainLog([]);
              } catch (e) { logSwallowed('src/popup/App.tsx', e); }
            }}
            chainLog={chainLog}
          />
        )}

        {activeTab === 'profiles' && (
          <ProfileSelector
            profiles={profiles}
            onProfilesChange={setProfiles}
            onSelect={setSelectedProfileId}
            selectedId={selectedProfileId}
          />
        )}

        {activeTab === 'settings' && settings && (
          <SettingsPanel
            settings={settings}
            onChange={(updated: Settings) => {
              setSettings(updated);
              void sendToBackground({ action: 'UPDATE_SETTINGS', payload: updated });
            }}
          />
        )}

        {activeTab === 'debug' && (
          <DebugPanel />
        )}
      </main>
    </div>
  );
}

export default function App(): JSX.Element {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

// =============================================================
// FillTab sub-component
// =============================================================

interface FillTabProps {
  forms: FormAnalysis[];
  selectedFormIndex: number;
  onSelectForm: (i: number) => void;
  profiles: Profile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  previewForm: FormAnalysis | null;
  onFieldChange: (id: string, value: string) => void;
  onSkipField: (id: string, skip: boolean) => void;
  onGenerate: () => Promise<void>;
  onFill: () => Promise<void>;
  status: AppStatus;
  errorMessage: string;
  chainingState: { active: boolean; fillCount: number };
  onStartChaining: () => Promise<void>;
  onStopChaining: () => Promise<void>;
  chainLog: Array<{ step: number; url: string; fieldsCount: number; ts: number }>;
}

function FillTab({
  forms,
  selectedFormIndex,
  onSelectForm,
  profiles,
  selectedProfileId,
  onSelectProfile,
  previewForm,
  onFieldChange,
  onSkipField,
  onGenerate,
  onFill,
  status,
  errorMessage,
  chainingState,
  onStartChaining,
  onStopChaining,
  chainLog,
}: FillTabProps): JSX.Element {
  const busy = status === 'filling' || status === 'generating' || status === 'analyzing';
  const [onlyRequired, setOnlyRequired] = useState(false);
  const [compactView, setCompactView] = useState(true);

  return (
    <>
      {/* Form selector (only shown when multiple forms are detected) */}
      {forms.length > 1 && (
        <div className="field-row">
          <label className="field-label">Form</label>
          <select
            className="field-select"
            value={selectedFormIndex}
            onChange={(e) => onSelectForm(Number(e.target.value))}
          >
            {forms.map((f, i) => (
              <option key={i} value={i}>
                Form {i + 1} — {f.type} ({f.fields.length} fields)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Profile selector */}
      <div className="field-row">
        <label className="field-label">Profile</label>
        <select
          className="field-select"
          value={selectedProfileId}
          onChange={(e) => onSelectProfile(e.target.value)}
        >
          <option value="">Generate new data</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {/* Advanced preview options */}
      <div className="setting-row setting-row--toggle" style={{display: 'flex', alignItems: 'center', gap: 12}}>
        <div style={{display: 'flex', gap: 12, alignItems: 'center'}}>
          <label style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            <input type="checkbox" checked={onlyRequired} onChange={(e) => setOnlyRequired(e.target.checked)} />
            <span style={{fontSize: 12, color: 'var(--clr-text-muted)'}}>Only required fields</span>
          </label>
          <label style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            <input type="checkbox" checked={compactView} onChange={(e) => setCompactView(e.target.checked)} />
            <span style={{fontSize: 12, color: 'var(--clr-text-muted)'}}>Compact preview</span>
          </label>
        </div>
      </div>

      {/* Preview */}
      {previewForm ? (
        <FormPreview
          form={previewForm}
          onFieldChange={onFieldChange}
          onSkipField={onSkipField}
          options={{ onlyRequired, compact: compactView }}
        />
      ) : (
        <div className="preview-placeholder">
          <p>Click &ldquo;Generate&rdquo; to preview data before filling.</p>
        </div>
      )}

      {/* Error */}
      {status === 'error' && (
        <div className="error-banner" role="alert">
          ⚠️ {errorMessage || 'An error occurred.'}
        </div>
      )}

      {/* Actions */}
      <div className="action-row">
        <button
          className="btn btn--secondary"
          onClick={() => void onGenerate()}
          disabled={busy}
          title="Generate new fake data"
        >
          🔄 Generate
        </button>
        <button
          className="btn btn--primary"
          onClick={() => void onFill()}
          disabled={busy}
          title="Fill the form with the generated data"
        >
          {busy ? '⏳ Working…' : previewForm ? '✅ Fill Form' : '⚡ Fill Now'}
        </button>
      </div>

      {/* Chaining controls */}
      <div className="action-row" style={{ marginTop: 8 }}>
        {!chainingState.active ? (
          <button
            className="btn btn--secondary"
            onClick={() => void onStartChaining()}
            disabled={busy}
            title="Fill this form, then auto-fill subsequent pages/steps"
          >
            🔗 Start Chaining
          </button>
        ) : (
          <button
            className="btn btn--secondary"
            onClick={() => void onStopChaining()}
            title="Stop auto-filling new forms"
            style={{ color: '#e53e3e' }}
          >
            ⛔ Stop Chaining ({chainingState.fillCount} steps)
          </button>
        )}
      </div>

      {/* Chain log */}
      {chainLog.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--clr-text-muted)' }}>
          <strong>Chain log:</strong>
          <div style={{ maxHeight: 100, overflowY: 'auto', marginTop: 4 }}>
            {chainLog.map((entry, i) => (
              <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                #{entry.step} — {entry.fieldsCount} fields — {(() => { try { return new URL(entry.url || 'about:blank').pathname.slice(0, 40); } catch { return entry.url?.slice(0, 40) ?? ''; } })()}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
